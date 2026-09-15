/**
 * End-to-end check in real Chromium: load the app, drop in audio files, wait
 * for analysis, verify a mix is planned, play it, and confirm audio is actually
 * flowing through the master chain.
 *
 * Chromium is launched with a fake audio device so the AudioContext runs
 * without hardware and the render quantum advances normally.
 */
import { chromium } from "playwright";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Usage: npm run dev, then
//   node scripts/browser-check.mjs [audioDir] [screenshotPath]
// Set CHROME_PATH to use a specific Chromium; otherwise Playwright's own
// download is used. APP_URL overrides the dev-server address.
const url = process.env.APP_URL ?? "http://localhost:5173/";
const audioDir = process.argv[2] ?? "test-audio";
const shotPath = process.argv[3];

let files;
try {
  files = readdirSync(audioDir).filter((f) => f.endsWith(".wav")).map((f) => join(audioDir, f));
} catch {
  throw new Error(
    `cannot read ${audioDir}. Generate test audio first: ` +
    `node scripts/make-test-audio.mjs ${audioDir}`,
  );
}
if (!files.length) {
  throw new Error(
    `no wav files in ${audioDir}. Generate them with: ` +
    `node scripts/make-test-audio.mjs ${audioDir}`,
  );
}

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

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--no-sandbox",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const consoleErrors = [];
const pageErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(err.message));

console.log("\nBrowser: load");
await page.goto(url, { waitUntil: "networkidle" });
check("app shell renders", await page.locator(".topbar h1").isVisible());
check("library drop zone present", await page.locator("#dropzone").isVisible());

console.log("\nBrowser: analysis");
await page.setInputFiles("#filepicker", files);
// Analysis of three 100 s tracks across the worker pool.
await page.waitForFunction(
  () => document.querySelectorAll(".track .pill").length >= 3,
  undefined,
  { timeout: 180000 },
);
const rows = await page.locator(".track").count();
check("every file appears in the library", rows === files.length, `${rows} rows`);

const meta = await page.locator(".track .track-meta").first().innerText();
check("track metrics are shown", /\d+\.\d/.test(meta), meta.replace(/\n/g, " | "));

const bpms = await page.$$eval(".track", (rows) =>
  rows.map((row) => Number(row.querySelector(".track-meta span")?.textContent ?? "NaN")),
);
check("detected tempos are in the expected range",
  bpms.length === 3 && bpms.every((b) => b > 120 && b < 130), bpms.join(", "));

const camelots = await page.$$eval(".track .camelot", (els) => els.map((e) => e.textContent));
check("every track has a Camelot key", camelots.every((c) => /^\d{1,2}[AB]$/.test(c ?? "")),
  camelots.join(", "));

console.log("\nBrowser: planning");
await page.waitForFunction(() => {
  const el = document.querySelector("#topstats");
  return el && /\d+:\d\d/.test(el.textContent ?? "");
}, undefined, { timeout: 20000 });
const mixLength = await page.$eval("#topstats", (el) => el.textContent ?? "");
check("a mix was planned automatically", /\d+:\d\d/.test(mixLength), mixLength.replace(/\s+/g, " ").trim());

const nowPlaying = await page.locator("#nowplaying").innerText();
check("the next blend is described", /Next:/.test(nowPlaying),
  nowPlaying.split("\n").slice(0, 4).join(" | "));
check("a transition style was chosen",
  /(bass swap|vocal over instrumental|filter sweep|harmonic blend|drop swap|echo out|loop roll|double drop|hard cut)/.test(nowPlaying),
  (nowPlaying.match(/(bass swap|vocal over instrumental|filter sweep|harmonic blend|drop swap|echo out|loop roll|double drop|hard cut)/) ?? [])[0]);

console.log("\nBrowser: playback");
await page.click("#play");
await page.waitForTimeout(6000);

const playState = await page.evaluate(() => {
  const readout = document.querySelector("#readout")?.textContent ?? "";
  const play = document.querySelector("#play")?.textContent ?? "";
  return { readout, play };
});
check("play button flipped to pause", playState.play === "Pause", playState.play);
const elapsed = Number((playState.readout.match(/^(\d+):(\d\d)/) ?? [])[2] ?? 0);
check("the playhead advanced", elapsed > 2, playState.readout);

const deckCount = await page.locator(".deck").count();
check("a deck is live", deckCount >= 1, `${deckCount} decks`);

// Confirm real signal, not just a moving clock: sample the master meters.
const level = await page.evaluate(async () => {
  let peak = 0;
  let rms = 0;
  for (let i = 0; i < 25; i++) {
    const m = window.continuum.meters();
    if (m) {
      peak = Math.max(peak, m.peak);
      rms = Math.max(rms, m.rms);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return { peak, rms };
});
check("audio is flowing through the master chain", level.peak > 0.02 && level.rms > 0.005,
  `peak ${level.peak.toFixed(3)}, rms ${level.rms.toFixed(4)}`);
const stems = await page.evaluate(() => window.continuum.stemsAvailable());
check("the stem separator loaded", stems === true, `stemsAvailable=${stems}`);
const planInfo = await page.evaluate(() => {
  const p = window.continuum.plan();
  return p ? { steps: p.steps.length, kinds: p.steps.map((s) => s.transitionOut?.kind ?? null) } : null;
});
check("the plan covers every analysed track", planInfo?.steps === 3,
  `${planInfo?.steps} steps, transitions: ${planInfo?.kinds.join(" -> ")}`);

const stemButtons = await page.locator(".deck .stem-btn").count();
check("per-deck stem controls are present", stemButtons >= 4, `${stemButtons} buttons`);

console.log("\nBrowser: interaction");
await page.locator(".deck .stem-btn").first().click();
await page.waitForTimeout(400);
const muted = await page.locator(".deck .stem-btn.on").count();
check("a stem can be muted live", muted >= 1, `${muted} muted`);

await page.locator(".track").nth(1).click();
await page.waitForTimeout(300);
const detail = await page.locator("#detail").innerText();
const needed = [
  "Tempo confidence", "Beat confidence", "Phrase length", "Pulse clarity",
  "Syncopation", "Danceability", "Key confidence", "Tonal stability",
  "Integrated", "Loudness range", "True peak", "Crest factor",
  "Centroid", "Flatness", "Brightness", "Bass mono", "Correlation",
  "Mixability", "Structure", "Cue points",
];
// CSS uppercases the group headings and innerText returns the transformed text.
const missing = needed.filter((label) => !new RegExp(label, "i").test(detail));
check("the detail panel shows the full measurement set", missing.length === 0,
  missing.length ? `missing: ${missing.join(", ")}` : `${needed.length} labels present`);
const cueCount = await page.locator("#detail .cue").count();
check("cue points are listed", cueCount > 0, `${cueCount} cues`);
const sectionCount = await page.locator("#detail .sections i").count();
check("the structure map is drawn", sectionCount > 0, `${sectionCount} sections`);

// Seek via the timeline.
const box = await page.locator("#timeline").boundingBox();
await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
await page.waitForTimeout(2500);
const afterSeek = await page.$eval("#readout", (el) => el.textContent ?? "");
check("clicking the timeline seeks", afterSeek !== playState.readout, afterSeek);

// Skip from the top of the set, where there is definitely a blend ahead.
await page.mouse.click(box.x + 2, box.y + box.height / 2);
await page.waitForTimeout(1200);
const beforeSkip = await page.evaluate(() => window.continuum.state().position);
await page.click("#next");
await page.waitForTimeout(2500);
const afterSkip = await page.evaluate(() => window.continuum.state().position);
check("skip jumps forward to the next blend", afterSkip > beforeSkip + 10,
  `${beforeSkip.toFixed(1)}s -> ${afterSkip.toFixed(1)}s`);
check("two decks run through a blend", await page.locator(".deck").count() >= 2,
  `${await page.locator(".deck").count()} decks`);

// Mid-blend the floor still belongs to the outgoing track, so that is what the
// header must name; the incoming one is the "next".
const blendHeader = (await page.locator("#nowplaying").innerText()).replace(/\n/g, " | ");
const deckNames = await page.$$eval(".deck .deck-name", (els) => els.map((e) => e.textContent ?? ""));
check("the header names the outgoing track during a blend",
  deckNames.length >= 2 && blendHeader.startsWith(deckNames[0]),
  `header "${blendHeader.slice(0, 40)}" vs deck A "${deckNames[0]}"`);
check("the header names the incoming track as next",
  deckNames.length >= 2 && blendHeader.includes(`Next: ${deckNames[1]}`),
  deckNames.join(" -> "));
check("the header says the blend is in progress", /blending now/.test(blendHeader));

await page.click("#play");
await page.waitForTimeout(500);
check("pause works", (await page.$eval("#play", (el) => el.textContent)) === "Play");

// End of set: seek close to the end, play, and confirm it stops rather than
// leaving the clock running past the total.
const total = await page.evaluate(() => window.continuum.plan().totalDuration);
await page.evaluate((t) => window.continuum.state() && null, total);
const box2 = await page.locator("#timeline").boundingBox();
await page.mouse.click(box2.x + box2.width * 0.995, box2.y + box2.height / 2);
await page.click("#play");
await page.waitForTimeout(6000);
const endState = await page.evaluate(() => ({
  readout: document.querySelector("#readout")?.textContent ?? "",
  playing: window.continuum.state().playing,
  position: window.continuum.state().position,
}));
check("playback stops at the end of the set", !endState.playing, endState.readout);
check("the position never reports past the total",
  endState.position <= total + 0.01, `${endState.position.toFixed(1)} of ${total.toFixed(1)}`);

console.log("\nBrowser: export");
// Pressing play while parked at the end of the set should restart it.
const parkedAt = await page.evaluate(() => window.continuum.state().position);
await page.click("#play");
await page.waitForTimeout(2500);
const afterRestart = await page.evaluate(() => window.continuum.state());
check("play restarts the set from the top when parked at the end",
  afterRestart.playing && afterRestart.position < parkedAt / 2,
  `${parkedAt.toFixed(0)}s -> ${afterRestart.position.toFixed(1)}s`);

// Live recording: capture a few seconds of the actual output.
await page.waitForTimeout(500);
await page.click("#record");
await page.waitForTimeout(4000);
const recordingLabel = await page.$eval("#record", (el) => el.textContent ?? "");
check("recording starts and the button reflects it", /stop/i.test(recordingLabel), recordingLabel);
const recDownload = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
await page.click("#record");
const recFile = await recDownload;
check("recording produces a downloadable file", recFile !== null,
  recFile ? recFile.suggestedFilename() : "no download event");
if (recFile) {
  const path = await recFile.path();
  const size = path ? statSync(path).size : 0;
  check("the recording has audio in it", size > 8000, `${(size / 1024).toFixed(0)} KB`);
}

// Offline render. This is the OfflineAudioContext suspend/resume path, which
// decodes upcoming tracks and releases finished ones mid-render.
await page.evaluate(() => { if (window.continuum.state().playing) document.querySelector("#play").click(); });
const wavDownload = page.waitForEvent("download", { timeout: 240000 }).catch(() => null);
await page.click("#export");
const wavFile = await wavDownload;
check("offline render produces a WAV", wavFile !== null,
  wavFile ? wavFile.suggestedFilename() : "no download event");
if (wavFile) {
  const path = await wavFile.path();
  const size = path ? statSync(path).size : 0;
  const total = await page.evaluate(() => window.continuum.plan().totalDuration);
  // 16-bit stereo at 44.1 kHz is 176.4 kB per second.
  const expected = total * 44100 * 2 * 2;
  check("the WAV is the length of the whole set",
    size > expected * 0.9 && size < expected * 1.2,
    `${(size / 1024 / 1024).toFixed(1)} MB for ${total.toFixed(0)}s (expected ~${(expected / 1024 / 1024).toFixed(1)} MB)`);
  // Confirm it is a real RIFF/WAVE file carrying non-silent audio.
  if (path) {
    const buf = readFileSync(path);
    check("the WAV has a valid header",
      buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE",
      `${buf.toString("ascii", 0, 4)}/${buf.toString("ascii", 8, 12)}`);
    let peak = 0;
    let nonZero = 0;
    for (let off = 44; off + 1 < buf.length; off += 2) {
      const v = Math.abs(buf.readInt16LE(off));
      if (v > 64) nonZero++;
      if (v > peak) peak = v;
    }
    const samples = (buf.length - 44) / 2;
    check("the rendered mix is not silent", peak > 3000,
      `peak ${(peak / 32768).toFixed(3)} full scale`);
    check("the rendered mix has audio throughout", nonZero > samples * 0.5,
      `${((nonZero / samples) * 100).toFixed(0)}% of samples above the noise floor`);
  }
}

console.log("\nBrowser: console cleanliness");
const ignorable = /favicon|Autoplay|AudioContext was not allowed/i;
const realErrors = [...consoleErrors, ...pageErrors].filter((e) => !ignorable.test(e));
check("no page or console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" // "));

if (shotPath) {
  await page.screenshot({ path: shotPath });
  console.log(`\nscreenshot: ${shotPath}`);
}

console.log(`\n${checks - failures}/${checks} browser checks passed`);
await browser.close();
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
