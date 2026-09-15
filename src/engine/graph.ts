/**
 * The audio graph: one Deck per playing track, feeding a shared Master chain.
 *
 * Both classes take a BaseAudioContext rather than an AudioContext, so exactly
 * the same graph code drives live playback and the offline render used for
 * export. Nothing here knows about the mix plan; the mixer drives it.
 *
 * Signal path per deck:
 *
 *   source -> stem separator -> highpass -> lowpass -> EQ(low/mid/high) -+-> deck gain -> master
 *                                                                        |
 *                                                                        +-> echo send -> delay
 *                                                                              ^    |      |
 *                                                                              +-- feedback +-> master
 *
 * The echo is tapped *before* the deck gain on purpose: pulling a deck's fader
 * down should leave its echo tail ringing, which is the whole point of an echo
 * out.
 */

import { STEMS, type StemName } from "../types";
import { clamp, dbToGain } from "../analysis/dsp";

export const WORKLET_URL = "worklets/stem-processor.js";
/** Matches LATENCY_SAMPLES in the worklet. Verified by the worklet test suite. */
export const STEM_LATENCY_SAMPLES = 4096;

export interface DeckOptions {
  /** false to skip the stem separator entirely (no AudioWorklet support) */
  useStems: boolean;
}

/** Load the stem worklet into a context. Returns false if unsupported. */
export async function loadStemWorklet(ctx: BaseAudioContext): Promise<boolean> {
  if (!("audioWorklet" in ctx)) return false;
  try {
    const url = new URL(WORKLET_URL, document.baseURI).href;
    await (ctx as AudioContext).audioWorklet.addModule(url);
    return true;
  } catch {
    return false;
  }
}

export class Deck {
  readonly ctx: BaseAudioContext;
  readonly input: GainNode;
  readonly output: GainNode;
  /** input-to-output delay contributed by the stem separator, in seconds */
  readonly latency: number;

  private readonly stem: AudioWorkletNode | null;
  private readonly highpass: BiquadFilterNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly eqLow: BiquadFilterNode;
  private readonly eqMid: BiquadFilterNode;
  private readonly eqHigh: BiquadFilterNode;
  private readonly trim: GainNode;
  private readonly echoSend: GainNode;
  private readonly echoDelay: DelayNode;
  private readonly echoFeedback: GainNode;
  private readonly echoTone: BiquadFilterNode;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private pendingLoop: { start: number; end: number } | null = null;
  private started = false;
  private startedAt = 0;
  private startOffset = 0;

  constructor(ctx: BaseAudioContext, opts: DeckOptions = { useStems: true }) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    if (opts.useStems) {
      this.stem = new AudioWorkletNode(ctx, "stem-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.latency = STEM_LATENCY_SAMPLES / ctx.sampleRate;
    } else {
      this.stem = null;
      this.latency = 0;
    }

    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = "highpass";
    this.highpass.frequency.value = 20;
    this.highpass.Q.value = 0.7;

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.value = 20000;
    this.lowpass.Q.value = 0.7;

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = "lowshelf";
    this.eqLow.frequency.value = 200;

    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = "peaking";
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.8;

    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = "highshelf";
    this.eqHigh.frequency.value = 4000;

    // Loudness-matching trim, separate from the fader so automation lanes can
    // own `gain` as a clean 0..1 fader without having to know the track's level.
    this.trim = ctx.createGain();
    this.trim.gain.value = 1;

    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.echoDelay = ctx.createDelay(2);
    this.echoDelay.delayTime.value = 0.25;
    this.echoFeedback = ctx.createGain();
    this.echoFeedback.gain.value = 0.55;
    // Darkening each repeat keeps a long echo from turning into noise.
    this.echoTone = ctx.createBiquadFilter();
    this.echoTone.type = "lowpass";
    this.echoTone.frequency.value = 3200;

    // Wire the chain.
    const head: AudioNode = this.stem ?? this.input;
    if (this.stem) this.input.connect(this.stem);
    head.connect(this.highpass);
    this.highpass.connect(this.lowpass);
    this.lowpass.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.trim);
    this.trim.connect(this.output);

    this.trim.connect(this.echoSend);
    this.echoSend.connect(this.echoDelay);
    this.echoDelay.connect(this.echoTone);
    this.echoTone.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoTone.connect(this.output);
  }

  connect(destination: AudioNode): void {
    this.output.connect(destination);
  }

  setTrimDb(db: number): void {
    this.trim.gain.value = dbToGain(db);
  }

  /** Echo time, usually a dotted eighth at the mix tempo. */
  setEchoTime(seconds: number): void {
    this.echoDelay.delayTime.value = clamp(seconds, 0.02, 2);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
  }

  /**
   * Start playback so that the *audible* output begins at `when` in context
   * time. The source is started earlier by exactly the separator's latency, so
   * everything downstream of the separator can be automated on mix time
   * without compensation.
   */
  start(when: number, offset: number, rate: number): void {
    if (!this.buffer || this.started) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;
    if (this.pendingLoop) {
      src.loopStart = this.pendingLoop.start;
      src.loopEnd = this.pendingLoop.end;
      src.loop = true;
    }
    src.connect(this.input);
    this.source = src;

    let sourceStart = when - this.latency;
    let sourceOffset = offset;
    const now = this.ctx.currentTime;
    if (sourceStart < now) {
      // Not enough runway: skip forward in the track instead of starting late,
      // which keeps the deck aligned with the mix timeline.
      sourceOffset += (now - sourceStart) * rate;
      sourceStart = now;
    }
    sourceOffset = clamp(sourceOffset, 0, Math.max(0, this.buffer.duration - 0.05));
    src.start(sourceStart, sourceOffset);
    this.started = true;
    this.startedAt = sourceStart;
    this.startOffset = sourceOffset;
  }

  stop(when: number): void {
    if (!this.source || !this.started) return;
    try {
      // Stop the source late enough that the separator's tail still flushes.
      this.source.stop(Math.max(this.ctx.currentTime, when - this.latency) + this.latency);
    } catch {
      /* already stopped */
    }
  }

  /** Track time currently sounding, accounting for the separator's delay. */
  trackTimeAt(contextTime: number, rate: number): number {
    if (!this.started) return this.startOffset;
    const elapsed = contextTime - this.latency - this.startedAt;
    return this.startOffset + Math.max(0, elapsed) * rate;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get bufferDuration(): number {
    return this.buffer?.duration ?? 0;
  }

  /**
   * Arm a loop over [start, end] in track seconds, to be applied when the deck
   * next starts. Playback runs linearly into the region and repeats from there,
   * so a loop roll needs no timed toggle.
   */
  prepareLoop(start: number, end: number): void {
    this.pendingLoop = end > start ? { start, end } : null;
  }

  /** Release an armed loop so the deck plays on past the region. */
  clearLoop(): void {
    this.pendingLoop = null;
    if (this.source) this.source.loop = false;
  }

  /** The AudioParam a lane target refers to, plus how it should be ramped. */
  param(target: string): { param: AudioParam; kind: "linear" | "frequency" | "db" } | null {
    switch (target) {
      case "gain":
        return { param: this.output.gain, kind: "linear" };
      case "highpass":
        return { param: this.highpass.frequency, kind: "frequency" };
      case "lowpass":
        return { param: this.lowpass.frequency, kind: "frequency" };
      case "echo":
        return { param: this.echoSend.gain, kind: "linear" };
      case "eq.low":
        return { param: this.eqLow.gain, kind: "db" };
      case "eq.mid":
        return { param: this.eqMid.gain, kind: "db" };
      case "eq.high":
        return { param: this.eqHigh.gain, kind: "db" };
      case "rate":
        return this.source ? { param: this.source.playbackRate, kind: "linear" } : null;
      default: {
        const stemMatch = /^stem\.(\w+)$/.exec(target);
        if (stemMatch && this.stem) {
          const name = stemMatch[1] as StemName;
          if (STEMS.includes(name)) {
            const p = this.stem.parameters.get(name);
            if (p) return { param: p, kind: "linear" };
          }
        }
        return null;
      }
    }
  }

  /** True when a lane target is pre-separator and so needs latency compensation. */
  static isPreSeparator(target: string): boolean {
    return target === "rate";
  }

  /** Immediate value set, for live user overrides. */
  setNow(target: string, value: number): void {
    const p = this.param(target);
    if (!p) return;
    const now = this.ctx.currentTime;
    p.param.cancelScheduledValues(now);
    p.param.setTargetAtTime(value, now, 0.02);
  }

  dispose(): void {
    try {
      this.source?.stop();
    } catch {
      /* not started */
    }
    this.source?.disconnect();
    this.output.disconnect();
    this.input.disconnect();
    this.stem?.disconnect();
  }
}

export interface MasterMeters {
  peak: number;
  rms: number;
  reduction: number;
}

/**
 * Master chain: gentle glue compression, then a fast limiter so that two decks
 * at full level cannot clip the output, then metering.
 */
export class Master {
  readonly ctx: BaseAudioContext;
  readonly input: GainNode;
  readonly analyser: AnalyserNode;
  readonly spectrum: AnalyserNode;

  private readonly glue: DynamicsCompressorNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly trim: GainNode;
  private readonly meterBuffer: Float32Array<ArrayBuffer>;

  constructor(ctx: BaseAudioContext, headroomDb = -1) {
    this.ctx = ctx;
    this.input = ctx.createGain();

    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -18;
    this.glue.knee.value = 12;
    this.glue.ratio.value = 2;
    this.glue.attack.value = 0.02;
    this.glue.release.value = 0.25;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.06;

    this.trim = ctx.createGain();
    this.trim.gain.value = dbToGain(headroomDb);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;
    this.spectrum = ctx.createAnalyser();
    this.spectrum.fftSize = 2048;
    this.spectrum.smoothingTimeConstant = 0.7;
    this.meterBuffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    this.input.connect(this.glue);
    this.glue.connect(this.limiter);
    this.limiter.connect(this.trim);
    this.trim.connect(this.analyser);
    this.analyser.connect(this.spectrum);
  }

  /** Terminal node, for connecting to a destination or a recorder tap. */
  get output(): AudioNode {
    return this.spectrum;
  }

  setTrimDb(db: number): void {
    this.trim.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.05);
  }

  meters(): MasterMeters {
    this.analyser.getFloatTimeDomainData(this.meterBuffer);
    let peak = 0;
    let sum = 0;
    for (const v of this.meterBuffer) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return {
      peak,
      rms: Math.sqrt(sum / this.meterBuffer.length),
      reduction: this.limiter.reduction,
    };
  }
}
