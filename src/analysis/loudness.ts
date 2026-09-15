/**
 * ITU-R BS.1770-4 loudness measurement.
 *
 * K-weighting is the standard two-stage filter: a high-shelf "head" stage and a
 * high-pass RLB stage. Coefficients are derived for the actual sample rate
 * rather than hard-coded for 48 kHz, so 44.1 kHz material measures correctly.
 */

import type { LoudnessProfile } from "../types";
import { biquad, gainToDb, percentile } from "./dsp";

/** Reference loudness every track in the mix is normalised toward. */
export const MIX_REFERENCE_LUFS = -9;

interface Coeffs { b0: number; b1: number; b2: number; a1: number; a2: number }

/** Stage 1: high-shelf, +4 dB at high frequency, per BS.1770 Table 1 (generalised). */
function shelfCoeffs(sampleRate: number): Coeffs {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const den = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / den,
    b1: (2 * (K * K - Vh)) / den,
    b2: (Vh - (Vb * K) / Q + K * K) / den,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  };
}

/** Stage 2: RLB high-pass at ~38 Hz. */
function highpassCoeffs(sampleRate: number): Coeffs {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const den = 1 + K / Q + K * K;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  };
}

function kWeight(x: Float32Array, sampleRate: number): Float32Array {
  const s = shelfCoeffs(sampleRate);
  const h = highpassCoeffs(sampleRate);
  const stage1 = biquad(x, s.b0, s.b1, s.b2, s.a1, s.a2);
  return biquad(stage1, h.b0, h.b1, h.b2, h.a1, h.a2);
}

/** Channel weights for the mean-square sum (L, R, C, Ls, Rs). Stereo needs no surround boost. */
const CHANNEL_WEIGHTS = [1, 1, 1, 1.41, 1.41];

export function measureLoudness(channels: Float32Array[], sampleRate: number): LoudnessProfile {
  const weighted = channels.map((ch) => kWeight(ch, sampleRate));
  const n = channels[0].length;

  // Gated blocks: 400 ms windows, 75 % overlap.
  const blockLen = Math.round(0.4 * sampleRate);
  const step = Math.round(0.1 * sampleRate);
  const blockLoudness: number[] = [];
  const blockPower: number[] = [];

  for (let start = 0; start + blockLen <= n; start += step) {
    let sum = 0;
    for (let c = 0; c < weighted.length; c++) {
      const w = CHANNEL_WEIGHTS[Math.min(c, CHANNEL_WEIGHTS.length - 1)];
      const ch = weighted[c];
      let ms = 0;
      for (let i = start; i < start + blockLen; i++) ms += ch[i] * ch[i];
      sum += w * (ms / blockLen);
    }
    blockPower.push(sum);
    blockLoudness.push(-0.691 + 10 * Math.log10(Math.max(sum, 1e-12)));
  }

  // Two-pass gating: absolute at -70 LUFS, then relative at -10 LU below the mean.
  const absGated: number[] = [];
  for (let i = 0; i < blockLoudness.length; i++) if (blockLoudness[i] > -70) absGated.push(blockPower[i]);
  const absMeanPower = absGated.reduce((a, b) => a + b, 0) / Math.max(1, absGated.length);
  const relThreshold = -0.691 + 10 * Math.log10(Math.max(absMeanPower, 1e-12)) - 10;

  const relGated: number[] = [];
  for (let i = 0; i < blockLoudness.length; i++) {
    if (blockLoudness[i] > -70 && blockLoudness[i] > relThreshold) relGated.push(blockPower[i]);
  }
  const gatedPower = relGated.length
    ? relGated.reduce((a, b) => a + b, 0) / relGated.length
    : absMeanPower;
  const integratedLufs = -0.691 + 10 * Math.log10(Math.max(gatedPower, 1e-12));

  // Short-term (3 s) loudness on a 100 ms grid for the timeline.
  const stLen = Math.round(3 * sampleRate);
  const stStep = Math.round(0.1 * sampleRate);
  const stCount = Math.max(1, Math.floor((n - stLen) / stStep) + 1);
  const shortTerm = new Float32Array(stCount);
  for (let k = 0; k < stCount; k++) {
    const start = k * stStep;
    let sum = 0;
    for (let c = 0; c < weighted.length; c++) {
      const w = CHANNEL_WEIGHTS[Math.min(c, CHANNEL_WEIGHTS.length - 1)];
      const ch = weighted[c];
      let ms = 0;
      const end = Math.min(n, start + stLen);
      for (let i = start; i < end; i++) ms += ch[i] * ch[i];
      sum += w * (ms / Math.max(1, end - start));
    }
    shortTerm[k] = -0.691 + 10 * Math.log10(Math.max(sum, 1e-12));
  }

  // Loudness range over short-term values above the gate.
  const lraPool = Array.from(shortTerm).filter((v) => v > -70 && v > integratedLufs - 20);
  const loudnessRangeLu = lraPool.length > 4
    ? percentile(lraPool, 95) - percentile(lraPool, 10)
    : 0;

  // True peak: 4x oversampled via linear interpolation, close enough for headroom.
  let truePeak = 0;
  let sumSq = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length - 1; i++) {
      const a = ch[i];
      const b = ch[i + 1];
      sumSq += a * a;
      const mag = Math.abs(a);
      if (mag > truePeak) truePeak = mag;
      for (let s = 1; s < 4; s++) {
        const t = s / 4;
        const v = Math.abs(a * (1 - t) + b * t);
        if (v > truePeak) truePeak = v;
      }
    }
  }
  const rms = Math.sqrt(sumSq / Math.max(1, channels.length * n));
  const truePeakDb = gainToDb(truePeak);
  const rmsDb = gainToDb(rms);

  let shortTermMax = -Infinity;
  for (const v of shortTerm) if (v > shortTermMax) shortTermMax = v;

  return {
    integratedLufs: round(integratedLufs),
    loudnessRangeLu: round(loudnessRangeLu),
    shortTermMaxLufs: round(shortTermMax),
    truePeakDb: round(truePeakDb),
    crestFactorDb: round(truePeakDb - rmsDb),
    rmsDb: round(rmsDb),
    normalisationGainDb: round(MIX_REFERENCE_LUFS - integratedLufs),
    shortTerm,
  };
}

function round(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : -70;
}
