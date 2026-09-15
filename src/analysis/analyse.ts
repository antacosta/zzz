/**
 * Full-track analysis pipeline. Runs inside the analysis worker.
 *
 * Everything downstream of decoding works on a 22.05 kHz mono (or mid/side)
 * signal: it halves the STFT cost with no measurable loss for tempo, key,
 * structure or vocal detection, while loudness and stereo measurements still
 * use the original full-rate samples because the standards require it.
 */

import type { Timelines, TrackAnalysis } from "../types";
import { clamp, mean, resample, stft } from "./dsp";
import { CHROMA_FFT_SIZE, CHROMA_HOP, alignChroma, chromagram, estimateKey, tonalFlux } from "./key";
import { measureLoudness } from "./loudness";
import { bandTimelines, energyTimeline, spectralProfile, stereoProfile } from "./spectral";
import { hpss, rhythmProfile, vocalTimeline } from "./stems";
import { findCues, segment } from "./structure";
import { buildGrid, onsetEnvelope } from "./tempo";

const ANALYSIS_RATE = 22050;
const FFT_SIZE = 2048;
const HOP = 512;

export interface RawTrack {
  id: string;
  name: string;
  sampleRate: number;
  channels: Float32Array[];
}

export type ProgressFn = (stage: string, fraction: number) => void;

export function analyseTrack(raw: RawTrack, onProgress: ProgressFn = () => {}): TrackAnalysis {
  const started = Date.now();
  const { channels, sampleRate } = raw;
  const duration = channels[0].length / sampleRate;
  const isStereo = channels.length >= 2;

  onProgress("loudness", 0.05);
  const loudness = measureLoudness(channels, sampleRate);
  const stereo = stereoProfile(channels, sampleRate);

  // Mid/side at the analysis rate. Mid drives every feature; side is only used
  // for the centre-channel cue in vocal detection.
  onProgress("resampling", 0.18);
  const midFull = new Float32Array(channels[0].length);
  const sideFull = new Float32Array(channels[0].length);
  if (isStereo) {
    const [l, r] = channels;
    for (let i = 0; i < midFull.length; i++) {
      midFull[i] = (l[i] + r[i]) * 0.5;
      sideFull[i] = (l[i] - r[i]) * 0.5;
    }
  } else {
    midFull.set(channels[0]);
  }
  const mid = resample(midFull, sampleRate, ANALYSIS_RATE);
  const side = isStereo ? resample(sideFull, sampleRate, ANALYSIS_RATE) : mid;

  onProgress("spectrogram", 0.28);
  const midSpec = stft(mid, ANALYSIS_RATE, FFT_SIZE, HOP);
  const sideSpec = isStereo ? stft(side, ANALYSIS_RATE, FFT_SIZE, HOP) : midSpec;

  onProgress("spectral features", 0.42);
  const bandTl = bandTimelines(midSpec);
  const spectral = spectralProfile(midSpec, bandTl);
  const energy = energyTimeline(bandTl);

  onProgress("tempo & beats", 0.52);
  const { onset, lowOnset } = onsetEnvelope(midSpec);
  const grid = buildGrid(midSpec, onset, lowOnset, energy);

  onProgress("harmonic analysis", 0.64);
  // Chroma uses a long window for semitone resolution, then gets mapped back
  // onto the main frame grid so every timeline shares one frame rate.
  const chromaSpec = stft(mid, ANALYSIS_RATE, CHROMA_FFT_SIZE, CHROMA_HOP);
  const chromaCoarse = chromagram(chromaSpec);
  const key = estimateKey(chromaCoarse);
  const chroma = alignChroma(chromaCoarse, CHROMA_HOP, HOP, midSpec.frames.length);
  const flux = tonalFlux(chroma);

  onProgress("source separation", 0.74);
  const h = hpss(midSpec);
  const vocal = vocalTimeline(midSpec, sideSpec, h.harmonic, isStereo);
  const rhythm = rhythmProfile(onset, grid.beats, midSpec.frameRate, h.percussiveRatio);

  const timelines: Timelines = {
    frameRate: midSpec.frameRate,
    energy,
    onset,
    vocal,
    percussive: h.percussive,
    bands: bandTl.bands,
    centroid: bandTl.centroid,
    tonalFlux: flux,
  };

  onProgress("structure", 0.86);
  const { sections } = segment(grid, timelines, chroma, duration);
  const cues = findCues(grid, timelines, sections, duration);

  const energyScore = clamp(
    0.5 * mean(Array.from(energy)) +
      0.3 * clamp((loudness.integratedLufs + 20) / 14, 0, 1) +
      0.2 * rhythm.danceability,
    0, 1,
  );

  // Mixability: stable tempo, confident grid, a usable intro/outro and a key we
  // actually believe. These are the properties that make a track forgiving.
  const hasMixIn = cues.some((c) => c.kind === "mix-in");
  const hasMixOut = cues.some((c) => c.kind === "mix-out");
  const mixability = clamp(
    0.30 * grid.tempoConfidence +
      0.25 * grid.beatConfidence +
      0.15 * key.confidence +
      0.10 * key.tonalStability +
      0.10 * rhythm.pulseClarity +
      0.05 * (hasMixIn ? 1 : 0) +
      0.05 * (hasMixOut ? 1 : 0),
    0, 1,
  );

  onProgress("done", 1);

  return {
    id: raw.id,
    name: raw.name,
    duration,
    sampleRate,
    channels: channels.length,
    grid,
    key,
    loudness,
    spectral,
    stereo,
    rhythm,
    sections,
    cues,
    timelines,
    energyScore: Math.round(energyScore * 1000) / 1000,
    mixability: Math.round(mixability * 1000) / 1000,
    vocalDensity: Math.round(mean(Array.from(vocal)) * 1000) / 1000,
    analysisMs: Date.now() - started,
  };
}
