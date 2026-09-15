/** Helpers for reading analysis timelines and grids at arbitrary times. */

import type { BeatGrid, CuePoint, Section, TrackAnalysis } from "../types";
import { clamp } from "../analysis/dsp";

export function valueAt(series: Float32Array, frameRate: number, t: number): number {
  if (!series.length) return 0;
  const idx = clamp(Math.round(t / frameRate), 0, series.length - 1);
  return series[idx];
}

export function meanOver(series: Float32Array, frameRate: number, t0: number, t1: number): number {
  if (!series.length) return 0;
  const a = clamp(Math.floor(Math.min(t0, t1) / frameRate), 0, series.length - 1);
  const b = clamp(Math.ceil(Math.max(t0, t1) / frameRate), a + 1, series.length);
  let s = 0;
  for (let i = a; i < b; i++) s += series[i];
  return s / (b - a);
}

/** Seconds per bar at the track's own tempo. */
export function barSeconds(grid: BeatGrid): number {
  return (60 / Math.max(grid.bpm, 1)) * grid.meter;
}

/** The phrase line at or before `t`, falling back to bars then to `t` itself. */
export function phraseAtOrBefore(grid: BeatGrid, t: number): number {
  let best = Number.NaN;
  for (const p of grid.phrases) {
    if (p <= t + 1e-6) best = p;
    else break;
  }
  if (Number.isFinite(best)) return best;
  for (const d of grid.downbeats) if (d <= t + 1e-6) best = d;
  return Number.isFinite(best) ? best : t;
}

/** All phrase lines inside [t0, t1]. */
export function phrasesBetween(grid: BeatGrid, t0: number, t1: number): number[] {
  const out: number[] = [];
  for (const p of grid.phrases) if (p >= t0 && p <= t1) out.push(p);
  return out;
}

/** All bar lines inside [t0, t1]. */
export function barsBetween(grid: BeatGrid, t0: number, t1: number): number[] {
  const out: number[] = [];
  for (const d of grid.downbeats) if (d >= t0 && d <= t1) out.push(d);
  return out;
}

export function cuesOfKind(track: TrackAnalysis, kind: CuePoint["kind"]): CuePoint[] {
  return track.cues.filter((c) => c.kind === kind);
}

export function sectionAt(track: TrackAnalysis, t: number): Section | null {
  for (const s of track.sections) if (t >= s.start && t < s.end) return s;
  return track.sections.length ? track.sections[track.sections.length - 1] : null;
}

/** Energy of a track at a time, 0..1. */
export function energyAt(track: TrackAnalysis, t: number): number {
  return valueAt(track.timelines.energy, track.timelines.frameRate, t);
}

export function vocalAt(track: TrackAnalysis, t: number): number {
  return valueAt(track.timelines.vocal, track.timelines.frameRate, t);
}

/** Mean vocal presence over a window, which is what matters for a blend. */
export function vocalOver(track: TrackAnalysis, t0: number, t1: number): number {
  return meanOver(track.timelines.vocal, track.timelines.frameRate, t0, t1);
}

export function energyOver(track: TrackAnalysis, t0: number, t1: number): number {
  return meanOver(track.timelines.energy, track.timelines.frameRate, t0, t1);
}

export function percussiveOver(track: TrackAnalysis, t0: number, t1: number): number {
  return meanOver(track.timelines.percussive, track.timelines.frameRate, t0, t1);
}

/**
 * Tempo matching.
 *
 * Beyond simple pitch-nudging, this looks for the metrical relationships DJs
 * genuinely use: a 174 BPM track and an 87 BPM track already lock together,
 * because two bars of the fast track fill one bar of the slow one. Neither deck
 * is sped up at all — only the metrical level being counted changes. So the
 * ratio reinterprets the incoming track's tempo, and the playback rate is
 * derived from that reinterpreted figure rather than being multiplied by it.
 *
 * Only 1, 2 and 1/2 are offered. Ratios like 3/2 would require pitching a deck
 * by a fifth, which is an effect, not a tempo match.
 */
export interface TempoMatch {
  /** blend tempo, in the outgoing track's metrical frame */
  mixBpm: number;
  /** playback rate for the outgoing deck (1 = unchanged) */
  fromRate: number;
  /** playback rate for the incoming deck (1 = unchanged) */
  toRate: number;
  /** metrical level applied to the incoming track: 1, 2 (double-time) or 0.5 */
  ratio: number;
  /** worst-case audible speed change of either deck, as a fraction */
  stretch: number;
  ok: boolean;
}

const RATIOS = [1, 2, 0.5];

export function matchTempo(fromBpm: number, toBpm: number, maxStretch = 0.06): TempoMatch {
  let best: TempoMatch | null = null;
  // A change of metrical level is a bigger musical decision than a small pitch
  // nudge, so it has to win on merit rather than by a hair.
  const cost = (m: TempoMatch) => m.stretch + (m.ratio === 1 ? 0 : 0.004);

  for (const ratio of RATIOS) {
    // The incoming tempo as it will be counted during the blend.
    const effectiveTo = toBpm * ratio;
    // Meet in the middle, weighted toward the outgoing track so the floor feels
    // the tempo move less.
    const mixBpm = fromBpm * 0.65 + effectiveTo * 0.35;
    const fromRate = mixBpm / fromBpm;
    const toRate = mixBpm / effectiveTo;
    const candidate: TempoMatch = {
      mixBpm,
      fromRate,
      toRate,
      ratio,
      stretch: Math.max(Math.abs(fromRate - 1), Math.abs(toRate - 1)),
      ok: false,
    };
    candidate.ok = candidate.stretch <= maxStretch;
    if (!best || cost(candidate) < cost(best)) best = candidate;
  }
  return best as TempoMatch;
}
