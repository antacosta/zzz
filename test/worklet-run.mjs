/** Assertions over the stem worklet. Invoked by scripts/run-tests.mjs. */

import { SR, bandEnergy, bestAlignment, loadProcessor, runProcessor } from "./worklet.test.mjs";

let failures = 0;
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (ok) console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
};

const Processor = loadProcessor(SR);

/** Test signal: a centre-panned vocal-band tone stack, a wide pad, a low bass
 *  tone, and a periodic click train standing in for drums. */
function makeSignal(seconds) {
  const n = Math.floor(SR * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // centre "vocal": 440 Hz + harmonics, identical in both channels
    let voc = 0;
    for (let h = 1; h <= 4; h++) voc += Math.sin(2 * Math.PI * 440 * h * t) / (h * 1.6);
    voc *= 0.22;
    // wide pad at 1.2/1.5 kHz, opposite phase between channels
    const padL = 0.14 * Math.sin(2 * Math.PI * 1200 * t);
    const padR = -0.14 * Math.sin(2 * Math.PI * 1500 * t);
    // sustained bass at 60 Hz
    const bass = 0.3 * Math.sin(2 * Math.PI * 60 * t);
    // click train at 4 Hz for broadband transients
    const phase = t % 0.25;
    const click = phase < 0.004 ? (Math.exp(-phase * 900) * 0.5) * (1 - 2 * ((i * 1103515245) % 2)) : 0;
    l[i] = voc + padL + bass + click;
    r[i] = voc + padR + bass + click;
  }
  return { l, r, n };
}

const { l, r } = makeSignal(3);

console.log("\nStem worklet: reconstruction");
const unity = runProcessor(Processor, l, r, { vocals: 1, drums: 1, bass: 1, other: 1 });
check("worklet reports readiness", !!unity.ready, JSON.stringify(unity.ready));

// With every stem at unity the masks sum to 1, so output must equal input,
// delayed by the pipeline latency.
const align = bestAlignment(l, unity.outL, 8192, 20000, 32768);
check("unity gains reconstruct the input", align.relativeError < 1e-3,
  `delay ${align.delay} samples, relative error ${align.relativeError.toExponential(2)}`);
check("reported latency matches the measured delay",
  unity.ready && unity.ready.latencySamples === align.delay,
  `reported ${unity.ready?.latencySamples}, measured ${align.delay}`);

console.log("\nStem worklet: separation");
const probe = 60000;
const full = runProcessor(Processor, l, r, {});
const noVocals = runProcessor(Processor, l, r, { vocals: 0 });
const noBass = runProcessor(Processor, l, r, { bass: 0 });
const onlyVocals = runProcessor(Processor, l, r, { vocals: 1, drums: 0, bass: 0, other: 0 });

const vocBandFull = bandEnergy(full.outL, SR, 380, 500, probe);
const vocBandMuted = bandEnergy(noVocals.outL, SR, 380, 500, probe);
check("muting vocals removes the centre vocal fundamental",
  vocBandMuted < vocBandFull * 0.2,
  `${(10 * Math.log10(vocBandMuted / vocBandFull)).toFixed(1)} dB`);

const padFull = bandEnergy(full.outL, SR, 1150, 1250, probe);
const padNoVocals = bandEnergy(noVocals.outL, SR, 1150, 1250, probe);
check("muting vocals keeps the wide pad", padNoVocals > padFull * 0.5,
  `${(10 * Math.log10(padNoVocals / padFull)).toFixed(1)} dB`);

const bassFull = bandEnergy(full.outL, SR, 50, 75, probe);
const bassMuted = bandEnergy(noBass.outL, SR, 50, 75, probe);
check("muting bass removes the sustained low tone", bassMuted < bassFull * 0.25,
  `${(10 * Math.log10(bassMuted / bassFull)).toFixed(1)} dB`);

const vocalsOnlyVoc = bandEnergy(onlyVocals.outL, SR, 380, 500, probe);
const vocalsOnlyBass = bandEnergy(onlyVocals.outL, SR, 50, 75, probe);
check("vocals-only keeps the vocal band", vocalsOnlyVoc > vocBandFull * 0.25,
  `${(10 * Math.log10(vocalsOnlyVoc / vocBandFull)).toFixed(1)} dB of full`);
check("vocals-only rejects the bass", vocalsOnlyBass < bassFull * 0.1,
  `${(10 * Math.log10(vocalsOnlyBass / bassFull)).toFixed(1)} dB`);

console.log("\nStem worklet: robustness");
const silence = new Float32Array(SR);
const sil = runProcessor(Processor, silence, silence, {});
check("silence in, silence out", sil.outL.every((v) => v === 0));

const mono = runProcessor(Processor, l, l, { vocals: 0 });
const monoVoc = bandEnergy(mono.outL, SR, 380, 500, probe);
const monoFull = bandEnergy(runProcessor(Processor, l, l, {}).outL, SR, 380, 500, probe);
check("mono input still separates the centre vocal", monoVoc < monoFull * 0.3,
  `${(10 * Math.log10(monoVoc / monoFull)).toFixed(1)} dB`);

const boosted = runProcessor(Processor, l, r, { vocals: 2 });
check("no output clipping or NaN at boosted gain",
  boosted.outL.every((v) => Number.isFinite(v) && Math.abs(v) < 4));

const p44 = loadProcessor(44100);
const out44 = runProcessor(p44, l, r, {});
check("works at 44.1 kHz", out44.outL.some((v) => v !== 0) &&
  out44.outL.every((v) => Number.isFinite(v)));

console.log(`\n${checks - failures}/${checks} worklet checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exitCode = 1;
}
