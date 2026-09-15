/** Display formatting shared across the UI. */

import type { SectionLabel, TrackAnalysis } from "../types";

export function time(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function num(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "–";
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function hz(v: number): string {
  if (!Number.isFinite(v)) return "–";
  return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function energyClass(energy: number): string {
  if (energy < 0.4) return "energy-low";
  if (energy < 0.62) return "energy-mid";
  if (energy < 0.85) return "energy-high";
  return "energy-peak";
}

export const SECTION_COLOURS: Record<SectionLabel, string> = {
  intro: "#3a4a5e",
  build: "#7a6ad4",
  drop: "#f2617a",
  groove: "#5ad1c8",
  breakdown: "#2f6f7a",
  bridge: "#f0a85e",
  outro: "#434b59",
};

export function transitionLabel(kind: string): string {
  return kind.replace(/-/g, " ");
}

/** One-line summary of a track, used in the library rows. */
export function trackSummary(a: TrackAnalysis): string {
  return `${num(a.grid.bpm, 1)} BPM · ${a.key.camelot} ${a.key.name}`;
}
