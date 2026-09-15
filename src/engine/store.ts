/**
 * The track library: files in, decoded buffers and analyses out.
 *
 * Analysis runs on a pool of workers so dropping in a dozen files uses every
 * core rather than blocking the UI on one. Decoded buffers are large (a
 * five-minute stereo track is around 100 MB of float samples), so the store
 * keeps only a handful in memory and re-decodes from the original File when an
 * evicted track is needed again. Analyses are small and kept forever.
 */

import type { TrackAnalysis } from "../types";
import type { AnalyseRequest, WorkerMessage } from "../analysis/worker";

export type TrackState = "queued" | "decoding" | "analysing" | "ready" | "error";

export interface LibraryTrack {
  id: string;
  name: string;
  file: File;
  state: TrackState;
  stage: string;
  progress: number;
  analysis?: TrackAnalysis;
  error?: string;
  /** excluded from the mix by the user */
  disabled: boolean;
}

/** How many decoded buffers to hold at once. */
const BUFFER_CACHE_SIZE = 5;

export class TrackStore {
  private readonly tracks = new Map<string, LibraryTrack>();
  private readonly order: string[] = [];
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly bufferLru: string[] = [];
  private readonly decoding = new Map<string, Promise<AudioBuffer>>();
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, Worker>();
  private nextId = 1;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly onChange: (track: LibraryTrack) => void,
    workerCount = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)),
  ) {
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL("../analysis/worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (ev: MessageEvent<WorkerMessage>) => this.onWorkerMessage(worker, ev.data);
      worker.onerror = (ev) => this.onWorkerError(worker, ev.message);
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  list(): LibraryTrack[] {
    return this.order.map((id) => this.tracks.get(id)!).filter(Boolean);
  }

  get(id: string): LibraryTrack | undefined {
    return this.tracks.get(id);
  }

  /** Every track that is analysed and not excluded. */
  ready(): TrackAnalysis[] {
    return this.list()
      .filter((t) => t.state === "ready" && !t.disabled && t.analysis)
      .map((t) => t.analysis!);
  }

  add(files: File[]): LibraryTrack[] {
    const added: LibraryTrack[] = [];
    for (const file of files) {
      const id = `t${this.nextId++}`;
      const track: LibraryTrack = {
        id,
        name: file.name.replace(/\.[^.]+$/, ""),
        file,
        state: "queued",
        stage: "queued",
        progress: 0,
        disabled: false,
      };
      this.tracks.set(id, track);
      this.order.push(id);
      this.queue.push(id);
      added.push(track);
      this.onChange(track);
    }
    void this.drain();
    return added;
  }

  remove(id: string): void {
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    this.tracks.delete(id);
    this.buffers.delete(id);
    const lruIdx = this.bufferLru.indexOf(id);
    if (lruIdx >= 0) this.bufferLru.splice(lruIdx, 1);
  }

  setDisabled(id: string, disabled: boolean): void {
    const track = this.tracks.get(id);
    if (!track) return;
    track.disabled = disabled;
    this.onChange(track);
  }

  getBuffer(id: string): AudioBuffer | undefined {
    const buffer = this.buffers.get(id);
    if (buffer) this.touch(id);
    return buffer;
  }

  /** Decode if needed. Safe to call repeatedly; concurrent calls share a promise. */
  async ensureBuffer(id: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(id);
    if (cached) {
      this.touch(id);
      return cached;
    }
    const inFlight = this.decoding.get(id);
    if (inFlight) return inFlight;

    const track = this.tracks.get(id);
    if (!track) throw new Error(`unknown track ${id}`);

    const promise = (async () => {
      const bytes = await track.file.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(bytes);
      this.buffers.set(id, buffer);
      this.touch(id);
      this.evict();
      return buffer;
    })();
    this.decoding.set(id, promise);
    try {
      return await promise;
    } finally {
      this.decoding.delete(id);
    }
  }

  /** Fire-and-forget decode so a buffer is ready before the mixer needs it. */
  prefetch(id: string): void {
    if (this.buffers.has(id) || this.decoding.has(id)) return;
    void this.ensureBuffer(id).catch(() => {
      /* the mixer will report the gap */
    });
  }

  /** Buffers currently resident, for the UI's memory readout. */
  cacheBytes(): number {
    let total = 0;
    for (const b of this.buffers.values()) {
      total += b.length * b.numberOfChannels * 4;
    }
    return total;
  }

  private touch(id: string): void {
    const idx = this.bufferLru.indexOf(id);
    if (idx >= 0) this.bufferLru.splice(idx, 1);
    this.bufferLru.push(id);
  }

  private evict(): void {
    while (this.bufferLru.length > BUFFER_CACHE_SIZE) {
      const id = this.bufferLru.shift()!;
      this.buffers.delete(id);
    }
  }

  /** Hand queued tracks to idle workers. */
  private async drain(): Promise<void> {
    while (this.queue.length && this.idle.length) {
      const id = this.queue.shift()!;
      const track = this.tracks.get(id);
      if (!track) continue;
      const worker = this.idle.shift()!;
      this.pending.set(id, worker);

      track.state = "decoding";
      track.stage = "decoding";
      this.onChange(track);

      try {
        const buffer = await this.ensureBuffer(id);
        // The worker takes ownership of these copies, so the AudioBuffer we
        // keep for playback is untouched.
        const channels: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          channels.push(buffer.getChannelData(c).slice());
        }
        track.state = "analysing";
        track.stage = "analysing";
        track.progress = 0.02;
        this.onChange(track);

        const request: AnalyseRequest = {
          type: "analyse",
          id,
          name: track.name,
          sampleRate: buffer.sampleRate,
          channels,
        };
        worker.postMessage(request, channels.map((c) => c.buffer));
      } catch (err) {
        track.state = "error";
        track.error = err instanceof Error ? err.message : String(err);
        track.stage = "failed";
        this.onChange(track);
        this.pending.delete(id);
        this.idle.push(worker);
        void this.drain();
      }
    }
  }

  private onWorkerMessage(worker: Worker, msg: WorkerMessage): void {
    const track = this.tracks.get(msg.id);
    if (!track) return;
    if (msg.type === "progress") {
      track.stage = msg.stage;
      track.progress = msg.fraction;
      this.onChange(track);
      return;
    }
    if (msg.type === "result") {
      track.analysis = reviveAnalysis(msg.analysis);
      track.name = track.analysis.name;
      track.state = "ready";
      track.stage = "ready";
      track.progress = 1;
    } else {
      track.state = "error";
      track.error = msg.message;
      track.stage = "failed";
    }
    this.onChange(track);
    this.pending.delete(msg.id);
    this.idle.push(worker);
    void this.drain();
  }

  private onWorkerError(worker: Worker, message: string): void {
    // Attribute the failure to whatever that worker was holding.
    for (const [id, w] of this.pending) {
      if (w !== worker) continue;
      const track = this.tracks.get(id);
      if (track) {
        track.state = "error";
        track.error = message;
        track.stage = "failed";
        this.onChange(track);
      }
      this.pending.delete(id);
    }
    this.idle.push(worker);
    void this.drain();
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.buffers.clear();
    this.bufferLru.length = 0;
  }
}

/**
 * Structured clone turns the analysis's typed arrays back into typed arrays but
 * `unknown` loses the types, so this re-asserts the shape in one place.
 */
function reviveAnalysis(raw: unknown): TrackAnalysis {
  return raw as TrackAnalysis;
}
