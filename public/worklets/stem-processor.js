/**
 * Real-time four-stem separator, STFT-domain.
 *
 * Splits the incoming stereo signal into vocals / drums / bass / other and
 * re-sums them at independently controllable gains, so the mixer can play the
 * vocal of one track over the instrumental of another, swap basslines on a
 * phrase line, or drop a track's drums out from under it.
 *
 * Method
 * ------
 * Masks are derived from median-filter harmonic/percussive separation
 * (Fitzgerald): a median along frequency keeps broadband transients, a median
 * along time keeps sustained partials. A centre-channel dominance term isolates
 * the lead vocal, which in practically all produced music sits in the middle of
 * the stereo image.
 *
 *   percussive(b) = pv^2 / (pv^2 + hv^2)      harmonic(b) = 1 - percussive(b)
 *   bass(b)       = harmonic(b) * lowWeight(b)
 *   vocals(b)     = harmonic(b) * vocalBand(b) * centre(b)
 *   drums(b)      = percussive(b)
 *   other(b)      = harmonic(b) - bass(b) - vocals(b)      (clamped at 0)
 *
 * The four masks sum to exactly 1 at every bin, so with all gains at 1 the
 * output is a sample-accurate reconstruction of the input and the node can be
 * left in the signal path permanently at no cost to fidelity.
 *
 * Latency
 * -------
 * Two things cost delay: filling the first analysis window (FFT_SIZE - HOP,
 * plus the HOP that triggers it) and the centred time-direction median, which
 * is not causal (MEDIAN_RADIUS * HOP). Together that is
 * FFT_SIZE + MEDIAN_RADIUS * HOP = 4096 samples, ~85 ms at 48 kHz.
 *
 * process() drains its output FIFO before it takes in new input, so that
 * figure holds exactly and does not shift with the render quantum size. It is
 * reported to the main thread on startup, and the scheduler subtracts it when
 * beat-aligning decks.
 */

const FFT_SIZE = 2048;
const HOP = 512;
const BINS = FFT_SIZE / 2 + 1;
const MEDIAN_RADIUS = 4; // frames either side, for the time-direction median
const FREQ_RADIUS = 4; // bins either side, for the frequency-direction median
const RING = MEDIAN_RADIUS * 2 + 1;
/** Deterministic input-to-output delay; see the note on latency above. */
const LATENCY_SAMPLES = FFT_SIZE + MEDIAN_RADIUS * HOP;

/** Iterative radix-2 FFT, precomputed twiddles. */
class FFT {
  constructor(size) {
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    const half = size >> 1;
    this.cos = new Float32Array(half);
    this.sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  transform(re, im) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step;
          const c = this.cos[tw];
          const s = this.sin[tw];
          const a = i + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  inverse(re, im) {
    const n = this.size;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.transform(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= -inv;
    }
  }
}

/** Median of the first `len` entries of `buf`, via insertion sort. Mutates buf. */
function medianInPlace(buf, len) {
  for (let i = 1; i < len; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  return len & 1 ? buf[len >> 1] : (buf[(len >> 1) - 1] + buf[len >> 1]) / 2;
}

class StemProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "vocals", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "drums", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "bass", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "other", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.fft = new FFT(FFT_SIZE);

    // Hann window used for both analysis and synthesis; with HOP = N/4 the
    // squared window sums to 1.5, which we divide back out on output.
    this.window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
    }
    this.olaScale = 1 / 1.5;

    // Input shift registers, one per channel.
    this.inL = new Float32Array(FFT_SIZE);
    this.inR = new Float32Array(FFT_SIZE);
    this.fill = 0;
    this.pending = new Float32Array(HOP);
    this.pendingR = new Float32Array(HOP);

    // Frame ring: complex spectra plus the mid/side magnitudes each frame needs.
    this.ring = [];
    for (let i = 0; i < RING; i++) {
      this.ring.push({
        reL: new Float32Array(FFT_SIZE), imL: new Float32Array(FFT_SIZE),
        reR: new Float32Array(FFT_SIZE), imR: new Float32Array(FFT_SIZE),
        midMag: new Float32Array(BINS), sideMag: new Float32Array(BINS),
      });
    }
    this.ringHead = 0;
    this.ringCount = 0;

    // Overlap-add accumulators and the output FIFO.
    this.olaL = new Float32Array(FFT_SIZE);
    this.olaR = new Float32Array(FFT_SIZE);
    this.outL = new Float32Array(FFT_SIZE * 4);
    this.outR = new Float32Array(FFT_SIZE * 4);
    this.outWrite = 0;
    this.outRead = 0;
    this.outAvail = 0;

    // Scratch, allocated once: the audio thread must not allocate.
    this.scratchTime = new Float32Array(RING);
    this.scratchFreq = new Float32Array(FREQ_RADIUS * 2 + 1);
    this.freqMed = new Float32Array(BINS);
    this.perc = new Float32Array(BINS);
    this.maskVocals = new Float32Array(BINS);
    this.maskDrums = new Float32Array(BINS);
    this.maskBass = new Float32Array(BINS);
    this.maskOther = new Float32Array(BINS);

    // Band weight curves, computed once for this sample rate.
    this.lowWeight = new Float32Array(BINS);
    this.vocalBand = new Float32Array(BINS);
    const binHz = sampleRate / FFT_SIZE;
    for (let b = 0; b < BINS; b++) {
      const hz = b * binHz;
      this.lowWeight[b] = ramp(hz, 220, 120); // 1 below 120 Hz, 0 above 220 Hz
      this.vocalBand[b] = ramp(hz, 180, 280) * ramp(hz, 6500, 4000);
    }

    // Smoothed gains; stepping a gain instantly would click on the mask sum.
    this.g = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.smoothing = 0.25;
    this.bypass = false;
    this.frameIndex = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (msg && msg.type === "bypass") this.bypass = !!msg.value;
    };
    this.port.postMessage({
      type: "ready",
      latencySamples: LATENCY_SAMPLES,
      fftSize: FFT_SIZE,
      hop: HOP,
    });
  }

  /** Analyse the current contents of the shift registers into the frame ring. */
  analyseFrame() {
    const slot = this.ring[this.ringHead];
    this.ringHead = (this.ringHead + 1) % RING;
    if (this.ringCount < RING) this.ringCount++;

    const { reL, imL, reR, imR, midMag, sideMag } = slot;
    for (let i = 0; i < FFT_SIZE; i++) {
      const w = this.window[i];
      reL[i] = this.inL[i] * w;
      imL[i] = 0;
      reR[i] = this.inR[i] * w;
      imR[i] = 0;
    }
    this.fft.transform(reL, imL);
    this.fft.transform(reR, imR);
    for (let b = 0; b < BINS; b++) {
      const mr = (reL[b] + reR[b]) * 0.5;
      const mi = (imL[b] + imR[b]) * 0.5;
      const sr = (reL[b] - reR[b]) * 0.5;
      const si = (imL[b] - imR[b]) * 0.5;
      midMag[b] = Math.sqrt(mr * mr + mi * mi);
      sideMag[b] = Math.sqrt(sr * sr + si * si);
    }
  }

  /** Index in the ring of the frame `back` frames behind the newest. */
  ringAt(back) {
    return (this.ringHead - 1 - back + RING * 2) % RING;
  }

  /** Build the four masks for the centre frame of the ring. */
  buildMasks(centreIdx) {
    const centre = this.ring[centreIdx];
    const mid = centre.midMag;
    const side = centre.sideMag;

    // Frequency-direction median -> percussive estimate.
    const fm = this.freqMed;
    const sf = this.scratchFreq;
    for (let b = 0; b < BINS; b++) {
      let k = 0;
      for (let j = b - FREQ_RADIUS; j <= b + FREQ_RADIUS; j++) {
        if (j < 0 || j >= BINS) continue;
        sf[k++] = mid[j];
      }
      fm[b] = medianInPlace(sf, k);
    }

    // Time-direction median -> harmonic estimate, using the whole ring.
    const st = this.scratchTime;
    for (let b = 0; b < BINS; b++) {
      for (let f = 0; f < this.ringCount; f++) {
        st[f] = this.ring[this.ringAt(f)].midMag[b];
      }
      const hv = medianInPlace(st, this.ringCount);
      const pv = fm[b];
      const denom = pv * pv + hv * hv + 1e-20;
      this.perc[b] = (pv * pv) / denom;
    }

    for (let b = 0; b < BINS; b++) {
      const p = this.perc[b];
      const h = 1 - p;
      const m = mid[b];
      const s = side[b];
      // Centre dominance: side energy is weighted up so that anything with real
      // stereo spread is excluded from the vocal stem.
      const centreness = (m * m) / (m * m + 2.5 * s * s + 1e-20);
      const bass = h * this.lowWeight[b];
      const vocals = h * this.vocalBand[b] * centreness;
      const other = Math.max(0, h - bass - vocals);
      this.maskDrums[b] = p;
      this.maskBass[b] = bass;
      this.maskVocals[b] = vocals;
      // Any shortfall from clamping goes back to `other` so the masks still
      // sum to 1 and unity gains reconstruct the input exactly.
      this.maskOther[b] = other + (h - bass - vocals - other);
    }
  }

  /** Apply masks to the centre frame, resynthesise and overlap-add. */
  synthesise(centreIdx) {
    const f = this.ring[centreIdx];
    const g = this.g;
    const reL = this.scratchReL || (this.scratchReL = new Float32Array(FFT_SIZE));
    const imL = this.scratchImL || (this.scratchImL = new Float32Array(FFT_SIZE));
    const reR = this.scratchReR || (this.scratchReR = new Float32Array(FFT_SIZE));
    const imR = this.scratchImR || (this.scratchImR = new Float32Array(FFT_SIZE));

    for (let b = 0; b < BINS; b++) {
      const gain = this.bypass
        ? 1
        : g.vocals * this.maskVocals[b] +
          g.drums * this.maskDrums[b] +
          g.bass * this.maskBass[b] +
          g.other * this.maskOther[b];
      reL[b] = f.reL[b] * gain;
      imL[b] = f.imL[b] * gain;
      reR[b] = f.reR[b] * gain;
      imR[b] = f.imR[b] * gain;
      // Mirror into the negative frequencies to keep the signal real.
      if (b > 0 && b < BINS - 1) {
        const m = FFT_SIZE - b;
        reL[m] = reL[b];
        imL[m] = -imL[b];
        reR[m] = reR[b];
        imR[m] = -imR[b];
      }
    }

    this.fft.inverse(reL, imL);
    this.fft.inverse(reR, imR);

    for (let i = 0; i < FFT_SIZE; i++) {
      const w = this.window[i] * this.olaScale;
      this.olaL[i] += reL[i] * w;
      this.olaR[i] += reR[i] * w;
    }

    // The first HOP samples of the accumulator are now complete.
    for (let i = 0; i < HOP; i++) {
      this.outL[this.outWrite] = this.olaL[i];
      this.outR[this.outWrite] = this.olaR[i];
      this.outWrite = (this.outWrite + 1) % this.outL.length;
    }
    this.outAvail += HOP;
    this.olaL.copyWithin(0, HOP);
    this.olaR.copyWithin(0, HOP);
    this.olaL.fill(0, FFT_SIZE - HOP);
    this.olaR.fill(0, FFT_SIZE - HOP);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const blockSize = output[0].length;
    const hasInput = input && input.length > 0 && input[0] && input[0].length > 0;
    const inCh0 = hasInput ? input[0] : null;
    const inCh1 = hasInput ? (input.length > 1 ? input[1] : input[0]) : null;

    // Smooth the gain targets once per render quantum.
    const k = this.smoothing;
    for (const name of ["vocals", "drums", "bass", "other"]) {
      const target = parameters[name][0];
      this.g[name] += (target - this.g[name]) * k;
    }

    // Drain the FIFO first. Emitting only what was already complete at the top
    // of the call is what keeps the latency fixed at LATENCY_SAMPLES; until the
    // FIFO has filled we emit silence, which is exactly that latency.
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    for (let i = 0; i < blockSize; i++) {
      if (this.outAvail > 0) {
        outL[i] = this.outL[this.outRead];
        if (outR) outR[i] = this.outR[this.outRead];
        this.outRead = (this.outRead + 1) % this.outL.length;
        this.outAvail--;
      } else {
        outL[i] = 0;
        if (outR) outR[i] = 0;
      }
    }

    // Then feed the shift registers, one hop at a time.
    for (let i = 0; i < blockSize; i++) {
      this.pending[this.fill] = inCh0 ? inCh0[i] : 0;
      this.pendingR[this.fill] = inCh1 ? inCh1[i] : 0;
      this.fill++;
      if (this.fill === HOP) {
        this.fill = 0;
        this.inL.copyWithin(0, HOP);
        this.inR.copyWithin(0, HOP);
        this.inL.set(this.pending, FFT_SIZE - HOP);
        this.inR.set(this.pendingR, FFT_SIZE - HOP);
        this.analyseFrame();
        this.frameIndex++;
        if (this.ringCount === RING) {
          const centreIdx = this.ringAt(MEDIAN_RADIUS);
          this.buildMasks(centreIdx);
          this.synthesise(centreIdx);
        }
      }
    }

    return true;
  }
}

/** Linear ramp from 1 at `one` to 0 at `zero`, in either direction. */
function ramp(x, zero, one) {
  if (zero > one) {
    if (x <= one) return 1;
    if (x >= zero) return 0;
    return (zero - x) / (zero - one);
  }
  if (x <= zero) return 0;
  if (x >= one) return 1;
  return (x - zero) / (one - zero);
}

registerProcessor("stem-processor", StemProcessor);
