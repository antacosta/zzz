/**
 * Analysis test harness. Runs the full pipeline over synthetic material whose
 * ground truth we know, and asserts the measurements land in range.
 * Run with: npm test
 */

import { analyseTrack } from "../src/analysis/analyse";
import { camelotDistance, camelotFor } from "../src/analysis/key";
import { makeTrack } from "./synth";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function near(actual: number, expected: number, tol: number): boolean {
  return Math.abs(actual - expected) <= tol;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// --- 128 BPM, C minor, with intro and vocal ---------------------------------
section("128 BPM / C minor / 8-bar intro / vocal from halfway");
const t1 = makeTrack({
  bpm: 128,
  seconds: 70,
  chord: [48, 51, 55, 60, 63], // C Eb G C Eb -> C minor
  vocal: true,
  introBars: 4,
});
const a1 = analyseTrack({ id: "t1", name: "test-128-cmin", ...t1 });

check("bpm detected", near(a1.grid.bpm, 128, 1.5), `got ${a1.grid.bpm}`);
check("tempo confident", a1.grid.tempoConfidence > 0.1, `conf ${a1.grid.tempoConfidence.toFixed(2)}`);
check("beat grid populated", a1.grid.beats.length > 120, `${a1.grid.beats.length} beats`);
check("downbeats are every 4th beat", near(a1.grid.downbeats.length, a1.grid.beats.length / 4, 2),
  `${a1.grid.downbeats.length} bars`);
check("phrase length musical", [4, 8, 16, 32].includes(a1.grid.phraseBars), `${a1.grid.phraseBars} bars`);
check("key is C minor or a relative", camelotDistance(a1.key.camelot, camelotFor(0, "minor")) <= 1,
  `${a1.key.name} / ${a1.key.camelot}`);
check("duration accurate", near(a1.duration, 70, 0.1), `${a1.duration.toFixed(2)}s`);
check("loudness in plausible range", a1.loudness.integratedLufs > -30 && a1.loudness.integratedLufs < -3,
  `${a1.loudness.integratedLufs} LUFS`);
check("true peak below clipping", a1.loudness.truePeakDb <= 0.2, `${a1.loudness.truePeakDb} dBTP`);
check("crest factor sane", a1.loudness.crestFactorDb > 2 && a1.loudness.crestFactorDb < 30,
  `${a1.loudness.crestFactorDb} dB`);
check("stereo width non-zero", a1.stereo.width > 0.02, `${a1.stereo.width}`);
check("bass mostly mono", a1.stereo.bassMonoRatio > 0.8, `${a1.stereo.bassMonoRatio}`);
check("percussive content found", a1.rhythm.percussiveRatio > 0.1, `${a1.rhythm.percussiveRatio}`);
check("pulse is clear", a1.rhythm.pulseClarity > 0.5, `${a1.rhythm.pulseClarity}`);
check("danceable", a1.rhythm.danceability > 0.35, `${a1.rhythm.danceability}`);
check("sections found", a1.sections.length >= 2, `${a1.sections.length} sections`);
check("first section is the intro", a1.sections[0].label === "intro", a1.sections[0].label);
check("has a mix-in cue", a1.cues.some((c) => c.kind === "mix-in"));
check("has a mix-out cue", a1.cues.some((c) => c.kind === "mix-out"));
check("mix-out is in the back half", (a1.cues.find((c) => c.kind === "mix-out")?.time ?? 0) > 35,
  `${a1.cues.find((c) => c.kind === "mix-out")?.time}s`);
check("cues are ordered and in range",
  a1.cues.every((c, i) => c.time >= 0 && c.time < a1.duration && (i === 0 || c.time >= a1.cues[i - 1].time)));

// Vocal detection: the second half should read much more vocal than the first.
const fr = a1.timelines.frameRate;
const halfFrame = Math.floor(a1.timelines.vocal.length / 2);
const meanOf = (x: Float32Array, lo: number, hi: number) => {
  let s = 0;
  for (let i = lo; i < hi; i++) s += x[i];
  return s / Math.max(1, hi - lo);
};
const firstHalfVocal = meanOf(a1.timelines.vocal, 0, halfFrame);
const secondHalfVocal = meanOf(a1.timelines.vocal, halfFrame, a1.timelines.vocal.length);
check("vocal timeline rises when the vocal enters", secondHalfVocal > firstHalfVocal * 1.4,
  `${firstHalfVocal.toFixed(3)} -> ${secondHalfVocal.toFixed(3)}`);
check("vocal-in cue lands near the real entry",
  a1.cues.filter((c) => c.kind === "vocal-in").some((c) => Math.abs(c.time - 35) < 12),
  a1.cues.filter((c) => c.kind === "vocal-in").map((c) => c.time.toFixed(1)).join(","));
check("timelines share a frame rate and length",
  a1.timelines.energy.length === a1.timelines.vocal.length &&
  a1.timelines.energy.length === a1.timelines.percussive.length &&
  a1.timelines.bands.every((b) => b.length === a1.timelines.energy.length),
  `${a1.timelines.energy.length} frames @ ${(1 / fr).toFixed(1)} fps`);
check("energy timeline is 0..1", Array.from(a1.timelines.energy).every((v) => v >= 0 && v <= 1));
check("mixability scored", a1.mixability > 0.3 && a1.mixability <= 1, `${a1.mixability}`);

// Beat-grid phase accuracy. The synthetic kicks land on exact multiples of the
// beat starting at t=0, so the grid's offset from truth is directly measurable.
// This is the measurement everything downstream inherits: a grid that is a
// fraction of a sixteenth note out makes cue points land wrong and reads as
// syncopation that is not there.
section("Beat-grid timing");
const beatSeconds = 60 / 128;
const phaseErrors: number[] = [];
for (const t of Array.from(a1.grid.beats)) {
  if (t < 20) continue; // skip the intro, which has no kicks to lock to
  const nearest = Math.round(t / beatSeconds) * beatSeconds;
  phaseErrors.push(t - nearest);
}
phaseErrors.sort((x, y) => x - y);
const medianPhaseError = phaseErrors[phaseErrors.length >> 1];
check("beat grid phase error is under 10 ms",
  Math.abs(medianPhaseError) < 0.01, `${(medianPhaseError * 1000).toFixed(1)} ms`);
// The worst beat matters as much as the median: a grid that is centred but
// drifting falls apart at the ends of the track, which is exactly where mix-in
// and mix-out cues live.
const worstPhaseError = Math.max(Math.abs(phaseErrors[0]), Math.abs(phaseErrors[phaseErrors.length - 1]));
check("worst beat is within 25 ms", worstPhaseError < 0.025,
  `${(worstPhaseError * 1000).toFixed(1)} ms`);
const firstBeatPhase = a1.grid.firstBeat % beatSeconds;
check("first beat lands on a kick",
  Math.min(firstBeatPhase, beatSeconds - firstBeatPhase) < 0.015,
  `${(Math.min(firstBeatPhase, beatSeconds - firstBeatPhase) * 1000).toFixed(0)} ms off`);
check("the grid is exactly regular", (() => {
  // A fitted constant-tempo grid should have no spacing variation at all.
  const beats = Array.from(a1.grid.beats);
  if (beats.length < 8) return false;
  const first = beats[1] - beats[0];
  return beats.every((t, i) => i === 0 || Math.abs(t - beats[i - 1] - first) < 1e-4);
})());
check("tempo is accurate to 0.1%",
  Math.abs(a1.grid.bpm - 128) / 128 < 0.001, `${a1.grid.bpm} vs 128`);
// A straight four-on-the-floor with offbeat hats is not a syncopated pattern;
// a grid that is out of phase is what makes it read as one.
check("a straight 4/4 pattern reads as low syncopation",
  a1.rhythm.syncopation < 0.5, `${a1.rhythm.syncopation}`);
check("a straight pattern reads as little or no swing",
  a1.rhythm.swing < 0.2, `${a1.rhythm.swing}`);
check("timelines expose a frame offset of half a window",
  Math.abs(a1.timelines.frameOffset - 1024 / 22050) < 1e-9,
  `${(a1.timelines.frameOffset * 1000).toFixed(1)} ms`);

// --- 174 BPM, F# major, no vocal -------------------------------------------
section("174 BPM / F# major / instrumental");
const t2 = makeTrack({ bpm: 174, seconds: 45, chord: [54, 58, 61, 66], vocal: false });
const a2 = analyseTrack({ id: "t2", name: "test-174-fsmaj", ...t2 });
check("fast tempo is detected at the right metrical level",
  near(a2.grid.bpm, 174, 1), `got ${a2.grid.bpm}`);
check("key is F# major or a relative", camelotDistance(a2.key.camelot, camelotFor(6, "major")) <= 1,
  `${a2.key.name} / ${a2.key.camelot}`);
check("instrumental reads low vocal density", a2.vocalDensity < 0.55, `${a2.vocalDensity}`);
check("no chord-only track flagged as very wide", a2.stereo.width <= 1);
// The centroid describes the track's characteristic spectrum, so it has to land
// inside the band the material actually occupies. Averaging the per-frame
// centroids instead put it wherever the quiet frames' noise sat.
for (const [label, a] of [["128 track", a1], ["174 track", a2]] as const) {
  check(`centroid lands in the occupied band (${label})`,
    a.spectral.centroidHz > 100 && a.spectral.centroidHz < 6000,
    `${a.spectral.centroidHz} Hz`);
  check(`rolloff is above the lowest band edge (${label})`,
    a.spectral.rolloff85Hz > 120, `${a.spectral.rolloff85Hz} Hz`);
}

// --- Tempo accuracy across the range ---------------------------------------
// Three hand-picked tracks do not establish that the tempo estimator works; a
// sweep does, and tempo is the measurement every other number depends on.
section("Tempo accuracy sweep (95-174 BPM)");
const sweepTempos = [95, 100, 110, 118, 120, 124, 127, 128, 135, 140, 150, 174];
let worstTempoError = 0;
let worstTempoAt = 0;
const wrongLevel: number[] = [];
for (const bpm of sweepTempos) {
  const track = makeTrack({ bpm, seconds: 40, chord: [48, 51, 55], seed: 12345 });
  const analysed = analyseTrack({ id: `sweep-${bpm}`, name: `${bpm}`, ...track });
  const errorPct = Math.abs((analysed.grid.bpm - bpm) / bpm) * 100;
  if (errorPct > 3) wrongLevel.push(bpm);
  if (errorPct > worstTempoError) {
    worstTempoError = errorPct;
    worstTempoAt = bpm;
  }
}
check("every tempo is found at the right metrical level", wrongLevel.length === 0,
  wrongLevel.length ? `missed: ${wrongLevel.join(", ")}` : `${sweepTempos.length} tempos`);
check("worst tempo error across the range is under 0.2%",
  worstTempoError < 0.2, `${worstTempoError.toFixed(3)}% at ${worstTempoAt} BPM`);

// --- Kick masked by a sustained bassline ------------------------------------
// A loud sustained note at the kick's own frequency is the normal case in dance
// music, and it used to defeat the tempo estimator: a transient on top of a
// large steady level barely moves a compressive flux measure, so the kick went
// missing from the onset envelope and the tempo landed 2-3% out.
section("Kick under a sustained bassline");
for (const [label, chord] of [
  ["low bass", [43, 46, 50, 55]],
  ["very low bass", [36, 39, 43]],
] as [string, number[]][]) {
  const track = makeTrack({ bpm: 127, seconds: 50, chord, introBars: 2, seed: 303 });
  const analysed = analyseTrack({ id: `mask-${label}`, name: label, ...track });
  check(`tempo survives a ${label} under the kick`,
    near(analysed.grid.bpm, 127, 0.5), `${analysed.grid.bpm} vs 127`);
  check(`grid fit stays high with a ${label}`,
    analysed.grid.beatConfidence > 0.7, `fit ${analysed.grid.beatConfidence.toFixed(2)}`);
}

// --- 44.1 vs 48 kHz agreement ----------------------------------------------
section("Sample-rate independence (44.1 kHz vs 48 kHz)");
// Hats off: the noise is drawn per sample, so leaving them in would mean the
// two rates carry different signals and the comparison would measure the
// fixture rather than the analysis.
const t3a = makeTrack({ bpm: 120, seconds: 40, chord: [45, 49, 52], sampleRate: 44100, hats: false });
const t3b = makeTrack({ bpm: 120, seconds: 40, chord: [45, 49, 52], sampleRate: 48000, hats: false });
const a3a = analyseTrack({ id: "a", name: "44k", ...t3a });
const a3b = analyseTrack({ id: "b", name: "48k", ...t3b });
check("bpm agrees across sample rates", near(a3a.grid.bpm, a3b.grid.bpm, 0.2),
  `${a3a.grid.bpm} vs ${a3b.grid.bpm}`);
check("bpm is accurate at both sample rates",
  near(a3a.grid.bpm, 120, 0.3) && near(a3b.grid.bpm, 120, 0.3),
  `${a3a.grid.bpm} / ${a3b.grid.bpm} vs 120`);
check("loudness agrees across sample rates", near(a3a.loudness.integratedLufs, a3b.loudness.integratedLufs, 1.0),
  `${a3a.loudness.integratedLufs} vs ${a3b.loudness.integratedLufs} LUFS`);
check("key agrees across sample rates", a3a.key.name === a3b.key.name,
  `${a3a.key.name} vs ${a3b.key.name}`);
check("spectral centroid agrees across sample rates",
  Math.abs(a3a.spectral.centroidHz - a3b.spectral.centroidHz) <
    a3a.spectral.centroidHz * 0.05,
  `${a3a.spectral.centroidHz} vs ${a3b.spectral.centroidHz} Hz`);
check("brightness agrees across sample rates",
  Math.abs(a3a.spectral.brightness - a3b.spectral.brightness) < 0.05,
  `${a3a.spectral.brightness} vs ${a3b.spectral.brightness}`);
check("band energies agree across sample rates",
  a3a.spectral.bandsDb.every((db, i) => Math.abs(db - a3b.spectral.bandsDb[i]) < 3),
  a3a.spectral.bandsDb.map((db, i) => (db - a3b.spectral.bandsDb[i]).toFixed(1)).join(" "));

// --- Mono input and degenerate cases ---------------------------------------
section("Mono and short input");
const mono = makeTrack({ bpm: 125, seconds: 30, chord: [50, 53, 57] });
const a4 = analyseTrack({ id: "m", name: "mono", sampleRate: mono.sampleRate, channels: [mono.channels[0]] });
check("mono analyses without error", a4.grid.beats.length > 30, `${a4.grid.beats.length} beats`);
check("mono reports zero width", a4.stereo.width === 0);
const tiny = makeTrack({ bpm: 128, seconds: 2, chord: [48, 52, 55] });
const a5 = analyseTrack({ id: "s", name: "short", ...tiny });
check("2-second clip does not throw", a5.duration > 0 && a5.sections.length >= 1);
check("camelot distance is symmetric",
  camelotDistance("8A", "5B") === camelotDistance("5B", "8A"));
check("camelot self-distance is zero", camelotDistance("8A", "8A") === 0);
check("camelot neighbours are close", camelotDistance("8A", "9A") === 1 && camelotDistance("8A", "8B") === 1);

section(`${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
