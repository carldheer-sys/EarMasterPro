import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Tone from 'tone'
import { BookOpen, Eye, EyeOff, FileText, Hash, Headphones, Keyboard, Loader2, Lock, Moon, Pause, Play, Repeat, Settings, Square, Sun, Type, Minus, Plus } from 'lucide-react'
import audioEngine, { INSTRUMENT_CONFIGS, isContextBlocked, resumeWithTimeout, swapToneContext } from '@common/lib/audioEngine'
import { GranularPlayer } from '@common/lib/granularPlayer'
import {
  beatsPerBarFromTimeSignature,
  buildMeterTimeline,
  DEFAULT_TIME_SIGNATURE,
  detectTimeDivision,
  getInternalBpm,
  normalizeKeyMode,
  normalizeTimeSignature,
  timeSignatureToString,
} from '@common/lib/midiUtils'
import { loadCatalog, loadSectionSession, loadSectionAudio } from '@/lib/catalog'
import PianoRoll from '@/components/PianoRoll'
import CatalogSheet from '@/components/CatalogSheet'
import SettingsSheet from '@/components/SettingsSheet'
import TranscriptionSheet from '@/components/TranscriptionSheet'
import KeyboardPanel from '@/components/KeyboardPanel'

// ─── Constants ───────────────────────────────────────────────────────────────

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1]
const SYNTH_CONFIG = { volume: -10 }
const AUDIO_DB = -2
const MAX_PLAYBACK_RECOVERY_ATTEMPTS = 3
const STALE_AUDIO_REBUILD_MS = 2 * 60 * 1000

// User-adjustable sound settings (persisted). Volumes are dB added to the
// per-note velocity scaling; instrument names resolve via audioEngine.
const SETTINGS_KEY = 'emp-settings'
const DEFAULT_USER_SETTINGS = {
  melodyInstrument: 'synth',
  chordsInstrument: 'pad',
  melodyVolume: 0,
  chordsVolume: -8,
  droneVolume: -10,
}

// Playback sources per training mode. `requires` maps to section capabilities.
const SOURCE_OPTIONS = {
  melody: [
    { id: 'melody-drone', label: 'Melody + Drone', requires: ['melody'] },
    { id: 'melody-chords', label: 'Melody + Chords', requires: ['melody', 'chords'] },
    { id: 'full', label: 'Full Song', requires: ['audio'] },
  ],
  harmony: [
    { id: 'chords-drone', label: 'Chords + Drone', requires: ['chords'] },
    { id: 'chords', label: 'Chords', requires: ['chords'] },
    { id: 'full', label: 'Full Song', requires: ['audio'] },
  ],
}

function speedLabel(v) {
  return `x${Number(v).toFixed(2).replace(/\.?0+$/, '')}`
}

const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }

function noteNameToMidi(name) {
  const m = /^([A-Ga-g])(#{0,2}|b{0,2})(-?\d+)$/.exec(name || '')
  if (!m) return 60
  let pc = NOTE_PC[m[1].toUpperCase()] ?? 0
  for (const ch of m[2]) pc += ch === '#' ? 1 : -1
  return (parseInt(m[3], 10) + 1) * 12 + pc
}

/**
 * Derive the section timeline from session data: key/meter events, bar
 * layout, and true content length (meter-aware, so e.g. a trailing 2/4 bar
 * shortens the section correctly).
 */
function buildTimeline(sessionData) {
  const sd = sessionData?.settings || {}
  const ts = normalizeTimeSignature(sd.timeSignature)
  const bars = sd.bars || 4
  const notes = sessionData?.notes || []
  const chordsNotes = sessionData?.chordsNotes || []
  const annotations = sessionData?.chordAnnotations || []
  const keyEvents = sessionData?.keyEvents?.length
    ? sessionData.keyEvents
    : [{ beat: 0, key: sd.key || 'C', keyMode: normalizeKeyMode(sd.keyMode || 'major') }]
  const contentEnd = Math.max(
    0,
    ...notes.map(n => n.start + n.duration),
    ...chordsNotes.map(n => n.start + n.duration),
    ...annotations.map(a => a.start + a.duration),
  )
  const meterEvents = sessionData?.meterEvents?.length ? sessionData.meterEvents : null
  const { barStarts, totalBeats } = meterEvents
    ? buildMeterTimeline(meterEvents, contentEnd)
    : {
        barStarts: null,
        totalBeats: Math.max(1, bars * beatsPerBarFromTimeSignature(ts)),
      }
  return { keyEvents, meterEvents, barStarts, totalBeats, contentEnd }
}

// ─── Note scheduling (audio-clock look-ahead; jitter-proof on mobile) ────────

function clearTimerList(timerRef) {
  timerRef.current.forEach(t => window.clearTimeout(t))
  timerRef.current = []
}

const AUDIO_LOOKAHEAD_S = 0.4   // how far ahead of the audio clock we enqueue
const AUDIO_TICK_MS = 100       // scheduler wake-up interval

/**
 * Look-ahead scheduler: ONE interval enqueues notes for the next ~0.4 s at
 * absolute AudioContext times. Timer jitter can't shift note timing — the
 * trigger times are stamped on the audio clock, so this is stutter-immune
 * even when the main thread stalls (the old per-note setTimeout approach let
 * every canvas repaint/buffer copy become audible jitter on mobile).
 *
 * pendingRef collects enqueued attacks {player, note, t, tEnd}; on pause/stop
 * we schedule triggerRelease at each pending attack time (silent cancel) and
 * releaseAll() the players for sounding notes.
 */
function scheduleNotesAudioClock(notes, { regionBeats, tempo, resumeRegionBeat, looping, timerRef, pendingRef }) {
  if (!notes.length || regionBeats <= 0) return
  const ctx = Tone.getContext().rawContext
  if (!ctx) return
  const spb = 60 / tempo                       // seconds per region beat
  const t0 = ctx.currentTime + 0.05            // audio time of region-beat `origin`
  const origin = resumeRegionBeat
  const R = regionBeats
  let scheduledUntil = origin                  // region-beat cursor (enqueued up to here)

  const fire = (n, p) => {
    const t = t0 + (p - origin) * spb
    const durSec = Math.max(0.05, Math.min(n.duration, R - n.start) * spb)
    const player = audioEngine.getPlayer(n.instrument)
    if (!player) return
    const velocity = Math.min(Math.max((n.velocity ?? 0.8) * Math.pow(10, (n.volume ?? 0) / 20), 0), 1)
    try {
      player.triggerAttack(n.note, t, velocity)
      player.triggerRelease(n.note, t + durSec)
      pendingRef.current.push({ player, note: n.note, t, tEnd: t + durSec })
    } catch (_) {}
  }

  const enqueue = () => {
    const horizonP = origin + (ctx.currentTime + AUDIO_LOOKAHEAD_S - t0) / spb
    if (horizonP <= scheduledUntil) return
    for (const n of notes) {
      if (!looping) {
        if (n.start >= scheduledUntil && n.start < horizonP && n.start < R) fire(n, n.start)
      } else {
        let k = Math.max(0, Math.ceil((scheduledUntil - n.start) / R))
        let p = k * R + n.start
        while (p < horizonP) { fire(n, p); k++; p += R }
      }
    }
    scheduledUntil = horizonP
    // Prune the pending list so it can't grow forever during long loops
    if (pendingRef.current.length > 400) {
      const now = ctx.currentTime
      pendingRef.current = pendingRef.current.filter(e => e.tEnd > now - 1)
    }
  }

  enqueue()
  timerRef.current.push(window.setInterval(enqueue, AUDIO_TICK_MS))
}

/** Silently cancel enqueued-but-unfired notes + release sounding ones. */
function cancelPendingAudioNotes(pendingRef) {
  const now = Tone.getContext().rawContext?.currentTime ?? 0
  for (const e of pendingRef.current) {
    // +20ms so the release lands just after the attack — cancels the note
    // without an audible blip and without racing a same-timestamp attack.
    try { e.player.triggerRelease(e.note, Math.max(now, e.t) + 0.02) } catch (_) {}
  }
  pendingRef.current = []
}

/**
 * Drone across a region with optional key changes. keyEvents are in section
 * beats; the region window maps them into region space. Single-key sections
 * sustain one drone across loops; multi-key sections re-voice at each key
 * boundary (and per loop iteration).
 */
function scheduleDroneSegments({ keyEvents, startBeat, regionBeats, resumeRegionBeat, tempo, droneDb, looping, timerRef }) {
  const msPerBeat = 60000 / tempo
  const events = keyEvents?.length ? keyEvents : [{ beat: 0, key: 'C' }]
  const segs = []
  for (let i = 0; i < events.length; i++) {
    const s = Math.max(0, (i === 0 ? 0 : events[i].beat) - startBeat)
    const e = Math.min(regionBeats, (events[i + 1]?.beat ?? Infinity) - startBeat)
    if (e > s) segs.push({ start: s, end: e, key: events[i].key })
  }
  if (!segs.length) segs.push({ start: 0, end: regionBeats, key: events[0].key })

  if (!looping || segs.length === 1) {
    for (const seg of segs) {
      if (seg.end <= resumeRegionBeat) continue
      const delay = Math.max(0, (seg.start - resumeRegionBeat) * msPerBeat)
      timerRef.current.push(window.setTimeout(() => {
        audioEngine.scheduleDroneNotes(seg.key, seg.end - seg.start, droneDb)
      }, delay))
    }
    return
  }

  // Multi-key looping: re-arm segment drones each region iteration
  const t0 = performance.now()
  let iter = 0
  const origin = resumeRegionBeat
  const armIteration = () => {
    const base = iter * regionBeats
    for (const seg of segs) {
      if (iter === 0 && seg.end <= origin) continue
      const absStart = base + Math.max(seg.start, iter === 0 ? origin : seg.start)
      const delay = Math.max(0, t0 + (absStart - origin) * msPerBeat - performance.now())
      timerRef.current.push(window.setTimeout(() => {
        audioEngine.scheduleDroneNotes(seg.key, regionBeats - seg.start, droneDb)
      }, delay))
    }
    const nextBoundary = (iter + 1) * regionBeats
    const msToNext = t0 + (nextBoundary - origin) * msPerBeat - performance.now() - 250
    timerRef.current.push(window.setTimeout(() => { iter += 1; armIteration() }, Math.max(0, msToNext)))
  }
  armIteration()
}

function releaseActiveNotes(activeNotesRef) {
  activeNotesRef.current.forEach(({ note, player }) => {
    try { player?.triggerRelease?.(note, Tone.now()) } catch (_) {}
  })
  activeNotesRef.current.clear()
}

// ─── Component ───────────────────────────────────────────────────────────────

function EarTrainer() {
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem('emp-theme') !== 'light' } catch (_) { return true }
  })

  // Catalog / session state
  const [catalog, setCatalog] = useState(null)
  const [selected, setSelected] = useState(null) // {artist, title, entry}
  const [session, setSession] = useState(null)
  const [audioReady, setAudioReady] = useState(false)

  // Training state
  const [mode, setMode] = useState('melody')
  const [source, setSource] = useState('melody-drone')
  const [speed, setSpeed] = useState(1)
  const [isLooping, setIsLooping] = useState(false)
  const [regionStart, setRegionStart] = useState(0)
  const [regionEnd, setRegionEnd] = useState(1)
  const [showAnswers, setShowAnswers] = useState(true)
  // 'theory' = scale degrees / Roman numerals; 'names' = note / chord names
  const [notation, setNotation] = useState('theory')

  // Playback state
  const [playbackState, setPlaybackState] = useState('stopped')
  const playbackStateRef = useRef('stopped')
  const [isInitialized, setIsInitialized] = useState(false)
  const [loading, setLoading] = useState(true)
  const [audioPreparing, setAudioPreparing] = useState(false)
  const [error, setError] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [showResumeOverlay, setShowResumeOverlay] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [transcriptionOpen, setTranscriptionOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [kbDroneOn, setKbDroneOn] = useState(false)
  const [loadingInstruments, setLoadingInstruments] = useState(() => new Set())
  // Bumped whenever the AudioContext is rebuilt — effects that hold
  // context-bound resources (the decoded section audio) re-run on change.
  const [contextEpoch, setContextEpoch] = useState(0)

  // Sound settings (persisted across sessions)
  const [userSettings, setUserSettings] = useState(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) return { ...DEFAULT_USER_SETTINGS, ...JSON.parse(raw) }
    } catch (_) {}
    return DEFAULT_USER_SETTINGS
  })
  const userSettingsRef = useRef(userSettings)
  useEffect(() => {
    userSettingsRef.current = userSettings
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(userSettings)) } catch (_) {}
  }, [userSettings])
  const patchSettings = useCallback((patch) => {
    setUserSettings(s => ({ ...s, ...patch }))
  }, [])

  // Lazily load an instrument — samplers fetch + decode on first use
  const ensureInstrument = useCallback(async (name) => {
    if (!name || audioEngine.synths[name] || audioEngine.samplers[name]) return
    setLoadingInstruments(prev => { const s = new Set(prev); s.add(name); return s })
    try {
      await audioEngine.loadInstrument(name, INSTRUMENT_CONFIGS[name] || {})
    } catch (err) {
      console.warn(`[EarTrainer] Instrument ${name} failed to load:`, err)
    } finally {
      setLoadingInstruments(prev => { const s = new Set(prev); s.delete(name); return s })
    }
  }, [])

  // Preload newly selected instruments in the background (playback falls back
  // to synth while a sampler is still loading)
  useEffect(() => {
    if (!isInitialized) return
    ensureInstrument(userSettings.melodyInstrument)
    ensureInstrument(userSettings.chordsInstrument)
  }, [userSettings.melodyInstrument, userSettings.chordsInstrument, isInitialized, ensureInstrument])

  // Refs
  const cursorRef = useRef(0)
  const audioPlayerRef = useRef(null)
  const noteTimersRef = useRef([])
  const notePendingRef = useRef([])   // enqueued-but-unfired audio-clock notes
  const stopTimerRef = useRef(null)
  const activeNotesRef = useRef(new Map())
  const playbackTokenRef = useRef(0)
  const pausedBeatRef = useRef(0)
  const seekBeatRef = useRef(0)
  const playbackStartTimeRef = useRef(0)
  const currentRegionRef = useRef({ startBeat: 0, regionBeats: 0, effectiveTempo: 120 })
  const dronePlayingRef = useRef(false)
  const lastAudioReinitializedAtRef = useRef(Date.now())
  const playbackWatchdogTimerRef = useRef(null)
  const playbackRecoveryAttemptRef = useRef(0)
  const playRef = useRef(null)
  const lastRawContextRef = useRef(null)
  const loadTokenRef = useRef(0)
  const audioAbortRef = useRef(null)
  const sectionRef = useRef(null) // {notes, chordsNotes, settings, capabilities}

  const capabilities = useMemo(() => {
    if (!selected?.entry) return { melody: false, chords: false, audio: false }
    return selected.entry.capabilities
  }, [selected])

  const settings = useMemo(() => {
    const sd = session?.settings || {}
    return {
      key: sd.key || 'C',
      keyMode: normalizeKeyMode(sd.keyMode || 'major'),
      tempo: sd.tempo || 120,
      bars: sd.bars || 4,
      timeSignature: normalizeTimeSignature(sd.timeSignature),
    }
  }, [session])

  // ── Theme ────────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    try { localStorage.setItem('emp-theme', isDark ? 'dark' : 'light') } catch (_) {}
  }, [isDark])
  const toggleTheme = useCallback(() => setIsDark(v => !v), [])

  // ── Audio context management (ported from proven mobile path) ────────────

  const resetAudioStateAfterContextChange = useCallback(() => {
    audioEngine.dispose()
    setIsInitialized(false)
    lastRawContextRef.current = null
  }, [])

  const ensureFreshAudioContext = useCallback(async ({ force = false, latencyHint = 'playback', start = true } = {}) => {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback' } catch (_) {}
    const rawBefore = Tone.getContext().rawContext
    const isClosed = Tone.getContext().state === 'closed' || rawBefore?.state === 'closed'
    // A closed context can never be reopened — always swap, not just on force.
    if (isClosed) {
      resetAudioStateAfterContextChange()
      swapToneContext(latencyHint)
    }
    const rawContext = Tone.getContext().rawContext
    if (start) {
      // resume() can hang forever on iOS interrupted contexts — never await bare
      await resumeWithTimeout(Tone.start())
      if (Tone.getContext().state !== 'running') await resumeWithTimeout(Tone.getContext().resume())
      if (rawContext?.state !== 'running') await resumeWithTimeout(rawContext.resume())
      if (Tone.getContext().state === 'closed' || rawContext?.state === 'closed') {
        throw new Error('Audio context could not be reopened.')
      }
    } else if (Tone.getContext().state === 'closed' || rawContext?.state === 'closed') {
      swapToneContext(latencyHint)
    }
    const contextChanged = Boolean(lastRawContextRef.current && lastRawContextRef.current !== rawContext)
    if (contextChanged) {
      resetAudioStateAfterContextChange()
      setContextEpoch(e => e + 1) // decoded audio + statechange listener rebind
    }
    lastRawContextRef.current = rawContext
    return { rawContext, contextChanged: contextChanged || (force && isClosed) }
  }, [resetAudioStateAfterContextChange])

  // ── Stop / pause ─────────────────────────────────────────────────────────

  const stopPlayback = useCallback(({ keepPreparing = false, keepRecovery = false, keepSeek = false } = {}) => {
    playbackTokenRef.current += 1
    clearTimerList(noteTimersRef)
    if (stopTimerRef.current) { window.clearTimeout(stopTimerRef.current); stopTimerRef.current = null }
    if (playbackWatchdogTimerRef.current) { window.clearTimeout(playbackWatchdogTimerRef.current); playbackWatchdogTimerRef.current = null }
    if (!keepRecovery) playbackRecoveryAttemptRef.current = 0
    cancelPendingAudioNotes(notePendingRef)
    audioEngine.stop()
    setKbDroneOn(false)
    releaseActiveNotes(activeNotesRef)
    Object.values(audioEngine.synths).forEach(s => { try { s.releaseAll?.() } catch (_) {} })
    Object.values(audioEngine.samplers).forEach(s => { try { s.releaseAll?.() } catch (_) {} })
    audioPlayerRef.current?.stop()
    dronePlayingRef.current = false
    if (!keepPreparing) setAudioPreparing(false)
    if (keepSeek && seekBeatRef.current > 0) {
      pausedBeatRef.current = seekBeatRef.current
      const sec = sectionRef.current
      const totalBeats = sec ? sec.totalBeats : 1
      cursorRef.current = totalBeats > 0 ? seekBeatRef.current / totalBeats : 0
    } else {
      seekBeatRef.current = 0
      pausedBeatRef.current = 0
      cursorRef.current = 0
    }
    // 'ambient' drops Now-Playing eligibility — dismisses the iOS lock-screen
    // banner the moment playback isn't running (only 'playback' sessions are
    // eligible). Restored to 'playback' in play()/ensureFreshAudioContext.
    try { if (navigator.audioSession) navigator.audioSession.type = 'ambient' } catch (_) {}
    try { if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none' } catch (_) {}
    playbackStateRef.current = 'stopped'
    setPlaybackState('stopped')
  }, [])

  const pausePlayback = useCallback(() => {
    if (playbackState !== 'playing') return
    const { startBeat, effectiveTempo } = currentRegionRef.current
    const elapsedBeats = Math.max(0, (Tone.now() - playbackStartTimeRef.current) * effectiveTempo / 60)
    pausedBeatRef.current = startBeat + elapsedBeats
    clearTimerList(noteTimersRef)
    if (stopTimerRef.current) { window.clearTimeout(stopTimerRef.current); stopTimerRef.current = null }
    if (playbackWatchdogTimerRef.current) { window.clearTimeout(playbackWatchdogTimerRef.current); playbackWatchdogTimerRef.current = null }
    cancelPendingAudioNotes(notePendingRef)
    audioEngine.pause({ releaseActiveNotes: false })
    audioEngine.stopDrone()
    setKbDroneOn(false)
    dronePlayingRef.current = false
    releaseActiveNotes(activeNotesRef)
    audioPlayerRef.current?.stop()
    try { if (navigator.audioSession) navigator.audioSession.type = 'ambient' } catch (_) {}
    try { if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none' } catch (_) {}
    playbackStateRef.current = 'paused'
    setPlaybackState('paused')
  }, [playbackState])

  // ── Playback recovery (watchdog, ported) ─────────────────────────────────

  const recoverAudioGraphForRetry = useCallback(async (attempt = 1) => {
    audioEngine.dispose()
    setIsInitialized(false)
    try { Tone.getTransport().cancel() } catch (_) {}
    try { Tone.getTransport().stop() } catch (_) {}
    lastRawContextRef.current = null
    const latencyHint = attempt >= 2 ? 'interactive' : 'playback'
    // From the second attempt on, replace the context outright — the old one
    // may be stuck in a state resume() can't escape (iOS 'interrupted').
    if (attempt >= 2) swapToneContext(latencyHint)
    const { rawContext } = await ensureFreshAudioContext({ force: true, latencyHint })
    await new Promise(r => window.setTimeout(r, 80))
    if (Tone.getContext().state !== 'running') await resumeWithTimeout(Tone.getContext().resume())
    if (rawContext?.state !== 'running') await resumeWithTimeout(rawContext.resume())
    await audioEngine.initialize({ loadDefaultPiano: false })
    await audioEngine.loadInstrument('synth', SYNTH_CONFIG)
    lastAudioReinitializedAtRef.current = Date.now()
    setIsInitialized(true)
    setContextEpoch(e => e + 1)
  }, [ensureFreshAudioContext])

  const verifyPlaybackStarted = useCallback((playbackToken, before, isSoundDue = () => false) => {
    if (playbackWatchdogTimerRef.current) window.clearTimeout(playbackWatchdogTimerRef.current)
    const tick = async () => {
      if (playbackToken !== playbackTokenRef.current || document.visibilityState !== 'visible'
          || playbackStateRef.current !== 'playing') return
      const rawContext = Tone.getContext().rawContext
      const rawAdvanced = rawContext ? rawContext.currentTime > before.rawTime + 0.15 : false
      const ticksAdvanced = Tone.getTransport().ticks > before.transportTicks + 2
      const cursorAdvanced = cursorRef.current > before.cursorPosition + 0.001
      // iOS can leave a context reporting 'running' with dead output after a
      // session interruption — a near-zero output level while the clock is
      // demonstrably running AND a note should be sounding means the render
      // graph is silently broken. A frozen clock or a musical rest must not
      // trigger recovery — so the silence veto only runs on the first tick,
      // right after start, when a note is known to be due. One read can still
      // land in a gap, so re-sample once.
      let audiblyAlive = true
      if (before.checkSilence) {
        audiblyAlive = !(rawAdvanced && isSoundDue()) || audioEngine.getOutputLevel() > 1e-4
        if (!audiblyAlive) {
          await new Promise(r => window.setTimeout(r, 250))
          if (playbackToken !== playbackTokenRef.current) return
          audiblyAlive = !isSoundDue() || audioEngine.getOutputLevel() > 1e-4
        }
      }
      if (Tone.getContext().state === 'running' && rawAdvanced && (ticksAdvanced || cursorAdvanced) && audiblyAlive) {
        playbackRecoveryAttemptRef.current = 0
        // Keep monitoring clock health while playing — iOS can kill the
        // render thread mid-play; a frozen clock is unambiguous (silence is
        // not, so it's skipped on periodic ticks).
        before = {
          rawTime: rawContext.currentTime,
          transportTicks: Tone.getTransport().ticks,
          cursorPosition: cursorRef.current,
          checkSilence: false,
        }
        playbackWatchdogTimerRef.current = window.setTimeout(tick, 2000)
        return
      }
      // First: try a plain resume before rebuilding
      if (playbackRecoveryAttemptRef.current === 0) {
        playbackRecoveryAttemptRef.current = 1
        try {
          if (Tone.getContext().state !== 'running') await resumeWithTimeout(Tone.getContext().resume())
          if (rawContext?.state !== 'running') await resumeWithTimeout(rawContext.resume())
          await new Promise(r => window.setTimeout(r, 200))
          if (playbackToken !== playbackTokenRef.current || playbackStateRef.current !== 'playing') return
          const nowCtx = Tone.getContext().rawContext
          const nowAdvanced = nowCtx && rawContext ? nowCtx.currentTime > rawContext.currentTime + 0.1 : false
          const nowAudible = !(before.checkSilence && nowAdvanced && isSoundDue()) || audioEngine.getOutputLevel() > 1e-4
          if (Tone.getContext().state === 'running' && nowAdvanced && nowAudible && Tone.getTransport().ticks > before.transportTicks + 2) {
            playbackRecoveryAttemptRef.current = 0
            before = {
              rawTime: nowCtx.currentTime,
              transportTicks: Tone.getTransport().ticks,
              cursorPosition: cursorRef.current,
              checkSilence: false,
            }
            playbackWatchdogTimerRef.current = window.setTimeout(tick, 2000)
            return
          }
        } catch (_) {}
      }
      const nextAttempt = playbackRecoveryAttemptRef.current + 1
      if (nextAttempt > MAX_PLAYBACK_RECOVERY_ATTEMPTS) {
        stopPlayback()
        setError('Playback did not start after several automatic retries. Tap Play again.')
        return
      }
      playbackRecoveryAttemptRef.current = nextAttempt
      setAudioPreparing(true)
      try {
        await recoverAudioGraphForRetry(nextAttempt)
        stopPlayback({ keepPreparing: true, keepRecovery: true })
        setAudioPreparing(false)
        window.setTimeout(() => playRef.current?.(), nextAttempt * 180)
      } catch (err) {
        stopPlayback()
        setError(`Playback recovery failed: ${err.message}`)
      }
    }
    playbackWatchdogTimerRef.current = window.setTimeout(tick, 900)
  }, [recoverAudioGraphForRetry, stopPlayback])

  // ── Play ─────────────────────────────────────────────────────────────────

  const play = useCallback(async () => {
    const sec = sectionRef.current
    if (!sec || loading || audioPreparing) return
    try {
      setAudioPreparing(true)
      setError('')
      // Unlock audio (requires user gesture on mobile)
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback' } catch (_) {}
      await ensureFreshAudioContext({ latencyHint: playbackRecoveryAttemptRef.current >= 2 ? 'interactive' : 'playback' })

      const resumeFromPause = playbackState === 'paused' || (playbackState === 'stopped' && seekBeatRef.current > 0)
      if (!resumeFromPause) {
        stopPlayback({ keepPreparing: true, keepRecovery: playbackRecoveryAttemptRef.current })
      } else {
        clearTimerList(noteTimersRef)
        releaseActiveNotes(activeNotesRef)
        audioPlayerRef.current?.stop()
      }

      // Stale-context pre-check
      if (!resumeFromPause && playbackRecoveryAttemptRef.current === 0 && Date.now() - lastAudioReinitializedAtRef.current > STALE_AUDIO_REBUILD_MS) {
        if (Tone.getContext().state === 'closed' || Tone.getContext().rawContext?.state === 'closed') {
          await recoverAudioGraphForRetry(0)
        } else {
          if (Tone.getContext().state !== 'running') await resumeWithTimeout(Tone.getContext().resume())
          if (Tone.getContext().rawContext?.state !== 'running') await resumeWithTimeout(Tone.getContext().rawContext.resume())
          lastAudioReinitializedAtRef.current = Date.now()
        }
      }

      // Engine-level health check INSIDE the gesture, BEFORE we bind anything:
      // rebuilds on stale (>20min)/closed/blocked contexts — including iOS
      // 'interrupted', which resume() can never escape (its promise hangs
      // forever). Doing it here means the context we bind below is final;
      // letting it happen inside audioEngine.start() would swap the context
      // AFTER the GranularPlayer + scheduled notes bound to the old one.
      const active = await audioEngine.ensureActive({ loadDefaultPiano: false })
      if (active.contextChanged || lastRawContextRef.current !== active.rawContext) {
        lastRawContextRef.current = active.rawContext
        setContextEpoch(e => e + 1)
      }
      setIsInitialized(true)

      // Last-resort guard: still blocked after ensureActive's rebuild. A
      // gesture-resume already failed, so retrying resume on this context is
      // pointless — always swap (attempt>=2) for a fresh in-gesture context.
      if (isContextBlocked(Tone.getContext().state) || isContextBlocked(Tone.getContext().rawContext?.state)) {
        await recoverAudioGraphForRetry(Math.max(2, playbackRecoveryAttemptRef.current + 1))
        if (isContextBlocked(Tone.getContext().state) || isContextBlocked(Tone.getContext().rawContext?.state)) {
          throw new Error('Audio is still blocked — tap Play again.')
        }
      }
      const playbackToken = playbackTokenRef.current
      // Read the context AFTER any recovery — a rebuild may have swapped it.
      const audioContext = Tone.getContext().rawContext
      if (!audioEngine.isInitialized) {
        await audioEngine.initialize({ loadDefaultPiano: false })
        await audioEngine.loadInstrument('synth', SYNTH_CONFIG)
        setIsInitialized(true)
      }

      // Rebind the audio player when the context was swapped. initialize()
      // handles the context change itself — it stops playback, drops the
      // stale worklet/gain and clears _loadedBuffer so the buffer is re-sent.
      // (Nulling fields by hand here used to bypass that cleanup, leaving a
      // worklet bound to the dead context playing into a disconnected gain.)
      if (audioPlayerRef.current && audioPlayerRef.current.audioContext !== audioContext) {
        try { await audioPlayerRef.current.initialize(audioContext) } catch (_) {}
      }
      // Tap the reference-audio output into the silence watchdog's analyser.
      // SAC-wrapped connect() accepts the call without wiring the underlying
      // native nodes (the analyser then reads silence while audio plays) —
      // connect the native nodes directly.
      try {
        const g = audioPlayerRef.current?.gainNode
        const an = audioEngine.outputAnalyser
        const tapSrc = g?._nativeAudioNode ?? g
        const tapDst = an?._nativeAudioNode ?? an
        if (tapSrc && tapDst) tapSrc.connect?.(tapDst)
      } catch (_) {}
      if (playbackToken !== playbackTokenRef.current) return

      const { settings: s, notes, chordsNotes, keyEvents } = sec
      const src = sourceRef.current
      const us = userSettingsRef.current
      const totalBeats = sec.totalBeats
      const startBeat = regionRef.current.start * totalBeats
      const endBeat = regionRef.current.end * totalBeats
      const resumeBeat = resumeFromPause ? Math.min(Math.max(pausedBeatRef.current, startBeat), endBeat) : startBeat
      const regionBeats = endBeat - startBeat
      const remainingBeats = Math.max(0, endBeat - resumeBeat)
      const internalTempo = getInternalBpm(s.tempo, s.timeSignature)
      const effectiveTempo = internalTempo * speedRef.current
      const resumeRegionBeat = resumeBeat - startBeat

      // Ensure the selected instruments exist before scheduling (samplers
      // fetch lazily; notes fall back to synth if a load failed)
      const usesMelody = src === 'melody-drone' || src === 'melody-chords'
      const usesChords = src === 'melody-chords' || src === 'chords' || src === 'chords-drone'
      await Promise.all([
        usesMelody ? ensureInstrument(us.melodyInstrument) : null,
        usesChords ? ensureInstrument(us.chordsInstrument) : null,
      ])

      const sliceRegion = (list, volumeDb, instrument) => (list || [])
        .filter(n => n.start < endBeat && n.start + n.duration > startBeat)
        .map(n => ({
          ...n,
          start: Math.max(0, n.start - startBeat),
          duration: Math.min(n.start + n.duration, endBeat) - Math.max(n.start, startBeat),
          volume: volumeDb,
          instrument,
        }))

      audioEngine.clearScheduledNotes()
      audioEngine.setLoopEnabledBeats(false, regionBeats)
      audioEngine.setTempo(s.tempo * speedRef.current, s.timeSignature)
      Tone.getTransport().timeSignature = beatsPerBarFromTimeSignature(s.timeSignature)
      audioEngine.totalTicks = Math.round(regionBeats * Tone.getTransport().PPQ)
      Tone.getTransport().position = `${Math.round(resumeRegionBeat * Tone.getTransport().PPQ)}i`

      // MIDI notes for the selected source
      let midiNotes = []
      if (usesMelody) midiNotes = midiNotes.concat(sliceRegion(notes, us.melodyVolume, us.melodyInstrument))
      if (usesChords) midiNotes = midiNotes.concat(sliceRegion(chordsNotes, us.chordsVolume, us.chordsInstrument))

      if (!isLoopingRef.current) audioEngine.scheduleStopAtBeats(regionBeats)
      else audioEngine.setLoopEnabledBeats(true, regionBeats)

      if (midiNotes.length) {
        notePendingRef.current = []
        scheduleNotesAudioClock(midiNotes, {
          regionBeats,
          tempo: effectiveTempo,
          resumeRegionBeat,
          looping: isLoopingRef.current,
          timerRef: noteTimersRef,
          pendingRef: notePendingRef,
        })
      }

      const playbackStartedFrom = {
        rawTime: audioContext?.currentTime || 0,
        transportTicks: Tone.getTransport().ticks,
        cursorPosition: cursorRef.current,
        checkSilence: true,
      }
      await audioEngine.start(resumeRegionBeat)
      playbackStartTimeRef.current = Tone.now() - resumeRegionBeat * 60 / effectiveTempo
      currentRegionRef.current = { startBeat, regionBeats, effectiveTempo }

      if (!isLoopingRef.current) {
        stopTimerRef.current = window.setTimeout(() => stopPlayback({ keepSeek: true }), Math.max(0, (remainingBeats / effectiveTempo) * 60000 + 250))
      }

      if ((src === 'melody-drone' || src === 'chords-drone') && (!resumeFromPause || !dronePlayingRef.current)) {
        scheduleDroneSegments({
          keyEvents,
          startBeat,
          regionBeats,
          resumeRegionBeat,
          tempo: effectiveTempo,
          droneDb: us.droneVolume,
          looping: isLoopingRef.current,
          timerRef: noteTimersRef,
        })
        dronePlayingRef.current = true
      }

      if (src === 'full' && audioPlayerRef.current) {
        const bps = internalTempo / 60
        audioPlayerRef.current.volume = AUDIO_DB
        audioPlayerRef.current.start(
          speedRef.current,
          resumeBeat / bps,
          isLoopingRef.current,
          startBeat / bps,
          endBeat / bps,
          isLoopingRef.current ? null : () => stopPlayback({ keepSeek: true })
        )
      }

      playbackStateRef.current = 'playing'
      setPlaybackState('playing')
      // Silence detection: full-song audio and drones sound continuously; for
      // MIDI sources a note must be due at the sampled cursor position —
      // a rest must not be mistaken for dead output. cursorRef is a 0..1
      // section fraction; midiNotes[].start is region-relative beats.
      const expectsContinuous = src === 'full' || src === 'melody-drone' || src === 'chords-drone'
      const isSoundDue = () => {
        if (expectsContinuous) return true
        const posBeats = cursorRef.current * totalBeats - startBeat
        return midiNotes.some(n => posBeats >= n.start - 0.05 && posBeats <= n.start + n.duration + 0.2)
      }
      verifyPlaybackStarted(playbackToken, playbackStartedFrom, isSoundDue)
    } catch (err) {
      console.error('Playback failed:', err)
      stopPlayback()
      setError(`Playback failed: ${err.message}`)
    } finally {
      setAudioPreparing(false)
    }
  }, [loading, audioPreparing, playbackState, ensureFreshAudioContext, recoverAudioGraphForRetry, stopPlayback, verifyPlaybackStarted, ensureInstrument])

  useEffect(() => { playRef.current = play }, [play])

  // Refs mirroring state for use inside stable callbacks
  const regionRef = useRef({ start: 0, end: 1 })
  const speedRef = useRef(1)
  const isLoopingRef = useRef(false)
  useEffect(() => { regionRef.current = { start: regionStart, end: regionEnd } }, [regionStart, regionEnd])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { isLoopingRef.current = isLooping }, [isLooping])

  // ── Cursor wiring ────────────────────────────────────────────────────────
  useEffect(() => {
    audioEngine.onCursorUpdate = progress => {
      const rs = regionRef.current.start
      cursorRef.current = rs + progress * (regionRef.current.end - rs)
    }
    audioEngine.onPlaybackComplete = () => stopPlayback({ keepSeek: true })
  }, [stopPlayback])

  // ── Engine init on mount ─────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        await audioEngine.initialize({ loadDefaultPiano: false })
        await audioEngine.loadInstrument('synth', SYNTH_CONFIG)
        if (mounted) setIsInitialized(true)
      } catch (err) {
        if (mounted) console.warn('Audio engine deferred init:', err.message)
      }
    })()
    return () => { mounted = false; stopPlayback() }
  }, [stopPlayback])

  // ── Visibility / pagehide recovery ───────────────────────────────────────
  // iOS suspends the AudioContext AND freezes JS timers when the app goes to
  // the background: pause cleanly on hide (position is remembered, Play
  // resumes it) instead of letting a stale timer burst fire on return.
  useEffect(() => {
    const handleHidden = () => {
      if (playbackState === 'playing') pausePlayback()
      // 'ambient' drops Now-Playing eligibility — the lock-screen banner
      // dismisses as soon as playback isn't running. iOS suspends the context
      // itself once the session deactivates; we deliberately do NOT suspend()
      // it here — a manual suspend races the OS's own interruption handling
      // and can leave the context stuck dead after a quick away-and-back.
      try { if (navigator.audioSession) navigator.audioSession.type = 'ambient' } catch (_) {}
      try { navigator.mediaSession && (navigator.mediaSession.playbackState = 'none') } catch (_) {}
    }
    const handleVisible = async () => {
      // NOTE: do not set audioSession.type='playback' here — 'playback' is only
      // set inside real user gestures (play/keyboard) so the lock-screen banner
      // is never eligible while nothing is playing.
      const toneState = Tone.getContext().state
      const rawState = Tone.getContext().rawContext?.state
      if (toneState === 'closed' || rawState === 'closed') {
        stopPlayback()
        setShowResumeOverlay(true)
        return
      }
      if (isContextBlocked(toneState) || isContextBlocked(rawState)) {
        // resume() without a user gesture may be ignored on iOS — try anyway
        // (helps Android/desktop); if it doesn't take, play() verifies the
        // state and rebuilds inside the next user gesture.
        await resumeWithTimeout(Tone.getContext().resume(), 800)
        if (Tone.getContext().rawContext && isContextBlocked(Tone.getContext().rawContext.state)) {
          await resumeWithTimeout(Tone.getContext().rawContext.resume(), 800)
        }
      }
      lastAudioReinitializedAtRef.current = Date.now()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') handleVisible()
      else handleHidden()
    }
    const handlePageHide = () => {
      if (playbackState === 'playing') stopPlayback()
      try { if (navigator.audioSession) navigator.audioSession.type = 'ambient' } catch (_) {}
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pageshow', handleVisible)
    window.addEventListener('focus', handleVisible)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pageshow', handleVisible)
      window.removeEventListener('focus', handleVisible)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [stopPlayback, pausePlayback, playbackState])

  // Auto-heal when an iOS audio-session interruption ends while the app is
  // visible: the context transitions 'interrupted' → 'suspended', at which
  // point a resume usually succeeds even without a gesture. Re-attached per
  // context (contextEpoch bumps on every swap).
  useEffect(() => {
    const raw = Tone.getContext()?.rawContext
    const native = raw?._nativeContext ?? raw
    if (!native?.addEventListener) return
    let wasInterrupted = native.state === 'interrupted'
    const onStateChange = () => {
      const s = native.state
      if (s === 'interrupted') { wasInterrupted = true; return }
      if (wasInterrupted && s === 'suspended' && document.visibilityState === 'visible') {
        wasInterrupted = false
        resumeWithTimeout(Tone.getContext().resume(), 800)
        if (native.resume) resumeWithTimeout(native.resume(), 800)
        return
      }
      wasInterrupted = s === 'interrupted'
    }
    native.addEventListener('statechange', onStateChange)
    return () => native.removeEventListener('statechange', onStateChange)
  }, [contextEpoch])

  // ── Catalog + section loading ────────────────────────────────────────────

  const loadSection = useCallback(async (artist, title, entry) => {
    const token = ++loadTokenRef.current
    stopPlayback()
    audioAbortRef.current?.abort()
    const controller = new AbortController()
    audioAbortRef.current = controller
    setLoading(true)
    setError('')
    setAudioReady(false)
    try {
      const sessionData = await loadSectionSession(entry, { signal: controller.signal })
      if (token !== loadTokenRef.current) return
      setSession(sessionData)
      setRegionStart(0)
      setRegionEnd(1)
      seekBeatRef.current = 0
      pausedBeatRef.current = 0
      cursorRef.current = 0

      const sd = sessionData.settings || {}
      const tl = buildTimeline(sessionData)
      sectionRef.current = {
        settings: {
          key: sd.key || 'C',
          keyMode: normalizeKeyMode(sd.keyMode || 'major'),
          tempo: sd.tempo || 120,
          bars: sd.bars || 4,
          timeSignature: normalizeTimeSignature(sd.timeSignature),
        },
        notes: sessionData.notes || [],
        chordsNotes: sessionData.chordsNotes || [],
        annotations: sessionData.chordAnnotations || [],
        keyEvents: tl.keyEvents,
        meterEvents: tl.meterEvents,
        barStarts: tl.barStarts,
        totalBeats: tl.totalBeats,
        noteRange: sessionData.noteRange || { lowestNote: 48, highestNote: 72 },
        chordsNoteRange: sessionData.chordsNoteRange || { lowestNote: 36, highestNote: 72 },
      }

      // Pick a valid mode + source for the new section
      const caps = entry.capabilities
      const effMode = (mode === 'melody' && caps.melody) || (mode === 'harmony' && caps.chords)
        ? mode
        : (caps.melody ? 'melody' : 'harmony')
      setMode(effMode)
      setSource(cur => {
        const ok = SOURCE_OPTIONS[effMode].some(o => o.id === cur && o.requires.every(r => caps[r]))
        return ok ? cur : SOURCE_OPTIONS[effMode].find(o => o.requires.every(r => caps[r]))?.id
      })

      setLoading(false)

      // Decode audio in the background (does not block the UI)
      if (caps.audio && entry.assets.audio) {
        const ctx = Tone.getContext().rawContext
        loadSectionAudio(entry, ctx, { signal: controller.signal })
          .then(async buffer => {
            if (token !== loadTokenRef.current) return
            const player = new GranularPlayer()
            player.loadBuffer(buffer)
            try { await player.initialize(ctx) } catch (_) { /* fallback path still works */ }
            if (token !== loadTokenRef.current) { player.dispose(); return }
            audioPlayerRef.current?.dispose()
            audioPlayerRef.current = player
            setAudioReady(true)
          })
          .catch(err => {
            if (err.name !== 'AbortError') console.warn('Audio decode failed:', err)
          })
      }
    } catch (err) {
      if (err.name === 'AbortError' || token !== loadTokenRef.current) return
      console.error(err)
      setError(`Could not load section: ${err.message}`)
      setLoading(false)
    }
  }, [stopPlayback, mode])

  // Initial catalog load + auto-select first section
  useEffect(() => {
    loadCatalog()
      .then(cat => {
        setCatalog(cat)
        const artist = cat.artists?.[0]
        const song = artist?.songs?.[0]
        const first = song?.sections?.[0]
        if (first) {
          setSelected({ artist: artist.name, title: song.title, entry: first })
          loadSection(artist.name, song.title, first)
        } else {
          setError('The catalog is empty.')
          setLoading(false)
        }
      })
      .catch(err => {
        console.error(err)
        setError('Could not load the catalog.')
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectSection = useCallback((artist, title, entry) => {
    if (selected?.entry?.id === entry.id) return
    setSelected({ artist, title, entry })
    loadSection(artist, title, entry)
  }, [selected, loadSection])

  // After a context rebuild the GranularPlayer is bound to the dead context —
  // rebind it in place. initialize() drops the stale worklet/gain and clears
  // _loadedBuffer so the already-decoded buffer (AudioBuffers are
  // context-independent) is re-sent on the next start. No re-decode or player
  // replacement: replacing the ref mid-play would dispose a running player.
  useEffect(() => {
    if (contextEpoch === 0) return
    const ctx = Tone.getContext().rawContext
    const player = audioPlayerRef.current
    if (!ctx || !player || player.audioContext === ctx) return
    player.initialize(ctx).catch(err => console.warn('Audio player re-init failed:', err))
  }, [contextEpoch])

  // Keep the play-time source in sync (stop playback when it changes)
  const sourceRef = useRef(source)
  useEffect(() => {
    if (sourceRef.current !== source) stopPlayback()
    sourceRef.current = source
  }, [source, stopPlayback])

  const selectMode = useCallback((next) => {
    if (next === mode) return
    const caps = capabilities
    if (next === 'melody' && !caps.melody) return
    if (next === 'harmony' && !caps.chords) return
    stopPlayback()
    setMode(next)
    setSource(cur => {
      const ok = SOURCE_OPTIONS[next].some(o => o.id === cur && o.requires.every(r => caps[r]))
      return ok ? cur : SOURCE_OPTIONS[next].find(o => o.requires.every(r => caps[r]))?.id
    })
  }, [mode, capabilities, stopPlayback])

  const handleRegionChange = useCallback((start, end) => {
    stopPlayback()
    setRegionStart(start)
    setRegionEnd(end)
  }, [stopPlayback])

  // ── Seek + note audition ─────────────────────────────────────────────────

  const playFromBeat = useCallback((beat) => {
    if (loading || audioPreparing) return
    const sec = sectionRef.current
    if (!sec) return
    const totalBeats = sec.totalBeats
    const startBeat = regionRef.current.start * totalBeats
    const endBeat = regionRef.current.end * totalBeats
    const clamped = Math.min(Math.max(beat, startBeat), endBeat)
    stopPlayback()
    seekBeatRef.current = clamped
    pausedBeatRef.current = clamped
    cursorRef.current = totalBeats > 0 ? clamped / totalBeats : 0
    setPlaybackState('paused')
  }, [loading, audioPreparing, stopPlayback])

  const playNoteOnClick = useCallback(async (note) => {
    try {
      if (Tone.getContext().state !== 'running' || Tone.getContext().rawContext?.state !== 'running') {
        // Swap-capable recovery (handles iOS 'interrupted') — a bare resume
        // can't escape an interrupted context.
        const active = await audioEngine.ensureActive({ loadDefaultPiano: false })
        if (lastRawContextRef.current !== active.rawContext) {
          lastRawContextRef.current = active.rawContext
          setContextEpoch(e => e + 1)
        }
      }
      audioPlayerRef.current?.stop()
      releaseActiveNotes(activeNotesRef)
      const us = userSettingsRef.current
      const inst = mode === 'harmony' ? us.chordsInstrument : us.melodyInstrument
      ensureInstrument(inst)
      const player = audioEngine.getPlayer(inst)
      if (!player) return
      player.triggerAttack(note.note, Tone.now(), Math.min(Math.max(note.velocity ?? 0.8, 0), 1))
      const sec = sectionRef.current
      const durSec = Math.max(0.3, (note.duration ?? 1) * 60 / ((sec?.settings.tempo || 120) * speedRef.current))
      window.setTimeout(() => {
        try { player.triggerRelease?.(note.note, Tone.now()) } catch (_) {}
      }, durSec * 1000)
    } catch (err) {
      console.warn('Note audition failed:', err)
    }
  }, [ensureInstrument, mode])

  // ── Transcription keyboard ───────────────────────────────────────────────

  const kbNoteOn = useCallback((noteName, velocity = 96) => {
    audioEngine.startNote(noteName, velocity, userSettingsRef.current.melodyInstrument)
  }, [])

  const kbNoteOff = useCallback((noteName) => {
    audioEngine.stopNote(noteName, userSettingsRef.current.melodyInstrument)
  }, [])

  const toggleKbDrone = useCallback(() => {
    if (kbDroneOn) {
      audioEngine.stopDrone()
      setKbDroneOn(false)
    } else {
      audioEngine.scheduleDroneNotes(settings.key, 4, userSettingsRef.current.droneVolume)
      setKbDroneOn(true)
    }
  }, [kbDroneOn, settings.key])

  // On open: warm the context + melody instrument so the first tap sounds.
  // On close: release held notes + the drone.
  useEffect(() => {
    if (!keyboardOpen) return
    audioEngine.ensureActive({ loadDefaultPiano: false })
      .then(({ rawContext }) => {
        if (lastRawContextRef.current !== rawContext) {
          lastRawContextRef.current = rawContext
          setContextEpoch(e => e + 1)
        }
        return ensureInstrument(userSettingsRef.current.melodyInstrument)
      })
      .catch(() => {})
    return () => {
      audioEngine.stopAllLiveNotes()
      audioEngine.stopDrone()
      setKbDroneOn(false)
    }
  }, [keyboardOpen, ensureInstrument])

  const handleResumeFromOverlay = useCallback(async () => {
    setShowResumeOverlay(false)
    setAudioPreparing(true)
    try {
      await recoverAudioGraphForRetry(0)
      lastAudioReinitializedAtRef.current = Date.now()
    } catch (err) {
      setError(`Audio recovery failed: ${err.message}`)
    } finally {
      setAudioPreparing(false)
    }
  }, [recoverAudioGraphForRetry])

  const [zoom, setZoom] = useState(1)

  // ── Derived UI data ──────────────────────────────────────────────────────

  const isBusy = loading || audioPreparing
  const sources = SOURCE_OPTIONS[mode]
  const sourceAvailable = (opt) => opt.requires.every(r => capabilities[r]) && (opt.id !== 'full' || audioReady)
  const displayNotes = mode === 'melody' ? (session?.notes || []) : (session?.chordsNotes || [])
  const timeline = useMemo(() => buildTimeline(session), [session])

  // Time division = smallest division that fits every displayed note exactly
  const division = useMemo(() => detectTimeDivision(displayNotes), [displayNotes])

  // Vertical range adapts to the displayed MIDI notes (3 semitones padding)
  const displayRange = useMemo(() => {
    let lo = Infinity, hi = -Infinity
    for (const n of displayNotes) {
      const m = noteNameToMidi(n.note)
      if (m < lo) lo = m
      if (m > hi) hi = m
    }
    if (!Number.isFinite(lo)) return { lowestNote: 48, highestNote: 72 }
    return { lowestNote: Math.max(0, lo - 3), highestNote: Math.min(127, hi + 3) }
  }, [displayNotes])

  // Ctrl/Cmd + wheel zoom from the piano roll
  const handleRollZoom = useCallback((deltaY) => {
    setZoom(z => Math.min(3, Math.max(0.4, +(z * (deltaY > 0 ? 0.9 : 1.1)).toFixed(3))))
  }, [])

  // Header key display: "F# Minor → A Major" for sections with a key change
  const keyDisplay = timeline.keyEvents.map(k => `${k.key} ${k.keyMode}`).join(' → ')

  // Song-level transcription doc (bundled Google-Docs HTML), if the catalog
  // has one for the selected song
  const transcriptionUrl = useMemo(() => {
    if (!catalog || !selected) return null
    const song = catalog.artists
      ?.find(a => a.name === selected.artist)?.songs
      ?.find(s => s.title === selected.title)
    return song?.transcription || null
  }, [catalog, selected])

  // ── Render ───────────────────────────────────────────────────────────────

  const bg = isDark
    ? 'bg-[radial-gradient(circle_at_top,#1e3a8a_0,#020617_45%)] text-white'
    : 'bg-[radial-gradient(circle_at_top,#dbeafe_0,#f8fafc_45%)] text-slate-900'
  const card = isDark ? 'border-white/10 bg-white/[0.07]' : 'border-slate-300 bg-white/80'
  const btnBase = 'flex items-center justify-center gap-1.5 rounded-2xl font-bold transition active:scale-95 disabled:opacity-40 disabled:pointer-events-none'

  return (
    <main className={`safe-top safe-bottom min-h-full ${bg}`}>
      <div className={`mx-auto flex min-h-full max-w-5xl flex-col gap-3 px-3 pt-3 sm:px-5 ${keyboardOpen ? 'pb-44' : 'pb-6'}`}>

        {/* ── Header ── */}
        <header className={`rounded-3xl border p-4 shadow-xl backdrop-blur-xl ${card}`}>
          {/* Mobile: buttons on their own row, then artist/title/meta each on a
              full-width line. Desktop (sm+): catalog | centered text | actions. */}
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap">
            <button
              onClick={() => setCatalogOpen(true)}
              className={`${btnBase} order-1 h-11 shrink-0 border px-4 text-sm ${isDark ? 'border-white/10 bg-sky-400/15 text-sky-200 hover:bg-sky-400/25' : 'border-slate-300 bg-sky-100 text-sky-800 hover:bg-sky-200'}`}
            >
              <BookOpen className="h-4 w-4" />
              <span className="hidden sm:inline">Catalog</span>
            </button>
            <div className="order-2 ml-auto flex shrink-0 gap-1.5 sm:order-3 sm:ml-0">
              <button onClick={() => setShowAnswers(v => !v)} title={showAnswers ? 'Hide answers' : 'Show answers'}
                className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                {showAnswers ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
              <button onClick={() => setNotation(v => v === 'theory' ? 'names' : 'theory')}
                title={notation === 'theory' ? 'Notation: scale degrees / Roman numerals (tap for note & chord names)' : 'Notation: note & chord names (tap for scale degrees / Roman numerals)'}
                className={`rounded-full p-2.5 transition active:scale-95 ${notation === 'names'
                  ? 'bg-sky-400/90 text-slate-950'
                  : isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                {notation === 'theory' ? <Hash className="h-4 w-4" /> : <Type className="h-4 w-4" />}
              </button>
              {transcriptionUrl && (
                <button onClick={() => setTranscriptionOpen(true)} title="Transcription"
                  className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                  <FileText className="h-4 w-4" />
                </button>
              )}
              <button onClick={() => setKeyboardOpen(v => !v)} title="Transcription keyboard"
                className={`rounded-full p-2.5 transition active:scale-95 ${keyboardOpen
                  ? 'bg-sky-400/90 text-slate-950'
                  : isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                <Keyboard className="h-4 w-4" />
              </button>
              <button onClick={() => setSettingsOpen(true)} title="Settings"
                className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                <Settings className="h-4 w-4" />
              </button>
              <button onClick={toggleTheme} title="Toggle theme"
                className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                {isDark ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4 text-indigo-500" />}
              </button>
            </div>
            <div className="order-3 w-full min-w-0 text-center sm:order-2 sm:w-auto sm:flex-1">
              <p className={`truncate text-sm font-extrabold uppercase tracking-[0.18em] sm:text-base ${isDark ? 'text-sky-300/90' : 'text-sky-700/90'}`}>
                {selected?.artist || 'Ear Master Pro'}
              </p>
              <h1 className="truncate text-xl font-extrabold leading-tight sm:text-2xl">
                {selected ? selected.title : 'Ear Master Pro'}
              </h1>
              <p className={`mt-0.5 text-xs font-medium sm:text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {selected ? `${selected.entry.label} · ` : ''}{keyDisplay} · {settings.tempo} BPM · {timeSignatureToString(settings.timeSignature)} · {settings.bars} bars
              </p>
            </div>
          </div>

          {/* ── Mode toggle ── */}
          <div className={`mt-4 grid grid-cols-2 gap-1 rounded-2xl border p-1 ${isDark ? 'border-white/10 bg-slate-950/60' : 'border-slate-300 bg-slate-100'}`}>
            {['melody', 'harmony'].map(m => {
              const disabled = (m === 'melody' && !capabilities.melody) || (m === 'harmony' && !capabilities.chords)
              const active = mode === m
              return (
                <button key={m} onClick={() => selectMode(m)} disabled={disabled}
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-xl text-sm font-bold transition active:scale-[0.98] ${active
                    ? 'bg-sky-400 text-slate-950 shadow'
                    : disabled ? 'opacity-40' : isDark ? 'text-slate-300 hover:bg-white/5' : 'text-slate-600 hover:bg-white/60'}`}>
                  {disabled && <Lock className="h-3.5 w-3.5" />}
                  {m === 'melody' ? 'Melody' : 'Harmony'}
                </button>
              )
            })}
          </div>
        </header>

        {/* ── Transport controls ── */}
        <section className={`rounded-3xl border p-3 shadow-xl backdrop-blur-xl ${card}`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Source selector */}
            <div className={`grid flex-1 grid-cols-3 gap-1 rounded-2xl border p-1 ${isDark ? 'border-white/10 bg-slate-950/60' : 'border-slate-300 bg-slate-100'}`}>
              {sources.map(opt => {
                const available = sourceAvailable(opt)
                const active = source === opt.id
                return (
                  <button key={opt.id} disabled={!available}
                    onClick={() => { stopPlayback(); setSource(opt.id) }}
                    title={available ? opt.label : `${opt.label} (not available)`}
                    className={`flex h-11 items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-bold transition active:scale-[0.98] sm:text-xs ${active
                      ? 'bg-emerald-400 text-slate-950 shadow'
                      : available ? isDark ? 'text-slate-300 hover:bg-white/5' : 'text-slate-600 hover:bg-white/60'
                        : 'opacity-40'}`}>
                    {!available && <Lock className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{opt.label}</span>
                  </button>
                )
              })}
            </div>

            {/* Play / Stop / Speed / Loop */}
            <div className="flex flex-wrap items-stretch gap-2">
              <button
                onClick={playbackState === 'playing' ? pausePlayback : play}
                disabled={!session || isBusy}
                className={`${btnBase} h-12 flex-1 px-6 text-slate-950 shadow-lg sm:flex-none ${playbackState === 'playing' ? 'bg-amber-300 shadow-amber-500/20' : 'bg-emerald-400 shadow-emerald-500/25'}`}
              >
                {isBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : playbackState === 'playing' ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                <span className="text-sm">{playbackState === 'playing' ? 'Pause' : 'Play'}</span>
              </button>
              <button onClick={() => stopPlayback()} disabled={playbackState === 'stopped' && cursorRef.current === 0}
                className={`${btnBase} h-12 flex-1 bg-rose-400 px-5 text-slate-950 shadow-lg shadow-rose-500/25 sm:flex-none`}>
                <Square className="h-4 w-4" />
                <span className="text-sm">Stop</span>
              </button>
              <div className="flex flex-1 basis-full items-stretch gap-2 sm:basis-auto sm:flex-none">
                <div className={`flex flex-1 items-center justify-center gap-1 rounded-2xl border px-1 ${isDark ? 'border-white/10 bg-slate-950/60' : 'border-slate-300 bg-slate-100'}`}>
                  {SPEED_OPTIONS.map(s => (
                    <button key={s} onClick={() => setSpeed(s)}
                      className={`h-10 flex-1 rounded-xl px-2.5 text-[11px] font-bold transition active:scale-95 ${Math.abs(speed - s) < 0.001
                        ? 'bg-sky-400 text-slate-950' : isDark ? 'text-slate-300 hover:bg-white/5' : 'text-slate-600 hover:bg-white/60'}`}>
                      {speedLabel(s)}
                    </button>
                  ))}
                </div>
                <button onClick={() => setIsLooping(v => !v)} title="Loop region"
                  className={`${btnBase} h-12 w-12 rounded-2xl border ${isLooping
                    ? 'border-sky-400/60 bg-sky-400/20 text-sky-300'
                    : isDark ? 'border-white/10 bg-slate-950/60 text-slate-400' : 'border-slate-300 bg-slate-100 text-slate-500'}`}>
                  <Repeat className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ── Piano roll ── */}
        <section className={`rounded-3xl border p-2 shadow-xl backdrop-blur-xl sm:p-3 ${card}`}>
          <PianoRoll
            notes={displayNotes}
            annotations={session?.chordAnnotations || []}
            mode={mode}
            tonic={settings.key}
            keyMode={settings.keyMode}
            bars={settings.bars}
            barStarts={timeline.barStarts}
            totalBeats={timeline.totalBeats}
            keyEvents={timeline.keyEvents}
            timeDivision={division}
            timeSignature={settings.timeSignature}
            lowestNote={displayRange.lowestNote}
            highestNote={displayRange.highestNote}
            regionStart={regionStart}
            regionEnd={regionEnd}
            onRegionChange={handleRegionChange}
            onZoom={handleRollZoom}
            cursorRef={cursorRef}
            isPlaying={playbackState === 'playing'}
            playbackState={playbackState}
            zoom={zoom}
            isDark={isDark}
            showAnswers={showAnswers}
            notation={notation}
            onNoteClick={playNoteOnClick}
            onSeek={playFromBeat}
          />
        </section>

        {/* ── Zoom ── */}
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => setZoom(z => Math.max(0.4, +(z - 0.2).toFixed(2)))} className={`rounded-full p-2 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}><Minus className="h-3.5 w-3.5" /></button>
          <span className={`text-xs font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Zoom {Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(3, +(z + 0.2).toFixed(2)))} className={`rounded-full p-2 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}><Plus className="h-3.5 w-3.5" /></button>
        </div>

        {/* ── Status ── */}
        {error && <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">{error}</div>}
        {isBusy && !error && (
          <div className={`flex items-center justify-center gap-2 rounded-2xl border p-3 text-sm ${isDark ? 'border-sky-300/30 bg-sky-400/10 text-sky-100' : 'border-sky-300 bg-sky-50 text-sky-800'}`}>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
      </div>

      {/* ── Catalog sheet ── */}
      {catalog && (
        <CatalogSheet
          open={catalogOpen}
          onClose={() => setCatalogOpen(false)}
          catalog={catalog}
          selectedId={selected?.entry?.id}
          onSelect={selectSection}
          isDark={isDark}
        />
      )}

      {/* ── Settings sheet ── */}
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={userSettings}
        onChange={patchSettings}
        loadingInstruments={loadingInstruments}
        isDark={isDark}
      />

      {/* ── Transcription sheet ── */}
      <TranscriptionSheet
        open={transcriptionOpen && !!transcriptionUrl}
        onClose={() => setTranscriptionOpen(false)}
        url={transcriptionUrl || ''}
        title={selected ? `${selected.title} — ${selected.entry.label}` : 'Transcription'}
        sectionAnchor={selected?.entry ? `${selected.entry.name}-section` : null}
        isDark={isDark}
        notation={notation}
        onNotationChange={setNotation}
      />

      {/* ── Transcription keyboard (bottom dock) ── */}
      <KeyboardPanel
        open={keyboardOpen}
        onClose={() => setKeyboardOpen(false)}
        isDark={isDark}
        tonic={settings.key}
        instrument={userSettings.melodyInstrument}
        droneOn={kbDroneOn}
        onToggleDrone={toggleKbDrone}
        onNoteOn={kbNoteOn}
        onNoteOff={kbNoteOff}
      />

      {/* ── Resume-audio overlay ── */}
      {showResumeOverlay && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-6">
          <div className={`rounded-3xl border p-6 text-center shadow-2xl ${isDark ? 'border-white/10 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}>
            <Headphones className={`mx-auto mb-3 h-10 w-10 ${isDark ? 'text-sky-400' : 'text-sky-600'}`} />
            <h2 className="text-lg font-bold">Audio Interrupted</h2>
            <p className={`mt-2 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>The audio context was closed while the app was in the background.</p>
            <button onClick={handleResumeFromOverlay} className="mt-4 rounded-2xl bg-emerald-400 px-6 py-3 font-bold text-slate-950 shadow-lg active:scale-95">
              Resume Audio
            </button>
          </div>
        </div>
      )}
    </main>
  )
}

export default EarTrainer
