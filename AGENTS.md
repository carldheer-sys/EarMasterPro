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
  `ToneBufferSource` retuned with `playbackRate` (±6 st), swelling in over
  ~0.5s (gain `setTargetAtTime`, τ 0.15). Sources are tracked in
  `droneSources`, their gains in `droneGains`; `_droneEpoch` guards
  in-flight renders against zombie attaches. `droneVoicingSpec()` is the
  single voicing definition shared with the bounce's inline render — never
  fork the constants. `offlineRenderProbe()` gates `droneLoopPromise`: a
  failed probe (or a silent/failed bake — logged, evicted for retry) sends
  the live path to `_scheduleDroneSynthFallback` (4-synth pad, logs once).
  Loop buffers live in a module-level cache — they are context-agnostic
  and must NOT be disposed on rebuild.
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
  inline drone-voicing segments + verbatim mastering chain) on an explicit
  `new Tone.OfflineContext(...)` — every node gets `{ context: ctx }`
  (`PolySynth` propagates it to voices; `toDestination()` binds via the
  node's own context) and the ctx is `dispose()`d after render. **Never
  `Tone.Offline(callback)`**: it swaps the global `Tone.context` for the
  callback's whole duration including `await`s — nodes built meanwhile
  (instruments, paused-drone) bind to the dead offline context and render
  into a buffer nobody hears. The drone is built from `droneVoicingSpec`
  inside the render, not from the shared loop cache, so a failed loop bake
  can't strip it from the bounce.
  'full' plays the loudness-normalized song WAV (`songBlobRef`) — under 0.5×,
  a pre-stretched OLA file since iOS can't preserve pitch below
  `playbackRate` 0.5. WebAudio stays only for live keyboard notes and as the
  fallback when a render/element fails — never play both at once. The
  `offlineRenderProbe` gates bounces, and a rendered buffer peaking below
  −60dBFS is evicted + treated as a failure (a silent render would
  otherwise "play" forever). Media-path failures log `[audio] media path:
  <reason> — WebAudio fallback`. `bounceSection` and `prime()` get start
  timeouts so a stalled `startRendering`/`play()` fails over instead of
  hanging Play; `prefetchBounce` is debounced (~600ms, skipped while
  playing) so settings drags don't spawn a render per tick.
- **Loudness is baked into the WAV samples** — `el.volume` is read-only on
  iOS, so `encodeWavPcm16` applies the gain while interleaving (peak-safe,
  hard-clipped). Where `el.volume` IS writable (`mediaVolumeWritable`
  probe), 'full' instead plays the source MP3 bytes + per-file
  `MediaSongPlayer.setVolume` — skipping the multi-MB WAV bake. Song WAVs
  hit `AUDIO_TARGET_RMS_DB` (−16); rendered mixes hit
  `BOUNCE_TARGET_RMS_DB` (−17), clamped by `AUDIO_PEAK_CEIL_DB` — the
  limiter leaves little headroom on loud renders, which is correct.
  Bounce results are cached by a JSON key of every audible input
  (`bounceKeyOf`); revoking a URL the element is playing is forbidden.
- **Encoders/stretchers must yield on song-length buffers** —
  `encodeWavPcm16`/`stretchBufferOla` are synchronous loops and freeze the
  main thread for seconds on multi-minute audio; use
  `encodeWavPcm16Async`/`stretchBufferOlaAsync` (chunked `await`s) for
  song/section-length work. The sync versions are for ≤ a few seconds
  (prime buffers, tests).
- **Media cursor runs on RAF, not the stall-watch interval** —
  `startMediaWatch` keeps stall detection at 100ms but a RAF loop
  interpolates `player.positionSec` between samples (capped +150ms ahead)
  so the playhead doesn't jump at 10fps; both are cancelled on stop/pause.
- **A media pause keeps the drone alive like a WebAudio pause** — the baked
  drone freezes with the element, so `pausePlayback` voices a live drone at
  the paused key (`startPausedDrone`, ramped in over ~0.5s). The next media
  `start` releases it only AFTER `player.start()` resolves (`handoffDrone`)
  so its 0.25s tail overlaps the baked voice — never stop it in `cleanup()`
  before the element is playing, that re-opens the resume gap.
  `mediaSession.playbackState` is `'paused'` while paused so the
  Now Playing/BT route stays claimed.
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
