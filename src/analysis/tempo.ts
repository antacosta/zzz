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
import {
  type Spectrogram, clamp, frameToTime, mean, median, normalise, smooth, stddev, timeToFrame,
} from "./dsp";

const MIN_BPM = 70;
const MAX_BPM = 190;

/**
 * Onset strength from band-weighted spectral flux over an adaptively whitened
 * spectrogram.
 *
 * Two things have to be got right here, and both are about what the envelope
 * does on real material rather than on a clean test signal.
 *
 * Whitening: a transient sitting on top of a loud steady tone barely registers,
 * because any compressive difference of magnitudes shrinks as the steady level
 * grows. A sustained bass note at the kick's own frequency therefore hides the
 * kick, which is not an edge case — it is most dance music. Each bin is divided
 * by its own recent peak before the flux is taken, so what counts is how much a
 * bin rose *relative to how loud it has lately been*, and the kick reads the
 * same whether or not a bassline is holding underneath it.
 *
 * Band weighting: a plain sum of flux across all bins over-weights broadband
 * transients. A hi-hat lights up every bin in the top three octaves while a kick
 * moves only a handful of low ones, so the hat wins and the beat tracker locks
 * to the offbeat. Flux is therefore taken per band, each band normalised by its
 * own median so bands contribute comparably however the track is mixed, and
 * summed with weights favouring where kicks and snares live.
 */
const FLUX_BAND_EDGES = [0, 100, 250, 600, 1500, 4000, 22050];
const FLUX_BAND_WEIGHTS = [1.6, 1.4, 1.1, 0.9, 0.55, 0.35];
/** Per-frame decay of the whitening envelope; about a 2 s memory at a 6 ms hop. */
const WHITEN_DECAY = 0.997;

export function onsetEnvelope(spec: Spectrogram): { onset: Float32Array; lowOnset: Float32Array } {
  const { frames, bins, fftSize, sampleRate } = spec;
  const n = frames.length;
  const binHz = sampleRate / fftSize;
  const bandCount = FLUX_BAND_WEIGHTS.length;

  // Bin ranges per band, computed once.
  const ranges: [number, number][] = [];
  for (let b = 0; b < bandCount; b++) {
    const lo = Math.max(1, Math.floor(FLUX_BAND_EDGES[b] / binHz));
    const hi = Math.min(bins, Math.max(lo + 1, Math.ceil(FLUX_BAND_EDGES[b + 1] / binHz)));
    ranges.push([lo, hi]);
  }

  // A floor for the whitening envelope, so near-silent bins are not amplified
  // into noise. Scaled to the track so it works at any absolute level.
  let globalMax = 0;
  for (let f = 0; f < n; f++) {
    const mag = frames[f];
    for (let b = 1; b < bins; b++) if (mag[b] > globalMax) globalMax = mag[b];
  }
  const floor = Math.max(globalMax * 1e-3, 1e-9);

  const peak = new Float32Array(bins).fill(floor);
  const white = new Float32Array(bins);
  const prevWhite = new Float32Array(bins);
  const bandFlux: Float32Array[] = ranges.map(() => new Float32Array(n));

  for (let f = 0; f < n; f++) {
    const mag = frames[f];
    for (let b = 1; b < bins; b++) {
      const decayed = peak[b] * WHITEN_DECAY;
      peak[b] = Math.max(mag[b], decayed, floor);
      white[b] = mag[b] / peak[b];
    }
    if (f > 0) {
      for (let band = 0; band < bandCount; band++) {
        const [lo, hi] = ranges[band];
        let sum = 0;
        for (let b = lo; b < hi; b++) {
          const d = white[b] - prevWhite[b];
          if (d > 0) sum += d;
        }
        bandFlux[band][f] = sum;
      }
    }
    prevWhite.set(white);
  }

  const onset = new Float32Array(n);
  for (let b = 0; b < bandCount; b++) {
    // Normalising by the median rather than the max keeps one loud crash from
    // flattening the whole band.
    const scale = median(bandFlux[b].filter((v) => v > 0)) || 1;
    const weight = FLUX_BAND_WEIGHTS[b];
    for (let f = 0; f < n; f++) onset[f] += (bandFlux[b][f] / scale) * weight;
  }

  // The low bands alone, which is what decides where the kick is.
  const lowOnset = new Float32Array(n);
  for (let b = 0; b < 2; b++) {
    const scale = median(bandFlux[b].filter((v) => v > 0)) || 1;
    for (let f = 0; f < n; f++) lowOnset[f] += bandFlux[b][f] / scale;
  }

  // Remove slow drift so quiet intros still yield usable peaks.
  const base = smooth(onset, Math.round(1.0 / spec.frameRate));
  for (let f = 0; f < n; f++) onset[f] = Math.max(0, onset[f] - base[f]);
  return { onset: normalise(onset), lowOnset: normalise(lowOnset) };
}

/**
 * Score a candidate period by how well a comb at that period explains the kick.
 *
 * Autocorrelation cannot tell a beat period from 3/2 of one: a kick with an
 * offbeat hat has energy at every half-beat, so a comb spaced at three
 * half-beats hits an onset every time and correlates just as well as the true
 * period. What separates them is *which* onsets the teeth land on. At the true
 * period every tooth lands on a kick; at 3/2 of it they alternate kick, hat,
 * kick, hat.
 *
 * Scoring on the weakest half of the teeth separates those cases cleanly, where
 * a mean over all teeth does not: alternating hit and miss averages out to
 * about the same value as hitting every time.
 *
 * The lag is a float and the envelope is interpolated, because tempo needs more
 * precision than the frame grid offers. At a 23 ms hop the integer lags either
 * side of 120 BPM are 117.8 and 123.4, so an integer-lag estimate can be several
 * BPM out however good the correlation is.
 */
function combSalience(
  lowOnset: Float32Array,
  lagFrames: number,
  phaseSteps = 24,
): number {
  const n = lowOnset.length;
  if (lagFrames < 2 || n < lagFrames * 4) return 0;
  const teeth = Math.floor((n - 1) / lagFrames);
  if (teeth < 4) return 0;

  const sample = (x: number): number => {
    if (x <= 0) return lowOnset[0];
    if (x >= n - 1) return lowOnset[n - 1];
    const i = Math.floor(x);
    const f = x - i;
    return lowOnset[i] * (1 - f) + lowOnset[i + 1] * f;
  };

  const values = new Float64Array(teeth);
  let best = 0;

  for (let p = 0; p < phaseSteps; p++) {
    const phase = (p / phaseSteps) * lagFrames;
    let count = 0;
    for (let k = 0; k < teeth; k++) {
      const x = phase + k * lagFrames;
      if (x >= n - 1) break;
      // An onset spans a few frames and the grid will not land on its peak, so
      // take the strongest sample from a narrow neighbourhood.
      let v = 0;
      for (let d = -1; d <= 1; d += 0.5) {
        const c = sample(x + d);
        if (c > v) v = c;
      }
      values[count++] = v;
    }
    if (count < 4) continue;
    const sorted = Array.from(values.subarray(0, count)).sort((a, b) => a - b);
    const half = Math.max(1, Math.floor(count / 2));
    let sum = 0;
    for (let i = 0; i < half; i++) sum += sorted[i];
    const weakHalf = sum / half;
    if (weakHalf > best) best = weakHalf;
  }
  return best;
}

/**
 * Sweep a candidate period locally and keep the one with the best comb
 * salience. This is where the final precision comes from: autocorrelation
 * proposes roughly the right period, and this settles it to a fraction of a BPM.
 */
function refineBySalience(
  lowOnset: Float32Array,
  lagFrames: number,
): { lag: number; score: number } {
  // Two passes. A single sweep wide enough to correct the autocorrelation peak
  // has a step of about 0.2 %, and at 128 BPM that is a quarter of a BPM, which
  // is enough to drift the grid by tens of milliseconds over a long track. The
  // second, narrow pass takes the resolution to roughly 0.015 %.
  const sweep = (centre: number, spread: number, steps: number): { lag: number; score: number } => {
    let bestLag = centre;
    let bestScore = -1;
    for (let i = 0; i < steps; i++) {
      const factor = 1 + spread * ((2 * i) / (steps - 1) - 1);
      const lag = centre * factor;
      const score = combSalience(lowOnset, lag);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    return { lag: bestLag, score: bestScore };
  };

  const coarse = sweep(lagFrames, 0.04, 41);
  return sweep(coarse.lag, 0.003, 41);
}

/**
 * Tempo estimation: autocorrelation proposes, comb salience decides.
 *
 * The autocorrelation of the onset envelope, comb-filtered so a true period is
 * credited for its harmonics, gives a shortlist of plausible periods. Each is
 * then refined and re-scored against the low-band onset envelope, which is what
 * resolves the metrical level and delivers the precision.
 */
export function estimateTempo(
  onset: Float32Array,
  frameRate: number,
  lowOnset?: Float32Array,
): { bpm: number; confidence: number; candidates: { bpm: number; score: number }[] } {
  const minLag = Math.floor(60 / MAX_BPM / frameRate);
  const maxLag = Math.ceil(60 / MIN_BPM / frameRate);
  const n = onset.length;
  const mu = mean(onset);
  const centred = new Float32Array(n);
  for (let i = 0; i < n; i++) centred[i] = onset[i] - mu;

  const acf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += centred[i] * centred[i + lag];
    acf[lag] = sum / (n - lag);
  }

  // Comb filter: a true period also has energy at 2x, 3x and 4x the lag.
  const comb = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = acf[lag];
    let weight = 1;
    for (const m of [2, 3, 4]) {
      const l = lag * m;
      if (l <= maxLag) {
        sum += acf[l] / m;
        weight += 1 / m;
      }
    }
    comb[lag] = sum / weight;
  }

  // Only local maxima are real hypotheses.
  const candidates: { bpm: number; score: number }[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (comb[lag] < comb[lag - 1] || comb[lag] <= comb[lag + 1]) continue;
    const bpm = 60 / (lag * frameRate);
    // Log-normal tempo prior centred on 126 BPM, the middle of the club range.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 126) / 0.9) ** 2);
    candidates.push({ bpm, score: comb[lag] * prior });
  }
  if (!candidates.length) {
    return { bpm: 126, confidence: 0, candidates: [{ bpm: 126, score: 0 }] };
  }

  candidates.sort((a, b) => b.score - a.score);
  const shortlist = candidates.slice(0, 6);

  if (lowOnset) {
    const topAcf = shortlist[0].score || 1e-9;
    for (const c of shortlist) {
      const acfScore = clamp(c.score / topAcf, 0, 1);
      const { lag, score } = refineBySalience(lowOnset, 60 / c.bpm / frameRate);
      c.bpm = 60 / (lag * frameRate);
      const prior = Math.exp(-0.5 * (Math.log2(c.bpm / 126) / 1.1) ** 2);
      // Autocorrelation and the prior keep a high-salience but implausible
      // period from running away with it; salience settles the near-ties.
      c.score = (acfScore * 0.35 + score * 0.65) * prior;
    }
    shortlist.sort((a, b) => b.score - a.score);
  }

  const best = shortlist[0];

  // Resolve the octave. Autocorrelation cannot distinguish a tempo from half or
  // double it, and the prior alone will happily report a 174 BPM track as 87.
  // If doubling the tempo still puts a tooth on an onset every time, the faster
  // level is the real beat, which is the convention every DJ tool follows.
  if (lowOnset) {
    let bpm = best.bpm;
    let score = combSalience(lowOnset, 60 / bpm / frameRate);
    for (let i = 0; i < 2; i++) {
      const faster = bpm * 2;
      if (faster > MAX_BPM) break;
      const fasterScore = combSalience(lowOnset, 60 / faster / frameRate);
      if (fasterScore < score * 0.85) break;
      bpm = faster;
      score = fasterScore;
    }
    // And the same downward, for a track tracked at four times its pulse.
    while (bpm / 2 >= MIN_BPM) {
      const slower = bpm / 2;
      const slowerScore = combSalience(lowOnset, 60 / slower / frameRate);
      // Only step down when the faster level is clearly the weaker reading.
      if (slowerScore < score / 0.85) break;
      bpm = slower;
      score = slowerScore;
    }
    best.bpm = bpm;
  }

  const confidence = best.score > 0 && shortlist[1]
    ? clamp(1 - shortlist[1].score / best.score, 0, 1)
    : 0.5;
  return {
    bpm: best.bpm,
    confidence,
    candidates: shortlist.slice(0, 4),
  };
}

/**
 * Nudge the whole grid onto the kick.
 *
 * Even with band weighting, a track whose hats are louder than its kick can be
 * tracked a half-beat out: the period is right but the phase sits on the
 * offbeat. Every shift of the grid within one beat is scored against the
 * low-band onset envelope and the best wins. Because the whole grid moves
 * together, this cannot disturb the tempo.
 */
export function alignToKick(
  beats: Float32Array,
  lowOnset: Float32Array,
  frameRate: number,
  frameOffset: number,
  bpm: number,
): { beats: Float32Array; shift: number } {
  if (beats.length < 8) return { beats, shift: 0 };
  const beatSeconds = 60 / bpm;
  // Thirty-second-note resolution, finer than the frame grid, so the search
  // step is never the limiting factor.
  const steps = 32;
  let bestShift = 0;
  let bestScore = -Infinity;

  for (let k = -steps / 2; k <= steps / 2; k++) {
    const shift = (k / steps) * beatSeconds;
    let score = 0;
    for (let i = 0; i < beats.length; i++) {
      const x = timeToFrame(beats[i] + shift, frameRate, frameOffset);
      if (x < 0 || x >= lowOnset.length - 1) continue;
      const idx = Math.floor(x);
      const f = x - idx;
      score += lowOnset[idx] * (1 - f) + lowOnset[idx + 1] * f;
    }
    // Prefer no shift when scores are close, so a confident grid is left alone.
    const adjusted = score * (k === 0 ? 1.02 : 1);
    if (adjusted > bestScore) {
      bestScore = adjusted;
      bestShift = shift;
    }
  }

  if (bestShift === 0) return { beats, shift: 0 };
  const shifted = new Float32Array(beats.length);
  for (let i = 0; i < beats.length; i++) shifted[i] = Math.max(0, beats[i] + bestShift);
  return { beats: shifted, shift: bestShift };
}

/** Ellis dynamic-programming beat tracker. */
export function trackBeats(
  onset: Float32Array,
  frameRate: number,
  bpm: number,
  tightness = 90,
  frameOffset = 0,
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
  for (let i = 0; i < rev.length; i++) beats[i] = frameToTime(rev[i], frameRate, frameOffset);

  // Confidence: mean onset strength on beats vs. the track mean.
  let onBeat = 0;
  for (const idx of rev) onBeat += localScore[idx];
  onBeat /= Math.max(1, rev.length);
  const overall = mean(localScore) || 1e-9;
  const confidence = clamp(onBeat / (overall * 2.5), 0, 1);
  return { beats, confidence };
}

/**
 * Spread of inter-beat intervals. Kept for material that is not metronomic and
 * has to be tracked beat by beat; a fitted constant grid has zero spread by
 * construction, so `gridStability` is the meaningful measure there.
 */
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
  frameOffset = 0,
): { phase: number; strength: number } {
  const scores = new Float32Array(meter);
  for (let i = 0; i < beats.length; i++) {
    const idx = Math.round(timeToFrame(beats[i], frameRate, frameOffset));
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
  frameOffset = 0,
): number {
  const candidates = [4, 8, 16, 32];
  let bestBars = 8;
  let bestScore = -Infinity;
  for (const bars of candidates) {
    let score = 0;
    let count = 0;
    for (let i = bars; i < downbeats.length; i += bars) {
      const idx = Math.round(timeToFrame(downbeats[i], frameRate, frameOffset));
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

/**
 * Fit a regular beat grid at a known tempo.
 *
 * The dynamic-programming tracker can only place a beat on a frame boundary, so
 * the spacings it produces are quantised: at a 23 ms hop the only options near
 * 120 BPM are 21 frames (123.4) and 22 frames (117.8). It settles on whichever
 * is cheaper and stays there, so reading the tempo back off its beat spacings
 * bakes in an error of a percent or two, and the grid then drifts away from the
 * music over the length of the track.
 *
 * Dance music is metronomic, so the better answer is a constant-tempo grid at
 * the precise tempo, phase-locked to the kick with sub-frame resolution. That is
 * also the grid a DJ expects, and the one cue points and phrase lines should be
 * measured against. Where a track genuinely is not metronomic, `tempoStability`
 * below reports it rather than the grid silently bending.
 */
export function fitGrid(
  lowOnset: Float32Array,
  frameRate: number,
  frameOffset: number,
  bpm: number,
  duration: number,
): { beats: Float32Array; fit: number } {
  const period = 60 / bpm;
  const n = lowOnset.length;
  if (n < 4 || period <= 0) return { beats: new Float32Array(0), fit: 0 };

  const sample = (t: number): number => {
    const x = timeToFrame(t, frameRate, frameOffset);
    if (x <= 0) return lowOnset[0];
    if (x >= n - 1) return lowOnset[n - 1];
    const i = Math.floor(x);
    const f = x - i;
    return lowOnset[i] * (1 - f) + lowOnset[i + 1] * f;
  };

  const count = Math.floor(duration / period);
  if (count < 4) return { beats: new Float32Array(0), fit: 0 };

  // Search the phase across one whole period, finely enough that the frame grid
  // is the limiting factor rather than the search step.
  const steps = 256;
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < steps; p++) {
    const phase = (p / steps) * period;
    let score = 0;
    for (let k = 0; k < count; k++) score += sample(phase + k * period);
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  const beats = new Float32Array(count);
  for (let k = 0; k < count; k++) beats[k] = bestPhase + k * period;

  // Fit quality: onset strength on the grid against the track's average.
  let overall = 0;
  for (let i = 0; i < n; i++) overall += lowOnset[i];
  overall /= n;
  const onGrid = bestScore / count;
  return { beats, fit: clamp(onGrid / Math.max(overall * 2.2, 1e-9), 0, 1) };
}

/**
 * How well a single constant tempo explains the whole track. A grid fitted to a
 * track that speeds up will match its first half and miss its second, so
 * comparing the fit in each half detects drift that the overall fit hides.
 */
export function gridStability(
  beats: Float32Array,
  lowOnset: Float32Array,
  frameRate: number,
  frameOffset: number,
): number {
  if (beats.length < 16) return 0;
  const n = lowOnset.length;
  const at = (t: number): number => {
    const x = timeToFrame(t, frameRate, frameOffset);
    if (x < 0 || x >= n - 1) return 0;
    const i = Math.floor(x);
    const f = x - i;
    return lowOnset[i] * (1 - f) + lowOnset[i + 1] * f;
  };
  const half = beats.length >> 1;
  let first = 0;
  let second = 0;
  for (let i = 0; i < half; i++) first += at(beats[i]);
  for (let i = half; i < beats.length; i++) second += at(beats[i]);
  first /= half;
  second /= beats.length - half;
  const lo = Math.min(first, second);
  const hi = Math.max(first, second);
  if (hi <= 1e-9) return 0;
  return clamp(lo / hi, 0, 1);
}

/**
 * Inputs to the grid builder. The onset envelope and the energy envelope are
 * computed from different STFTs — onsets need time resolution, energy needs
 * frequency resolution — so each carries its own frame rate and offset.
 */
export interface GridInput {
  onset: Float32Array;
  lowOnset: Float32Array;
  onsetRate: number;
  onsetOffset: number;
  energy: Float32Array;
  energyRate: number;
  energyOffset: number;
  duration: number;
}

export function buildGrid(input: GridInput): BeatGrid {
  const { onset, lowOnset, onsetRate, onsetOffset, energy, energyRate, energyOffset } = input;
  const { bpm, confidence: tempoConfidence } = estimateTempo(onset, onsetRate, lowOnset);

  // A constant-tempo grid at the estimated tempo, phase-locked to the kick.
  const fitted = fitGrid(lowOnset, onsetRate, onsetOffset, bpm, input.duration);
  let beats = fitted.beats;
  if (!beats.length) {
    // Nothing periodic to lock to: fall back to the dynamic-programming tracker
    // so the rest of the pipeline still has something to work with.
    beats = trackBeats(onset, onsetRate, bpm, 90, onsetOffset).beats;
  }
  beats = alignToKick(beats, lowOnset, onsetRate, onsetOffset, bpm).beats;

  const meter = 4;
  const { phase } = findDownbeatPhase(beats, lowOnset, onsetRate, meter, onsetOffset);

  const downbeatList: number[] = [];
  for (let i = phase; i < beats.length; i += meter) downbeatList.push(beats[i]);
  const downbeats = Float32Array.from(downbeatList);

  const phraseBars = estimatePhraseBars(downbeats, energy, energyRate, energyOffset);
  const phraseList: number[] = [];
  for (let i = 0; i < downbeats.length; i += phraseBars) phraseList.push(downbeats[i]);

  return {
    beats,
    downbeats,
    phrases: Float32Array.from(phraseList),
    bpm: Math.round(bpm * 100) / 100,
    tempoConfidence,
    beatConfidence: fitted.fit,
    phraseBars,
    firstBeat: beats.length ? beats[0] : 0,
    meter,
  };
}
