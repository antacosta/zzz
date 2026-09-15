/** Planner and transition assertions. Bundled and run by scripts/run-tests.mjs. */

import { camelotDistance } from "../src/analysis/key";
import {
  DEFAULT_PLAN_OPTIONS, arcTarget, buildPlan, compatibility, orderSet, planMix,
} from "../src/engine/planner";
import { matchTempo } from "../src/engine/query";
import { laneValueAt, planTransition } from "../src/engine/transitions";
import type { TrackAnalysis } from "../src/types";
import { makeAnalysis } from "./fixtures";

let failures = 0;
let checks = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  checks++;
  if (ok) console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
};

// A small, deliberately varied library.
const library: TrackAnalysis[] = [
  makeAnalysis({ id: "opener", name: "Opener", bpm: 122, duration: 300, tonic: 9, mode: "minor", energy: 0.42, vocalDensity: 0.05, brightness: 0.12 }),
  makeAnalysis({ id: "builder", name: "Builder", bpm: 124, duration: 320, tonic: 4, mode: "minor", energy: 0.62, vocalDensity: 0.08, dropAt: 150, brightness: 0.22 }),
  makeAnalysis({ id: "vocal", name: "Vocal Cut", bpm: 125, duration: 300, tonic: 11, mode: "minor", energy: 0.72, vocalDensity: 0.55, vocalShape: "second-half", brightness: 0.3 }),
  makeAnalysis({ id: "instr", name: "Instrumental Roller", bpm: 126, duration: 340, tonic: 11, mode: "minor", energy: 0.8, vocalDensity: 0.04, loopAt: 180, brightness: 0.18 }),
  makeAnalysis({ id: "peak", name: "Peak Tool", bpm: 127, duration: 300, tonic: 6, mode: "minor", energy: 0.96, vocalDensity: 0.03, dropAt: 120, brightness: 0.35 }),
  makeAnalysis({ id: "closer", name: "Closer", bpm: 123, duration: 330, tonic: 1, mode: "minor", energy: 0.58, vocalDensity: 0.12, brightness: 0.15 }),
];

console.log("\nEnergy arc");
const n = 6;
const targets = Array.from({ length: n }, (_, i) => arcTarget(i, n, DEFAULT_PLAN_OPTIONS));
check("arc starts at the configured start energy",
  Math.abs(targets[0] - DEFAULT_PLAN_OPTIONS.startEnergy) < 1e-6, targets[0].toFixed(2));
check("arc ends at the configured end energy",
  Math.abs(targets[n - 1] - DEFAULT_PLAN_OPTIONS.endEnergy) < 1e-6, targets[n - 1].toFixed(2));
check("arc peaks in the interior and is the maximum",
  Math.max(...targets) > targets[0] && Math.max(...targets) > targets[n - 1],
  targets.map((t) => t.toFixed(2)).join(" "));
check("arc rises monotonically to the peak", (() => {
  const peakIdx = targets.indexOf(Math.max(...targets));
  for (let i = 1; i <= peakIdx; i++) if (targets[i] < targets[i - 1]) return false;
  return true;
})());

console.log("\nTempo matching");
const same = matchTempo(128, 128);
check("identical tempos need no stretch", same.stretch < 1e-9 && same.ratio === 1);
const close = matchTempo(126, 130);
check("nearby tempos match inside the budget", close.ok && close.stretch < 0.03,
  `${(close.stretch * 100).toFixed(2)} % at ${close.mixBpm.toFixed(1)} BPM`);
const halfTime = matchTempo(174, 87);
check("half-time relationship is found", halfTime.ok && Math.abs(halfTime.ratio - 2) < 1e-9,
  `ratio ${halfTime.ratio}, stretch ${(halfTime.stretch * 100).toFixed(2)} %`);
check("a half-time match leaves both decks at their own speed",
  Math.abs(halfTime.fromRate - 1) < 1e-9 && Math.abs(halfTime.toRate - 1) < 1e-9,
  `fromRate ${halfTime.fromRate.toFixed(4)}, toRate ${halfTime.toRate.toFixed(4)}`);
const wide = matchTempo(100, 150);
check("a genuinely unmixable gap is reported as such", !wide.ok,
  `ok=${wide.ok} ratio=${wide.ratio} stretch=${(wide.stretch * 100).toFixed(1)} %`);
check("no ratio requires pitching a deck by a musical interval",
  [1, 2, 0.5].includes(matchTempo(100, 150).ratio) &&
  [1, 2, 0.5].includes(matchTempo(128, 90).ratio) &&
  [1, 2, 0.5].includes(matchTempo(140, 175).ratio));
const dnb = matchTempo(87, 174);
check("double-time is found in the other direction too",
  dnb.ok && Math.abs(dnb.ratio - 0.5) < 1e-9 && Math.abs(dnb.toRate - 1) < 1e-9,
  `ratio ${dnb.ratio}, toRate ${dnb.toRate.toFixed(4)}`);

console.log("\nPairwise compatibility");
const aMin = library[0]; // 9 minor = 1A
const compatKey = makeAnalysis({ id: "k1", name: "Same key", bpm: 122, duration: 300, tonic: 9, mode: "minor", energy: 0.5, vocalDensity: 0.05 });
const farKey = makeAnalysis({ id: "k2", name: "Far key", bpm: 122, duration: 300, tonic: 3, mode: "major", energy: 0.5, vocalDensity: 0.05 });
check("a harmonically close track scores above a distant one",
  compatibility(aMin, compatKey, 0.5, DEFAULT_PLAN_OPTIONS).score >
  compatibility(aMin, farKey, 0.5, DEFAULT_PLAN_OPTIONS).score,
  `${camelotDistance(aMin.key.camelot, compatKey.key.camelot)} vs ${camelotDistance(aMin.key.camelot, farKey.key.camelot)} wheel steps`);

const onArc = makeAnalysis({ id: "e1", name: "On arc", bpm: 122, duration: 300, tonic: 9, mode: "minor", energy: 0.9, vocalDensity: 0.05 });
const offArc = makeAnalysis({ id: "e2", name: "Off arc", bpm: 122, duration: 300, tonic: 9, mode: "minor", energy: 0.2, vocalDensity: 0.05 });
check("a track matching the arc target scores above one that does not",
  compatibility(aMin, onArc, 0.9, DEFAULT_PLAN_OPTIONS).score >
  compatibility(aMin, offArc, 0.9, DEFAULT_PLAN_OPTIONS).score);
check("key repetition is penalised",
  compatibility(aMin, compatKey, 0.5, DEFAULT_PLAN_OPTIONS, []).score >
  compatibility(aMin, compatKey, 0.5, DEFAULT_PLAN_OPTIONS, [compatKey.key.camelot, compatKey.key.camelot]).score);

console.log("\nSet ordering");
const ordered = orderSet(library);
check("every track is used exactly once",
  ordered.length === library.length && new Set(ordered.map((t) => t.id)).size === library.length,
  ordered.map((t) => t.name).join(" -> "));
check("the opener is a low-energy track", ordered[0].energyScore <= 0.6, `${ordered[0].name} @ ${ordered[0].energyScore}`);
check("the peak track is not first or last",
  ordered[0].id !== "peak" && ordered[ordered.length - 1].id !== "peak",
  `peak at position ${ordered.findIndex((t) => t.id === "peak") + 1}/${ordered.length}`);
const pinned = orderSet(library, { firstTrackId: "peak" });
check("a pinned first track is honoured", pinned[0].id === "peak");
check("ordering a single track works", orderSet([library[0]]).length === 1);
check("ordering an empty library works", orderSet([]).length === 0);

console.log("\nTransition selection");
// Vocal track into an instrumental in the same key should pick the stem swap.
const vocalTrack = library[2];
const instrTrack = library[3];
const stemT = planTransition(vocalTrack, instrTrack, { creative: true });
check("vocal into instrumental chooses a stem-swap blend",
  stemT.kind === "vocal-over-instrumental", `${stemT.kind}: ${stemT.rationale}`);
check("that blend automates the outgoing stems",
  stemT.lanes.some((l) => l.target === "a.stem.drums") &&
  stemT.lanes.some((l) => l.target === "a.stem.vocals"));
check("the outgoing vocal stays up while its backing is stripped", (() => {
  const voc = stemT.lanes.find((l) => l.target === "a.stem.vocals")!;
  const drums = stemT.lanes.find((l) => l.target === "a.stem.drums")!;
  const mid = stemT.beats * 0.5;
  return laneValueAt(voc, mid) > 0.8 && laneValueAt(drums, mid) < 0.2;
})());
check("the incoming vocal is held back until the handover", (() => {
  const bVoc = stemT.lanes.find((l) => l.target === "b.stem.vocals")!;
  return laneValueAt(bVoc, stemT.beats * 0.5) < 0.2 && laneValueAt(bVoc, stemT.beats) > 0.8;
})());

// Creative off should never produce a stem swap.
const safeT = planTransition(vocalTrack, instrTrack, { creative: false });
check("creative mode off avoids stem swaps and double drops",
  safeT.kind !== "vocal-over-instrumental" && safeT.kind !== "double-drop" && safeT.kind !== "loop-roll",
  safeT.kind);

// A distant key pair should fall back to something that hides the clash.
const clashA = makeAnalysis({ id: "ca", name: "Clash A", bpm: 128, duration: 300, tonic: 0, mode: "major", energy: 0.7, vocalDensity: 0.4 });
const clashB = makeAnalysis({ id: "cb", name: "Clash B", bpm: 128, duration: 300, tonic: 1, mode: "minor", energy: 0.7, vocalDensity: 0.4 });
const clashT = planTransition(clashA, clashB);
check("a key clash picks filter or echo, not a harmonic blend",
  clashT.kind !== "harmonic-blend" && clashT.kind !== "double-drop",
  `${clashT.kind} (${camelotDistance(clashA.key.camelot, clashB.key.camelot)} wheel steps)`);

// Same key, similar energy, no vocals: a long harmonic blend is ideal.
const blendA = makeAnalysis({ id: "ba", name: "Blend A", bpm: 126, duration: 320, tonic: 7, mode: "minor", energy: 0.7, vocalDensity: 0.02 });
const blendB = makeAnalysis({ id: "bb", name: "Blend B", bpm: 126, duration: 320, tonic: 7, mode: "minor", energy: 0.72, vocalDensity: 0.02 });
const blendT = planTransition(blendA, blendB);
check("matched instrumentals in one key blend long",
  blendT.beats >= 32 && ["harmonic-blend", "bass-swap"].includes(blendT.kind),
  `${blendT.kind}, ${blendT.beats} beats`);

console.log("\nTransition invariants");
const pairs: [TrackAnalysis, TrackAnalysis][] = [];
for (const a of library) for (const b of library) if (a.id !== b.id) pairs.push([a, b]);
let bassDoubled = 0;
let outOfRange = 0;
let notBarAligned = 0;
let laneOutOfRange = 0;
for (const [a, b] of pairs) {
  const t = planTransition(a, b);
  if (t.beats % a.grid.meter !== 0 && t.kind !== "hard-cut") notBarAligned++;
  if (t.fromTime < 0 || t.fromTime > a.duration) outOfRange++;
  if (t.toTime < 0 || t.toTime > b.duration) outOfRange++;
  const aBass = t.lanes.find((l) => l.target === "a.stem.bass");
  const bBass = t.lanes.find((l) => l.target === "b.stem.bass");
  if (aBass && bBass) {
    // The one thing a mix must never do: two basslines at full level together.
    for (let beat = 0; beat <= t.beats; beat += 0.5) {
      if (laneValueAt(aBass, beat) > 0.75 && laneValueAt(bBass, beat) > 0.75) {
        bassDoubled++;
        break;
      }
    }
  }
  for (const l of t.lanes) {
    const isFreq = l.target.includes("pass");
    const isEq = l.target.includes("eq.");
    for (const p of l.points) {
      const bad = isFreq
        ? p.value < 15 || p.value > 22000
        : isEq
          ? p.value < -24 || p.value > 12
          : p.value < 0 || p.value > 2;
      if (bad || !Number.isFinite(p.value) || p.beat < 0 || p.beat > t.beats + 1e-6) laneOutOfRange++;
    }
  }
}
check(`no transition doubles the bass (${pairs.length} pairs)`, bassDoubled === 0, `${bassDoubled} violations`);
check("all exit and entry points are inside their tracks", outOfRange === 0, `${outOfRange} violations`);
check("all blend lengths are a whole number of bars", notBarAligned === 0, `${notBarAligned} violations`);
check("all automation values are in range", laneOutOfRange === 0, `${laneOutOfRange} violations`);

// A 2:1 pair must have its blend windows measured in each track's own time.
const fastTrack = makeAnalysis({ id: "dnb", name: "DnB", bpm: 174, duration: 300, tonic: 9, mode: "minor", energy: 0.85, vocalDensity: 0.05 });
const slowTrack = makeAnalysis({ id: "hh", name: "Half Time", bpm: 87, duration: 300, tonic: 9, mode: "minor", energy: 0.7, vocalDensity: 0.05 });
const ratioT = planTransition(fastTrack, slowTrack);
check("a 2:1 pair is mixed without pitching either deck",
  Math.abs(ratioT.fromRate - 1) < 0.07 && Math.abs(ratioT.toRate - 1) < 0.07,
  `fromRate ${ratioT.fromRate.toFixed(3)}, toRate ${ratioT.toRate.toFixed(3)}`);
check("a 2:1 blend stays inside both files", (() => {
  const seconds = (ratioT.beats * 60) / ratioT.mixBpm;
  return ratioT.fromTime + seconds * ratioT.fromRate <= fastTrack.duration + 0.25 &&
    ratioT.toTime + seconds * ratioT.toRate <= slowTrack.duration + 0.25;
})());

console.log("\nMix timeline");
const plan = planMix(library);
check("plan covers every track", plan.steps.length === library.length);
check("plan has a sensible duration",
  plan.totalDuration > 600 && plan.totalDuration < 3600, `${Math.round(plan.totalDuration)}s`);
check("each deck starts when the previous blend begins", (() => {
  for (let i = 1; i < plan.steps.length; i++) {
    if (Math.abs(plan.steps[i].startAt - plan.steps[i - 1].transitionStartAt) > 1e-3) return false;
  }
  return true;
})());
check("mix time advances monotonically", (() => {
  for (let i = 1; i < plan.steps.length; i++) {
    if (plan.steps[i].startAt < plan.steps[i - 1].startAt) return false;
    if (plan.steps[i].transitionStartAt <= plan.steps[i].startAt) return false;
  }
  return true;
})());
check("no deck is asked to play past the end of its file", (() => {
  for (const s of plan.steps) {
    const track = library.find((t) => t.id === s.trackId)!;
    const outSeconds = s.transitionOut ? (s.transitionOut.beats * 60) / s.transitionOut.mixBpm : 0;
    const finalTrackTime = s.exitTime + outSeconds * s.rateOut;
    if (finalTrackTime > track.duration + 0.5) return false;
    if (s.trackOffset < 0 || s.trackOffset >= track.duration) return false;
  }
  return true;
})());
check("playback rates stay within the stretch budget", plan.steps.every(
  (s) => Math.abs(s.rateIn - 1) <= 0.5 && Math.abs(s.rateOut - 1) <= 0.5),
  plan.steps.map((s) => s.rateOut.toFixed(3)).join(" "));
check("loudness trims are capped", plan.steps.every((s) => s.gainDb >= -12 && s.gainDb <= 6));
check("every step after the first has an inbound transition",
  plan.steps.slice(1).every((s) => s.transitionIn !== null) && plan.steps[0].transitionIn === null);
check("the last step has no outbound transition",
  plan.steps[plan.steps.length - 1].transitionOut === null);
check("plan reports notes", plan.notes.length > 0, plan.notes[0]);

const twoTrack = buildPlan([library[0], library[1]]);
check("a two-track plan works", twoTrack.steps.length === 2 && twoTrack.totalDuration > 0);
const oneTrack = buildPlan([library[0]]);
check("a one-track plan works", oneTrack.steps.length === 1 && oneTrack.steps[0].transitionOut === null);
check("an empty plan works", buildPlan([]).steps.length === 0);

console.log(`\n${checks - failures}/${checks} planner checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exitCode = 1;
}
