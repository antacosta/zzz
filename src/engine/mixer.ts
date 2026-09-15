/**
 * Plan execution.
 *
 * The mixer turns a MixPlan into scheduled Web Audio automation. It runs the
 * same code path live and offline: live playback uses a lookahead scheduler so
 * a three-hour set costs nothing up front, and the offline render for export
 * simply schedules every step at once.
 *
 * Everything downstream of a deck's stem separator is automated directly on mix
 * time, because Deck.start already offsets the source by the separator's
 * latency. Only pre-separator targets (playback rate) need compensating, which
 * Deck reports via `isPreSeparator`.
 */

import { clamp } from "../analysis/dsp";
import { STEMS } from "../types";
import type { AutomationLane, MixPlan, MixStep, Transition } from "../types";
import { Deck, type DeckOptions, Master } from "./graph";
import { HP_OPEN, LP_OPEN } from "./transitions";

/** Neutral state every deck is put into before its lanes are applied. */
const DEFAULTS: [string, number][] = [
  ["gain", 1],
  ["highpass", HP_OPEN],
  ["lowpass", LP_OPEN],
  ["eq.low", 0],
  ["eq.mid", 0],
  ["eq.high", 0],
  ["echo", 0],
  ...STEMS.map((s) => [`stem.${s}`, 1] as [string, number]),
];

export interface ScheduledStep {
  step: MixStep;
  deck: Deck;
}

export interface MixerOptions extends DeckOptions {
  /** true when driving an OfflineAudioContext: no wall-clock timers are used */
  offline: boolean;
}

export interface MixerCallbacks {
  /** Resolve a decoded buffer for a track; may be async in the live engine. */
  getBuffer(trackId: string): AudioBuffer | undefined;
  /** Ask the host to have a buffer ready soon. */
  prefetch?(trackId: string): void;
  onStepStart?(step: MixStep): void;
  onStepEnd?(step: MixStep): void;
}

/** How far ahead of the playhead the live scheduler works, in seconds. */
export const LOOKAHEAD = 10;
/** How far ahead buffers are requested. */
const PREFETCH = 45;
/** Length of a loop-roll hold, in bars. */
const LOOP_BARS = 4;
/** Extra time a deck is kept alive after its blend, so the echo tail rings out. */
const TAIL = 2.5;

export class Mixer {
  readonly ctx: BaseAudioContext;
  readonly master: Master;

  private plan: MixPlan | null = null;
  private readonly options: MixerOptions;
  private readonly callbacks: MixerCallbacks;
  private readonly active = new Map<number, ScheduledStep>();
  private readonly scheduled = new Set<number>();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  /** context time corresponding to mix time 0 */
  private origin = 0;

  constructor(
    ctx: BaseAudioContext,
    master: Master,
    callbacks: MixerCallbacks,
    options: Partial<MixerOptions> = {},
  ) {
    this.ctx = ctx;
    this.master = master;
    this.callbacks = callbacks;
    this.options = { useStems: true, offline: false, ...options };
  }

  setPlan(plan: MixPlan): void {
    this.reset();
    this.plan = plan;
  }

  /** Anchor mix time 0 to a context time. */
  setOrigin(contextTime: number): void {
    this.origin = contextTime;
  }

  get mixOrigin(): number {
    return this.origin;
  }

  /** Current mix-time position. */
  position(): number {
    return this.ctx.currentTime - this.origin;
  }

  activeSteps(): ScheduledStep[] {
    return [...this.active.values()].sort((a, b) => a.step.index - b.step.index);
  }

  /** The step that should be sounding at a mix time, for seeking and the UI. */
  stepAt(mixTime: number): MixStep | null {
    if (!this.plan) return null;
    let found: MixStep | null = null;
    for (const s of this.plan.steps) {
      if (s.startAt <= mixTime) found = s;
      else break;
    }
    return found;
  }

  /**
   * Schedule everything that begins before `untilMixTime`. Called repeatedly by
   * the live transport, and once with the full duration for an offline render.
   */
  pump(untilMixTime: number): void {
    if (!this.plan) return;
    for (const step of this.plan.steps) {
      if (step.startAt > untilMixTime) {
        if (step.startAt <= untilMixTime + PREFETCH) this.callbacks.prefetch?.(step.trackId);
        continue;
      }
      if (this.scheduled.has(step.index)) continue;
      // A step whose whole slot is already behind the playhead is skipped, which
      // is what happens after a seek.
      if (step.endAt + TAIL < this.position()) {
        this.scheduled.add(step.index);
        continue;
      }
      this.scheduleStep(step);
    }
  }

  private scheduleStep(step: MixStep): void {
    const buffer = this.callbacks.getBuffer(step.trackId);
    if (!buffer) {
      // Not decoded yet; try again on the next pump.
      this.callbacks.prefetch?.(step.trackId);
      return;
    }
    this.scheduled.add(step.index);

    const deck = new Deck(this.ctx, this.options);
    deck.setBuffer(buffer);
    deck.setTrimDb(step.gainDb);
    deck.connect(this.master.input);

    const startCtx = this.origin + step.startAt;
    // If we are mid-step (after a seek), pick up the track where it should be.
    const now = this.ctx.currentTime;
    let offset = step.trackOffset;
    let startWhen = startCtx;
    if (startCtx < now) {
      offset += (now - startCtx) * step.rateIn;
      startWhen = now;
    }

    const echoBeats = 0.75; // dotted eighth
    const mixBpm = step.transitionOut?.mixBpm ?? step.transitionIn?.mixBpm ?? 120;
    deck.setEchoTime((echoBeats * 60) / mixBpm);

    // Looping has to be set up before the source starts. Playback runs
    // linearly into the loop region and only then begins repeating, so this
    // reproduces a loop roll without any wall-clock timer, which means the
    // offline render behaves exactly like live playback.
    const loopLane = step.transitionOut?.lanes.find((l) => l.target === "a.loop");
    if (loopLane && step.transitionOut) {
      const secondsPerBeat = 60 / step.transitionOut.mixBpm;
      // Four bars of the outgoing track, measured in its own timeline.
      const loopSeconds = LOOP_BARS * 4 * secondsPerBeat * step.rateOut;
      const end = Math.min(deck.bufferDuration, step.exitTime + loopSeconds);
      if (end > step.exitTime + 0.1) deck.prepareLoop(step.exitTime, end);
    }

    deck.start(startWhen, offset, step.rateIn);

    // Neutral state first, so lanes that start from 0 are not fighting a
    // previously-set value.
    for (const [target, value] of DEFAULTS) {
      const p = deck.param(target);
      if (!p) continue;
      p.param.cancelScheduledValues(startWhen);
      p.param.setValueAtTime(value, Math.max(now, startWhen - 0.001));
    }

    // Tempo glide from the incoming blend's rate to this track's own.
    if (step.rampSeconds > 0) {
      const rateParam = deck.param("rate");
      if (rateParam) {
        const at = this.origin + step.rampAt - deck.latency;
        rateParam.param.setValueAtTime(step.rateIn, Math.max(now, at));
        rateParam.param.linearRampToValueAtTime(
          step.rateOut,
          Math.max(now, at) + step.rampSeconds,
        );
      }
    }

    // Inbound blend: this deck is the "b" side.
    if (step.transitionIn) {
      this.applyLanes(deck, step.transitionIn, "b.", this.origin + step.startAt);
    }
    // Outbound blend: this deck is the "a" side.
    if (step.transitionOut) {
      this.applyLanes(deck, step.transitionOut, "a.", this.origin + step.transitionStartAt);
    }

    deck.stop(this.origin + step.endAt + TAIL);

    this.active.set(step.index, { step, deck });
    this.callbacks.onStepStart?.(step);

    // Tear the deck down once it has finished sounding. An offline render has
    // no wall clock to hang this on, and nothing to reclaim before it finishes.
    if (!this.options.offline) {
      const lifetime = (this.origin + step.endAt + TAIL - now) * 1000;
      const timer = setTimeout(() => {
        deck.dispose();
        this.active.delete(step.index);
        this.callbacks.onStepEnd?.(step);
      }, Math.max(0, lifetime) + 250);
      this.timers.push(timer);
    }
  }

  private applyLanes(deck: Deck, transition: Transition, prefix: string, anchor: number): void {
    const secondsPerBeat = 60 / transition.mixBpm;
    for (const lane of transition.lanes) {
      if (!lane.target.startsWith(prefix)) continue;
      const target = lane.target.slice(prefix.length);
      if (target === "loop") continue; // handled separately, not an AudioParam
      const p = deck.param(target);
      if (!p) continue;
      const offset = Deck.isPreSeparator(target) ? -deck.latency : 0;
      this.scheduleLane(p.param, p.kind, lane, anchor + offset, secondsPerBeat);
    }
  }

  private scheduleLane(
    param: AudioParam,
    kind: "linear" | "frequency" | "db",
    lane: AutomationLane,
    anchor: number,
    secondsPerBeat: number,
  ): void {
    const now = this.ctx.currentTime;
    const pts = lane.points;
    if (!pts.length) return;
    const firstAt = Math.max(now, anchor + pts[0].beat * secondsPerBeat);
    param.cancelScheduledValues(firstAt);
    param.setValueAtTime(pts[0].value, firstAt);
    for (let i = 1; i < pts.length; i++) {
      const at = anchor + pts[i].beat * secondsPerBeat;
      if (at <= now) {
        param.setValueAtTime(pts[i].value, now);
        continue;
      }
      if (kind === "frequency") {
        // Frequency sweeps have to be exponential to sound linear.
        param.exponentialRampToValueAtTime(clamp(pts[i].value, 20, 20000), at);
      } else {
        param.linearRampToValueAtTime(pts[i].value, at);
      }
    }
  }

  /** Live user override on whichever deck is currently the "a" or "b" side. */
  overrideDeck(stepIndex: number, target: string, value: number): void {
    this.active.get(stepIndex)?.deck.setNow(target, value);
  }

  reset(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
    for (const { deck } of this.active.values()) deck.dispose();
    this.active.clear();
    this.scheduled.clear();
  }
}
