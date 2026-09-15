/**
 * Writes synthetic test tracks as 16-bit WAV files, for driving the app in a
 * browser. Reuses the same generator the analysis tests use.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/make-test-audio.mjs <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), "continuum-synth-"));
const bundle = join(tmp, "synth.mjs");
await build({
  entryPoints: ["test/synth.ts"],
  outfile: bundle,
  bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "error",
});
const { makeTrack } = await import(pathToFileURL(bundle).href);
rmSync(tmp, { recursive: true, force: true });

function wav(channels, sampleRate) {
  const frames = channels[0].length;
  const ch = channels.length;
  const buf = Buffer.alloc(44 + frames * ch * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * ch * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  return buf;
}

// A small set with deliberate variety: keys a wheel-step apart, tempos inside
// the stretch budget, one vocal track and two instrumentals.
const specs = [
  { file: "01-opener-124-amin.wav", bpm: 124, seconds: 100, chord: [45, 48, 52, 57], vocal: false, introBars: 4, seed: 101 },
  { file: "02-vocal-126-cmin.wav", bpm: 126, seconds: 100, chord: [48, 51, 55, 60], vocal: true, introBars: 2, seed: 202 },
  { file: "03-roller-127-gmin.wav", bpm: 127, seconds: 100, chord: [43, 46, 50, 55], vocal: false, introBars: 2, seed: 303 },
];

for (const spec of specs) {
  const t = makeTrack(spec);
  writeFileSync(join(outDir, spec.file), wav(t.channels, t.sampleRate));
  console.log(`wrote ${spec.file} (${spec.bpm} BPM, ${spec.seconds}s)`);
}
