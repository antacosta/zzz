/** Shared vocabulary between the analysis worker, the mix planner and the UI. */

export type StemName = "vocals" | "drums" | "bass" | "other";

export const STEMS: StemName[] = ["vocals", "drums", "bass", "other"];

/** Seven-band energy split used throughout the planner and the stem masks. */
export const BAND_EDGES = [0, 60, 120, 250, 500, 2000, 6000, 20000] as const;
export const BAND_NAMES = ["sub", "bass", "lowmid", "mid", "highmid", "high", "air"] as const;
export type BandName = (typeof BAND_NAMES)[number];

export interface BeatGrid {
  /** beat positions in seconds */
  beats: Float32Array;
  /** indices into `beats` that start a bar (every 4th beat from the detected downbeat) */
  downbeats: Float32Array;
  /** phrase boundaries in seconds (every `phraseBars` bars) */
  phrases: Float32Array;
  bpm: number;
  /** tempo stability, 1 = metronomic */
  tempoConfidence: number;
  beatConfidence: number;
  phraseBars: number;
  /** offset of beat one, seconds */
  firstBeat: number;
  meter: number;
}

export interface KeyEstimate {
  /** 0 = C, 11 = B */
  tonic: number;
  mode: "major" | "minor";
  name: string;
  /** Camelot wheel code, e.g. "8A" */
  camelot: string;
  confidence: number;
  /**
   * Runner-up keys, for tracks whose harmony is ambiguous. `relative` is how
   * strong each candidate was as a fraction of the winner, so 0.9 means "very
   * nearly this key instead". It is deliberately on a different scale from
   * `confidence` above, and named differently, because mixing the two in one
   * display made the alternates look more likely than the chosen key.
   */
  alternates: { name: string; camelot: string; relative: number }[];
  /** 12-bin average chroma over the track */
  chroma: number[];
  /** how strongly the track sticks to one key, 0..1 */
  tonalStability: number;
}

export interface LoudnessProfile {
  /** ITU-R BS.1770-4 integrated loudness, LUFS */
  integratedLufs: number;
  /** loudness range (95th - 10th percentile of short-term), LU */
  loudnessRangeLu: number;
  shortTermMaxLufs: number;
  truePeakDb: number;
  /** headroom before clipping after gain normalisation */
  crestFactorDb: number;
  rmsDb: number;
  /** gain in dB to reach the mix reference loudness */
  normalisationGainDb: number;
  /** short-term LUFS timeline, one value per 100 ms */
  shortTerm: Float32Array;
}

export interface SpectralProfile {
  centroidHz: number;
  rolloff85Hz: number;
  bandwidthHz: number;
  /** Wiener entropy; high = noisy, low = tonal */
  flatness: number;
  /** per-band mean energy in dB, ordered as BAND_NAMES */
  bandsDb: number[];
  /** spectral contrast per band (peak-to-valley, dB) */
  contrastDb: number[];
  /** mean frame-to-frame spectral change, a texture/busyness measure */
  fluxMean: number;
  /** high-frequency content ratio, a proxy for mastering brightness */
  brightness: number;
}

export interface StereoProfile {
  /** 0 = mono, 1 = fully decorrelated */
  width: number;
  /** -1..1 inter-channel correlation */
  correlation: number;
  /** side energy relative to mid, dB */
  sideToMidDb: number;
  /** how much of the low end is mono (good bass-swap candidates score high) */
  bassMonoRatio: number;
}

export interface RhythmProfile {
  /** onset strength per beat, normalised */
  onsetDensity: number;
  /** 0..1, how regular the inter-beat intervals are */
  pulseClarity: number;
  /** ratio of percussive to harmonic energy from HPSS */
  percussiveRatio: number;
  /** syncopation: onset energy landing off the 1/8 grid */
  syncopation: number;
  /** composite 0..1 groove score */
  danceability: number;
  /** detected swing amount, 0 = straight, 0.33 = triplet feel */
  swing: number;
}

export type SectionLabel =
  | "intro"
  | "build"
  | "drop"
  | "groove"
  | "breakdown"
  | "bridge"
  | "outro";

export interface Section {
  start: number;
  end: number;
  label: SectionLabel;
  /** 0..1 loudness+band energy composite */
  energy: number;
  /** 0..1 how much lead vocal is present */
  vocalness: number;
  /** 0..1 rhythmic drive */
  drive: number;
  /** bar index of the section start on the beat grid */
  startBar: number;
  bars: number;
}

/** A point the mixer can legally start or leave a track on. */
export interface CuePoint {
  time: number;
  bar: number;
  kind: "mix-in" | "mix-out" | "drop" | "vocal-in" | "vocal-out" | "break" | "loop";
  /** 0..1 how good this point is for its purpose */
  score: number;
  label: string;
}

/** Per-frame timelines, all sampled on the same frame rate. */
export interface Timelines {
  frameRate: number;
  /** time of frame 0; see Spectrogram.frameOffset */
  frameOffset: number;
  /** 0..1 */
  energy: Float32Array;
  /** onset strength envelope */
  onset: Float32Array;
  /** 0..1 lead-vocal likelihood */
  vocal: Float32Array;
  /** 0..1 percussive dominance */
  percussive: Float32Array;
  /** per-band energy in dB, [band][frame] */
  bands: Float32Array[];
  centroid: Float32Array;
  /** harmonic change rate, useful for finding safe blend windows */
  tonalFlux: Float32Array;
}

export interface TrackAnalysis {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  grid: BeatGrid;
  key: KeyEstimate;
  loudness: LoudnessProfile;
  spectral: SpectralProfile;
  stereo: StereoProfile;
  rhythm: RhythmProfile;
  sections: Section[];
  cues: CuePoint[];
  timelines: Timelines;
  /** 0..1 overall energy used to shape the set arc */
  energyScore: number;
  /** 0..1 how easy this track is to mix (stable tempo, clean intro/outro) */
  mixability: number;
  /** mean vocal presence across the track */
  vocalDensity: number;
  analysisMs: number;
}

export type TransitionKind =
  | "bass-swap"
  | "vocal-over-instrumental"
  | "filter-sweep"
  | "harmonic-blend"
  | "drop-swap"
  | "echo-out"
  | "loop-roll"
  | "double-drop"
  | "hard-cut";

/** Automation of one parameter over the transition, in beats from transition start. */
export interface AutomationLane {
  target: string;
  points: { beat: number; value: number }[];
}

export interface Transition {
  kind: TransitionKind;
  /** length in beats */
  beats: number;
  /** outgoing-track time where the blend begins */
  fromTime: number;
  /** incoming-track time that is aligned to `fromTime` */
  toTime: number;
  /** tempo both decks are pulled to during the blend */
  mixBpm: number;
  lanes: AutomationLane[];
  /** human-readable reason the planner chose this */
  rationale: string;
  score: number;
}

/**
 * One track's slot in the mix timeline. All `*At` fields are mix-timeline
 * seconds; `trackOffset` and `exitTime` are positions inside the track itself.
 *
 * A deck's playback rate is not constant: it enters at whatever rate the
 * previous transition's mix tempo demanded, then glides to the rate its own
 * outgoing transition needs, the way a DJ nudges the pitch once a blend is done.
 */
export interface MixStep {
  index: number;
  trackId: string;
  trackName: string;
  /** mix-time the deck starts playing */
  startAt: number;
  /** track time at `startAt` */
  trackOffset: number;
  /** mix-time the deck stops */
  endAt: number;
  /** mix-time its outgoing transition begins (equals endAt for the last step) */
  transitionStartAt: number;
  /** track time at `transitionStartAt` */
  exitTime: number;
  transitionIn: Transition | null;
  transitionOut: Transition | null;
  /** rate while the incoming blend is still running */
  rateIn: number;
  /** rate for the body of the track and its outgoing blend */
  rateOut: number;
  /** mix-time where the rate glides from rateIn to rateOut */
  rampAt: number;
  rampSeconds: number;
  /** loudness-matching trim */
  gainDb: number;
}

export interface MixPlan {
  steps: MixStep[];
  totalDuration: number;
  targetBpm: number;
  /** 0..1 energy arc actually achieved, one value per step */
  arc: number[];
  notes: string[];
}
