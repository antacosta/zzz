# Continuum

Drop audio files in, get one continuous DJ mix out. Everything runs in the
browser: nothing is uploaded, and the mix plays live while you can still reach
in and change it.

The premise is that a mix is only as good as what you know about the tracks. So
Continuum measures far more per track than a DJ app normally does, and the
planner spends that information on choosing what follows what, where to leave
each track, and which kind of blend the pair can actually support — including
stem-level moves like riding one track's vocal over the next one's instrumental.

```
npm install
npm run dev      # http://localhost:5173
npm test         # 119 checks over the analysis, planner and worklet
npm run build    # static bundle in dist/
```

Drop in two or more files and a mix is planned as soon as they finish analysing.
Press play. Analysis runs at roughly 30x realtime per core, across a worker pool.

---

## What gets measured

Everything below is computed per track, shown in the right-hand panel, and used
by the planner.

**Rhythm and grid.** Tempo to a few hundredths of a BPM, a constant-tempo beat
grid phase-locked to the kick, bar downbeats, phrase length (4/8/16/32 bars),
pulse clarity, onset density, percussive ratio, syncopation, swing, and a
composite danceability.

**Harmony.** Key and mode from chroma correlated against Temperley profiles,
mapped to the Camelot wheel, with runner-up keys, a confidence figure and a
tonal-stability measure for tracks that modulate.

**Loudness.** Full ITU-R BS.1770-4: K-weighted integrated LUFS with two-pass
gating, short-term timeline, loudness range, 4x-oversampled true peak, crest
factor, and the trim needed to reach the mix reference level.

**Spectrum.** Seven-band energy timelines, centroid, 85% rolloff, bandwidth,
flatness, per-band spectral contrast, brightness and mean flux.

**Stereo field.** Width, inter-channel correlation, side-to-mid ratio, and how
mono the low end is — which is what decides whether a bass swap will work.

**Sources.** Median-filter harmonic/percussive separation gives a percussive
timeline, and a four-cue model (centre-channel dominance, vocal-band share,
harmonic peakiness, pitch continuity) gives a lead-vocal likelihood timeline.
That is what tells the planner where a track has a voice it could borrow.

**Structure.** Bar-synchronous self-similarity novelty segmentation, snapped to
the 8-bar unit, labelled intro / build / drop / groove / breakdown / bridge /
outro. From those, cue points: mix-in, mix-out, drops, vocal entries and exits,
breakdowns, and stable eight-bar stretches that are safe to loop.

## How the mix is built

**Ordering.** Tracks are ordered greedily on a pairwise score — Camelot
distance, how far either deck must be stretched, fit to the set's energy arc,
and variety so the mix does not sit in one key or one timbre — with one-step
lookahead so the planner cannot strand itself in an unmixable corner. The arc
itself is configurable: where the peak sits, how high, how it tapers.

**Tempo.** Only the 1, 2 and 1/2 metrical levels are offered, and each deck's
playback rate is derived from the reinterpreted tempo rather than multiplied by
the ratio, so a 174 and an 87 BPM track lock together with neither deck sped up.
Decks enter at the previous blend's tempo and glide to their own afterwards, the
way you would nudge a pitch fader once a blend is done.

**Transitions.** For each chosen pair, every exit point on the outgoing track,
entry point on the incoming one, and blend style is scored, and the best wins.
Style fitness gates on what the measurements support:

| Style | Needs |
| --- | --- |
| Bass swap | keys within a few wheel steps, a real low end on both sides |
| Vocal over instrumental | a vocal to isolate, an instrumental to put it over, close keys |
| Vocal intro over groove | the mirror image: incoming voice over the outgoing band |
| Filter sweep | nothing in particular — this is what survives a key clash |
| Harmonic blend | genuinely the same key, matched energy, no vocal clash |
| Drop swap | an entry that lands on the incoming drop |
| Echo out | short and decisive; indifferent to harmony |
| Loop roll | a stable eight-bar groove to hold |
| Double drop | one key, matched high energy, no vocals fighting |
| Hard cut | the pair is genuinely unmixable |

Each returns automation for deck gain, the four stem gains, high-pass,
low-pass, three-band EQ and echo send. One invariant is enforced across every
pair: two basslines are never at full level at the same time.

## Real-time stem separation

Blends that move individual stems need separation on the audio thread, so it is
done in an AudioWorklet in the STFT domain. Masks come from median-filter
harmonic/percussive separation plus a centre-channel term for the lead vocal,
and are built as a partition of unity — at unity gains the node reconstructs its
input to 1e-14 relative error, so it stays in the signal path permanently at no
cost to fidelity. Delay is fixed at 4096 samples and reported to the scheduler,
which compensates when aligning decks.

While the mix plays you can mute any stem on either deck, sweep either deck's
filters, seek, skip to the next blend, and rebuild the plan with different
settings. A manual move takes that parameter off automation, which is what a
hand on the mixer should do.

## Getting the mix out

**Record** captures the live output as you hear it, including anything you
changed by hand, at bounded memory cost, so it works for a set of any length.

**Export WAV** re-renders offline. A long set will not fit in memory with every
track decoded at once, so the render is driven in chunks through
`OfflineAudioContext.suspend()`, decoding what is coming up and releasing what
is finished at each suspension. Memory stays proportional to the window rather
than to the length of the set.

## Layout

```
src/analysis/    dsp, tempo, key, loudness, spectral, stems, structure, worker
src/engine/      query, transitions, planner, graph, mixer, transport, render, store
src/ui/          app, scope, format, styles
public/worklets/ stem-processor.js
test/            synth fixtures and the check harness
scripts/         test runner, test-audio generator, browser check
```

`npm test` runs the analysis, planner and worklet suites. The analysis tests
work against synthetic material with known ground truth — tempo accuracy across
95–174 BPM, beat-grid phase error, key, loudness, vocal onset, kick masked by a
sustained bassline, sample-rate independence, mono and degenerate input.
`scripts/browser-check.mjs` drives the real app in Chromium end to end, from
dropping files to confirming audio at the master bus:

```
npm run test:audio      # writes synthetic test tracks to test-audio/
npm run dev             # in another shell
npm run test:browser    # 39 checks against the running app
```

Set `CHROME_PATH` to use a Chromium you already have, and `APP_URL` if the dev
server is not on the default port.

## Notes and limits

- Separation is mask-based, not a trained source-separation model. It is clean
  enough to swap and mute stems in a blend; it is not a stem export.
- The beat grid is a fitted constant tempo, which is right for produced
  electronic music. Live or hand-played material will report low grid fit and
  low tempo confidence rather than silently bending the grid.
- Key detection on sparse or heavily processed material is the least reliable
  measurement here, which is why its confidence is shown and why the planner
  falls back to filter and echo transitions when it is low.
