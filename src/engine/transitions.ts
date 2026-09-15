/**
 * Transition selection and automation.
 *
 * For a given pair of tracks the planner enumerates candidate exit points on
 * the outgoing track, entry points on the incoming track, and every transition
 * style that the pair's measurements actually support. Each combination is
 * scored, and the winner is returned with the full parameter automation the
 * live engine needs to execute it.
 *
 * Lane targets are namespaced `a.` for the outgoing deck and `b.` for the
 * incoming one:
 *
 *   a.gain / b.gain              deck gain, linear 0..1
 *   a.stem.<name> / b.stem.<name>  stem gain, linear 0..1 (vocals/drums/bass/other)
 *   a.lowpass / b.lowpass        low-pass cutoff in Hz
 *   a.highpass / b.highpass      high-pass cutoff in Hz
 *   a.eq.<band> / b.eq.<band>    shelving/peaking EQ trim in dB (low/mid/high)
 *   a.echo / b.echo              echo send, 0..1
 *
 * Beat 0 of every lane is the moment the two tracks first sound together.
 */

import { camelotDistance } from "../analysis/key";
import { clamp } from "../analysis/dsp";
import type { AutomationLane, Transition, TransitionKind, TrackAnalysis } from "../types";
import {
  type TempoMatch,
  barSeconds,
  cuesOfKind,
  energyOver,
  matchTempo,
  percussiveOver,
  phraseAtOrBefore,
  phrasesBetween,
  vocalOver,
} from "./query";

/** Open cutoffs, i.e. filters effectively out of circuit. */
const LP_OPEN = 20000;
const HP_OPEN = 20;

export interface TransitionOptions {
  /** maximum fraction either deck may be time-stretched */
  maxStretch: number;
  /** preferred blend length in beats; styles scale around this */
  preferredBeats: number;
  /** true when the set wants energy to rise here */
  wantRise: boolean;
  /** allow long creative blends (stem swaps, double drops) */
  creative: boolean;
}

export const DEFAULT_TRANSITION_OPTIONS: TransitionOptions = {
  maxStretch: 0.06,
  preferredBeats: 32,
  wantRise: false,
  creative: true,
};

function lane(target: string, points: [number, number][]): AutomationLane {
  return { target, points: points.map(([beat, value]) => ({ beat, value })) };
}

/** Context measured once per (exit, entry) pair and shared by every style. */
interface Ctx {
  a: TrackAnalysis;
  b: TrackAnalysis;
  exit: number;
  entry: number;
  tempo: TempoMatch;
  keyDistance: number;
  /** measurements over the blend window itself */
  aVocal: number;
  bVocal: number;
  aEnergy: number;
  bEnergy: number;
  aPerc: number;
  bPerc: number;
  beats: number;
  /** real seconds of blend at the mix tempo */
  seconds: number;
  /** seconds of the outgoing track consumed by the blend */
  aSpan: number;
  /** seconds of the incoming track consumed by the blend */
  bSpan: number;
  /** does the incoming entry land on a drop? */
  entryIsDrop: boolean;
  /** exit and entry both sit on phrase lines */
  phraseLocked: boolean;
}

function makeCtx(
  a: TrackAnalysis,
  b: TrackAnalysis,
  exit: number,
  entry: number,
  beats: number,
  tempo: TempoMatch,
): Ctx {
  const seconds = (beats * 60) / tempo.mixBpm;
  // Each deck's own clock advances at its playback rate, so the stretch of
  // track covered by the blend differs per deck. With a 2:1 metrical ratio the
  // incoming track covers half as many of its own bars as the outgoing one.
  const aSpan = seconds * tempo.fromRate;
  const bSpan = seconds * tempo.toRate;
  const aWin: [number, number] = [exit, exit + aSpan];
  const bWin: [number, number] = [entry, entry + bSpan];
  const entryIsDrop = cuesOfKind(b, "drop").some((c) => Math.abs(c.time - entry) < 0.3);
  const phraseLocked =
    Math.abs(phraseAtOrBefore(a.grid, exit) - exit) < 0.15 &&
    Math.abs(phraseAtOrBefore(b.grid, entry) - entry) < 0.15;

  return {
    a, b, exit, entry, tempo, beats, seconds, aSpan, bSpan,
    keyDistance: camelotDistance(a.key.camelot, b.key.camelot),
    aVocal: vocalOver(a, ...aWin),
    bVocal: vocalOver(b, ...bWin),
    aEnergy: energyOver(a, ...aWin),
    bEnergy: energyOver(b, ...bWin),
    aPerc: percussiveOver(a, ...aWin),
    bPerc: percussiveOver(b, ...bWin),
    entryIsDrop,
    phraseLocked,
  };
}

interface Style {
  kind: TransitionKind;
  /** blend length in beats, or null when the style dictates its own */
  beats: number;
  build(ctx: Ctx): { lanes: AutomationLane[]; rationale: string };
  /** 0 when the pair cannot support this style at all */
  fitness(ctx: Ctx, opts: TransitionOptions): number;
}

/**
 * Bass swap: the workhorse. The incoming track arrives with its low end
 * removed, both tracks share the middle for a phrase, then the basslines trade
 * places on a phrase line so the low end is never doubled.
 */
const bassSwap: Style = {
  kind: "bass-swap",
  beats: 32,
  build(ctx) {
    const n = ctx.beats;
    const swap = n / 2;
    return {
      lanes: [
        lane("b.gain", [[0, 0], [n * 0.15, 1], [n, 1]]),
        lane("b.stem.bass", [[0, 0], [swap - 1, 0], [swap, 1]]),
        lane("b.highpass", [[0, 220], [swap - 1, 220], [swap, HP_OPEN]]),
        lane("a.stem.bass", [[0, 1], [swap - 1, 1], [swap, 0]]),
        lane("a.highpass", [[0, HP_OPEN], [swap - 1, HP_OPEN], [swap, 200]]),
        lane("a.gain", [[0, 1], [swap, 1], [n * 0.9, 0.35], [n, 0]]),
        // Trim the outgoing mids slightly once the new track is carrying them.
        lane("a.eq.mid", [[0, 0], [swap, -2], [n, -6]]),
      ],
      rationale: `bass swap on the phrase line at beat ${swap}`,
    };
  },
  fitness(ctx, opts) {
    if (ctx.keyDistance > 3.5) return 0;
    let s = 0.7;
    if (ctx.phraseLocked) s += 0.15;
    // Needs both tracks to actually have a low end worth swapping.
    s += clamp(Math.min(ctx.a.stereo.bassMonoRatio, ctx.b.stereo.bassMonoRatio), 0, 1) * 0.1;
    // Vocals on both sides at once is the one thing this style cannot hide.
    s -= Math.min(ctx.aVocal, ctx.bVocal) * 0.5;
    s -= clamp(ctx.keyDistance / 4, 0, 1) * 0.2;
    if (opts.wantRise && ctx.bEnergy > ctx.aEnergy) s += 0.08;
    return clamp(s, 0, 1);
  },
};

/**
 * Vocal over instrumental: strip the outgoing track down to its lead vocal and
 * let it ride over the incoming track's instrumental. This is the mashup move,
 * and it is why the stem separator exists.
 */
const vocalOverInstrumental: Style = {
  kind: "vocal-over-instrumental",
  beats: 64,
  build(ctx) {
    const n = ctx.beats;
    const strip = n * 0.25;
    const hold = n * 0.75;
    return {
      lanes: [
        // The incoming track comes up as a full instrumental.
        lane("b.gain", [[0, 0], [n * 0.12, 1], [n, 1]]),
        lane("b.stem.vocals", [[0, 0], [hold, 0], [n, 1]]),
        lane("b.highpass", [[0, 160], [n * 0.2, HP_OPEN]]),
        // The outgoing track loses everything but the voice.
        lane("a.stem.drums", [[0, 1], [strip, 0.25], [strip * 1.4, 0]]),
        lane("a.stem.bass", [[0, 1], [strip * 0.6, 0]]),
        lane("a.stem.other", [[0, 1], [strip, 0.5], [hold, 0.2], [n, 0]]),
        lane("a.stem.vocals", [[0, 1], [hold, 1], [n * 0.95, 0.6], [n, 0]]),
        lane("a.gain", [[0, 1], [hold, 1], [n, 0]]),
        // A touch of echo on the acapella makes the handover feel intentional.
        lane("a.echo", [[0, 0], [hold, 0.15], [n, 0.45]]),
      ],
      rationale: `outgoing acapella rides ${Math.round(n / 4)} bars of the incoming instrumental`,
    };
  },
  fitness(ctx, opts) {
    if (!opts.creative) return 0;
    // Needs a vocal to isolate and an instrumental to put it over.
    if (ctx.aVocal < 0.3) return 0;
    if (ctx.bVocal > 0.3) return 0;
    if (ctx.keyDistance > 2.5) return 0;
    let s = 0.55 + ctx.aVocal * 0.35;
    s += (1 - ctx.bVocal) * 0.15;
    // Harmony matters much more here than in a filtered blend: the vocal is
    // exposed against the new chords.
    s -= clamp(ctx.keyDistance / 2.5, 0, 1) * 0.3;
    s += ctx.a.key.tonalStability * 0.1;
    s += ctx.bPerc * 0.1;
    if (ctx.phraseLocked) s += 0.1;
    return clamp(s, 0, 1);
  },
};

/**
 * Instrumental under vocal, the mirror image: hold the outgoing groove and
 * bring the new track in vocal-first, so the new voice announces itself over
 * music the floor already knows.
 */
const vocalIntro: Style = {
  kind: "vocal-over-instrumental",
  beats: 48,
  build(ctx) {
    const n = ctx.beats;
    const reveal = n * 0.6;
    return {
      lanes: [
        lane("b.gain", [[0, 0], [n * 0.1, 1], [n, 1]]),
        lane("b.stem.vocals", [[0, 1], [n, 1]]),
        lane("b.stem.drums", [[0, 0], [reveal, 0], [n * 0.85, 1]]),
        lane("b.stem.bass", [[0, 0], [reveal, 0], [n * 0.85, 1]]),
        lane("b.stem.other", [[0, 0.2], [reveal, 0.6], [n * 0.85, 1]]),
        lane("a.stem.vocals", [[0, 1], [n * 0.08, 0]]),
        lane("a.stem.drums", [[0, 1], [reveal, 1], [n * 0.9, 0]]),
        lane("a.stem.bass", [[0, 1], [reveal * 0.9, 1], [reveal, 0]]),
        lane("a.stem.other", [[0, 1], [reveal, 0.4], [n, 0]]),
        lane("a.gain", [[0, 1], [n * 0.9, 0.5], [n, 0]]),
      ],
      rationale: "incoming vocal enters over the outgoing groove, band reveal on the phrase",
    };
  },
  fitness(ctx, opts) {
    if (!opts.creative) return 0;
    if (ctx.bVocal < 0.3) return 0;
    if (ctx.aVocal > 0.25) return 0;
    if (ctx.keyDistance > 2.5) return 0;
    let s = 0.5 + ctx.bVocal * 0.3 + ctx.aPerc * 0.15;
    s -= clamp(ctx.keyDistance / 2.5, 0, 1) * 0.3;
    if (ctx.phraseLocked) s += 0.1;
    return clamp(s, 0, 1);
  },
};

/**
 * Filter sweep: the safe option. Neither track's full spectrum is ever present
 * at once, so it survives loose keys and busy arrangements.
 */
const filterSweep: Style = {
  kind: "filter-sweep",
  beats: 32,
  build(ctx) {
    const n = ctx.beats;
    return {
      lanes: [
        lane("b.gain", [[0, 0], [n * 0.2, 1], [n, 1]]),
        lane("b.highpass", [[0, 2400], [n * 0.5, 400], [n * 0.85, HP_OPEN]]),
        lane("a.lowpass", [[0, LP_OPEN], [n * 0.5, 2200], [n * 0.85, 420]]),
        lane("a.gain", [[0, 1], [n * 0.6, 0.8], [n, 0]]),
        lane("a.stem.bass", [[0, 1], [n * 0.5, 0.4], [n * 0.7, 0]]),
        lane("b.stem.bass", [[0, 0], [n * 0.5, 0.3], [n * 0.7, 1]]),
      ],
      rationale: "complementary filter sweep, spectra never overlap fully",
    };
  },
  fitness(ctx, _opts) {
    let s = 0.55;
    // This is the style that tolerates a key clash.
    s += clamp(ctx.keyDistance / 5, 0, 1) * 0.2;
    s -= Math.min(ctx.aVocal, ctx.bVocal) * 0.2;
    if (ctx.phraseLocked) s += 0.1;
    return clamp(s, 0, 1);
  },
};

/** Long harmonic blend: for tracks that genuinely share a key. */
const harmonicBlend: Style = {
  kind: "harmonic-blend",
  beats: 64,
  build(ctx) {
    const n = ctx.beats;
    return {
      lanes: [
        lane("b.gain", [[0, 0], [n * 0.4, 0.75], [n, 1]]),
        lane("b.stem.bass", [[0, 0], [n * 0.45, 0], [n * 0.55, 1]]),
        lane("b.highpass", [[0, 140], [n * 0.55, HP_OPEN]]),
        lane("a.stem.bass", [[0, 1], [n * 0.45, 1], [n * 0.55, 0]]),
        lane("a.gain", [[0, 1], [n * 0.6, 0.8], [n, 0]]),
        // Carve a little space so the two mid ranges do not fight.
        lane("a.eq.mid", [[0, 0], [n * 0.5, -3], [n, -8]]),
        lane("b.eq.mid", [[0, -3], [n * 0.5, 0], [n, 0]]),
      ],
      rationale: `${ctx.a.key.camelot} into ${ctx.b.key.camelot}, long harmonic blend`,
    };
  },
  fitness(ctx, _opts) {
    if (ctx.keyDistance > 1) return 0;
    let s = 0.75 - ctx.keyDistance * 0.15;
    s += Math.min(ctx.a.key.confidence, ctx.b.key.confidence) * 0.15;
    s -= Math.min(ctx.aVocal, ctx.bVocal) * 0.4;
    s -= Math.abs(ctx.aEnergy - ctx.bEnergy) * 0.3;
    if (ctx.phraseLocked) s += 0.1;
    return clamp(s, 0, 1);
  },
};

/** Drop swap: ride the outgoing breakdown, then hand over exactly on the drop. */
const dropSwap: Style = {
  kind: "drop-swap",
  beats: 16,
  build(ctx) {
    const n = ctx.beats;
    const hit = n - 1;
    return {
      lanes: [
        lane("b.gain", [[0, 0.7], [hit, 1], [n, 1]]),
        lane("b.highpass", [[0, 700], [hit - 2, 300], [hit, HP_OPEN]]),
        lane("b.stem.bass", [[0, 0], [hit, 1]]),
        lane("a.stem.bass", [[0, 1], [hit - 0.1, 1], [hit, 0]]),
        lane("a.gain", [[0, 1], [hit - 0.1, 1], [hit, 0.25], [n, 0]]),
        lane("a.echo", [[0, 0], [hit, 0.5], [n, 0.2]]),
      ],
      rationale: "handover lands on the incoming drop",
    };
  },
  fitness(ctx, opts) {
    if (!ctx.entryIsDrop) return 0;
    let s = 0.7;
    if (opts.wantRise) s += 0.15;
    // Works best when the outgoing track has already thinned out.
    s += clamp(0.6 - ctx.aEnergy, 0, 0.6) * 0.4;
    s += clamp(ctx.bEnergy - ctx.aEnergy, 0, 1) * 0.2;
    s -= clamp(ctx.keyDistance / 5, 0, 1) * 0.15;
    if (ctx.phraseLocked) s += 0.1;
    return clamp(s, 0, 1);
  },
};

/** Echo out: short, decisive, and indifferent to harmony. */
const echoOut: Style = {
  kind: "echo-out",
  beats: 8,
  build(ctx) {
    const n = ctx.beats;
    return {
      lanes: [
        lane("b.gain", [[0, 0], [n * 0.25, 1]]),
        lane("b.highpass", [[0, 400], [n * 0.5, HP_OPEN]]),
        lane("b.stem.bass", [[0, 0], [n * 0.4, 1]]),
        lane("a.echo", [[0, 0], [n * 0.2, 0.7], [n, 0.3]]),
        lane("a.stem.bass", [[0, 1], [n * 0.2, 0]]),
        lane("a.stem.drums", [[0, 1], [n * 0.3, 0]]),
        lane("a.lowpass", [[0, LP_OPEN], [n * 0.6, 900]]),
        lane("a.gain", [[0, 1], [n * 0.5, 0.6], [n, 0]]),
      ],
      rationale: "echo the outgoing track out; key clash never resolves audibly",
    };
  },
  fitness(ctx, _opts) {
    let s = 0.4;
    // The escape hatch when nothing else fits.
    s += clamp(ctx.keyDistance / 4, 0, 1) * 0.3;
    s += clamp(ctx.tempo.stretch / 0.06, 0, 1) * 0.15;
    s += Math.min(ctx.aVocal, ctx.bVocal) * 0.2;
    return clamp(s, 0, 1);
  },
};

/** Loop roll: hold the outgoing groove on a stable loop while the new track opens up. */
const loopRoll: Style = {
  kind: "loop-roll",
  beats: 16,
  build(ctx) {
    const n = ctx.beats;
    return {
      lanes: [
        lane("b.gain", [[0, 0], [n * 0.25, 1], [n, 1]]),
        lane("b.highpass", [[0, 1600], [n * 0.75, HP_OPEN]]),
        lane("b.stem.bass", [[0, 0], [n * 0.6, 1]]),
        lane("a.loop", [[0, 1], [n * 0.75, 1], [n * 0.8, 0]]),
        lane("a.stem.vocals", [[0, 1], [n * 0.2, 0]]),
        lane("a.stem.bass", [[0, 1], [n * 0.55, 0]]),
        lane("a.lowpass", [[0, LP_OPEN], [n * 0.8, 1200]]),
        lane("a.gain", [[0, 1], [n * 0.8, 0.7], [n, 0]]),
      ],
      rationale: "outgoing groove loops while the incoming filter opens",
    };
  },
  fitness(ctx, opts) {
    if (!opts.creative) return 0;
    const hasLoop = cuesOfKind(ctx.a, "loop").some((c) => Math.abs(c.time - ctx.exit) < 0.3);
    if (!hasLoop) return 0;
    let s = 0.55 + ctx.a.rhythm.pulseClarity * 0.2;
    s -= ctx.aVocal * 0.3;
    if (ctx.phraseLocked) s += 0.1;
    return clamp(s, 0, 1);
  },
};

/** Double drop: both tracks at full tilt for a phrase. High risk, high reward. */
const doubleDrop: Style = {
  kind: "double-drop",
  beats: 16,
  build(ctx) {
    const n = ctx.beats;
    return {
      lanes: [
        lane("b.gain", [[0, 1], [n, 1]]),
        lane("b.stem.vocals", [[0, 0], [n * 0.5, 0], [n, 1]]),
        lane("b.stem.bass", [[0, 0], [n * 0.5, 1]]),
        lane("a.stem.bass", [[0, 1], [n * 0.5, 0]]),
        lane("a.stem.vocals", [[0, 1], [n * 0.25, 0]]),
        lane("a.gain", [[0, 1], [n * 0.5, 0.85], [n, 0]]),
        // Both tracks running hot needs headroom taken out of the mids.
        lane("a.eq.mid", [[0, -2], [n, -8]]),
        lane("b.eq.mid", [[0, -2], [n, 0]]),
      ],
      rationale: "double drop, basslines and vocals split between the decks",
    };
  },
  fitness(ctx, opts) {
    if (!opts.creative) return 0;
    if (!ctx.entryIsDrop) return 0;
    if (ctx.keyDistance > 1) return 0;
    if (ctx.aEnergy < 0.55 || ctx.bEnergy < 0.55) return 0;
    let s = 0.5;
    s -= Math.abs(ctx.aEnergy - ctx.bEnergy) * 0.5;
    s -= Math.min(ctx.aVocal, ctx.bVocal) * 0.6;
    s += ctx.tempo.stretch < 0.02 ? 0.15 : 0;
    return clamp(s, 0, 1);
  },
};

/** Hard cut: for a deliberate gear change. */
const hardCut: Style = {
  kind: "hard-cut",
  beats: 2,
  build(ctx) {
    const n = ctx.beats;
    return {
      lanes: [
        lane("a.gain", [[0, 1], [n * 0.5, 0]]),
        lane("b.gain", [[0, 0], [n * 0.5, 1]]),
      ],
      rationale: "cut on the downbeat, no blend attempted",
    };
  },
  fitness(ctx, _opts) {
    // Only when the pair is genuinely unmixable.
    const unmixable = !ctx.tempo.ok || ctx.keyDistance > 4.5;
    return unmixable ? 0.45 : 0.08;
  },
};

const STYLES: Style[] = [
  bassSwap,
  vocalOverInstrumental,
  vocalIntro,
  filterSweep,
  harmonicBlend,
  dropSwap,
  echoOut,
  loopRoll,
  doubleDrop,
  hardCut,
];

/**
 * Candidate exit points on the outgoing track, best first. `blendTrackSeconds`
 * is how much of this track's own timeline the blend consumes, so an exit is
 * only offered when there is that much material left after it.
 */
function exitCandidates(a: TrackAnalysis, blendTrackSeconds: number): number[] {
  const out: number[] = [];
  const tailGuard = a.duration - blendTrackSeconds;
  for (const c of cuesOfKind(a, "mix-out")) if (c.time <= tailGuard) out.push(c.time);
  for (const c of cuesOfKind(a, "loop")) if (c.time > a.duration * 0.45 && c.time <= tailGuard) out.push(c.time);
  // Phrase lines through the back half give the planner room to manoeuvre.
  for (const p of phrasesBetween(a.grid, a.duration * 0.45, tailGuard)) out.push(p);
  if (!out.length) out.push(Math.max(0, tailGuard));
  return dedupe(out, 0.5).slice(0, 10);
}

/**
 * Candidate entry points on the incoming track. `blendTrackSeconds` is how much
 * of this track's own timeline the blend will consume, which is what the
 * drop-landing entry has to be measured against.
 */
function entryCandidates(b: TrackAnalysis, blendTrackSeconds: number): number[] {
  const out: number[] = [];
  for (const c of cuesOfKind(b, "mix-in")) out.push(c.time);
  for (const c of cuesOfKind(b, "vocal-in")) if (c.time < b.duration * 0.7) out.push(c.time);
  // Entering so the blend lands exactly on a drop is the highest-value option.
  for (const c of cuesOfKind(b, "drop")) {
    const lead = c.time - blendTrackSeconds;
    if (lead >= 0) out.push(lead);
  }
  const first = b.grid.phrases.length ? b.grid.phrases[0] : 0;
  out.push(first);
  out.push(0);
  return dedupe(out.filter((t) => t >= 0 && t < b.duration * 0.8), 0.5).slice(0, 8);
}

function dedupe(values: number[], tol: number): number[] {
  const out: number[] = [];
  for (const v of values) if (!out.some((o) => Math.abs(o - v) < tol)) out.push(v);
  return out;
}

export interface TransitionCandidate extends Transition {
  /** how much of the outgoing track plays before the blend starts */
  exitTime: number;
  entryTime: number;
  fromRate: number;
  toRate: number;
}

/**
 * Choose the best transition from `a` into `b`, considering every exit, entry
 * and style the pair supports.
 */
export function planTransition(
  a: TrackAnalysis,
  b: TrackAnalysis,
  options: Partial<TransitionOptions> = {},
): TransitionCandidate {
  const opts = { ...DEFAULT_TRANSITION_OPTIONS, ...options };
  const tempo = matchTempo(a.grid.bpm, b.grid.bpm, opts.maxStretch);

  let best: TransitionCandidate | null = null;

  for (const style of STYLES) {
    // Scale the style's natural length toward the caller's preference, but keep
    // it a whole number of bars.
    const blend = Math.max(
      2,
      Math.round((style.beats * 0.6 + opts.preferredBeats * 0.4) / a.grid.meter) * a.grid.meter,
    );
    const beats = style === hardCut ? style.beats : blend;
    const blendSeconds = (beats * 60) / tempo.mixBpm;
    const aSpan = blendSeconds * tempo.fromRate;
    const bSpan = blendSeconds * tempo.toRate;

    for (const exit of exitCandidates(a, aSpan)) {
      for (const entry of entryCandidates(b, bSpan)) {
        // Both tracks must have enough material left to complete the blend.
        if (exit + aSpan > a.duration + 0.25) continue;
        if (entry + bSpan > b.duration) continue;
        const ctx = makeCtx(a, b, exit, entry, beats, tempo);

        const fit = style.fitness(ctx, opts);
        if (fit <= 0) continue;

        // Global penalties that apply whatever the style.
        let score = fit;
        score -= clamp((ctx.tempo.stretch - 0.03) / 0.03, 0, 1) * 0.15;
        if (!ctx.tempo.ok && style !== hardCut && style !== echoOut) score -= 0.3;
        // Prefer leaving a track after it has done its work.
        score += clamp(exit / a.duration, 0, 1) * 0.1;
        // Prefer entries that are not buried deep inside the incoming track.
        score -= clamp(entry / Math.max(b.duration, 1), 0, 1) * 0.15;
        score += a.mixability * 0.05 + b.mixability * 0.05;

        if (!best || score > best.score) {
          const { lanes, rationale } = style.build(ctx);
          best = {
            kind: style.kind,
            beats,
            fromTime: exit,
            toTime: entry,
            mixBpm: Math.round(tempo.mixBpm * 100) / 100,
            lanes,
            rationale,
            score: Math.round(score * 1000) / 1000,
            exitTime: exit,
            entryTime: entry,
            fromRate: tempo.fromRate,
            toRate: tempo.toRate,
          };
        }
      }
    }
  }

  if (best) return best;

  // Nothing scored: fall back to a cut at the last phrase line, which always works.
  const exit = phraseAtOrBefore(a.grid, Math.max(0, a.duration - barSeconds(a.grid)));
  const ctx = makeCtx(a, b, exit, 0, hardCut.beats, tempo);
  const { lanes, rationale } = hardCut.build(ctx);
  return {
    kind: "hard-cut",
    beats: hardCut.beats,
    fromTime: exit,
    toTime: 0,
    mixBpm: Math.round(tempo.mixBpm * 100) / 100,
    lanes,
    rationale,
    score: 0,
    exitTime: exit,
    entryTime: 0,
    fromRate: tempo.fromRate,
    toRate: tempo.toRate,
  };
}

/** Value of a lane at a given beat, with linear interpolation between points. */
export function laneValueAt(lane: AutomationLane, beat: number): number {
  const pts = lane.points;
  if (!pts.length) return 0;
  if (beat <= pts[0].beat) return pts[0].value;
  for (let i = 1; i < pts.length; i++) {
    if (beat <= pts[i].beat) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const span = p1.beat - p0.beat;
      if (span <= 1e-9) return p1.value;
      const t = (beat - p0.beat) / span;
      return p0.value + (p1.value - p0.value) * t;
    }
  }
  return pts[pts.length - 1].value;
}

export { LP_OPEN, HP_OPEN };
