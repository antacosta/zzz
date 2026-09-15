/**
 * Source-activity estimation: which parts of the song are vocal, which are
 * percussive, and how the groove behaves.
 *
 * Harmonic/percussive separation uses Fitzgerald's median-filter method on the
 * magnitude spectrogram: filtering along time isolates sustained (harmonic)
 * content, filtering along frequency isolates transients (percussive).
 *
 * Lead-vocal likelihood combines four cues that are cheap and complementary:
 *   1. harmonic dominance in the 200 Hz - 5 kHz vocal band
 *   2. centre-channel dominance (lead vocals are almost always panned centre)
 *   3. spectral peak spacing consistent with a single voiced source
 *   4. frame-to-frame pitch continuity, which distinguishes voice from pads
 */

import type { RhythmProfile } from "../types";
import { type Spectrogram, clamp, mean, median, normalise, percentile, smooth, stddev } from "./dsp";

export interface HpssResult {
  /** [frame] 0..1 percussive dominance */
  percussive: Float32Array;
  /** [frame] 0..1 harmonic dominance */
  harmonic: Float32Array;
  /** overall percussive energy share */
  percussiveRatio: number;
}

/**
 * Median-filter HPSS reduced to per-frame ratios. We avoid materialising both
 * full spectrograms by streaming the frequency-direction median and keeping a
 * ring buffer for the time-direction median.
 */
export function hpss(spec: Spectrogram, timeRadius = 8, freqRadius = 8): HpssResult {
  const { frames, bins } = spec;
  const n = frames.length;
  const percussive = new Float32Array(n);
  const harmonic = new Float32Array(n);
  let percTotal = 0;
  let harmTotal = 0;

  const scratch = new Float32Array(timeRadius * 2 + 1);

  for (let f = 0; f < n; f++) {
    const mag = frames[f];
    // Percussive estimate: median along frequency at this frame.
    const freqMed = runningMedian(mag, freqRadius);
    let p = 0;
    let h = 0;
    for (let b = 1; b < bins; b++) {
      // Harmonic estimate: median along time for this bin.
      let k = 0;
      for (let t = f - timeRadius; t <= f + timeRadius; t++) {
        if (t < 0 || t >= n) continue;
        scratch[k++] = frames[t][b];
      }
      const timeMed = median(scratch.subarray(0, k));
      const pv = freqMed[b];
      const hv = timeMed;
      const denom = pv * pv + hv * hv + 1e-12;
      // Wiener-style soft masks
      const pMask = (pv * pv) / denom;
      const e = mag[b] * mag[b];
      p += e * pMask;
      h += e * (1 - pMask);
    }
    const tot = p + h + 1e-12;
    percussive[f] = p / tot;
    harmonic[f] = h / tot;
    percTotal += p;
    harmTotal += h;
  }

  return {
    percussive: smooth(percussive, 3),
    harmonic: smooth(harmonic, 3),
    percussiveRatio: percTotal / (percTotal + harmTotal + 1e-12),
  };
}

function runningMedian(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const scratch = new Float32Array(radius * 2 + 1);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= n) continue;
      scratch[k++] = x[j];
    }
    out[i] = median(scratch.subarray(0, k));
  }
  return out;
}

/**
 * Per-frame lead-vocal likelihood. `midSpec` is the STFT of (L+R)/2 and
 * `sideSpec` of (L-R)/2; when the source is mono, pass the same spectrogram
 * twice and the centre-dominance cue degrades gracefully to a constant.
 */
export function vocalTimeline(
  midSpec: Spectrogram,
  sideSpec: Spectrogram,
  harmonicRatio: Float32Array,
  isStereo: boolean,
): Float32Array {
  const { frames, bins, fftSize, sampleRate } = midSpec;
  const binHz = sampleRate / fftSize;
  const loBin = Math.max(1, Math.floor(200 / binHz));
  const hiBin = Math.min(bins - 1, Math.ceil(5000 / binHz));
  const n = frames.length;

  const centre = new Float32Array(n);
  const bandEnergy = new Float32Array(n);
  const peakiness = new Float32Array(n);
  const pitchTrack = new Float32Array(n);

  for (let f = 0; f < n; f++) {
    const mid = frames[f];
    const side = sideSpec.frames[Math.min(f, sideSpec.frames.length - 1)];
    let midE = 0;
    let sideE = 0;
    let bandE = 0;
    let allE = 0;
    let peak = 0;
    let peakBin = loBin;
    for (let b = 1; b < bins; b++) {
      const m = mid[b] * mid[b];
      allE += m;
      if (b >= loBin && b <= hiBin) {
        midE += m;
        sideE += side[b] * side[b];
        bandE += m;
        if (mid[b] > peak) {
          peak = mid[b];
          peakBin = b;
        }
      }
    }
    centre[f] = isStereo ? clamp(midE / (midE + sideE * 2 + 1e-12), 0, 1) : 0.6;
    bandEnergy[f] = allE > 0 ? clamp(bandE / allE, 0, 1) : 0;
    // Peakiness inside the vocal band: a voice has a small number of strong
    // harmonics, a full mix in that band is comparatively flat.
    const slice = mid.subarray(loBin, hiBin);
    const p90 = percentile(slice, 90);
    const p50 = percentile(slice, 50);
    peakiness[f] = clamp(Math.log1p(p90 / (p50 + 1e-9)) / 2.5, 0, 1);
    pitchTrack[f] = peakBin * binHz;
  }

  // Pitch continuity: voiced phrases glide, they do not jump randomly.
  const continuity = new Float32Array(n);
  for (let f = 1; f < n; f++) {
    const ratio = pitchTrack[f] / Math.max(pitchTrack[f - 1], 1e-6);
    const cents = Math.abs(1200 * Math.log2(ratio));
    // Reward small but non-zero movement (vibrato/melody), punish jumps.
    continuity[f] = clamp(1 - Math.abs(cents - 40) / 400, 0, 1);
  }
  if (n > 1) continuity[0] = continuity[1];

  const raw = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const harm = clamp(harmonicRatio[Math.min(f, harmonicRatio.length - 1)], 0, 1);
    raw[f] =
      0.30 * centre[f] +
      0.22 * bandEnergy[f] +
      0.24 * peakiness[f] +
      0.14 * smoothPick(continuity, f) +
      0.10 * harm;
  }

  // Vocals arrive in phrases: smooth over ~0.7 s then stretch the contrast so
  // instrumental passages read as clearly empty.
  const sm = smooth(raw, Math.max(2, Math.round(0.7 / midSpec.frameRate)));
  const norm = normalise(sm);
  const out = new Float32Array(n);
  const gate = percentile(norm, 45);
  for (let f = 0; f < n; f++) {
    out[f] = clamp((norm[f] - gate) / Math.max(1 - gate, 1e-6), 0, 1) ** 0.8;
  }
  return out;
}

function smoothPick(x: Float32Array, i: number): number {
  const a = x[Math.max(0, i - 1)];
  const b = x[i];
  const c = x[Math.min(x.length - 1, i + 1)];
  return (a + b + c) / 3;
}

export function rhythmProfile(
  onset: Float32Array,
  beats: Float32Array,
  frameRate: number,
  percussiveRatio: number,
): RhythmProfile {
  if (beats.length < 8) {
    return {
      onsetDensity: 0, pulseClarity: 0, percussiveRatio: round(percussiveRatio, 3),
      syncopation: 0, danceability: 0, swing: 0,
    };
  }
  const iois = new Float32Array(beats.length - 1);
  for (let i = 1; i < beats.length; i++) iois[i - 1] = beats[i] - beats[i - 1];
  const mu = mean(iois);
  const pulseClarity = clamp(1 - (stddev(iois, mu) / Math.max(mu, 1e-9)) * 6, 0, 1);

  // Onset density: onsets per beat, where an onset is a local peak above the mean.
  const thresh = mean(onset) + stddev(onset);
  let onsets = 0;
  for (let i = 1; i < onset.length - 1; i++) {
    if (onset[i] > thresh && onset[i] >= onset[i - 1] && onset[i] > onset[i + 1]) onsets++;
  }
  const duration = beats[beats.length - 1] - beats[0];
  const onsetDensity = duration > 0 ? onsets / (duration / mu) : 0;

  // Syncopation and swing: where does onset energy land inside each beat?
  // 8 sub-positions per beat.
  const SUB = 8;
  const histogram = new Float32Array(SUB);
  for (let i = 0; i < beats.length - 1; i++) {
    const t0 = beats[i];
    const span = beats[i + 1] - t0;
    if (span <= 0) continue;
    for (let s = 0; s < SUB; s++) {
      const t = t0 + (span * s) / SUB;
      const idx = Math.round(t / frameRate);
      if (idx >= 0 && idx < onset.length) histogram[s] += onset[idx];
    }
  }
  const total = histogram.reduce((a, b) => a + b, 0) || 1e-9;
  const onGrid = histogram[0] + histogram[2] + histogram[4] + histogram[6];
  const syncopation = clamp(1 - onGrid / total, 0, 1);
  // Swing: energy at the triplet position (index ~5.33 of 8) vs the straight 8th (index 4... use 2nd 8th).
  const straight8 = histogram[2] + histogram[6];
  const swung = histogram[3] + histogram[7];
  const swing = clamp(swung / (straight8 + swung + 1e-9) - 0.35, 0, 1) * 0.5;

  const danceability = clamp(
    0.40 * pulseClarity + 0.25 * clamp(percussiveRatio * 1.8, 0, 1) +
    0.20 * clamp(onsetDensity / 4, 0, 1) + 0.15 * (1 - Math.abs(syncopation - 0.35) * 2),
    0, 1,
  );

  return {
    onsetDensity: round(onsetDensity, 2),
    pulseClarity: round(pulseClarity, 3),
    percussiveRatio: round(percussiveRatio, 3),
    syncopation: round(syncopation, 3),
    danceability: round(danceability, 3),
    swing: round(swing, 3),
  };
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Number.isFinite(v) ? Math.round(v * f) / f : 0;
}
