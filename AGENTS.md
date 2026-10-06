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
- Mastering chain is `midiGain → compressor → limiter → destination` plus a
  parallel reverb send. **No distortion/waveshaper** — summed voices clipped it.
- Per-layer drone nodes go in `droneGains`/`droneLfos`/`droneSynths` —
  `stopDrone()` disposes all of them. Adding a node without tracking it = leak.
- `loadInstrument` dedupes concurrent loads via `instrumentLoads`; sample
  ArrayBuffers are cached module-level (`sampleArrayBufferCache`) and re-decoded
  per context epoch.
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
- **Watchdog rebuilds need 2 consecutive dead ticks** — a single stalled-clock
  window is normal on Bluetooth and must not tear down the graph (a rebuild is
  an audible stop). `interrupted` states are neutral ticks: the statechange
  auto-heal handles them; a rebuilt context is born interrupted too.
- **PianoRoll canvas is viewport-sized** and follows scroll via a transform in
  the RAF loop — never size it to `gridWidth × dpr` (exceeds iOS canvas limits
  and repaints the whole grid per scroll tick).
- `GranularPlayer` reuses its AudioWorkletNode across starts — buffer data is
  posted only when the AudioBuffer object changes. `catalog.js` caches MP3
  bytes + decoded buffers per context.
- **Instrument maps**: `Tonejs-Instruments.js` — an instrument listed in `list`
  without a note map silently falls back to synth (trumpet bug). Keep maps for
  every listed instrument.
- **Transcription docs** carry both notations (`span.d` theory / `span.n` name);
  the sheet flips `body[data-notation]` + `data-theme`. Generator:
  `Music_Catalog/scripts&skills/generate_html.py`.
