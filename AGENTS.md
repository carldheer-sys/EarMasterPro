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
- **The drone is a baked stereo loop** (`droneBaker.js`): ~10s AudioBuffer
  rendered via OfflineAudioContext per octave band, played as a looping
  `ToneBufferSource` retuned with `playbackRate` (±6 st). Sources are
  tracked in `droneSources`, their gains in `droneGains`; `_droneEpoch`
  guards in-flight renders against zombie attaches. The old 4-synth path
  survives as `_scheduleDroneSynthFallback` when OfflineAudioContext is
  unavailable. Loop buffers live in a module-level cache — they are
  context-agnostic and must NOT be disposed on rebuild.
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
  an audible stop). `interrupted` states are neutral ticks (bounded at 15):
  the statechange auto-heal handles them; a rebuilt context is born
  interrupted too.
- **Section playback goes through `<audio>`, not the WebAudio output path** —
  iOS + Bluetooth underruns the AudioContext render thread (~1s dropouts)
  while the OS media pipeline buffers deep. `MediaSongPlayer`
  (`mediaPlayback.js`) plays rendered WAV blobs on two A/B elements for
  gapless region loops; `sectionBounce.js` renders the whole mix (notes +
  baked-drone segments + verbatim mastering chain) via `Tone.Offline`.
  'full' plays the loudness-normalized song WAV (`songBlobRef`) — under 0.5×,
  a pre-stretched OLA file since iOS can't preserve pitch below
  `playbackRate` 0.5. WebAudio stays only for live keyboard notes and as the
  fallback when a render/element fails — never play both at once.
- **Loudness is baked into the WAV samples** — `el.volume` is read-only on
  iOS, so `encodeWavPcm16` applies the gain while interleaving (peak-safe,
  hard-clipped). Song WAVs hit `AUDIO_TARGET_RMS_DB` (−16); rendered mixes
  hit `BOUNCE_TARGET_RMS_DB` (−17), clamped by `AUDIO_PEAK_CEIL_DB` — the
  limiter leaves little headroom on loud renders, which is correct.
  Bounce results are cached by a JSON key of every audible input
  (`bounceKeyOf`); revoking a URL the element is playing is forbidden.
- **A media pause keeps the drone alive like a WebAudio pause** — the baked
  drone freezes with the element, so `pausePlayback` voices a live drone at
  the paused key (`startPausedDrone`); the next media `start` stops it
  (cleanup → `stopDrone`) because the voice is inside the bounce.
- **Instrument volumes live in `INSTRUMENT_CONFIGS`/`SYNTH_TYPES` only** —
  the live engine and `buildInstrument` in sectionBounce read the same
  tables; never tune one path without the other. Drone level is
  `volumeDb + 3dB` in both `_startDroneLoop` and the bounce — a sine bed
  reads far quieter than pitched voices at equal RMS.
- **`MediaSongPlayer` seeks only after the element is ready** — setting
  `currentTime` before readyState≥2 (or before `_ensureReady`'s `el.load()`)
  can be silently dropped → playback restarts from 0 on pause/resume.
  `pause()` pauses BOTH A/B elements — a pre-started standby would otherwise
  keep sounding.
- **`MediaSongPlayer.prime()` must run inside the user gesture** — a bounce
  render can outlive user-activation; playing a 1-frame silent WAV once
  unlocks both elements for the session.
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
