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
- **`Music_Catalog` is a sibling directory, not part of the repo.** Committed
  `public/catalog/` is the build source on CI; build-catalog.mjs falls back to
  it when the source dir is absent.
- Section audio is `audio.mp3` (192k). `session.eartrainer.json.files.vocals`
  must point at the same file.
- Session windows can differ from Hooktheory `keyFrames` (pickup extension,
  trims) — effective window lives in `song-info.json` (`visibleWindow`,
  `windowStart`/`windowEnd`). Exporter: `Music_Catalog/scripts&skills/hooktheory_to_earmaster.py`.

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
- **Instrument maps**: `Tonejs-Instruments.js` — an instrument listed in `list`
  without a note map silently falls back to synth (trumpet bug). Keep maps for
  every listed instrument.
- **Transcription docs** carry both notations (`span.d` theory / `span.n` name);
  the sheet flips `body[data-notation]` + `data-theme`. Generator:
  `Music_Catalog/scripts&skills/generate_html.py`.
