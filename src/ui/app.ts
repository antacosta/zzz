/**
 * Application shell.
 *
 * Static structure is rendered once per state change; anything that moves
 * (scopes, playhead, deck times) is updated imperatively from a single
 * requestAnimationFrame loop, so playback never waits on DOM diffing.
 */

import { clamp } from "../analysis/dsp";
import { MIX_REFERENCE_LUFS } from "../analysis/loudness";
import { BAND_NAMES, STEMS, type MixPlan, type MixStep, type StemName, type TrackAnalysis } from "../types";
import { DEFAULT_PLAN_OPTIONS, type PlanOptions, planMix } from "../engine/planner";
import { renderMixToWav } from "../engine/render";
import { TrackStore, type LibraryTrack } from "../engine/store";
import { Transport } from "../engine/transport";
import { HP_OPEN, LP_OPEN } from "../engine/transitions";
import * as fmt from "./format";
import {
  drawSpectrum, drawTimeline, drawTrackWave, drawWaveform, sectionStrip, surface,
} from "./scope";

interface DeckOverride {
  stems: Record<StemName, number>;
  lowpass: number;
  highpass: number;
}

export class App {
  private readonly root: HTMLElement;
  private readonly store: TrackStore;
  private readonly transport: Transport;
  private readonly analysisCtx: AudioContext;

  private plan: MixPlan | null = null;
  private selectedId: string | null = null;
  private options: PlanOptions = { ...DEFAULT_PLAN_OPTIONS };
  private overrides = new Map<number, DeckOverride>();
  private hoverTime: number | null = null;
  private busy: string | null = null;
  private spectrumData = new Uint8Array(1024);
  private waveData = new Float32Array(2048);
  /** number of ready tracks the current plan was built from */
  private plannedCount = 0;
  private frame = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    // Decoding needs a context. This one is created up front and only used for
    // decodeAudioData, so it can exist before any user gesture.
    this.analysisCtx = new AudioContext();
    void this.analysisCtx.suspend();
    this.store = new TrackStore(this.analysisCtx, (track) => this.onTrackChange(track));
    this.transport = new Transport(this.store);

    this.renderShell();
    this.bindGlobal();
    this.loop();
    this.exposeTestHook();
  }

  /**
   * A read-only handle for the end-to-end browser check, which needs to assert
   * on real master levels rather than on what the canvas happens to look like.
   */
  private exposeTestHook(): void {
    (window as unknown as { continuum?: unknown }).continuum = {
      meters: () => this.transport.master?.meters() ?? null,
      state: () => this.transport.state(),
      plan: () => this.plan,
      stemsAvailable: () => this.transport.stemsAvailable,
      readyCount: () => this.store.ready().length,
    };
  }

  // ---- data ------------------------------------------------------------

  private onTrackChange(track: LibraryTrack): void {
    this.renderLibrary();
    if (this.selectedId === track.id) this.renderDetail();
    // Build a mix without being asked, and keep folding in tracks as they
    // finish: the point of the tool is that you drop files and press play.
    // Once the set is running, replanning under the playhead would be rude, so
    // new arrivals wait for an explicit rebuild.
    if (track.state !== "ready") {
      this.renderTopbar();
      return;
    }
    const ready = this.store.ready().length;
    if (ready >= 1 && ready !== this.plannedCount && !this.transport.isPlaying) {
      this.buildPlan();
    } else {
      this.renderTopbar();
      if (ready !== this.plannedCount) {
        this.toast(`${ready - this.plannedCount} new track(s) ready — Rebuild mix to include them.`);
      }
    }
  }

  private analyses(): Map<string, TrackAnalysis> {
    const map = new Map<string, TrackAnalysis>();
    for (const t of this.store.list()) if (t.analysis) map.set(t.id, t.analysis);
    return map;
  }

  private buildPlan(): void {
    const ready = this.store.ready();
    if (ready.length < 1) {
      this.toast("Add at least one analysed track first.");
      return;
    }
    this.plan = planMix(ready, this.options);
    this.plannedCount = ready.length;
    this.transport.setPlan(this.plan);
    this.overrides.clear();
    this.renderTopbar();
    this.renderLibrary();
    this.renderNowPlaying();
    this.renderNotes();
    this.toast(
      `Mix built: ${this.plan.steps.length} tracks, ${fmt.time(this.plan.totalDuration)}`,
    );
  }

  // ---- shell -----------------------------------------------------------

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="topbar">
        <div class="brand">
          <h1>Continuum</h1>
          <span class="tag">continuous DJ mixing</span>
        </div>
        <div class="spacer"></div>
        <div id="topstats" style="display:flex;gap:18px"></div>
        <button id="rebuild">Rebuild mix</button>
        <button id="record">Record</button>
        <button id="export">Export WAV</button>
      </div>
      <div class="main">
        <div class="col left">
          <div class="col-head">
            <h2>Library</h2>
            <div class="spacer"></div>
            <span id="libcount" class="kbd"></span>
          </div>
          <div class="col-body">
            <div class="dropzone" id="dropzone">
              <strong>Drop audio files here</strong>
              <span>or click to choose &middot; wav, mp3, flac, m4a, ogg</span>
            </div>
            <div id="library"></div>
          </div>
          <div class="options" id="options"></div>
        </div>
        <div class="col centre">
          <div class="now-playing" id="nowplaying"></div>
          <div class="scopes">
            <div class="scope"><span class="label">Output</span><canvas id="scope-wave"></canvas></div>
            <div class="scope"><span class="label">Spectrum</span><canvas id="scope-spectrum"></canvas></div>
          </div>
          <div class="decks" id="decks"></div>
          <div class="transport">
            <div class="timeline" id="timeline"><canvas id="timeline-canvas"></canvas></div>
            <div class="transport-row">
              <button class="icon" id="prev" title="Previous track (left arrow)">&#9198;</button>
              <button class="primary play-btn" id="play">Play</button>
              <button class="icon" id="next" title="Next blend (right arrow)">&#9197;</button>
              <span class="time-readout" id="readout">0:00 / 0:00</span>
              <div class="spacer"></div>
              <span class="kbd">space play</span>
              <span class="kbd">&larr; &rarr; skip</span>
            </div>
          </div>
        </div>
        <div class="col right">
          <div class="col-head"><h2 id="detail-head">Measurements</h2></div>
          <div class="col-body" id="detail"></div>
        </div>
      </div>
      <input type="file" id="filepicker" multiple accept="audio/*" style="display:none" />
    `;

    this.bindShell();
    this.renderLibrary();
    this.renderOptions();
    this.renderNowPlaying();
    this.renderDetail();
    this.renderTopbar();
  }

  private $<T extends HTMLElement>(id: string): T {
    return this.root.querySelector(`#${id}`) as T;
  }

  private bindShell(): void {
    const picker = this.$<HTMLInputElement>("filepicker");
    const dropzone = this.$("dropzone");

    dropzone.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
      if (picker.files) this.addFiles([...picker.files]);
      picker.value = "";
    });

    for (const type of ["dragenter", "dragover"]) {
      dropzone.addEventListener(type, (ev) => {
        ev.preventDefault();
        dropzone.classList.add("over");
      });
    }
    for (const type of ["dragleave", "drop"]) {
      dropzone.addEventListener(type, () => dropzone.classList.remove("over"));
    }
    dropzone.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const dt = (ev as DragEvent).dataTransfer;
      if (dt?.files) this.addFiles([...dt.files]);
    });

    this.$("play").addEventListener("click", () => void this.togglePlay());
    this.$("next").addEventListener("click", () => void this.transport.skipNext());
    this.$("prev").addEventListener("click", () => void this.transport.skipPrevious());
    this.$("rebuild").addEventListener("click", () => this.buildPlan());
    this.$("record").addEventListener("click", () => void this.toggleRecording());
    this.$("export").addEventListener("click", () => void this.exportWav());

    const timeline = this.$("timeline");
    timeline.addEventListener("click", (ev) => {
      if (!this.plan) return;
      const rect = timeline.getBoundingClientRect();
      const frac = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      void this.transport.seek(frac * this.plan.totalDuration);
    });
    timeline.addEventListener("mousemove", (ev) => {
      if (!this.plan) return;
      const rect = timeline.getBoundingClientRect();
      this.hoverTime = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * this.plan.totalDuration;
    });
    timeline.addEventListener("mouseleave", () => {
      this.hoverTime = null;
    });

    // Library interactions, delegated so rows can be re-rendered freely.
    this.$("library").addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const row = target.closest("[data-track]") as HTMLElement | null;
      if (!row) return;
      const id = row.dataset.track!;
      if (target.closest("[data-action=toggle]")) {
        const track = this.store.get(id);
        if (track) this.store.setDisabled(id, !track.disabled);
        return;
      }
      if (target.closest("[data-action=remove]")) {
        this.store.remove(id);
        if (this.selectedId === id) this.selectedId = null;
        this.renderLibrary();
        this.renderDetail();
        return;
      }
      this.selectedId = id;
      this.renderLibrary();
      this.renderDetail();
    });
  }

  private bindGlobal(): void {
    window.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      document.body.classList.add("dragging");
    });
    window.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
    window.addEventListener("drop", (ev) => {
      ev.preventDefault();
      document.body.classList.remove("dragging");
    });

    window.addEventListener("keydown", (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        void this.togglePlay();
      } else if (ev.code === "ArrowRight") {
        ev.preventDefault();
        void this.transport.skipNext();
      } else if (ev.code === "ArrowLeft") {
        ev.preventDefault();
        void this.transport.skipPrevious();
      }
    });
  }

  private addFiles(files: File[]): void {
    const audio = files.filter(
      (f) => f.type.startsWith("audio/") || /\.(wav|mp3|flac|m4a|aac|ogg|opus|aiff?)$/i.test(f.name),
    );
    if (!audio.length) {
      this.toast("No audio files in that drop.", true);
      return;
    }
    this.store.add(audio);
    this.renderLibrary();
  }

  // ---- topbar ----------------------------------------------------------

  private renderTopbar(): void {
    const ready = this.store.ready();
    const bpms = ready.map((t) => t.grid.bpm);
    const avgBpm = bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : 0;
    const stats: [string, string][] = [
      ["tracks", `${ready.length}`],
      ["avg bpm", bpms.length ? fmt.num(avgBpm, 1) : "–"],
      ["mix length", this.plan ? fmt.time(this.plan.totalDuration) : "–"],
      ["target", `${MIX_REFERENCE_LUFS} LUFS`],
      ["cached", fmt.bytes(this.store.cacheBytes())],
    ];
    this.$("topstats").innerHTML = stats
      .map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join("");
    this.$("libcount").textContent = `${this.store.list().length} files`;
    this.$<HTMLButtonElement>("export").disabled = !this.plan;
  }

  // ---- library ---------------------------------------------------------

  private renderLibrary(): void {
    const tracks = this.store.list();
    const playingIds = new Set(this.transport.state().activeSteps.map((s) => s.step.trackId));
    const container = this.$("library");
    if (!tracks.length) {
      container.innerHTML = "";
      this.renderTopbar();
      return;
    }

    container.innerHTML = tracks
      .map((track) => {
        const a = track.analysis;
        const classes = [
          "track",
          this.selectedId === track.id ? "selected" : "",
          track.disabled ? "disabled" : "",
          playingIds.has(track.id) ? "playing" : "",
        ].filter(Boolean).join(" ");

        let body: string;
        if (track.state === "ready" && a) {
          const order = this.plan?.steps.findIndex((s) => s.trackId === track.id) ?? -1;
          body = `
            <div class="track-meta">
              <span>${fmt.num(a.grid.bpm, 1)}</span>
              <span class="camelot">${a.key.camelot}</span>
              <span>${a.key.name}</span>
              <span>${fmt.time(a.duration)}</span>
              <span>${fmt.num(a.loudness.integratedLufs, 1)} LUFS</span>
            </div>
            <div class="track-meta">
              <span class="pill ${fmt.energyClass(a.energyScore)}">E ${Math.round(a.energyScore * 100)}</span>
              <span>vox ${fmt.pct(a.vocalDensity)}</span>
              <span>mix ${fmt.pct(a.mixability)}</span>
              ${order >= 0 ? `<span>#${order + 1} in set</span>` : ""}
            </div>`;
        } else if (track.state === "error") {
          body = `<div class="track-err">${escapeHtml(track.error ?? "failed")}</div>`;
        } else {
          body = `
            <div class="track-stage">${escapeHtml(track.stage)}</div>
            <div class="track-bar"><i style="width:${(track.progress * 100).toFixed(0)}%"></i></div>`;
        }

        return `
          <div class="${classes}" data-track="${track.id}">
            <div class="track-top">
              <span class="track-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</span>
              <button class="ghost" data-action="toggle" title="${track.disabled ? "Include" : "Exclude"} in mix">${track.disabled ? "off" : "on"}</button>
              <button class="ghost" data-action="remove" title="Remove">&times;</button>
            </div>
            ${body}
          </div>`;
      })
      .join("");
    this.renderTopbar();
  }

  // ---- plan options ----------------------------------------------------

  private renderOptions(): void {
    const o = this.options;
    const sliders: [keyof PlanOptions, string, number, number, number, (v: number) => string][] = [
      ["adventurousness", "Adventurousness", 0, 1, 0.05, (v) => fmt.pct(v)],
      ["preferredBeats", "Blend length", 8, 128, 8, (v) => `${v} beats (${v / 4} bars)`],
      ["maxStretch", "Max stretch", 0.01, 0.12, 0.005, (v) => `${(v * 100).toFixed(1)}%`],
      ["peakPosition", "Peak at", 0.2, 0.95, 0.05, (v) => fmt.pct(v)],
      ["peakEnergy", "Peak energy", 0.5, 1, 0.05, (v) => fmt.pct(v)],
    ];

    this.$("options").innerHTML = `
      ${sliders
        .map(([key, label, min, max, step, format]) => {
          const value = o[key] as number;
          return `
            <div class="option">
              <label>${label}<span id="opt-${key}-v">${format(value)}</span></label>
              <input type="range" data-opt="${key}" min="${min}" max="${max}" step="${step}" value="${value}" />
            </div>`;
        })
        .join("")}
      <div class="toggle-row">
        <button id="opt-creative" class="${o.creative ? "on" : ""}" title="Stem swaps, double drops, loop rolls">Creative blends</button>
      </div>
      <div class="notes" id="notes"></div>
    `;

    this.$("options").addEventListener("input", (ev) => {
      const input = ev.target as HTMLInputElement;
      const key = input.dataset.opt as keyof PlanOptions | undefined;
      if (!key) return;
      (this.options[key] as number) = Number(input.value);
      const entry = sliders.find(([k]) => k === key);
      const label = this.root.querySelector(`#opt-${key}-v`);
      if (entry && label) label.textContent = entry[5](Number(input.value));
    });
    this.$("opt-creative").addEventListener("click", () => {
      this.options.creative = !this.options.creative;
      this.$("opt-creative").classList.toggle("on", this.options.creative);
    });
    this.renderNotes();
  }

  private renderNotes(): void {
    const el = this.root.querySelector("#notes");
    if (!el) return;
    if (!this.plan) {
      el.innerHTML = `<p>Adjust, then <b>Rebuild mix</b>.</p>`;
      return;
    }
    el.innerHTML = `<ul style="padding-left:14px;margin:6px 0 0">${this.plan.notes
      .slice(0, 6)
      .map((note) => `<li>${escapeHtml(note)}</li>`)
      .join("")}</ul>`;
  }

  // ---- now playing -----------------------------------------------------

  private renderNowPlaying(): void {
    const el = this.$("nowplaying");
    if (!this.plan || !this.plan.steps.length) {
      el.innerHTML = `
        <h2 class="np-title">Nothing loaded</h2>
        <div class="np-sub">Drop audio files in the library to begin</div>`;
      return;
    }
    const state = this.transport.state();
    const step = state.currentStep ?? this.plan.steps[0];
    const analyses = this.analyses();
    const track = analyses.get(step.trackId);
    const next = this.plan.steps[step.index + 1];
    const nextTrack = next ? analyses.get(next.trackId) : undefined;
    const untilBlend = step.transitionStartAt - state.position;

    el.innerHTML = `
      <h2 class="np-title">${escapeHtml(step.trackName)}</h2>
      <div class="np-sub">
        ${track ? `${fmt.num(track.grid.bpm * step.rateOut, 1)} BPM` : ""}
        ${track ? `&middot; ${track.key.camelot} ${track.key.name}` : ""}
        &middot; rate ${fmt.num(step.rateOut, 3)}&times;
        &middot; trim ${fmt.num(step.gainDb, 1)} dB
        &middot; track ${step.index + 1}/${this.plan.steps.length}
      </div>
      ${
        step.transitionOut && next
          ? `<div class="np-next">
               <b>Next:</b> ${escapeHtml(next.trackName)}
               ${nextTrack ? `(${fmt.num(nextTrack.grid.bpm, 1)} &middot; ${nextTrack.key.camelot})` : ""}
               &mdash; <span class="kind">${fmt.transitionLabel(step.transitionOut.kind)}</span>
               over ${step.transitionOut.beats / 4} bars
               ${untilBlend > 0 ? `in <b>${fmt.time(untilBlend)}</b>` : `<b>&mdash; blending now</b>`}
               <br /><span style="color:var(--text-faint)">${escapeHtml(step.transitionOut.rationale)}</span>
             </div>`
          : `<div class="np-next">Final track of the set.</div>`
      }`;
  }

  // ---- decks -----------------------------------------------------------

  private renderDecks(): void {
    const container = this.$("decks");
    const active = this.transport.state().activeSteps;
    if (!active.length) {
      const hint = this.plan
        ? "Press play to start the mix."
        : "Add tracks, and a mix is built automatically.";
      if (container.dataset.empty !== hint) {
        container.dataset.empty = hint;
        container.innerHTML = `<div class="empty">${hint}</div>`;
      }
      return;
    }
    delete container.dataset.empty;

    const signature = active.map((s) => s.step.index).join(",");
    if (container.dataset.sig === signature) {
      this.updateDeckValues();
      return;
    }
    container.dataset.sig = signature;

    const analyses = this.analyses();
    container.innerHTML = active
      .map(({ step }, i) => {
        const role = i === active.length - 1 && active.length > 1 ? "b" : "a";
        const track = analyses.get(step.trackId);
        const override = this.ensureOverride(step.index);
        return `
          <div class="deck role-${role}" data-step="${step.index}">
            <div class="deck-head">
              <span class="deck-role">${role.toUpperCase()}</span>
              <span class="deck-name">${escapeHtml(step.trackName)}</span>
              <span class="deck-time" data-deck-time>0:00</span>
            </div>
            <div class="deck-body">
              <div class="deck-wave"><canvas data-deck-wave></canvas></div>
              <div class="stem-row">
                ${STEMS.map(
                  (stem) => `
                  <button class="stem-btn danger ${override.stems[stem] === 0 ? "on" : ""}"
                          data-stem="${stem}" title="Mute the ${stem} stem on this deck">
                    ${override.stems[stem] === 0 ? "muted" : "live"}
                    <small>${stem}</small>
                  </button>`,
                ).join("")}
              </div>
              <div class="knob-row">
                <div class="knob">
                  <label>Low cut <span data-hp-v>off</span></label>
                  <input type="range" data-hp min="0" max="1" step="0.01" value="0" />
                </div>
                <div class="knob">
                  <label>High cut <span data-lp-v>off</span></label>
                  <input type="range" data-lp min="0" max="1" step="0.01" value="0" />
                </div>
              </div>
              ${
                track
                  ? `<div class="track-meta">
                       <span class="pill ${fmt.energyClass(track.energyScore)}">E ${Math.round(track.energyScore * 100)}</span>
                       <span>${track.key.camelot}</span>
                       <span>${fmt.num(track.grid.bpm, 1)} BPM</span>
                       <span>${fmt.num(track.loudness.integratedLufs, 1)} LUFS</span>
                       <span>vox ${fmt.pct(track.vocalDensity)}</span>
                     </div>`
                  : ""
              }
            </div>
          </div>`;
      })
      .join("");

    this.bindDeckControls();
  }

  private ensureOverride(stepIndex: number): DeckOverride {
    let override = this.overrides.get(stepIndex);
    if (!override) {
      override = {
        stems: { vocals: 1, drums: 1, bass: 1, other: 1 },
        lowpass: 0,
        highpass: 0,
      };
      this.overrides.set(stepIndex, override);
    }
    return override;
  }

  private bindDeckControls(): void {
    for (const deck of this.root.querySelectorAll<HTMLElement>(".deck")) {
      const stepIndex = Number(deck.dataset.step);
      const override = this.ensureOverride(stepIndex);

      for (const btn of deck.querySelectorAll<HTMLButtonElement>("[data-stem]")) {
        btn.addEventListener("click", () => {
          const stem = btn.dataset.stem as StemName;
          const muted = override.stems[stem] === 0;
          override.stems[stem] = muted ? 1 : 0;
          btn.classList.toggle("on", !muted);
          btn.childNodes[0].textContent = muted ? "live " : "muted ";
          // A manual move takes the parameter off automation, which is what a
          // hand on the mixer should do.
          this.transport.override(stepIndex, `stem.${stem}`, override.stems[stem]);
        });
      }

      const hp = deck.querySelector<HTMLInputElement>("[data-hp]")!;
      const hpLabel = deck.querySelector<HTMLElement>("[data-hp-v]")!;
      hp.addEventListener("input", () => {
        override.highpass = Number(hp.value);
        const freq = override.highpass <= 0.001 ? HP_OPEN : 20 * 1000 ** override.highpass;
        hpLabel.textContent = override.highpass <= 0.001 ? "off" : fmt.hz(freq);
        this.transport.override(stepIndex, "highpass", freq);
      });

      const lp = deck.querySelector<HTMLInputElement>("[data-lp]")!;
      const lpLabel = deck.querySelector<HTMLElement>("[data-lp-v]")!;
      lp.addEventListener("input", () => {
        override.lowpass = Number(lp.value);
        const freq = override.lowpass <= 0.001 ? LP_OPEN : 20000 / 1000 ** override.lowpass;
        lpLabel.textContent = override.lowpass <= 0.001 ? "off" : fmt.hz(freq);
        this.transport.override(stepIndex, "lowpass", freq);
      });
    }
  }

  /** Per-frame deck updates: time readout and waveform playhead. */
  private updateDeckValues(): void {
    const analyses = this.analyses();
    const position = this.transport.position();
    for (const deckEl of this.root.querySelectorAll<HTMLElement>(".deck")) {
      const stepIndex = Number(deckEl.dataset.step);
      const step = this.plan?.steps[stepIndex];
      if (!step) continue;
      const track = analyses.get(step.trackId);
      const trackTime = trackTimeAtMixTime(step, position);

      const timeEl = deckEl.querySelector<HTMLElement>("[data-deck-time]");
      if (timeEl) {
        timeEl.textContent = `${fmt.time(trackTime)} / ${fmt.time(track?.duration ?? 0)}`;
      }
      const canvas = deckEl.querySelector<HTMLCanvasElement>("[data-deck-wave]");
      if (canvas && track) {
        const s = surface(canvas);
        if (s) drawTrackWave(s, track, trackTime, step.exitTime);
      }
    }
  }

  // ---- detail panel ----------------------------------------------------

  private renderDetail(): void {
    const el = this.$("detail");
    const track = this.selectedId ? this.store.get(this.selectedId) : null;
    const a = track?.analysis;
    if (!track || !a) {
      el.innerHTML = `<div class="empty">Select a track to see every measurement taken from it.</div>`;
      this.$("detail-head").textContent = "Measurements";
      return;
    }
    this.$("detail-head").textContent = "Measurements";

    const rows = (entries: [string, string][]): string =>
      entries
        .map(([k, v]) => `<div class="metric"><span class="k">${k}</span><span class="v">${v}</span></div>`)
        .join("");

    const maxBand = Math.max(...a.spectral.bandsDb);
    const minBand = Math.min(...a.spectral.bandsDb);
    const bandSpan = Math.max(1, maxBand - minBand);

    el.innerHTML = `
      <div class="detail">
        <h3>${escapeHtml(a.name)}</h3>
        <div class="sub">${fmt.time(a.duration)} &middot; ${a.sampleRate} Hz &middot; ${a.channels}ch &middot; analysed in ${(a.analysisMs / 1000).toFixed(1)}s</div>

        <div class="metric-group">
          <h4>Rhythm &amp; grid</h4>
          ${rows([
            ["Tempo", `${fmt.num(a.grid.bpm, 2)} BPM`],
            ["Tempo confidence", fmt.pct(a.grid.tempoConfidence)],
            ["Beat confidence", fmt.pct(a.grid.beatConfidence)],
            ["Beats / bars", `${a.grid.beats.length} / ${a.grid.downbeats.length}`],
            ["Phrase length", `${a.grid.phraseBars} bars`],
            ["First beat", `${fmt.num(a.grid.firstBeat, 3)} s`],
            ["Pulse clarity", fmt.pct(a.rhythm.pulseClarity)],
            ["Onset density", `${fmt.num(a.rhythm.onsetDensity, 2)} / beat`],
            ["Percussive ratio", fmt.pct(a.rhythm.percussiveRatio)],
            ["Syncopation", fmt.pct(a.rhythm.syncopation)],
            ["Swing", fmt.pct(a.rhythm.swing)],
            ["Danceability", fmt.pct(a.rhythm.danceability)],
          ])}
        </div>

        <div class="metric-group">
          <h4>Harmony</h4>
          ${rows([
            ["Key", `${a.key.name} (${a.key.camelot})`],
            ["Key confidence", fmt.pct(a.key.confidence)],
            ["Tonal stability", fmt.pct(a.key.tonalStability)],
            ...a.key.alternates.slice(0, 2).map(
              (alt, i) =>
                [
                  `Alternate ${i + 1}`,
                  `${alt.name} (${alt.camelot}) — ${fmt.pct(alt.relative)} as strong`,
                ] as [string, string],
            ),
          ])}
        </div>

        <div class="metric-group">
          <h4>Loudness</h4>
          ${rows([
            ["Integrated", `${fmt.num(a.loudness.integratedLufs, 1)} LUFS`],
            ["Short-term max", `${fmt.num(a.loudness.shortTermMaxLufs, 1)} LUFS`],
            ["Loudness range", `${fmt.num(a.loudness.loudnessRangeLu, 1)} LU`],
            ["True peak", `${fmt.num(a.loudness.truePeakDb, 1)} dBTP`],
            ["Crest factor", `${fmt.num(a.loudness.crestFactorDb, 1)} dB`],
            ["RMS", `${fmt.num(a.loudness.rmsDb, 1)} dBFS`],
            ["Mix trim", `${fmt.num(a.loudness.normalisationGainDb, 1)} dB`],
          ])}
        </div>

        <div class="metric-group">
          <h4>Spectrum</h4>
          ${rows([
            ["Centroid", fmt.hz(a.spectral.centroidHz)],
            ["Rolloff (85%)", fmt.hz(a.spectral.rolloff85Hz)],
            ["Bandwidth", fmt.hz(a.spectral.bandwidthHz)],
            ["Flatness", fmt.num(a.spectral.flatness, 4)],
            ["Brightness", fmt.pct(a.spectral.brightness)],
            ["Spectral flux", fmt.num(a.spectral.fluxMean, 3)],
          ])}
          <div class="bars">
            ${a.spectral.bandsDb
              .map((db) => {
                const h = ((db - minBand) / bandSpan) * 100;
                return `<i class="b" style="height:${Math.max(2, h).toFixed(0)}%" title="${fmt.num(db, 1)} dB"></i>`;
              })
              .join("")}
          </div>
          <div class="bars-labels">${BAND_NAMES.map((b) => `<span>${b}</span>`).join("")}</div>
        </div>

        <div class="metric-group">
          <h4>Stereo field</h4>
          ${rows([
            ["Width", fmt.pct(a.stereo.width)],
            ["Correlation", fmt.num(a.stereo.correlation, 3)],
            ["Side / mid", `${fmt.num(a.stereo.sideToMidDb, 1)} dB`],
            ["Bass mono", fmt.pct(a.stereo.bassMonoRatio)],
          ])}
        </div>

        <div class="metric-group">
          <h4>Mix character</h4>
          ${rows([
            ["Energy score", fmt.pct(a.energyScore)],
            ["Vocal density", fmt.pct(a.vocalDensity)],
            ["Mixability", fmt.pct(a.mixability)],
          ])}
        </div>

        <div class="metric-group">
          <h4>Structure (${a.sections.length} sections)</h4>
          <div class="sections">${sectionStrip(a.sections, a.duration)}</div>
          <div class="legend">
            ${[...new Set(a.sections.map((s) => s.label))]
              .map(
                (label) =>
                  `<span><i style="background:${fmt.SECTION_COLOURS[label]}"></i>${label}</span>`,
              )
              .join("")}
          </div>
        </div>

        <div class="metric-group">
          <h4>Cue points (${a.cues.length})</h4>
          <div class="cue-list">
            ${a.cues
              .map(
                (c) => `<div class="cue">
                  <span class="t">${fmt.time(c.time)}</span>
                  <span class="kind">${c.kind}</span>
                  <span class="lbl">${escapeHtml(c.label)}</span>
                </div>`,
              )
              .join("")}
          </div>
        </div>
      </div>`;
  }

  // ---- transport actions ----------------------------------------------

  private async togglePlay(): Promise<void> {
    if (!this.plan) {
      this.toast("No mix yet — add at least two tracks.", true);
      return;
    }
    // The decode context was left suspended until a gesture arrived.
    if (this.analysisCtx.state === "suspended") void this.analysisCtx.resume();
    await this.transport.toggle();
    if (!this.transport.stemsAvailable) {
      this.toast("Stem separation unavailable in this browser; blends will use EQ and filters only.");
    }
    this.renderDecks();
  }

  private async toggleRecording(): Promise<void> {
    const button = this.$<HTMLButtonElement>("record");
    if (this.transport.state().recording) {
      const blob = await this.transport.stopRecording();
      button.classList.remove("on");
      button.textContent = "Record";
      if (blob) {
        const ext = blob.type.includes("ogg") ? "ogg" : "webm";
        download(blob, `continuum-mix.${ext}`);
        this.toast(`Recording saved (${fmt.bytes(blob.size)}).`);
      }
      return;
    }
    if (!this.transport.isReady) await this.transport.play();
    if (!this.transport.startRecording()) {
      this.toast("Recording is not supported in this browser.", true);
      return;
    }
    button.classList.add("on");
    button.textContent = "Stop rec";
    this.toast("Recording the live output, including anything you change by hand.");
  }

  private async exportWav(): Promise<void> {
    if (!this.plan || this.busy) return;
    this.busy = "export";
    const button = this.$<HTMLButtonElement>("export");
    button.disabled = true;
    try {
      const result = await renderMixToWav(this.plan, this.store, 44100, (fraction, stage) => {
        button.textContent = `${stage} ${Math.round(fraction * 100)}%`;
      });
      download(result.blob, "continuum-mix.wav");
      this.toast(`Rendered ${fmt.time(result.duration)} (${fmt.bytes(result.blob.size)}).`);
    } catch (err) {
      this.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      button.textContent = "Export WAV";
      button.disabled = false;
      this.busy = null;
    }
  }

  // ---- animation loop --------------------------------------------------

  private loop(): void {
    const tick = (): void => {
      this.frame++;
      const state = this.transport.state();

      // Scopes, every frame.
      const master = this.transport.master;
      if (master) {
        if (this.spectrumData.length !== master.spectrum.frequencyBinCount) {
          this.spectrumData = new Uint8Array(new ArrayBuffer(master.spectrum.frequencyBinCount));
        }
        if (this.waveData.length !== master.analyser.fftSize) {
          this.waveData = new Float32Array(new ArrayBuffer(master.analyser.fftSize * 4));
        }
        master.analyser.getFloatTimeDomainData(this.waveData);
        master.spectrum.getByteFrequencyData(this.spectrumData);
      }
      const waveSurface = surface(this.$<HTMLCanvasElement>("scope-wave"));
      if (waveSurface) drawWaveform(waveSurface, this.waveData);
      const specSurface = surface(this.$<HTMLCanvasElement>("scope-spectrum"));
      if (specSurface && master) {
        drawSpectrum(specSurface, this.spectrumData, master.ctx.sampleRate, master.spectrum.fftSize);
      }

      // Timeline and readout.
      if (this.plan) {
        const timelineSurface = surface(this.$<HTMLCanvasElement>("timeline-canvas"));
        if (timelineSurface) {
          drawTimeline(timelineSurface, this.plan, this.analyses(), state.position, this.hoverTime);
        }
        this.$("readout").textContent =
          `${fmt.time(state.position)} / ${fmt.time(this.plan.totalDuration)}`;
      }

      this.$("play").textContent = state.playing ? "Pause" : "Play";
      this.renderDecks();

      // Cheaper updates a few times a second rather than every frame.
      if (this.frame % 15 === 0) {
        this.renderNowPlaying();
        this.renderTopbar();
      }
      if (this.frame % 60 === 0) this.renderLibrary();

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---- misc ------------------------------------------------------------

  private toast(message: string, error = false): void {
    const el = document.createElement("div");
    el.className = `toast${error ? " err" : ""}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), error ? 6000 : 3800);
  }
}

/** Where a step's track is, in its own time, at a given mix time. */
function trackTimeAtMixTime(step: MixStep, mixTime: number): number {
  const t = mixTime - step.startAt;
  if (t <= 0) return step.trackOffset;
  const inboundSeconds = step.transitionIn ? (step.transitionIn.beats * 60) / step.transitionIn.mixBpm : 0;
  if (t <= inboundSeconds) return step.trackOffset + t * step.rateIn;
  let time = step.trackOffset + inboundSeconds * step.rateIn;
  const afterInbound = t - inboundSeconds;
  if (afterInbound <= step.rampSeconds) {
    // Linear rate glide integrates to the mean rate over the elapsed portion.
    const frac = step.rampSeconds > 0 ? afterInbound / step.rampSeconds : 1;
    const rate = step.rateIn + (step.rateOut - step.rateIn) * frac * 0.5;
    return time + afterInbound * rate;
  }
  time += step.rampSeconds * ((step.rateIn + step.rateOut) / 2);
  return time + (afterInbound - step.rampSeconds) * step.rateOut;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
