/**
 * Core DSP primitives shared by every analyser.
 * Everything here is allocation-conscious: the analysis worker runs these over
 * whole tracks, so buffers are reused wherever it is safe to do so.
 */

/** In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` length must be a power of two. */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`);
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

  transform(re: Float32Array, im: Float32Array): void {
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

  /** Inverse transform (scaled by 1/N). */
  inverse(re: Float32Array, im: Float32Array): void {
    for (let i = 0; i < this.size; i++) im[i] = -im[i];
    this.transform(re, im);
    const inv = 1 / this.size;
    for (let i = 0; i < this.size; i++) {
      re[i] *= inv;
      im[i] *= -inv;
    }
  }
}

export function hann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

export interface Spectrogram {
  /** magnitude frames, each `bins` long (bins = fftSize/2 + 1) */
  frames: Float32Array[];
  bins: number;
  hop: number;
  fftSize: number;
  sampleRate: number;
  /** seconds per frame */
  frameRate: number;
}

/** Magnitude STFT of a mono signal. */
export function stft(
  signal: Float32Array,
  sampleRate: number,
  fftSize = 2048,
  hop = 512,
): Spectrogram {
  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  const bins = fftSize / 2 + 1;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const count = Math.max(1, Math.floor((signal.length - fftSize) / hop) + 1);
  const frames: Float32Array[] = new Array(count);

  for (let f = 0; f < count; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) {
      const s = off + i;
      re[i] = s < signal.length ? signal[s] * win[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    const mag = new Float32Array(bins);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
    frames[f] = mag;
  }

  return { frames, bins, hop, fftSize, sampleRate, frameRate: hop / sampleRate };
}

/** Downmix an AudioBuffer-like channel set to mono. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Linear-interpolating resampler; adequate for feature extraction (not playback). */
export function resample(signal: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return signal;
  const ratio = from / to;
  const n = Math.floor(signal.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(signal.length - 1, i0 + 1);
    const t = x - i0;
    out[i] = signal[i0] * (1 - t) + signal[i1] * t;
  }
  return out;
}

/** Running median over a 1-D array with a centred window of `radius` samples each side. */
export function medianFilter(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const scratch = new Float32Array(radius * 2 + 1);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= n) continue;
      scratch[k++] = x[j];
    }
    const slice = scratch.subarray(0, k);
    out[i] = median(slice);
  }
  return out;
}

export function median(values: ArrayLike<number>): number {
  const a = Float32Array.from(values as never);
  a.sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(values: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return values.length ? s / values.length : 0;
}

export function stddev(values: ArrayLike<number>, mu = mean(values)): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += (values[i] - mu) ** 2;
  return values.length ? Math.sqrt(s / values.length) : 0;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const a = Float32Array.from(values as never);
  a.sort();
  if (!a.length) return 0;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[idx];
}

/** Normalise to 0..1 by min/max with a guard against flat input. */
export function normalise(x: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of x) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  const out = new Float32Array(x.length);
  if (span < 1e-12) return out;
  for (let i = 0; i < x.length; i++) out[i] = (x[i] - lo) / span;
  return out;
}

/** Smooth with a symmetric moving average of half-width `radius`. */
export function smooth(x: Float32Array, radius: number): Float32Array {
  if (radius < 1) return x.slice();
  const n = x.length;
  const out = new Float32Array(n);
  let acc = 0;
  const win = radius * 2 + 1;
  const padded = new Float32Array(n + radius * 2);
  padded.set(x, radius);
  for (let i = 0; i < radius; i++) {
    padded[i] = x[0];
    padded[n + radius + i] = x[n - 1];
  }
  for (let i = 0; i < win; i++) acc += padded[i];
  for (let i = 0; i < n; i++) {
    out[i] = acc / win;
    acc += padded[i + win] - padded[i];
  }
  return out;
}

/** Transposed-direct-form-II biquad applied offline over a signal (returns a new array). */
export function biquad(
  x: Float32Array,
  b0: number, b1: number, b2: number, a1: number, a2: number,
): Float32Array {
  const y = new Float32Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = b0 * x[i] + z1;
    z1 = b1 * x[i] - a1 * out + z2;
    z2 = b2 * x[i] - a2 * out;
    y[i] = out;
  }
  return y;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(g, 1e-12));
}
