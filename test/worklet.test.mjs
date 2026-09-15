/**
 * Offline test of the stem-separation worklet.
 *
 * The worklet is real DSP running on the audio thread, so it gets tested the
 * same way: instantiate the processor with stubbed AudioWorklet globals, push
 * audio through in 128-sample render quanta, and measure what comes out.
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SR = 48000;
const BLOCK = 128;

export function loadProcessor(sampleRate = SR) {
  let registered = null;
  const sandbox = {
    sampleRate,
    currentTime: 0,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (m) => { this.port._sent.push(m); },
          onmessage: null,
          _sent: [],
        };
      }
    },
    registerProcessor: (_name, cls) => { registered = cls; },
    console,
    Math,
    Float32Array,
    Uint32Array,
  };
  const ctx = createContext(sandbox);
  runInContext(readFileSync("public/worklets/stem-processor.js", "utf8"), ctx, {
    filename: "stem-processor.js",
  });
  if (!registered) throw new Error("worklet did not call registerProcessor");
  return registered;
}

/** Run a stereo signal through the processor and return the stereo output. */
export function runProcessor(Processor, left, right, gains = {}) {
  const p = new Processor();
  const params = {
    vocals: [gains.vocals ?? 1],
    drums: [gains.drums ?? 1],
    bass: [gains.bass ?? 1],
    other: [gains.other ?? 1],
  };
  const n = left.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const inBufL = new Float32Array(BLOCK);
  const inBufR = new Float32Array(BLOCK);
  const obL = new Float32Array(BLOCK);
  const obR = new Float32Array(BLOCK);

  for (let off = 0; off + BLOCK <= n; off += BLOCK) {
    inBufL.set(left.subarray(off, off + BLOCK));
    inBufR.set(right.subarray(off, off + BLOCK));
    obL.fill(0);
    obR.fill(0);
    p.process([[inBufL, inBufR]], [[obL, obR]], params);
    outL.set(obL, off);
    outR.set(obR, off);
  }
  return { outL, outR, ready: p.port._sent.find((m) => m.type === "ready") };
}

/** Energy of `x` inside [loHz, hiHz], measured with a plain DFT over one window. */
export function bandEnergy(x, sampleRate, loHz, hiHz, start = 0, len = 16384) {
  const N = Math.min(len, x.length - start);
  let energy = 0;
  const loK = Math.floor((loHz * N) / sampleRate);
  const hiK = Math.ceil((hiHz * N) / sampleRate);
  for (let k = loK; k <= hiK; k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / N;
    for (let i = 0; i < N; i++) {
      // Hann-windowed to keep leakage from dominating narrow bands
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      const v = x[start + i] * win;
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    energy += re * re + im * im;
  }
  return energy;
}

/** Best-fit integer delay between `a` (reference) and `b`, plus the residual. */
export function bestAlignment(a, b, maxDelay, probeStart, probeLen) {
  let bestDelay = 0;
  let bestErr = Infinity;
  for (let d = 0; d <= maxDelay; d++) {
    let err = 0;
    let ref = 0;
    for (let i = 0; i < probeLen; i++) {
      const ai = probeStart + i;
      const bi = ai + d;
      if (bi >= b.length) break;
      err += (a[ai] - b[bi]) ** 2;
      ref += a[ai] ** 2;
    }
    const rel = ref > 0 ? err / ref : Infinity;
    if (rel < bestErr) {
      bestErr = rel;
      bestDelay = d;
    }
  }
  return { delay: bestDelay, relativeError: bestErr };
}

export { SR, BLOCK };
