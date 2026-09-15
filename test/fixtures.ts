/**
 * Synthetic TrackAnalysis fixtures for planner and transition tests.
 * Building these directly (rather than analysing audio) keeps the tests fast
 * and lets each case pin down exactly the measurements it cares about.
 */

import { camelotFor } from "../src/analysis/key";
import type { CuePoint, Section, TrackAnalysis, Timelines } from "../src/types";
import { BAND_NAMES } from "../src/types";

export interface FixtureSpec {
  id: string;
  name: string;
  bpm: number;
  duration: number;
  /** 0 = C, 11 = B */
  tonic: number;
  mode: "major" | "minor";
  energy: number;
  /** mean vocal presence */
  vocalDensity: number;
  /** where the vocal sits: "none" | "throughout" | "second-half" */
  vocalShape?: "none" | "throughout" | "second-half";
  /** insert a drop cue at this time */
  dropAt?: number;
  /** add a stable-groove loop cue at this time */
  loopAt?: number;
  brightness?: number;
  mixability?: number;
  phraseBars?: number;
}

const FRAME_RATE = 512 / 22050;

export function makeAnalysis(spec: FixtureSpec): TrackAnalysis {
  const meter = 4;
  const beatSeconds = 60 / spec.bpm;
  const beatCount = Math.floor(spec.duration / beatSeconds);
  const beats = new Float32Array(beatCount);
  for (let i = 0; i < beatCount; i++) beats[i] = i * beatSeconds;
  const downbeatList: number[] = [];
  for (let i = 0; i < beatCount; i += meter) downbeatList.push(beats[i]);
  const downbeats = Float32Array.from(downbeatList);
  const phraseBars = spec.phraseBars ?? 8;
  const phraseList: number[] = [];
  for (let i = 0; i < downbeats.length; i += phraseBars) phraseList.push(downbeats[i]);

  const frames = Math.max(8, Math.floor(spec.duration / FRAME_RATE));
  const energy = new Float32Array(frames);
  const vocal = new Float32Array(frames);
  const percussive = new Float32Array(frames);
  const onset = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const tonalFlux = new Float32Array(frames);
  const shape = spec.vocalShape ?? (spec.vocalDensity > 0.2 ? "throughout" : "none");

  for (let f = 0; f < frames; f++) {
    const x = f / frames;
    // Quiet intro, body, short outro: enough structure for the cue finder.
    const envelope = x < 0.08 ? x / 0.08 : x > 0.92 ? (1 - x) / 0.08 : 1;
    energy[f] = Math.min(1, spec.energy * envelope);
    percussive[f] = 0.55 * envelope;
    onset[f] = 0.5 * envelope;
    centroid[f] = 2000 + 1500 * (spec.brightness ?? 0.2);
    tonalFlux[f] = 0.1;
    if (shape === "throughout") vocal[f] = spec.vocalDensity * envelope;
    else if (shape === "second-half") vocal[f] = x > 0.5 ? spec.vocalDensity * 1.6 * envelope : 0.02;
    else vocal[f] = 0.03;
  }

  const bands = BAND_NAMES.map((_, i) =>
    Float32Array.from({ length: frames }, () => -20 - i * 2 + spec.energy * 10),
  );

  const timelines: Timelines = {
    frameRate: FRAME_RATE,
    frameOffset: 2048 / 2 / 22050,
    energy, onset, vocal, percussive, bands, centroid, tonalFlux,
  };

  const barSeconds = beatSeconds * meter;
  const snapBar = (t: number) => {
    let best = downbeats.length ? downbeats[0] : 0;
    for (const d of downbeats) if (Math.abs(d - t) < Math.abs(best - t)) best = d;
    return best;
  };
  const snapPhrase = (t: number) => {
    let best = phraseList.length ? phraseList[0] : 0;
    for (const p of phraseList) if (Math.abs(p - t) < Math.abs(best - t)) best = p;
    return best;
  };

  const cues: CuePoint[] = [
    { time: snapPhrase(spec.duration * 0.1), bar: 0, kind: "mix-in", score: 0.9, label: "beat establishes" },
    { time: snapPhrase(spec.duration * 0.8), bar: 0, kind: "mix-out", score: 0.85, label: "energy ramps down" },
  ];
  if (spec.dropAt !== undefined) {
    cues.push({ time: snapBar(spec.dropAt), bar: 0, kind: "drop", score: 0.9, label: "drop" });
  }
  if (spec.loopAt !== undefined) {
    cues.push({ time: snapPhrase(spec.loopAt), bar: 0, kind: "loop", score: 0.7, label: "8-bar groove" });
  }
  if (shape === "second-half") {
    cues.push({
      time: snapBar(spec.duration * 0.5), bar: 0, kind: "vocal-in", score: 0.7, label: "vocal enters",
    });
  }
  cues.sort((a, b) => a.time - b.time);

  const sections: Section[] = [
    { start: 0, end: spec.duration * 0.12, label: "intro", energy: spec.energy * 0.4, vocalness: 0.02, drive: 0.2, startBar: 0, bars: 8 },
    { start: spec.duration * 0.12, end: spec.duration * 0.85, label: "groove", energy: spec.energy, vocalness: spec.vocalDensity, drive: 0.6, startBar: 8, bars: 32 },
    { start: spec.duration * 0.85, end: spec.duration, label: "outro", energy: spec.energy * 0.5, vocalness: 0.05, drive: 0.3, startBar: 40, bars: 8 },
  ];

  return {
    id: spec.id,
    name: spec.name,
    duration: spec.duration,
    sampleRate: 44100,
    channels: 2,
    grid: {
      beats, downbeats, phrases: Float32Array.from(phraseList),
      bpm: spec.bpm, tempoConfidence: 0.8, beatConfidence: 0.8,
      phraseBars, firstBeat: 0, meter,
    },
    key: {
      tonic: spec.tonic, mode: spec.mode,
      name: `${spec.tonic} ${spec.mode}`,
      camelot: camelotFor(spec.tonic, spec.mode),
      confidence: 0.8, alternates: [], chroma: new Array(12).fill(1 / 12),
      tonalStability: 0.8,
    },
    loudness: {
      integratedLufs: -8 - spec.energy * 2, loudnessRangeLu: 6, shortTermMaxLufs: -6,
      truePeakDb: -0.5, crestFactorDb: 9, rmsDb: -12,
      normalisationGainDb: -9 - (-8 - spec.energy * 2),
      shortTerm: new Float32Array(10).fill(-9),
    },
    spectral: {
      centroidHz: 2200, rolloff85Hz: 9000, bandwidthHz: 3000, flatness: 0.2,
      bandsDb: BAND_NAMES.map((_, i) => -20 - i * 2), contrastDb: BAND_NAMES.map(() => 12),
      fluxMean: 0.3, brightness: spec.brightness ?? 0.2,
    },
    stereo: { width: 0.4, correlation: 0.6, sideToMidDb: -9, bassMonoRatio: 0.95 },
    rhythm: {
      onsetDensity: 3, pulseClarity: 0.85, percussiveRatio: 0.45,
      syncopation: 0.3, danceability: 0.75, swing: 0,
    },
    sections, cues, timelines,
    energyScore: spec.energy,
    mixability: spec.mixability ?? 0.8,
    vocalDensity: spec.vocalDensity,
    analysisMs: 0,
  };
}

/** Bar length in seconds, for tests that assert beat alignment. */
export function barLength(bpm: number, meter = 4): number {
  return (60 / bpm) * meter;
}
