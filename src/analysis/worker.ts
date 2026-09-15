/// <reference lib="webworker" />
/**
 * Analysis worker. Receives decoded PCM, returns a full TrackAnalysis.
 * Decoding happens on the main thread (OfflineAudioContext is not available in
 * every worker scope), so what crosses the boundary here is raw Float32Arrays.
 */

import { analyseTrack, type RawTrack } from "./analyse";

export interface AnalyseRequest {
  type: "analyse";
  id: string;
  name: string;
  sampleRate: number;
  channels: Float32Array[];
}

export type WorkerMessage =
  | { type: "progress"; id: string; stage: string; fraction: number }
  | { type: "result"; id: string; analysis: unknown }
  | { type: "error"; id: string; message: string };

self.onmessage = (ev: MessageEvent<AnalyseRequest>) => {
  const req = ev.data;
  if (req.type !== "analyse") return;
  const raw: RawTrack = {
    id: req.id,
    name: req.name,
    sampleRate: req.sampleRate,
    channels: req.channels,
  };
  try {
    const analysis = analyseTrack(raw, (stage, fraction) => {
      const msg: WorkerMessage = { type: "progress", id: req.id, stage, fraction };
      self.postMessage(msg);
    });
    const msg: WorkerMessage = { type: "result", id: req.id, analysis };
    self.postMessage(msg);
  } catch (err) {
    const msg: WorkerMessage = {
      type: "error",
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(msg);
  }
};
