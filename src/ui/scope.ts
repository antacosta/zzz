/**
 * Canvas visualisers. All of them redraw from scratch each frame at device
 * pixel ratio; the shapes are simple enough that this stays cheap and avoids
 * any resize bookkeeping.
 */

import { clamp, timeToFrame } from "../analysis/dsp";
import type { MixPlan, Section, TrackAnalysis } from "../types";
import { SECTION_COLOURS } from "./format";

export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

export function surface(canvas: HTMLCanvasElement): Surface | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

/** Master output oscilloscope. */
export function drawWaveform(s: Surface, data: Float32Array): void {
  const { ctx, width, height } = s;
  const mid = height / 2;
  ctx.strokeStyle = "#5ad1c8";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(data.length / width));
  for (let x = 0; x < width; x++) {
    const i = Math.min(data.length - 1, x * step);
    const y = mid - data[i] * mid * 0.92;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.055)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
}

/** Master spectrum, log-frequency. */
export function drawSpectrum(s: Surface, data: Uint8Array, sampleRate: number, fftSize: number): void {
  const { ctx, width, height } = s;
  const binHz = sampleRate / fftSize;
  const minHz = 30;
  const maxHz = Math.min(18000, sampleRate / 2);
  const logMin = Math.log2(minHz);
  const logSpan = Math.log2(maxHz) - logMin;
  const gradient = ctx.createLinearGradient(0, height, 0, 0);
  gradient.addColorStop(0, "#2a4f63");
  gradient.addColorStop(0.55, "#5ad1c8");
  gradient.addColorStop(1, "#f0a85e");
  ctx.fillStyle = gradient;

  const cols = Math.floor(width / 3);
  for (let c = 0; c < cols; c++) {
    const f0 = 2 ** (logMin + (c / cols) * logSpan);
    const f1 = 2 ** (logMin + ((c + 1) / cols) * logSpan);
    const b0 = Math.max(1, Math.floor(f0 / binHz));
    const b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
    let peak = 0;
    for (let b = b0; b < b1 && b < data.length; b++) peak = Math.max(peak, data[b]);
    const h = (peak / 255) * height;
    ctx.fillRect(c * 3, height - h, 2, h);
  }
}

/** Per-deck waveform with the section map and a playhead. */
export function drawTrackWave(
  s: Surface,
  track: TrackAnalysis,
  playhead: number,
  blendStart?: number,
): void {
  const { ctx, width, height } = s;
  const duration = track.duration || 1;

  // Section bands underneath.
  for (const section of track.sections) {
    const x0 = (section.start / duration) * width;
    const x1 = (section.end / duration) * width;
    ctx.fillStyle = SECTION_COLOURS[section.label];
    ctx.globalAlpha = 0.22;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    ctx.globalAlpha = 1;
  }

  // Energy envelope.
  const energy = track.timelines.energy;
  const { frameRate, frameOffset } = track.timelines;
  ctx.fillStyle = "rgba(90, 209, 200, 0.55)";
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x < width; x++) {
    const t = (x / width) * duration;
    const i = clamp(Math.round(timeToFrame(t, frameRate, frameOffset)), 0, energy.length - 1);
    ctx.lineTo(x, height - energy[i] * height * 0.95);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  // Vocal presence on top, so a glance shows where the voice is.
  const vocal = track.timelines.vocal;
  ctx.strokeStyle = "rgba(240, 168, 94, 0.9)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const t = (x / width) * duration;
    const i = clamp(Math.round(timeToFrame(t, frameRate, frameOffset)), 0, vocal.length - 1);
    const y = height - vocal[i] * height * 0.9;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Where this deck's outgoing blend begins.
  if (blendStart !== undefined && blendStart > 0) {
    const x = (blendStart / duration) * width;
    ctx.strokeStyle = "rgba(139, 124, 246, 0.9)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Playhead.
  const px = (clamp(playhead, 0, duration) / duration) * width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 0.5, 0, 1.5, height);
}

/** The whole-set timeline: one block per track, coloured by energy. */
export function drawTimeline(
  s: Surface,
  plan: MixPlan,
  tracks: Map<string, TrackAnalysis>,
  position: number,
  hover: number | null,
): void {
  const { ctx, width, height } = s;
  const total = plan.totalDuration || 1;

  ctx.fillStyle = "#12151b";
  ctx.fillRect(0, 0, width, height);

  for (const step of plan.steps) {
    const track = tracks.get(step.trackId);
    const x0 = (step.startAt / total) * width;
    const x1 = (step.endAt / total) * width;
    const energy = track?.energyScore ?? 0.5;
    const h = 6 + energy * (height - 14);
    // Alternating rows make overlapping blends legible.
    const y = step.index % 2 === 0 ? height - h - 4 : 4;
    ctx.fillStyle = energyColour(energy);
    ctx.globalAlpha = 0.85;
    roundRect(ctx, x0, y, Math.max(2, x1 - x0), h, 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Mark the blend region.
    const bx0 = (step.transitionStartAt / total) * width;
    if (step.transitionOut) {
      ctx.fillStyle = "rgba(139, 124, 246, 0.55)";
      ctx.fillRect(bx0, y, Math.max(1.5, x1 - bx0), h);
    }
  }

  // Phrase-ish gridlines every five minutes.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let t = 300; t < total; t += 300) {
    const x = (t / total) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  if (hover !== null) {
    const x = (clamp(hover, 0, total) / total) * width;
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  const px = (clamp(position, 0, total) / total) * width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 0.75, 0, 1.75, height);
}

function energyColour(energy: number): string {
  if (energy < 0.4) return "#4a6b8a";
  if (energy < 0.62) return "#3e9e97";
  if (energy < 0.85) return "#c9883f";
  return "#d1526a";
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Small horizontal section strip used in the detail panel. */
export function sectionStrip(sections: Section[], duration: number): string {
  return sections
    .map((s) => {
      const w = ((s.end - s.start) / Math.max(duration, 1)) * 100;
      return `<i style="width:${w.toFixed(2)}%;background:${SECTION_COLOURS[s.label]}" title="${s.label} · ${s.bars} bars"></i>`;
    })
    .join("");
}
