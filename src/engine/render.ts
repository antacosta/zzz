/**
 * Offline render of a whole mix to a WAV file.
 *
 * A long set will not fit in memory if every decoded track is resident at once,
 * so the render drives the OfflineAudioContext in chunks: `suspend(when)`
 * pauses rendering at a known point, which is the one moment we can safely
 * decode the tracks coming up and release the ones already played, and then
 * `resume()` continues. Memory stays proportional to the window, not the set.
 */

import type { MixPlan } from "../types";
import { Master, loadStemWorklet } from "./graph";
import { Mixer } from "./mixer";
import type { TrackStore } from "./store";
import { audioBufferToWav } from "./wav";

/** Render window: how far ahead tracks are decoded and scheduled. */
const CHUNK_SECONDS = 30;
/** Tail so the last blend and its echo finish inside the file. */
const TAIL_SECONDS = 4;

export interface RenderProgress {
  (fraction: number, stage: string): void;
}

export interface RenderResult {
  blob: Blob;
  duration: number;
  sampleRate: number;
}

export async function renderMixToWav(
  plan: MixPlan,
  store: TrackStore,
  sampleRate = 44100,
  onProgress: RenderProgress = () => {},
): Promise<RenderResult> {
  if (!plan.steps.length) throw new Error("nothing to render");

  const duration = plan.totalDuration + TAIL_SECONDS;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil(duration * sampleRate),
    sampleRate,
  });

  const stems = await loadStemWorklet(ctx);
  const master = new Master(ctx);
  master.output.connect(ctx.destination);

  // The offline context has its own sample rate, so it needs its own decodes.
  const buffers = new Map<string, AudioBuffer>();
  const decoding = new Map<string, Promise<void>>();

  const decode = (trackId: string): Promise<void> => {
    if (buffers.has(trackId)) return Promise.resolve();
    const existing = decoding.get(trackId);
    if (existing) return existing;
    const track = store.get(trackId);
    if (!track) return Promise.resolve();
    const promise = (async () => {
      const bytes = await track.file.arrayBuffer();
      buffers.set(trackId, await ctx.decodeAudioData(bytes));
    })();
    decoding.set(trackId, promise);
    return promise;
  };

  const mixer = new Mixer(
    ctx,
    master,
    { getBuffer: (id) => buffers.get(id) },
    { useStems: stems, offline: true },
  );
  mixer.setOrigin(0);
  mixer.setPlan(plan);

  /** Decode everything starting inside [from, to], and drop what is done with. */
  const prepare = async (from: number, to: number): Promise<void> => {
    await Promise.all(
      plan.steps
        .filter((s) => s.startAt <= to && s.endAt + TAIL_SECONDS >= from)
        .map((s) => decode(s.trackId)),
    );
    for (const step of plan.steps) {
      if (step.endAt + TAIL_SECONDS < from && buffers.has(step.trackId)) {
        // Only release a track that no later step still needs.
        const neededLater = plan.steps.some(
          (s) => s.trackId === step.trackId && s.endAt + TAIL_SECONDS >= from,
        );
        if (!neededLater) {
          buffers.delete(step.trackId);
          decoding.delete(step.trackId);
        }
      }
    }
  };

  onProgress(0, "decoding");
  await prepare(0, CHUNK_SECONDS * 2);
  mixer.pump(CHUNK_SECONDS * 2);

  // Arm the suspend points before rendering starts.
  const stops: number[] = [];
  for (let t = CHUNK_SECONDS; t < duration; t += CHUNK_SECONDS) stops.push(t);

  const suspensions = stops.map((t) => ({ at: t, promise: ctx.suspend(t) }));
  const rendering = ctx.startRendering();

  for (const { at, promise } of suspensions) {
    await promise;
    onProgress(Math.min(0.97, at / duration), "rendering");
    await prepare(at, at + CHUNK_SECONDS * 2);
    mixer.pump(at + CHUNK_SECONDS * 2);
    void ctx.resume();
  }

  const rendered = await rendering;
  onProgress(0.98, "writing wav");
  const blob = audioBufferToWav(rendered);
  onProgress(1, "done");

  return { blob, duration: rendered.duration, sampleRate };
}
