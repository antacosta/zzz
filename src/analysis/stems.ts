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
import {
  type Spectrogram, clamp, frameToTime, mean, medianInPlace, normalise, percentile,
  smooth, stddev,
} from "./dsp";

export interface HpssResult {
  /** [frame] 0..1 percussive dominance */
  percussive: Float32Array;
  /** [frame] 0..1 harmonic dominance */
  harmonic: Float32Array;
  /** overall percussive energy share */
  percussiveRatio: number;
}

/**
 * Median-filter HPSS reduced to per-frame ratios.
 *
 * Only scalar ratios per frame are needed, not the separated spectrograms, so
 * this takes three shortcuts that cost nothing measurable in the result and
 * turn the most expensive stage of the analysis into a minor one:
 *
 *  - the medians are computed in preallocated scratch space, because an
 *    allocation per bin per frame ran to millions of allocations per track;
 *  - bins above `HPSS_MAX_HZ` are skipped, as they carry little of the
 *    harmonic/percussive distinction but a large share of the bins;
 *  - ratios are computed every `stride` frames and interpolated between. The
 *    ratio is a smooth quantity that was already being smoothed afterwards,
 *    while the medians themselves still look at every neighbouring frame.
 */
const HPSS_MAX_HZ = 8000;

export function hpss(
  spec: Spectrogram,
  timeRadius = 8,
  freqRadius = 8,
  stride = 4,
): HpssResult {
  const { frames, bins, fftSize, sampleRate } = spec;
  const n = frames.length;
  const percussive = new Float32Array(n);
  const harmonic = new Float32Array(n);
  let percTotal = 0;
  let harmTotal = 0;

  const binHz = sampleRate / fftSize;
  const maxBin = Math.min(bins, Math.ceil(HPSS_MAX_HZ / binHz));
  const timeScratch = new Float32Array(timeRadius * 2 + 1);
  const freqScratch = new Float32Array(freqRadius * 2 + 1);
  const freqMed = new Float32Array(bins);
  const computed: number[] = [];

  for (let f = 0; f < n; f += stride) {
    const mag = frames[f];
    // Percussive estimate: median along frequency at this frame.
    for (let b = 1; b < maxBin; b++) {
      let k = 0;
      for (let j = b - freqRadius; j <= b + freqRadius; j++) {
        if (j < 1 || j >= maxBin) continue;
        freqScratch[k++] = mag[j];
      }
      freqMed[b] = medianInPlace(freqScratch, k);
    }

    let p = 0;
    let h = 0;
    for (let b = 1; b < maxBin; b++) {
      // Harmonic estimate: median along time for this bin.
      let k = 0;
      for (let t = f - timeRadius; t <= f + timeRadius; t++) {
        if (t < 0 || t >= n) continue;
        timeScratch[k++] = frames[t][b];
      }
      const hv = medianInPlace(timeScratch, k);
      const pv = freqMed[b];
      const denom = pv * pv + hv * hv + 1e-12;
      // Wiener-style soft mask
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
    computed.push(f);
  }

  // Fill the strided gaps by interpolating between computed frames.
  for (let i = 0; i + 1 < computed.length; i++) {
    const f0 = computed[i];
    const f1 = computed[i + 1];
    for (let f = f0 + 1; f < f1; f++) {
      const w = (f - f0) / (f1 - f0);
      percussive[f] = percussive[f0] * (1 - w) + percussive[f1] * w;
      harmonic[f] = harmonic[f0] * (1 - w) + harmonic[f1] * w;
    }
  }
  // And hold the last computed value through any tail.
  const last = computed[computed.length - 1] ?? 0;
  for (let f = last + 1; f < n; f++) {
    percussive[f] = percussive[last];
    harmonic[f] = harmonic[last];
  }

  return {
    percussive: smooth(percussive, 3),
    harmonic: smooth(harmonic, 3),
    percussiveRatio: percTotal / (percTotal + harmTotal + 1e-12),
  };
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
  frameOffset = 0,
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

  // Where do onsets land inside each beat? Twelve subdivisions resolve both the
  // sixteenth-note grid (0, 3, 6, 9) and the triplet positions (4, 8), which is
  // what distinguishes a swung eighth from a straight one.
  //
  // Only detected onset *peaks* are counted, not the envelope frame by frame.
  // The envelope has a noise floor spread across every frame, so integrating it
  // would spread roughly a third of the total across the four on-grid positions
  // whatever the rhythm is, and report every track as heavily syncopated.
  // Peaks are also assigned to their nearest subdivision rather than the
  // subdivisions being point-sampled: an onset is a few frames wide while a
  // subdivision at 128 BPM is only 39 ms, so sampling counts one kick several
  // times over.
  const SUB = 12;
  const histogram = new Float32Array(SUB);
  let beatIdx = 0;
  for (let f = 1; f < onset.length - 1; f++) {
    if (onset[f] < thresh) continue;
    if (onset[f] < onset[f - 1] || onset[f] <= onset[f + 1]) continue;
    const t = frameToTime(f, frameRate, frameOffset);
    while (beatIdx < beats.length - 2 && beats[beatIdx + 1] <= t) beatIdx++;
    const t0 = beats[beatIdx];
    const span = beats[beatIdx + 1] - t0;
    if (span <= 0 || t < t0) continue;
    const phase = (t - t0) / span;
    if (phase < 0 || phase >= 1) continue;
    histogram[Math.round(phase * SUB) % SUB] += onset[f];
  }
  const total = histogram.reduce((a, b) => a + b, 0) || 1e-9;
  // Sixteenth-note positions.
  const onGrid = histogram[0] + histogram[3] + histogram[6] + histogram[9];
  const syncopation = clamp(1 - onGrid / total, 0, 1);
  // Swing: does the second eighth of each beat sit straight (6/12) or on the
  // triplet (8/12)? Comparing those two positions directly means a pattern
  // with nothing at either reads as no swing rather than as noise.
  const straightEighth = histogram[6];
  const swungEighth = histogram[8];
  const swing = clamp(
    (swungEighth - straightEighth) / (swungEighth + straightEighth + 1e-9),
    0, 1,
  );

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
