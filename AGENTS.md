# EarMasterPro

Single-page PWA ear-training app. One page (`apps/web/src/pages/EarTrainer.jsx`), pre-transcribed catalog bundled under `public/catalog/`.

## Commands

- `npm run dev` — regenerate catalog + vite dev (LAN-reachable via `--host`)
- `npm run build` — regenerate catalog + production build to `dist/web` (Netlify runs this)
- `npm test` / `npx vitest run` — vitest suites in `tests/`
- `node tests/<name>.mjs` — standalone script-style tests (tempoEngine, midiImportExport)
- `node scripts/build-catalog.mjs` — rebuild `public/catalog/` from `../Music_Catalog`

## Invariants

- **`public/sw.js`**: `CACHE_NAME` must keep the `__SW_VERSION__` placeholder —
  `vite.config.js` stamps it with a content hash per build. Never hardcode a
  version; a stale cache name strands clients on old builds (blank pages).
- **`catalog.json` + `session.eartrainer.json` are network-first** in sw.js —
  they carry data that changes on re-export. Catalog binaries stay cache-first.
- **A missing `/catalog/*` path answers HTTP 200 with `index.html`** (SPA
  fallback) — `catalog.js` therefore rejects `text/html` on JSON endpoints
  (`StaleCatalogError`), `EarTrainer` reloads the manifest once and retries
  by section id, and `TranscriptionSheet` verifies fetched docs carry
  `data-notation` (else it would srcDoc the app shell into the sheet).
- **`Music_Catalog` is a sibling directory, not part of the repo.** Its tree is
  `<Artist>/<Title>/<section>/` (artist/song names from `song-info.json`);
  collaborations use a single combined artist, `Artist (ft. X)` (e.g.
  `Lady Gaga (ft. Bruno Mars)/Die With A Smile`). build-catalog bundles each
  song as flat `Artist - Title` so catalog paths stay stable — legacy flat
  dirs still work. Committed `public/catalog/` is the build source on CI;
  build-catalog.mjs falls back to it when the source dir is absent.
- Section audio is `audio.mp3` (192k). `session.eartrainer.json.files.vocals`
  must point at the same file.
- Session windows can differ from Hooktheory `keyFrames` (pickup extension,
  trims) — effective window lives in `song-info.json` (`visibleWindow`,
  `windowStart`/`windowEnd`). Exporter: `Music_Catalog/scripts&skills/hooktheory_to_earmaster.py`.
- **`keyMode` supports all church modes** (`Major`, `Minor`, `Dorian`,
  `Phrygian`, `Lydian`, `Mixolydian`, `Locrian`). There is exactly ONE
  `normalizeKeyMode` — `packages/common/src/lib/midiUtils.js`, exported.
  Never reimplement it locally: a stale copy in EarTrainer collapsed
  `Dorian`→`Major` and wrongly red-flagged diatonic notes.

## Audio engine (`packages/common/src/lib/audioEngine.js`)

- **Never `await` a bare `resume()`/`Tone.start()`** — on iOS they can hang
  forever on an `interrupted` context. Always wrap in `resumeWithTimeout`.
- **`swapToneContext()`** replaces `Tone.context` AND closes the old raw
  context (iOS leaks live contexts otherwise).
- **`isContextBlocked()`** treats `suspended`/`interrupted`/`closed` as dead —
  `play()` must recover inside the user gesture before scheduling.
- **Mastering chain is `midiGain → compressor → limiter → destination`** —
  no distortion/waveshaper (summed voices clipped it) and no `Tone.Reverb`
  convolver (`Tone.Reverb` ran an `OfflineContext` render inside
  `initialize()`, stalling gesture activation, and taxed the mobile audio
  render thread over Bluetooth). Matches Sonofield (`reverbSend = 0`) and
  SingMasterPro.
- **Sonofield SF2 sounds (`public/samples/`)**: extracted from
  `Sonofield_REA/free.sf2` via `scripts/extract-sonofield-samples.py`:
  1. **Drone (`public/samples/sonofield-drone/<C..B>.mp3`)**: 12 chromatic
     stereo loops (C3–B3, ~14s pre-crossfaded loop with a 0.25s guard band so
     looping `[0.1s .. 14.1s]` stays strictly inside the file and never
     crosses MP3 encoder padding). Cached at module scope in
     `droneArrayBufferCache` + `droneAudioBufferCache` (`tonicToDroneStem`).
     `loadSection` warms all `keyEvents` tonics via `prefetchDrone(tonic)`;
     `scheduleDroneNotes` starts synchronously in 0ms when cached, swelling
     in over ~0.45s (`setTargetAtTime`, τ=0.15) and releasing over τ=0.08s
     on stop/key change. Falls back to `droneBaker.js` → 4-synth pad if
     unloaded.
  2. **Synth (`public/samples/sonofield-synth/<G2..E6>.mp3`)**: 16 stereo
     minor-third multisample zones (MIDI 43–88, sustain loop unrolled to 4s,
     per-zone SF2 centibel attenuation baked in) routed through a 20%
     `Tone.Chorus` send (`chorusSend=200`). `_initializeInner` builds a
     synchronous `PolySynth` fallback in `synths['synth']` so `getPlayer` is
     non-null in 0ms while `samplers['synth']` decodes (~40ms locally).
- **Context-agnostic `AudioBuffer` caching (`sampleAudioBufferCache`)**:
  `loadInstrument` caches both raw `ArrayBuffer`s (`sampleArrayBufferCache`)
  and decoded `AudioBuffer`s (`sampleAudioBufferCache`) at module scope,
  decoding in parallel batches (`DECODE_CONCURRENCY = 8`) with 6s fetch
  timeouts. Context rebuilds (`swapToneContext`) reuse already-decoded
  `AudioBuffer`s in <1ms without re-fetching or re-decoding. Dense sample
  maps (`piano`, `guitar-acoustic`, `cello`) are thinned to minor-third
  zones (28/13/13 files) and cached cache-first in `public/sw.js`.
- `window.audioEngine` is exposed for CDP debugging.
- **`Tone.context.rawContext` is a `standardized-audio-context` WRAPPER, not a
  `BaseAudioContext`** — `new AudioWorkletNode(wrapper)` throws. Unwrap via
  `._nativeContext` for native-API construction (see `GranularPlayer`);
  wrapped nodes connect via `wrappedNode._nativeAudioNode`.
- **Note scheduling is audio-clock look-ahead** (`scheduleNotesAudioClock` in
  EarTrainer): one 100ms interval enqueues notes ≥0.4s ahead at absolute
  AudioContext times — never schedule notes with per-note `setTimeout`
  (timer jitter = audible stutter on mobile). The horizon is widened to
  `ctx.outputLatency + 0.6s` (≤1.5s) on high-latency routes like Bluetooth,
  whose clock advances in bursts long enough to starve a 0.4s window.
- **Latency hint is always `'playback'`** (`PLAYBACK_LATENCY_HINT`) — never
  retry with `'interactive'`: its small output buffer underruns on Bluetooth.
- **Watchdog rebuilds need 2 consecutive dead ticks and never rebuild an
  advancing clock** — on Bluetooth A2DP the output clock advances in bursts
  and analyser samples can lag behind scheduled audio; never tear down a
  context whose `rawContext.currentTime` and `Transport.ticks` are advancing.
  `getOutputLevel()` uses `getByteTimeDomainData` (with `outputAnalyser`
  pulled via `silentKeepalive`) because `getFloatTimeDomainData` returns
  zeros on iOS Safari.
- **`play()` unlocks the `AudioContext` first inside the user gesture** —
  `ensureFreshAudioContext` + `audioEngine.ensureActive` run before any
  instrument warmup, and `ensureInstrument` in `play()` is bounded by
  `INSTRUMENT_WAIT_MS` (350ms) so a slow uncached CDN fetch never blocks
  playback start or burns transient user activation.
- **PianoRoll canvas is viewport-sized and redraws imperatively on scroll** —
  `scrollLeftRef` + `drawCanvasRef` redraw the visible slice without React
  `setScrollLeft` state updates (which previously caused 60 React re-renders
  per second during playback auto-scroll). Grid bar/division lines are
  clipped to `[viewportStartBeat - 1, viewportEndBeat + 1]`, and note labels
  use crisp `strokeText` outlines instead of software `shadowBlur`.
- `GranularPlayer` reuses its AudioWorkletNode across starts — buffer data is
  posted only when the AudioBuffer object changes. `catalog.js` caches MP3
  bytes + decoded buffers per context.
- **Instrument maps**: `Tonejs-Instruments.js` — an instrument listed in `list`
  without a note map silently falls back to synth (trumpet bug). Keep maps for
  every listed instrument.
- **Transcription docs** carry both notations (`span.d` theory / `span.n` name);
  the sheet flips `body[data-notation]` + `data-theme`. Generator:
  `Music_Catalog/scripts&skills/generate_html.py`.
