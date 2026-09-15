/**
 * Chroma extraction and key estimation.
 *
 * Chroma comes from a harmonically-weighted log-frequency mapping of the STFT:
 * each bin votes into its pitch class, and we also down-weight the first few
 * harmonics so a strong bass note does not drag the profile to its overtones.
 * Key is then the best correlation against Temperley-style major/minor profiles.
 */

import type { KeyEstimate } from "../types";
import { type Spectrogram, clamp, mean, stddev } from "./dsp";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Temperley key profiles, normalised at use time. */
const MAJOR_PROFILE = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const MINOR_PROFILE = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];

/**
 * Camelot wheel: index by pitch class for each mode.
 * 8B = C major, 8A = A minor, and the wheel moves by perfect fifths.
 */
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

export function camelotFor(tonic: number, mode: "major" | "minor"): string {
  return mode === "major" ? CAMELOT_MAJOR[tonic] : CAMELOT_MINOR[tonic];
}

/**
 * Chroma needs far finer frequency resolution than the 2048-point analysis
 * STFT provides: at 22 kHz a 2048 window is ~10.8 Hz per bin, which is wider
 * than a semitone below A3, so rounding a bin to a pitch class mislabels bass
 * notes and flips major/minor. So chroma gets its own long window, and each
 * bin's energy is spread across neighbouring pitch classes by its fractional
 * distance in semitones rather than snapped to the nearest one.
 */
export const CHROMA_FFT_SIZE = 8192;
export const CHROMA_HOP = 2048;

const CHROMA_LO_HZ = 65;
const CHROMA_HI_HZ = 2100;

export function chromagram(spec: Spectrogram): Float32Array[] {
  const { frames, bins, fftSize, sampleRate } = spec;
  const binHz = sampleRate / fftSize;

  // Pre-compute, per bin, which two pitch classes it feeds and with what weight.
  const pcLow = new Int8Array(bins).fill(-1);
  const pcHigh = new Int8Array(bins).fill(-1);
  const wLow = new Float32Array(bins);
  const wHigh = new Float32Array(bins);
  const octaveWeight = new Float32Array(bins);

  for (let b = 1; b < bins; b++) {
    const hz = b * binHz;
    if (hz < CHROMA_LO_HZ || hz > CHROMA_HI_HZ) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const floorMidi = Math.floor(midi);
    const frac = midi - floorMidi;
    pcLow[b] = (((floorMidi % 12) + 12) % 12) as number;
    pcHigh[b] = ((((floorMidi + 1) % 12) + 12) % 12) as number;
    // Raised-cosine split: energy exactly on a semitone centre goes entirely to
    // that class, energy between two classes is shared.
    wLow[b] = 0.5 + 0.5 * Math.cos(Math.PI * frac);
    wHigh[b] = 1 - wLow[b];
    // Emphasise the octaves chords actually occupy (roughly A2..A5).
    octaveWeight[b] = Math.exp(-0.5 * ((midi - 60) / 18) ** 2);
  }

  const out: Float32Array[] = new Array(frames.length);
  for (let f = 0; f < frames.length; f++) {
    const mag = frames[f];
    const c = new Float32Array(12);
    for (let b = 1; b < bins; b++) {
      const lo = pcLow[b];
      if (lo < 0) continue;
      const e = mag[b] * mag[b] * octaveWeight[b];
      c[lo] += e * wLow[b];
      c[pcHigh[b]] += e * wHigh[b];
    }
    // Normalise each frame so loud sections do not dominate the average.
    let max = 0;
    for (let i = 0; i < 12; i++) if (c[i] > max) max = c[i];
    if (max > 0) for (let i = 0; i < 12; i++) c[i] /= max;
    out[f] = c;
  }
  return out;
}

/**
 * Stretch chroma frames computed at a coarser hop onto the main analysis frame
 * grid. Frames are shared by reference; nothing mutates them downstream.
 */
export function alignChroma(
  chroma: Float32Array[],
  chromaHop: number,
  targetHop: number,
  targetFrames: number,
): Float32Array[] {
  if (!chroma.length) return new Array(targetFrames).fill(new Float32Array(12));
  const ratio = targetHop / chromaHop;
  const out: Float32Array[] = new Array(targetFrames);
  for (let f = 0; f < targetFrames; f++) {
    const src = Math.min(chroma.length - 1, Math.floor(f * ratio));
    out[f] = chroma[src];
  }
  return out;
}

function correlate(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const ma = mean(a);
  const mb = mean(b);
  const sa = stddev(a, ma);
  const sb = stddev(b, mb);
  if (sa < 1e-9 || sb < 1e-9) return 0;
  let s = 0;
  for (let i = 0; i < 12; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (12 * sa * sb);
}

export function estimateKey(chroma: Float32Array[]): KeyEstimate {
  const avg = new Float32Array(12);
  for (const c of chroma) for (let i = 0; i < 12; i++) avg[i] += c[i];
  const inv = 1 / Math.max(1, chroma.length);
  for (let i = 0; i < 12; i++) avg[i] *= inv;

  const results: { tonic: number; mode: "major" | "minor"; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotMaj = new Float32Array(12);
    const rotMin = new Float32Array(12);
    for (let i = 0; i < 12; i++) {
      rotMaj[i] = MAJOR_PROFILE[(i - tonic + 12) % 12];
      rotMin[i] = MINOR_PROFILE[(i - tonic + 12) % 12];
    }
    results.push({ tonic, mode: "major", score: correlate(avg, rotMaj) });
    results.push({ tonic, mode: "minor", score: correlate(avg, rotMin) });
  }
  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  // Tonal stability: how consistently per-window key estimates agree with the
  // global winner. Windows are ~8 s of frames.
  const windowSize = Math.max(1, Math.floor(chroma.length / 12));
  let agree = 0;
  let windows = 0;
  for (let start = 0; start + windowSize <= chroma.length; start += windowSize) {
    const w = new Float32Array(12);
    for (let f = start; f < start + windowSize; f++) for (let i = 0; i < 12; i++) w[i] += chroma[f][i];
    let localBest = -Infinity;
    let localTonic = 0;
    let localMode: "major" | "minor" = "major";
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const mode of ["major", "minor"] as const) {
        const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
        const rot = new Float32Array(12);
        for (let i = 0; i < 12; i++) rot[i] = profile[(i - tonic + 12) % 12];
        const s = correlate(w, rot);
        if (s > localBest) {
          localBest = s;
          localTonic = tonic;
          localMode = mode;
        }
      }
    }
    windows++;
    if (localTonic === best.tonic && localMode === best.mode) agree++;
    else if (localMode !== best.mode && (localTonic - best.tonic + 12) % 12 === (best.mode === "major" ? 9 : 3)) {
      agree += 0.5; // relative major/minor still counts as tonally stable
    }
  }

  const runnerUp = results[1];
  const confidence = clamp(best.score, 0, 1) * clamp(1 - runnerUp.score / (best.score || 1), 0.2, 1);

  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${NOTE_NAMES[best.tonic]} ${best.mode === "major" ? "maj" : "min"}`,
    camelot: camelotFor(best.tonic, best.mode),
    confidence: clamp(confidence * 1.6, 0, 1),
    alternates: results.slice(1, 4).map((r) => ({
      name: `${NOTE_NAMES[r.tonic]} ${r.mode === "major" ? "maj" : "min"}`,
      camelot: camelotFor(r.tonic, r.mode),
      confidence: clamp(r.score, 0, 1),
    })),
    chroma: Array.from(avg),
    tonalStability: windows ? clamp(agree / windows, 0, 1) : 0,
  };
}

/** Frame-to-frame chroma change: low values mark harmonically safe blend windows. */
export function tonalFlux(chroma: Float32Array[]): Float32Array {
  const out = new Float32Array(chroma.length);
  for (let f = 1; f < chroma.length; f++) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += (chroma[f][i] - chroma[f - 1][i]) ** 2;
    out[f] = Math.sqrt(s);
  }
  if (out.length > 1) out[0] = out[1];
  return out;
}

/**
 * Harmonic distance on the Camelot wheel.
 * 0 = same key, 1 = one step (energy/mood shift or relative), 2 = two steps, etc.
 * Returns Infinity-ish 7 for keys with no comfortable relationship.
 */
export function camelotDistance(a: string, b: string): number {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return 7;
  if (pa.num === pb.num && pa.letter === pb.letter) return 0;
  const ring = Math.min(
    Math.abs(pa.num - pb.num),
    12 - Math.abs(pa.num - pb.num),
  );
  if (pa.letter === pb.letter) return ring; // same mode, along the wheel
  if (ring === 0) return 1; // relative major/minor
  // Mode change plus a wheel step is usable but weaker.
  return ring + 1.5;
}

function parseCamelot(code: string): { num: number; letter: "A" | "B" } | null {
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return null;
  return { num: Number(m[1]), letter: m[2] as "A" | "B" };
}

/** Semitone shift needed to move `from` into `to` (-6..6), for key-shift blending. */
export function semitoneShift(fromTonic: number, toTonic: number): number {
  let d = (toTonic - fromTonic + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}

export { NOTE_NAMES };
