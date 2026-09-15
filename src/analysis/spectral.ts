/**
 * Spectral, stereo and per-band measurements.
 */

import { BAND_EDGES, BAND_NAMES, type SpectralProfile, type StereoProfile } from "../types";
import { type Spectrogram, clamp, gainToDb, mean, median, percentile, smooth } from "./dsp";

export interface BandTimelines {
  /** [band][frame] energy in dB */
  bands: Float32Array[];
  centroid: Float32Array;
  flux: Float32Array;
  energy: Float32Array;
}

/** Bin index ranges for each band edge pair. */
function bandRanges(fftSize: number, sampleRate: number, bins: number): [number, number][] {
  const binHz = sampleRate / fftSize;
  const ranges: [number, number][] = [];
  for (let i = 0; i < BAND_NAMES.length; i++) {
    const lo = Math.max(1, Math.floor(BAND_EDGES[i] / binHz));
    const hi = Math.min(bins - 1, Math.ceil(BAND_EDGES[i + 1] / binHz));
    ranges.push([lo, Math.max(lo + 1, hi)]);
  }
  return ranges;
}

export function bandTimelines(spec: Spectrogram): BandTimelines {
  const { frames, bins, fftSize, sampleRate } = spec;
  const ranges = bandRanges(fftSize, sampleRate, bins);
  const n = frames.length;
  const bands = ranges.map(() => new Float32Array(n));
  const centroid = new Float32Array(n);
  const flux = new Float32Array(n);
  const energy = new Float32Array(n);
  const binHz = sampleRate / fftSize;

  let prev: Float32Array | null = null;
  for (let f = 0; f < n; f++) {
    const mag = frames[f];
    for (let b = 0; b < ranges.length; b++) {
      const [lo, hi] = ranges[b];
      let s = 0;
      for (let k = lo; k < hi; k++) s += mag[k] * mag[k];
      bands[b][f] = gainToDb(Math.sqrt(s / (hi - lo)));
    }
    let num = 0;
    let den = 0;
    let tot = 0;
    for (let k = 1; k < bins; k++) {
      const m = mag[k];
      num += k * binHz * m;
      den += m;
      tot += m * m;
    }
    centroid[f] = den > 0 ? num / den : 0;
    energy[f] = Math.sqrt(tot / bins);
    if (prev) {
      let d = 0;
      for (let k = 1; k < bins; k++) {
        const diff = mag[k] - prev[k];
        if (diff > 0) d += diff * diff;
      }
      flux[f] = Math.sqrt(d);
    }
    prev = mag;
  }
  if (n > 1) flux[0] = flux[1];

  return { bands, centroid, flux, energy };
}

export function spectralProfile(spec: Spectrogram, tl: BandTimelines): SpectralProfile {
  const { frames, bins, fftSize, sampleRate } = spec;
  const binHz = sampleRate / fftSize;
  const ranges = bandRanges(fftSize, sampleRate, bins);

  // Average magnitude spectrum over loud frames only, so silence does not skew it.
  const energySorted = percentile(tl.energy, 55);
  const avg = new Float32Array(bins);
  let used = 0;
  for (let f = 0; f < frames.length; f++) {
    if (tl.energy[f] < energySorted) continue;
    const mag = frames[f];
    for (let b = 0; b < bins; b++) avg[b] += mag[b];
    used++;
  }
  if (used > 0) for (let b = 0; b < bins; b++) avg[b] /= used;

  // Rolloff: frequency below which 85 % of the energy sits.
  let total = 0;
  for (let b = 1; b < bins; b++) total += avg[b] * avg[b];
  let acc = 0;
  let rolloff = 0;
  for (let b = 1; b < bins; b++) {
    acc += avg[b] * avg[b];
    if (acc >= total * 0.85) {
      rolloff = b * binHz;
      break;
    }
  }

  const centroidHz = mean(tl.centroid.filter((v) => v > 0));

  // Bandwidth: energy-weighted spread around the centroid.
  let spread = 0;
  let den = 0;
  for (let b = 1; b < bins; b++) {
    const hz = b * binHz;
    spread += avg[b] * (hz - centroidHz) ** 2;
    den += avg[b];
  }
  const bandwidthHz = den > 0 ? Math.sqrt(spread / den) : 0;

  // Flatness: geometric over arithmetic mean (Wiener entropy).
  let logSum = 0;
  let arith = 0;
  let count = 0;
  for (let b = 1; b < bins; b++) {
    const v = Math.max(avg[b], 1e-10);
    logSum += Math.log(v);
    arith += v;
    count++;
  }
  const flatness = count ? Math.exp(logSum / count) / (arith / count) : 0;

  // Spectral contrast: peak-to-valley within each band on the averaged spectrum.
  const contrastDb: number[] = [];
  const bandsDb: number[] = [];
  for (const [lo, hi] of ranges) {
    const slice = avg.subarray(lo, hi);
    const peak = percentile(slice, 90);
    const valley = percentile(slice, 15);
    contrastDb.push(round(gainToDb(peak) - gainToDb(valley)));
    bandsDb.push(round(gainToDb(Math.max(median(slice), 1e-10))));
  }

  // Brightness: energy above 4 kHz relative to total.
  const hiStart = Math.floor(4000 / binHz);
  let hiE = 0;
  let allE = 0;
  for (let b = 1; b < bins; b++) {
    const e = avg[b] * avg[b];
    allE += e;
    if (b >= hiStart) hiE += e;
  }

  return {
    centroidHz: Math.round(centroidHz),
    rolloff85Hz: Math.round(rolloff),
    bandwidthHz: Math.round(bandwidthHz),
    flatness: round(flatness, 4),
    bandsDb,
    contrastDb,
    fluxMean: round(mean(tl.flux), 4),
    brightness: round(allE > 0 ? hiE / allE : 0, 4),
  };
}

export function stereoProfile(channels: Float32Array[], sampleRate: number): StereoProfile {
  if (channels.length < 2) {
    return { width: 0, correlation: 1, sideToMidDb: -80, bassMonoRatio: 1 };
  }
  const [l, r] = channels;
  const n = Math.min(l.length, r.length);
  let midE = 0;
  let sideE = 0;
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < n; i++) {
    const m = (l[i] + r[i]) * 0.5;
    const s = (l[i] - r[i]) * 0.5;
    midE += m * m;
    sideE += s * s;
    lr += l[i] * r[i];
    ll += l[i] * l[i];
    rr += r[i] * r[i];
  }
  const correlation = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
  const sideToMidDb = gainToDb(Math.sqrt(sideE / Math.max(midE, 1e-12)));

  // Bass mono ratio: low-passed mid vs side energy below ~150 Hz.
  // A one-pole low-pass is plenty for a ratio measurement.
  const a = Math.exp((-2 * Math.PI * 150) / sampleRate);
  let lpMid = 0;
  let lpSide = 0;
  let bMid = 0;
  let bSide = 0;
  for (let i = 0; i < n; i++) {
    const m = (l[i] + r[i]) * 0.5;
    const s = (l[i] - r[i]) * 0.5;
    lpMid = m * (1 - a) + lpMid * a;
    lpSide = s * (1 - a) + lpSide * a;
    bMid += lpMid * lpMid;
    bSide += lpSide * lpSide;
  }
  const bassMonoRatio = clamp(bMid / Math.max(bMid + bSide, 1e-12), 0, 1);

  return {
    width: round(clamp(Math.sqrt(sideE / Math.max(midE + sideE, 1e-12)) * 2, 0, 1), 3),
    correlation: round(correlation, 3),
    sideToMidDb: round(sideToMidDb),
    bassMonoRatio: round(bassMonoRatio, 3),
  };
}

/** Composite 0..1 energy timeline blending loudness with band weighting. */
export function energyTimeline(tl: BandTimelines): Float32Array {
  const n = tl.energy.length;
  const out = new Float32Array(n);
  // Weight bands the way a dancefloor hears intensity: kick/bass and presence.
  const weights = [1.0, 1.3, 0.9, 0.8, 1.0, 0.7, 0.4];
  for (let f = 0; f < n; f++) {
    let s = 0;
    let w = 0;
    for (let b = 0; b < tl.bands.length; b++) {
      const db = tl.bands[b][f];
      // Map -60..0 dB onto 0..1
      s += clamp((db + 60) / 60, 0, 1) * weights[b];
      w += weights[b];
    }
    out[f] = s / w;
  }
  return smooth(out, 8);
}

function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Number.isFinite(v) ? Math.round(v * f) / f : 0;
}
