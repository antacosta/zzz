/** Synthetic audio generators used by the analysis tests. */

export interface Synth {
  sampleRate: number;
  channels: Float32Array[];
}

const NOTE_HZ = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Deterministic PRNG (mulberry32). The hat bursts and the noise floor need to
 * be reproducible, or the analysis tests report different numbers on every run
 * and nothing can be tuned or trusted.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A four-on-the-floor loop with a kick, offbeat hat, a sustained triad and an
 * optional centre-panned "vocal" melody, so tests can check tempo, key,
 * downbeat phase and vocal detection independently.
 */
export function makeTrack(opts: {
  bpm: number;
  seconds: number;
  /** midi note numbers of the chord */
  chord: number[];
  sampleRate?: number;
  vocal?: boolean;
  /** PRNG seed, so a given spec always produces identical samples */
  seed?: number;
  /** silence the drums for the first N bars to create an intro */
  introBars?: number;
  /**
   * Include the offbeat noise hats. Turn them off when comparing analyses
   * across sample rates: the noise is drawn per sample, so two rates produce
   * genuinely different signals and the comparison would measure the fixture
   * rather than the analysis.
   */
  hats?: boolean;
}): Synth {
  const sampleRate = opts.sampleRate ?? 44100;
  const rand = rng(opts.seed ?? 0x5eed);
  const n = Math.floor(sampleRate * opts.seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const beat = 60 / opts.bpm;
  const introEnd = (opts.introBars ?? 0) * beat * 4;

  // Drums
  for (let b = 0; ; b++) {
    const t = b * beat;
    if (t >= opts.seconds) break;
    if (t < introEnd) continue;
    // kick: 55 Hz sine with a fast decay
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < sampleRate * 0.16 && start + i < n; i++) {
      const env = Math.exp(-i / (sampleRate * 0.035));
      const f = 90 * Math.exp(-i / (sampleRate * 0.02)) + 48;
      const v = Math.sin((2 * Math.PI * f * i) / sampleRate) * env * 0.85;
      l[start + i] += v;
      r[start + i] += v;
    }
    // offbeat hat: filtered noise burst
    if (opts.hats !== false) {
      const hatStart = Math.floor((t + beat / 2) * sampleRate);
      for (let i = 0; i < sampleRate * 0.05 && hatStart + i < n; i++) {
        const env = Math.exp(-i / (sampleRate * 0.008));
        const v = (rand() * 2 - 1) * env * 0.16;
        l[hatStart + i] += v * 0.9;
        r[hatStart + i] += v * 1.1;
      }
    }
  }

  // Sustained chord, spread across the stereo field
  for (let c = 0; c < opts.chord.length; c++) {
    const hz = NOTE_HZ(opts.chord[c]);
    const pan = (c / Math.max(1, opts.chord.length - 1)) * 0.6 + 0.2;
    for (let i = 0; i < n; i++) {
      const v =
        (Math.sin((2 * Math.PI * hz * i) / sampleRate) +
          0.35 * Math.sin((4 * Math.PI * hz * i) / sampleRate)) *
        0.13;
      l[i] += v * (1 - pan);
      r[i] += v * pan;
    }
  }

  // Centre-panned melody in the vocal band, entering halfway through
  if (opts.vocal) {
    const melody = [67, 69, 71, 72, 71, 69];
    const noteLen = beat * 2;
    const vocalStart = opts.seconds / 2;
    for (let k = 0; ; k++) {
      const t = vocalStart + k * noteLen;
      if (t >= opts.seconds) break;
      const hz = NOTE_HZ(melody[k % melody.length]);
      const start = Math.floor(t * sampleRate);
      const len = Math.floor(noteLen * 0.85 * sampleRate);
      for (let i = 0; i < len && start + i < n; i++) {
        const env = Math.min(1, i / (sampleRate * 0.02)) * Math.min(1, (len - i) / (sampleRate * 0.05));
        // vibrato + harmonics, as a voice would have
        const vib = 1 + 0.01 * Math.sin((2 * Math.PI * 5.5 * i) / sampleRate);
        let v = 0;
        for (let harm = 1; harm <= 4; harm++) {
          v += Math.sin((2 * Math.PI * hz * vib * harm * i) / sampleRate) / (harm * 1.5);
        }
        v *= env * 0.3;
        l[start + i] += v;
        r[start + i] += v;
      }
    }
  }

  // Keep it out of clipping territory
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) {
    l[i] *= g;
    r[i] *= g;
  }

  return { sampleRate, channels: [l, r] };
}
