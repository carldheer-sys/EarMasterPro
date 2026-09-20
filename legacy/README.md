# Legacy code archive

This directory preserves the pre-rebuild EarMasterPro source for reference.
It is **not compiled** — it sits outside the Vite app root (`apps/web`) and
its `@/` alias imports will not resolve here.

## Contents

- `pages/MidiEditor.jsx` — the MIDI editor page, to be re-integrated into the
  Ear Training page in a future iteration.
- `pages/EarTrainer.jsx` — the former desktop ear-training page (sessions,
  exports, instrument selection).
- `pages/MobileEarTrainer.jsx` — the former mobile ear-training page; the new
  unified page's playback/recovery logic was ported from here.
- `pages/LandingPage.jsx` — the former navigation landing page.
- `components/` — `PianoRollCanvas.jsx` (the canvas roll the new
  `apps/web/src/components/PianoRoll.jsx` is based on), `PianoRoll.jsx`,
  `ReferenceTrack.jsx`, `BackendControl.jsx`, `Toast.jsx`, `ui/` primitives.
- `hooks/` — analysis/interaction hooks. `useHarmonyAnalysis.js` depended on
  the retired Python backend; chord annotations are now baked into session
  JSON (`chordAnnotations`) instead.
- `lib/backend.js`, `App.jsx`, `main.jsx`, `index.css`, `index.html`,
  `vite.config.js` — the old router app shell.
