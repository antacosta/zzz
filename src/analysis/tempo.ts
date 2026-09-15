/**
 * Tempo, beat, downbeat and phrase estimation.
 *
 * Onset envelope: log-magnitude spectral flux over a mel-ish band split, which
 * is more robust on dense electronic masters than broadband flux.
 * Tempo: autocorrelation of the onset envelope weighted by a log-normal prior,
 * cross-checked against a comb-filter score so we pick the right metrical level.
 * Beats: Ellis-style dynamic programming, maximising onset strength while
 * penalising deviation from the estimated period.
 * Downbeats: score each of the `meter` beat phases by low-band onset weight.
 * Phrases: fit 8/16/32-bar phrasing by looking for the strongest periodic
 * novelty at bar multiples.
 */

import type { BeatGrid } from "../types";
import { type Spectrogram, clamp, mean, normalise, smooth, stddev } from "./dsp";

const MIN_BPM = 70;
const MAX_BPM = 190;

/** Per-band spectral flux summed into a single onset strength envelope. */
export function onsetEnvelope(spec: Spectrogram): { onset: Float32Array; lowOnset: Float32Array } {
  const { frames, bins, fftSize, sampleRate } = spec;
  const n = frames.length;
  const onset = new Float32Array(n);
  const lowOnset = new Float32Array(n);
  const binHz = sampleRate / fftSize;
  const lowCut = Math.max(1, Math.floor(160 / binHz));

  let prev = frames[0];
  for (let f = 1; f < n; f++) {
    const cur = frames[f];
    let sum = 0;
    let low = 0;
    for (let b = 1; b < bins; b++) {
      // log-domain difference, half-wave rectified
      const d = Math.log1p(cur[b] * 100) - Math.log1p(prev[b] * 100);
      if (d > 0) {
        sum += d;
        if (b <= lowCut) low += d;
      }
    }
    onset[f] = sum;
    lowOnset[f] = low;
    prev = cur;
  }

  // Remove slow drift so quiet intros still yield usable peaks.
  const base = smooth(onset, Math.round(1.0 / spec.frameRate));
  for (let f = 0; f < n; f++) onset[f] = Math.max(0, onset[f] - base[f]);
  return { onset: normalise(onset), lowOnset: normalise(lowOnset) };
}

/** Autocorrelation + comb filtering over the onset envelope. */
export function estimateTempo(
  onset: Float32Array,
  frameRate: number,
): { bpm: number; confidence: number; candidates: { bpm: number; score: number }[] } {
  const minLag = Math.floor(60 / MAX_BPM / frameRate);
  const maxLag = Math.ceil(60 / MIN_BPM / frameRate);
  const n = onset.length;
  const mu = mean(onset);
  const centred = new Float32Array(n);
  for (let i = 0; i < n; i++) centred[i] = onset[i] - mu;

  const acf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += centred[i] * centred[i + lag];
    acf[lag] = s / (n - lag);
  }

  // Log-normal tempo prior centred on 126 BPM (typical club range).
  const scored: { bpm: number; score: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * frameRate);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 126) / 0.9) ** 2);
    // Comb filter: a true period also has energy at 2x and 4x the lag.
    let comb = acf[lag];
    let weight = 1;
    for (const m of [2, 3, 4]) {
      const l = lag * m;
      if (l <= maxLag) {
        comb += acf[l] / m;
        weight += 1 / m;
      }
    }
    scored.push({ bpm, score: (comb / weight) * prior });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Keep only well-separated candidates for reporting.
  const candidates: { bpm: number; score: number }[] = [];
  for (const c of scored) {
    if (candidates.every((k) => Math.abs(k.bpm - c.bpm) > 3)) candidates.push(c);
    if (candidates.length === 4) break;
  }
  const confidence = best.score > 0 && candidates[1]
    ? clamp(1 - candidates[1].score / best.score, 0, 1)
    : 0.5;
  return { bpm: best.bpm, confidence, candidates };
}

/** Ellis dynamic-programming beat tracker. */
export function trackBeats(
  onset: Float32Array,
  frameRate: number,
  bpm: number,
  tightness = 90,
): { beats: Float32Array; confidence: number } {
  const period = 60 / bpm / frameRate;
  const n = onset.length;
  if (n < 4 || period < 1) return { beats: new Float32Array(0), confidence: 0 };

  const localScore = smooth(onset, Math.max(1, Math.round(period / 8)));
  const score = new Float32Array(n);
  const prev = new Int32Array(n).fill(-1);
  const searchLo = Math.max(1, Math.round(period * 0.5));
  const searchHi = Math.round(period * 2);
  // Pre-compute the deviation penalty for each candidate spacing.
  const penalty = new Float32Array(searchHi + 1);
  for (let d = searchLo; d <= searchHi; d++) {
    penalty[d] = -tightness * Math.log(d / period) ** 2;
  }

  for (let i = 0; i < n; i++) {
    let bestScore = -Infinity;
    let bestPrev = -1;
    const lo = Math.max(0, i - searchHi);
    for (let j = lo; j <= i - searchLo; j++) {
      const cand = score[j] + penalty[i - j];
      if (cand > bestScore) {
        bestScore = cand;
        bestPrev = j;
      }
    }
    if (bestPrev < 0) {
      score[i] = localScore[i];
      prev[i] = -1;
    } else {
      score[i] = localScore[i] + bestScore;
      prev[i] = bestPrev;
    }
  }

  // Start backtracking from a strong late peak, not simply the global max.
  let tail = 0;
  let tailScore = -Infinity;
  for (let i = Math.floor(n * 0.5); i < n; i++) {
    if (score[i] > tailScore) {
      tailScore = score[i];
      tail = i;
    }
  }
  const rev: number[] = [];
  for (let i = tail; i >= 0; i = prev[i]) {
    rev.push(i);
    if (prev[i] < 0) break;
  }
  rev.reverse();

  const beats = new Float32Array(rev.length);
  for (let i = 0; i < rev.length; i++) beats[i] = rev[i] * frameRate;

  // Confidence: mean onset strength on beats vs. the track mean.
  let onBeat = 0;
  for (const idx of rev) onBeat += localScore[idx];
  onBeat /= Math.max(1, rev.length);
  const overall = mean(localScore) || 1e-9;
  const confidence = clamp(onBeat / (overall * 2.5), 0, 1);
  return { beats, confidence };
}

/** Tempo stability from inter-beat interval spread. */
export function tempoStability(beats: Float32Array): number {
  if (beats.length < 8) return 0;
  const iois = new Float32Array(beats.length - 1);
  for (let i = 1; i < beats.length; i++) iois[i - 1] = beats[i] - beats[i - 1];
  const mu = mean(iois);
  if (mu <= 0) return 0;
  return clamp(1 - (stddev(iois, mu) / mu) * 8, 0, 1);
}

/**
 * Pick the beat phase that starts bars. Kick-heavy low-band onsets carry the
 * downbeat in most dance music, so the low onset envelope gets the deciding vote.
 */
export function findDownbeatPhase(
  beats: Float32Array,
  lowOnset: Float32Array,
  frameRate: number,
  meter = 4,
): { phase: number; strength: number } {
  const scores = new Float32Array(meter);
  for (let i = 0; i < beats.length; i++) {
    const idx = Math.round(beats[i] / frameRate);
    if (idx < 0 || idx >= lowOnset.length) continue;
    scores[i % meter] += lowOnset[idx];
  }
  let phase = 0;
  for (let p = 1; p < meter; p++) if (scores[p] > scores[phase]) phase = p;
  const total = scores.reduce((a, b) => a + b, 0) || 1e-9;
  return { phase, strength: clamp((scores[phase] / total) * meter - 1, 0, 1) };
}

/**
 * Choose phrase length by testing which bar multiple best explains the largest
 * jumps in the energy envelope. Dance music phrases on 8/16/32 bars.
 */
export function estimatePhraseBars(
  downbeats: Float32Array,
  energy: Float32Array,
  frameRate: number,
): number {
  const candidates = [4, 8, 16, 32];
  let bestBars = 8;
  let bestScore = -Infinity;
  for (const bars of candidates) {
    let score = 0;
    let count = 0;
    for (let i = bars; i < downbeats.length; i += bars) {
      const idx = Math.round(downbeats[i] / frameRate);
      if (idx < 2 || idx >= energy.length - 2) continue;
      // change in energy across the boundary
      score += Math.abs(energy[Math.min(energy.length - 1, idx + 2)] - energy[idx - 2]);
      count++;
    }
    if (count < 2) continue;
    // Prefer longer phrases only if they explain boundaries clearly better.
    const norm = score / count + Math.log2(bars) * 0.01;
    if (norm > bestScore) {
      bestScore = norm;
      bestBars = bars;
    }
  }
  return bestBars;
}

export function buildGrid(
  spec: Spectrogram,
  onset: Float32Array,
  lowOnset: Float32Array,
  energy: Float32Array,
): BeatGrid {
  const frameRate = spec.frameRate;
  const { bpm, confidence: tempoConfidence } = estimateTempo(onset, frameRate);
  const { beats, confidence: beatConfidence } = trackBeats(onset, frameRate, bpm);
  const meter = 4;
  const { phase } = findDownbeatPhase(beats, lowOnset, frameRate, meter);

  const downbeatList: number[] = [];
  for (let i = phase; i < beats.length; i += meter) downbeatList.push(beats[i]);
  const downbeats = Float32Array.from(downbeatList);

  const phraseBars = estimatePhraseBars(downbeats, energy, frameRate);
  const phraseList: number[] = [];
  for (let i = 0; i < downbeats.length; i += phraseBars) phraseList.push(downbeats[i]);

  // Refine BPM from the tracked beats: more accurate than the ACF peak alone.
  let refined = bpm;
  if (beats.length > 16) {
    const span = beats[beats.length - 1] - beats[0];
    if (span > 0) refined = ((beats.length - 1) / span) * 60;
  }

  return {
    beats,
    downbeats,
    phrases: Float32Array.from(phraseList),
    bpm: Math.round(refined * 100) / 100,
    tempoConfidence,
    beatConfidence,
    phraseBars,
    firstBeat: beats.length ? beats[0] : 0,
    meter,
  };
}
