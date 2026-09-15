/**
 * Live transport: owns the AudioContext, drives the lookahead scheduler, and
 * handles play/pause/seek/skip plus live recording of the output.
 *
 * Pause suspends the context rather than tearing anything down. Suspending
 * freezes the context clock, so every piece of scheduled automation stays
 * exactly where it was and resuming continues the mix mid-blend.
 */

import type { MixPlan, MixStep } from "../types";
import { Master, loadStemWorklet } from "./graph";
import { LOOKAHEAD, Mixer, type ScheduledStep } from "./mixer";
import type { TrackStore } from "./store";

export interface TransportState {
  playing: boolean;
  position: number;
  duration: number;
  activeSteps: ScheduledStep[];
  /** the step that owns the floor; mid-blend this is the outgoing track */
  currentStep: MixStep | null;
  recording: boolean;
  stemsAvailable: boolean;
}

const SCHEDULE_INTERVAL_MS = 250;

export class Transport {
  ctx: AudioContext | null = null;
  master: Master | null = null;
  mixer: Mixer | null = null;
  stemsAvailable = false;

  private plan: MixPlan | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private recorder: MediaRecorder | null = null;
  private recorderTap: MediaStreamAudioDestinationNode | null = null;
  private recordedChunks: Blob[] = [];
  private pausedPosition = 0;
  private running = false;

  constructor(private readonly store: TrackStore) {}

  /** Create the context and load the stem worklet. Must follow a user gesture. */
  async init(): Promise<void> {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.stemsAvailable = await loadStemWorklet(ctx);
    const master = new Master(ctx);
    master.output.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.mixer = new Mixer(
      ctx,
      master,
      {
        getBuffer: (id) => this.store.getBuffer(id),
        prefetch: (id) => this.store.prefetch(id),
      },
      { useStems: this.stemsAvailable, offline: false },
    );
    // A plan set before the context existed has to be handed over now.
    if (this.plan) this.mixer.setPlan(this.plan);
  }

  get isReady(): boolean {
    return this.ctx !== null;
  }

  setPlan(plan: MixPlan): void {
    this.plan = plan;
    this.pausedPosition = 0;
    if (this.mixer) this.mixer.setPlan(plan);
  }

  async play(): Promise<void> {
    await this.init();
    if (!this.ctx || !this.mixer || !this.plan) return;
    // Parked at the end of the set: start it again from the top rather than
    // sitting there doing nothing, which is what pressing play there means.
    // This cannot test `running`, because a pause deliberately leaves that set
    // so that resuming continues mid-blend.
    if (this.pausedPosition >= this.plan.totalDuration - 0.01) {
      this.pausedPosition = 0;
      this.running = false;
      this.mixer.reset();
      this.mixer.setPlan(this.plan);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (!this.running) {
      this.mixer.setOrigin(this.ctx.currentTime - this.pausedPosition);
      this.running = true;
    }
    this.startScheduler();
  }

  async pause(): Promise<void> {
    if (!this.ctx || !this.mixer) return;
    this.pausedPosition = this.mixer.position();
    await this.ctx.suspend();
    this.stopScheduler();
  }

  async toggle(): Promise<void> {
    if (this.isPlaying) await this.pause();
    else await this.play();
  }

  get isPlaying(): boolean {
    return this.ctx?.state === "running" && this.running;
  }

  /** Rebuild the graph from a new position. */
  async seek(mixTime: number): Promise<void> {
    await this.init();
    if (!this.ctx || !this.mixer || !this.plan) return;
    const target = Math.max(0, Math.min(mixTime, this.plan.totalDuration));
    const wasPlaying = this.isPlaying;
    this.mixer.reset();
    this.mixer.setPlan(this.plan);
    this.pausedPosition = target;
    this.running = false;
    if (wasPlaying) await this.play();
    else {
      this.mixer.setOrigin(this.ctx.currentTime - target);
      this.mixer.pump(target + LOOKAHEAD);
    }
  }

  /**
   * Jump to the next blend, the way a DJ would cut a track short. During the
   * final track there is nothing to skip to, and jumping to the end of the set
   * would just land on silence, so this does nothing instead.
   */
  async skipNext(): Promise<void> {
    if (!this.plan || !this.mixer) return;
    const pos = this.position();
    const next = this.plan.steps.find(
      (s) => s.transitionOut !== null && s.transitionStartAt > pos + 0.5,
    );
    if (!next) return;
    await this.seek(next.transitionStartAt);
  }

  async skipPrevious(): Promise<void> {
    if (!this.plan) return;
    const pos = this.position();
    // Back to the start of the current step, or the previous one if we just got here.
    const current = [...this.plan.steps].reverse().find((s) => s.startAt <= pos - 1.5);
    const prior = current
      ? [...this.plan.steps].reverse().find((s) => s.startAt < current.startAt - 1.5)
      : undefined;
    await this.seek((pos - (current?.startAt ?? 0) < 5 ? prior ?? current : current)?.startAt ?? 0);
  }

  position(): number {
    if (!this.mixer) return this.pausedPosition;
    const raw = this.isPlaying ? Math.max(0, this.mixer.position()) : this.pausedPosition;
    // Never report past the end of the set: the context clock keeps running
    // after the last deck has finished, and a readout that climbs past the
    // total is just wrong.
    return this.plan ? Math.min(raw, this.plan.totalDuration) : raw;
  }

  state(): TransportState {
    const position = this.position();
    return {
      playing: this.isPlaying,
      position,
      duration: this.plan?.totalDuration ?? 0,
      activeSteps: this.mixer?.activeSteps() ?? [],
      currentStep: this.mixer?.floorStep(position) ?? null,
      recording: this.recorder?.state === "recording",
      stemsAvailable: this.stemsAvailable,
    };
  }

  /** Live user override on a currently-playing deck. */
  override(stepIndex: number, target: string, value: number): void {
    this.mixer?.overrideDeck(stepIndex, target, value);
  }

  setMasterTrimDb(db: number): void {
    this.master?.setTrimDb(db);
  }

  /**
   * Record the live output. This captures whatever is actually played,
   * including live overrides, at bounded memory cost, which is what makes it
   * usable for a set of any length.
   */
  startRecording(): boolean {
    if (!this.ctx || !this.master || this.recorder) return false;
    if (typeof MediaRecorder === "undefined") return false;
    const tap = this.ctx.createMediaStreamDestination();
    this.master.output.connect(tap);
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
      (t) => MediaRecorder.isTypeSupported(t),
    );
    const recorder = new MediaRecorder(tap.stream, mimeType ? { mimeType } : undefined);
    this.recordedChunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.recordedChunks.push(ev.data);
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.recorderTap = tap;
    return true;
  }

  async stopRecording(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await done;
    const type = recorder.mimeType || "audio/webm";
    const blob = new Blob(this.recordedChunks, { type });
    this.master?.output.disconnect(this.recorderTap!);
    this.recorder = null;
    this.recorderTap = null;
    this.recordedChunks = [];
    return blob;
  }

  private startScheduler(): void {
    if (this.interval !== null) return;
    const tick = () => {
      if (!this.mixer) return;
      const position = this.mixer.position();
      // The set is over: stop rather than leaving the clock running on silence.
      if (this.plan && position >= this.plan.totalDuration) {
        void this.pause().then(() => {
          this.pausedPosition = this.plan?.totalDuration ?? 0;
        });
        return;
      }
      this.mixer.pump(position + LOOKAHEAD);
    };
    tick();
    this.interval = setInterval(tick, SCHEDULE_INTERVAL_MS);
  }

  private stopScheduler(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopScheduler();
    this.mixer?.reset();
    await this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.mixer = null;
  }
}
