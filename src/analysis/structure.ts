/**
 * Structural segmentation and cue-point extraction.
 *
 * Features are aggregated per bar so the self-similarity matrix is small and
 * musically aligned. Boundaries come from checkerboard-kernel novelty on the
 * SSM (Foote), then get snapped to the nearest phrase boundary because dance
 * music changes on phrase lines, not wherever the novelty peak happens to sit.
 * Sections are then labelled from their energy / drive / vocal signature and
 * their position relative to their neighbours.
 */

import type { BeatGrid, CuePoint, Section, SectionLabel, Timelines } from "../types";
import { clamp, mean, percentile, smooth } from "./dsp";

interface BarFeature {
  start: number;
  end: number;
  vec: Float32Array;
  energy: number;
  vocal: number;
  percussive: number;
  centroid: number;
}

/** One feature vector per bar: chroma + band energies + drive descriptors. */
function barFeatures(
  grid: BeatGrid,
  tl: Timelines,
  chroma: Float32Array[],
  duration: number,
): BarFeature[] {
  const bars: BarFeature[] = [];
  const bounds: number[] = Array.from(grid.downbeats);
  if (bounds.length < 2) {
    // No usable grid: fall back to fixed 4 s blocks so downstream code still works.
    for (let t = 0; t < duration; t += 4) bounds.push(t);
  }
  bounds.push(duration);

  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const f0 = Math.max(0, Math.floor(start / tl.frameRate));
    const f1 = Math.min(tl.energy.length, Math.max(f0 + 1, Math.ceil(end / tl.frameRate)));
    const dim = 12 + tl.bands.length + 3;
    const vec = new Float32Array(dim);

    for (let f = f0; f < f1; f++) {
      const c = chroma[Math.min(f, chroma.length - 1)];
      for (let k = 0; k < 12; k++) vec[k] += c[k];
    }
    for (let b = 0; b < tl.bands.length; b++) {
      let s = 0;
      for (let f = f0; f < f1; f++) s += clamp((tl.bands[b][f] + 60) / 60, 0, 1);
      vec[12 + b] = s / (f1 - f0);
    }
    let energy = 0;
    let vocal = 0;
    let perc = 0;
    let cent = 0;
    for (let f = f0; f < f1; f++) {
      energy += tl.energy[f];
      vocal += tl.vocal[f];
      perc += tl.percussive[f];
      cent += tl.centroid[f];
    }
    const cnt = f1 - f0;
    energy /= cnt;
    vocal /= cnt;
    perc /= cnt;
    cent /= cnt;
    vec[12 + tl.bands.length] = energy;
    vec[13 + tl.bands.length] = vocal;
    vec[14 + tl.bands.length] = perc;

    // L2-normalise so the SSM measures shape, not level.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < vec.length; k++) vec[k] /= norm;

    bars.push({ start, end, vec, energy, vocal, percussive: perc, centroid: cent });
  }
  return bars;
}

/** Foote novelty: correlate a checkerboard kernel along the SSM diagonal. */
function novelty(bars: BarFeature[], kernelBars: number): Float32Array {
  const n = bars.length;
  const nov = new Float32Array(n);
  const k = Math.max(2, kernelBars);
  for (let i = 0; i < n; i++) {
    let past = 0;
    let future = 0;
    let cross = 0;
    let cp = 0;
    let cf = 0;
    let cc = 0;
    for (let a = i - k; a < i; a++) {
      if (a < 0) continue;
      for (let b = i - k; b < i; b++) {
        if (b < 0) continue;
        past += dot(bars[a].vec, bars[b].vec);
        cp++;
      }
      for (let b = i; b < i + k; b++) {
        if (b >= n) continue;
        cross += dot(bars[a].vec, bars[b].vec);
        cc++;
      }
    }
    for (let a = i; a < i + k; a++) {
      if (a >= n) continue;
      for (let b = i; b < i + k; b++) {
        if (b >= n) continue;
        future += dot(bars[a].vec, bars[b].vec);
        cf++;
      }
    }
    const self = (cp ? past / cp : 0) + (cf ? future / cf : 0);
    const other = cc ? (2 * cross) / cc : 0;
    nov[i] = Math.max(0, self - other);
  }
  return smooth(nov, 1);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Peak-pick novelty and snap each boundary to the nearest phrase line. */
function pickBoundaries(nov: Float32Array, phraseBars: number, minBars: number): number[] {
  const n = nov.length;
  const thresh = percentile(nov, 70) + 0.15 * (percentile(nov, 95) - percentile(nov, 70));
  const peaks: { bar: number; strength: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (nov[i] >= thresh && nov[i] >= nov[i - 1] && nov[i] > nov[i + 1]) {
      peaks.push({ bar: i, strength: nov[i] });
    }
  }
  peaks.sort((a, b) => b.strength - a.strength);

  const chosen: number[] = [0];
  for (const p of peaks) {
    // Snap to the phrase grid; phrase-aligned edits are what make a mix feel right.
    const snapped = Math.round(p.bar / phraseBars) * phraseBars;
    const bar = clamp(snapped, 0, n - 1);
    if (chosen.every((c) => Math.abs(c - bar) >= minBars)) chosen.push(bar);
  }
  chosen.sort((a, b) => a - b);
  return chosen;
}

function labelSections(
  bars: BarFeature[],
  boundaries: number[],
): Section[] {
  const energies = bars.map((b) => b.energy);
  const loud = percentile(energies, 78);
  const quiet = percentile(energies, 32);
  const vocals = bars.map((b) => b.vocal);
  const vocalHigh = Math.max(0.28, percentile(vocals, 62));
  const percs = bars.map((b) => b.percussive);
  const drivey = percentile(percs, 55);

  const sections: Section[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const startBar = boundaries[i];
    const endBar = i + 1 < boundaries.length ? boundaries[i + 1] : bars.length;
    if (endBar <= startBar) continue;
    const slice = bars.slice(startBar, endBar);
    const energy = mean(slice.map((b) => b.energy));
    const vocalness = mean(slice.map((b) => b.vocal));
    const drive = mean(slice.map((b) => b.percussive));
    // Trend across the section tells build from breakdown.
    const half = Math.max(1, Math.floor(slice.length / 2));
    const firstHalf = mean(slice.slice(0, half).map((b) => b.energy));
    const secondHalf = mean(slice.slice(-half).map((b) => b.energy));
    const rising = secondHalf - firstHalf;

    const isFirst = i === 0;
    const isLast = i === boundaries.length - 1;
    const prev = sections[sections.length - 1];

    let label: SectionLabel;
    if (isFirst && energy <= loud) label = "intro";
    else if (isLast && energy < loud) label = "outro";
    else if (energy >= loud && drive >= drivey && prev && prev.energy < energy - 0.06) label = "drop";
    else if (rising > 0.05 && energy < loud) label = "build";
    else if (energy <= quiet && drive < drivey) label = "breakdown";
    else if (energy >= loud) label = "groove";
    else if (vocalness >= vocalHigh) label = "bridge";
    else label = "groove";

    sections.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      label,
      energy: round(energy, 3),
      vocalness: round(vocalness, 3),
      drive: round(drive, 3),
      startBar,
      bars: endBar - startBar,
    });
  }
  return sections;
}

export function segment(
  grid: BeatGrid,
  tl: Timelines,
  chroma: Float32Array[],
  duration: number,
): { sections: Section[]; bars: { start: number; end: number }[] } {
  const bars = barFeatures(grid, tl, chroma, duration);
  if (bars.length < 4) {
    return {
      sections: [{
        start: 0, end: duration, label: "groove",
        energy: round(mean(Array.from(tl.energy)), 3),
        vocalness: round(mean(Array.from(tl.vocal)), 3),
        drive: round(mean(Array.from(tl.percussive)), 3),
        startBar: 0, bars: bars.length,
      }],
      bars: bars.map((b) => ({ start: b.start, end: b.end })),
    };
  }
  const nov = novelty(bars, Math.max(4, Math.min(16, grid.phraseBars)));
  // Snap to the 8-bar unit (or the phrase length if it is shorter): 8 bars is
  // the granularity real arrangements change on, even when phrases run to 16
  // or 32 bars.
  const snapUnit = Math.max(2, Math.min(8, grid.phraseBars));
  const boundaries = pickBoundaries(nov, snapUnit, snapUnit);
  return {
    sections: labelSections(bars, boundaries),
    bars: bars.map((b) => ({ start: b.start, end: b.end })),
  };
}

/** Time of the nearest downbeat to `t`, preferring phrase lines when close. */
export function snapToPhrase(grid: BeatGrid, t: number): number {
  if (!grid.phrases.length) return snapToBar(grid, t);
  let best = grid.phrases[0];
  let bestD = Math.abs(best - t);
  for (const p of grid.phrases) {
    const d = Math.abs(p - t);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export function snapToBar(grid: BeatGrid, t: number): number {
  if (!grid.downbeats.length) return t;
  let best = grid.downbeats[0];
  let bestD = Math.abs(best - t);
  for (const d of grid.downbeats) {
    const dd = Math.abs(d - t);
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  return best;
}

export function barIndexAt(grid: BeatGrid, t: number): number {
  let idx = 0;
  for (let i = 0; i < grid.downbeats.length; i++) {
    if (grid.downbeats[i] <= t + 1e-6) idx = i;
    else break;
  }
  return idx;
}

/**
 * Cue points the mixer can actually use. Everything is snapped to a bar, and
 * scored so the planner can prefer the strongest option.
 */
export function findCues(
  grid: BeatGrid,
  tl: Timelines,
  sections: Section[],
  duration: number,
): CuePoint[] {
  const cues: CuePoint[] = [];
  const push = (time: number, kind: CuePoint["kind"], score: number, label: string) => {
    const t = clamp(snapToBar(grid, time), 0, Math.max(0, duration - 0.5));
    if (cues.some((c) => c.kind === kind && Math.abs(c.time - t) < 0.75)) return;
    cues.push({ time: round(t, 3), bar: barIndexAt(grid, t), kind, score: round(score, 3), label });
  };

  // Mix-in: the first bar where a steady beat is established.
  const beatOnset = smooth(tl.percussive, 6);
  let mixIn = 0;
  for (let f = 0; f < beatOnset.length; f++) {
    if (beatOnset[f] > 0.35 && tl.energy[f] > 0.25) {
      mixIn = f * tl.frameRate;
      break;
    }
  }
  push(snapToPhrase(grid, mixIn), "mix-in", 0.9, "beat establishes");

  // Mix-out: last phrase line that still has at least 8 bars of track left and
  // where energy has begun to fall away, i.e. the natural exit ramp.
  const barSeconds = (60 / grid.bpm) * grid.meter;
  const tailGuard = duration - barSeconds * 4;
  let mixOut = tailGuard;
  let bestOutScore = -Infinity;
  for (const p of grid.phrases) {
    if (p < duration * 0.5 || p > tailGuard) continue;
    const f = Math.min(tl.energy.length - 1, Math.round(p / tl.frameRate));
    const ahead = Math.min(tl.energy.length - 1, Math.round((p + barSeconds * 4) / tl.frameRate));
    // Prefer a point where energy is decaying and vocals are out of the way.
    const s = (tl.energy[f] - tl.energy[ahead]) + (1 - tl.vocal[f]) * 0.5 + (p / duration) * 0.3;
    if (s > bestOutScore) {
      bestOutScore = s;
      mixOut = p;
    }
  }
  push(mixOut, "mix-out", 0.85, "energy ramps down on a phrase line");

  // Drops and breakdowns come straight from the section labels.
  for (const s of sections) {
    if (s.label === "drop") push(s.start, "drop", 0.7 + s.energy * 0.3, `drop (${s.bars} bars)`);
    if (s.label === "breakdown" || s.label === "intro") {
      if (s.bars >= 4) push(s.start, "break", 0.6 + (1 - s.energy) * 0.3, `${s.label} (${s.bars} bars)`);
    }
  }

  // Vocal entries and exits, hysteresis-gated so a single loud word does not
  // register as a phrase.
  const vocalSm = smooth(tl.vocal, Math.max(2, Math.round(0.8 / tl.frameRate)));
  let inVocal = false;
  for (let f = 1; f < vocalSm.length; f++) {
    const t = f * tl.frameRate;
    if (!inVocal && vocalSm[f] > 0.45) {
      inVocal = true;
      push(t, "vocal-in", 0.5 + vocalSm[f] * 0.4, "lead vocal enters");
    } else if (inVocal && vocalSm[f] < 0.22) {
      inVocal = false;
      push(t, "vocal-out", 0.5, "lead vocal clears");
    }
  }

  // Loop candidates: 8-bar stretches with very stable energy and no vocal, which
  // are the safe places to hold a groove while the next track arrives.
  for (const p of grid.phrases) {
    const f0 = Math.round(p / tl.frameRate);
    const f1 = Math.round((p + barSeconds * 8) / tl.frameRate);
    if (f1 >= tl.energy.length) break;
    let lo = Infinity;
    let hi = -Infinity;
    let vocalSum = 0;
    for (let f = f0; f < f1; f++) {
      lo = Math.min(lo, tl.energy[f]);
      hi = Math.max(hi, tl.energy[f]);
      vocalSum += tl.vocal[f];
    }
    const flat = hi - lo;
    const vocalMean = vocalSum / (f1 - f0);
    if (flat < 0.1 && vocalMean < 0.25 && tl.energy[f0] > 0.3) {
      push(p, "loop", 0.6 + (0.1 - flat) * 2, "8-bar stable groove");
    }
  }

  cues.sort((a, b) => a.time - b.time);
  return cues;
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Number.isFinite(v) ? Math.round(v * f) / f : 0;
}
