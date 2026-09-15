/**
 * Set ordering and mix-timeline assembly.
 *
 * Ordering is greedy with a cheap pairwise compatibility score, because the
 * full transition search is far too expensive to run over every pair: for N
 * tracks we score N^2 cheap comparisons, then run the real search only on the
 * N-1 pairs we actually chose.
 *
 * Compatibility weighs harmonic distance on the Camelot wheel, how far either
 * deck has to be stretched, how well the candidate's energy fits the arc the
 * set is meant to follow at that point, and variety so the mix does not sit in
 * one key or one timbre for half an hour.
 */

import { camelotDistance } from "../analysis/key";
import { clamp } from "../analysis/dsp";
import { MIX_REFERENCE_LUFS } from "../analysis/loudness";
import type { MixPlan, MixStep, TrackAnalysis } from "../types";
import { type TransitionCandidate, planTransition } from "./transitions";
import { barSeconds, cuesOfKind, matchTempo } from "./query";

export interface PlanOptions {
  /** maximum fraction either deck may be time-stretched */
  maxStretch: number;
  /** preferred blend length in beats */
  preferredBeats: number;
  /** allow stem swaps, double drops and other creative blends */
  creative: boolean;
  /** energy at the start of the set, 0..1 */
  startEnergy: number;
  /** energy at the peak, 0..1 */
  peakEnergy: number;
  /** where the peak sits, as a fraction of the set */
  peakPosition: number;
  /** energy at the end, 0..1 */
  endEnergy: number;
  /** 0 = strictly follow the arc and keys, 1 = maximise variety */
  adventurousness: number;
  /** pin this track first; otherwise the best opener is chosen */
  firstTrackId?: string;
  /** cap the number of tracks used */
  maxTracks?: number;
  /** ramp length in bars after an incoming blend completes */
  rampBars: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  maxStretch: 0.06,
  preferredBeats: 32,
  creative: true,
  startEnergy: 0.45,
  peakEnergy: 0.95,
  peakPosition: 0.72,
  endEnergy: 0.6,
  adventurousness: 0.35,
  rampBars: 8,
};

/** Target energy for position `i` of `n` along the set's arc. */
export function arcTarget(i: number, n: number, o: PlanOptions): number {
  if (n <= 1) return o.peakEnergy;
  const x = i / (n - 1);
  const p = clamp(o.peakPosition, 0.05, 0.95);
  if (x <= p) {
    // Ease in toward the peak rather than climbing linearly: sets that rise too
    // evenly feel mechanical.
    const t = x / p;
    return o.startEnergy + (o.peakEnergy - o.startEnergy) * (t * t * (3 - 2 * t));
  }
  const t = (x - p) / (1 - p);
  return o.peakEnergy + (o.endEnergy - o.peakEnergy) * (t * t * (3 - 2 * t));
}

/** Cheap pairwise score used for ordering. Higher is better. */
export function compatibility(
  a: TrackAnalysis,
  b: TrackAnalysis,
  targetEnergy: number,
  o: PlanOptions,
  recentKeys: string[] = [],
): { score: number; keyDistance: number; stretch: number } {
  const keyDistance = camelotDistance(a.key.camelot, b.key.camelot);
  const tempo = matchTempo(a.grid.bpm, b.grid.bpm, o.maxStretch);

  // Harmony: a same-or-neighbouring key is worth a lot; beyond two steps the
  // planner has to lean on filter or echo transitions, so it costs.
  const keyScore = 1 - clamp(keyDistance / 4, 0, 1);
  // Tempo: free inside the stretch budget, falls off sharply past it.
  const tempoScore = tempo.ok
    ? 1 - clamp(tempo.stretch / o.maxStretch, 0, 1) * 0.35
    : clamp(1 - (tempo.stretch - o.maxStretch) / 0.08, 0, 1) * 0.4;
  // Arc: how close this track sits to where the set should be.
  const arcScore = 1 - clamp(Math.abs(b.energyScore - targetEnergy) / 0.45, 0, 1);
  // Direction: moving with the arc beats moving against it.
  const wantRise = targetEnergy > a.energyScore;
  const rises = b.energyScore > a.energyScore;
  const directionScore = wantRise === rises ? 1 : 0.55;

  // Variety: discourage sitting in one key, and reward a change of timbre.
  const keyRepeats = recentKeys.filter((k) => k === b.key.camelot).length;
  const varietyScore = clamp(1 - keyRepeats * 0.35, 0, 1);
  const timbreDelta = Math.abs(a.spectral.brightness - b.spectral.brightness);
  const timbreScore = clamp(timbreDelta * 4, 0, 1);

  // Two dense vocal tracks back to back is tiring and hard to blend.
  const vocalClash = Math.min(a.vocalDensity, b.vocalDensity);

  const adv = clamp(o.adventurousness, 0, 1);
  const score =
    0.30 * (1 - adv * 0.45) * keyScore +
    0.22 * tempoScore +
    0.18 * arcScore +
    0.08 * directionScore +
    0.09 * varietyScore +
    0.05 * (adv * timbreScore + (1 - adv) * (1 - timbreScore)) +
    0.08 * b.mixability -
    0.06 * vocalClash;

  return { score, keyDistance, stretch: tempo.stretch };
}

/** Order the tracks into a set. */
export function orderSet(tracks: TrackAnalysis[], options: Partial<PlanOptions> = {}): TrackAnalysis[] {
  const o = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const pool = tracks.slice(0, o.maxTracks ?? tracks.length);
  if (pool.length <= 1) return pool;

  const remaining = new Map(pool.map((t) => [t.id, t]));
  const order: TrackAnalysis[] = [];

  // Opener: closest to the arc's starting energy, weighted by how forgiving the
  // track is to mix out of.
  let first: TrackAnalysis | undefined = o.firstTrackId ? remaining.get(o.firstTrackId) : undefined;
  if (!first) {
    const target = arcTarget(0, pool.length, o);
    first = pool.reduce((best, t) => {
      const score = (x: TrackAnalysis) =>
        1 - Math.abs(x.energyScore - target) + x.mixability * 0.4 +
        (cuesOfKind(x, "mix-out").length ? 0.1 : 0);
      return score(t) > score(best) ? t : best;
    });
  }
  order.push(first);
  remaining.delete(first.id);

  while (remaining.size) {
    const current = order[order.length - 1];
    const target = arcTarget(order.length, pool.length, o);
    const recentKeys = order.slice(-3).map((t) => t.key.camelot);
    let bestTrack: TrackAnalysis | null = null;
    let bestScore = -Infinity;
    for (const cand of remaining.values()) {
      const { score } = compatibility(current, cand, target, o, recentKeys);
      // Lookahead: a track that strands the set in an unmixable corner is a bad
      // pick even when it scores well on its own.
      let escape = 0;
      if (remaining.size > 1) {
        let bestNext = -Infinity;
        for (const next of remaining.values()) {
          if (next.id === cand.id) continue;
          const nextTarget = arcTarget(order.length + 1, pool.length, o);
          bestNext = Math.max(bestNext, compatibility(cand, next, nextTarget, o).score);
        }
        escape = bestNext;
      }
      const total = score + escape * 0.25;
      if (total > bestScore) {
        bestScore = total;
        bestTrack = cand;
      }
    }
    if (!bestTrack) break;
    order.push(bestTrack);
    remaining.delete(bestTrack.id);
  }

  return order;
}

/**
 * Assemble the mix timeline for an ordered set: where each deck starts, what
 * rate it runs at, and when the blends happen.
 */
export function buildPlan(
  ordered: TrackAnalysis[],
  options: Partial<PlanOptions> = {},
): MixPlan {
  const o = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const notes: string[] = [];
  if (!ordered.length) {
    return { steps: [], totalDuration: 0, targetBpm: 0, arc: [], notes: ["no tracks"] };
  }

  // Resolve the transition for every consecutive pair first; the timeline maths
  // needs to know each blend's length and tempo before it can place anything.
  const transitions: (TransitionCandidate | null)[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const target = arcTarget(i + 1, ordered.length, o);
    const t = planTransition(ordered[i], ordered[i + 1], {
      maxStretch: o.maxStretch,
      preferredBeats: o.preferredBeats,
      creative: o.creative,
      wantRise: target > ordered[i].energyScore,
    });
    transitions.push(t);
  }
  transitions.push(null);

  const steps: MixStep[] = [];
  let mixTime = 0;

  for (let i = 0; i < ordered.length; i++) {
    const track = ordered[i];
    const inbound = i > 0 ? transitions[i - 1] : null;
    const outbound = transitions[i];

    // Entry: the first track starts at its own mix-in cue, later tracks start
    // wherever the incoming transition said to.
    const mixInCue = cuesOfKind(track, "mix-in")[0];
    const trackOffset = inbound ? inbound.entryTime : (mixInCue ? mixInCue.time : 0);
    const rateIn = inbound ? inbound.toRate : 1;
    const rateOut = outbound ? outbound.fromRate : rateIn;

    const startAt = mixTime;
    const inboundSeconds = inbound ? (inbound.beats * 60) / inbound.mixBpm : 0;

    // After the incoming blend finishes, glide from rateIn to rateOut.
    const rampAt = startAt + inboundSeconds;
    const rampSeconds =
      Math.abs(rateOut - rateIn) < 1e-6
        ? 0
        : (o.rampBars * barSeconds(track.grid)) / Math.max(rateIn, 1e-6);

    // Track time reached by the end of the ramp.
    let trackTime = trackOffset + inboundSeconds * rateIn;
    trackTime += rampSeconds * ((rateIn + rateOut) / 2);

    let transitionStartAt: number;
    let exitTime: number;
    if (outbound) {
      exitTime = outbound.exitTime;
      // Steady-state play-through to the exit point.
      const remainingTrack = exitTime - trackTime;
      if (remainingTrack < 0) {
        // The chosen exit is already behind us, which happens when a very long
        // inbound blend eats past it. Leave immediately on the next bar.
        const bar = barSeconds(track.grid) / Math.max(rateOut, 1e-6);
        transitionStartAt = rampAt + rampSeconds + bar;
        exitTime = trackTime + bar * rateOut;
        notes.push(
          `${track.name}: inbound blend ran past the planned exit, leaving one bar later`,
        );
      } else {
        transitionStartAt = rampAt + rampSeconds + remainingTrack / Math.max(rateOut, 1e-6);
      }
      mixTime = transitionStartAt;
    } else {
      // Last track: run to its mix-out cue, or the end of the file.
      const mixOut = cuesOfKind(track, "mix-out")[0];
      exitTime = mixOut ? Math.max(mixOut.time, trackTime) : track.duration;
      transitionStartAt = rampAt + rampSeconds + (exitTime - trackTime) / Math.max(rateOut, 1e-6);
      mixTime = transitionStartAt;
    }

    const outboundSeconds = outbound ? (outbound.beats * 60) / outbound.mixBpm : 0;
    const endAt = transitionStartAt + outboundSeconds;

    steps.push({
      index: i,
      trackId: track.id,
      trackName: track.name,
      startAt: round(startAt),
      trackOffset: round(trackOffset),
      endAt: round(endAt),
      transitionStartAt: round(transitionStartAt),
      exitTime: round(exitTime),
      transitionIn: inbound,
      transitionOut: outbound,
      rateIn: round(rateIn, 6),
      rateOut: round(rateOut, 6),
      rampAt: round(rampAt),
      rampSeconds: round(rampSeconds),
      // Loudness match, capped so a quiet master is not pushed into the limiter.
      gainDb: clamp(track.loudness.normalisationGainDb, -12, 6),
    });

    if (outbound && outbound.score < 0.25) {
      notes.push(
        `${track.name} -> ${ordered[i + 1].name}: weak match (${outbound.kind}), ` +
          `${outbound.rationale}`,
      );
    }
  }

  const last = steps[steps.length - 1];
  const totalDuration = last.endAt;
  const targetBpm = transitions.length > 1 && transitions[0]
    ? transitions[0].mixBpm
    : ordered[0].grid.bpm;

  notes.unshift(
    `${ordered.length} tracks, ${formatDuration(totalDuration)}, ` +
      `reference loudness ${MIX_REFERENCE_LUFS} LUFS`,
  );

  return {
    steps,
    totalDuration: round(totalDuration),
    targetBpm,
    arc: ordered.map((t) => t.energyScore),
    notes,
  };
}

/** Order then assemble, the one call the UI needs. */
export function planMix(tracks: TrackAnalysis[], options: Partial<PlanOptions> = {}): MixPlan {
  return buildPlan(orderSet(tracks, options), options);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
