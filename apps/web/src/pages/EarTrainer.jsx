import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Tone from 'tone'
import { BookOpen, Eye, EyeOff, FileText, Hash, Headphones, Loader2, Lock, Moon, Pause, Play, Repeat, Settings, Square, Sun, Type, Minus, Plus } from 'lucide-react'
import audioEngine, { INSTRUMENT_CONFIGS } from '@common/lib/audioEngine'
import { GranularPlayer } from '@common/lib/granularPlayer'
import {
  beatsPerBarFromTimeSignature,
  buildMeterTimeline,
  DEFAULT_TIME_SIGNATURE,
  detectTimeDivision,
  getInternalBpm,
  normalizeTimeSignature,
  timeSignatureToString,
} from '@common/lib/midiUtils'
import { loadCatalog, loadSectionSession, loadSectionAudio } from '@/lib/catalog'
import PianoRoll from '@/components/PianoRoll'
import CatalogSheet from '@/components/CatalogSheet'
import SettingsSheet from '@/components/SettingsSheet'
import TranscriptionSheet from '@/components/TranscriptionSheet'

// ─── Constants ───────────────────────────────────────────────────────────────

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1]
const SYNTH_CONFIG = { volume: -8 }
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

function normalizeKeyMode(value) {
  return String(value || '').toLowerCase().includes('minor') ? 'Minor' : 'Major'
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

// ─── Note scheduling (setTimeout-based; proven robust on mobile Safari) ──────

function clearTimerList(timerRef) {
  timerRef.current.forEach(t => window.clearTimeout(t))
  timerRef.current = []
}

function scheduleNotes(notes, tempo, startBeat, timerRef, activeNotesRef) {
  if (!notes.length) return
  const secondsPerBeat = 60 / tempo
  timerRef.current = notes
    .filter(n => n.start + n.duration > startBeat)
    .flatMap(note => {
      const noteId = note.id || `${note.note}-${note.start}`
      const noteEnd = note.start + note.duration
      const delayMs = Math.max(0, (note.start - startBeat) * secondsPerBeat * 1000)
      const durationMs = Math.max(50, (noteEnd - Math.max(note.start, startBeat)) * secondsPerBeat * 1000)
      const velocity = Math.min(Math.max((note.velocity ?? 0.8) * Math.pow(10, (note.volume ?? 0) / 20), 0), 1)
      const player = audioEngine.getPlayer(note.instrument)
      const startTimer = window.setTimeout(() => {
        if (!player) return
        player.triggerAttack(note.note, Tone.now(), velocity)
        activeNotesRef.current.set(noteId, { note: note.note, player })
      }, delayMs)
      const endTimer = window.setTimeout(() => {
        const active = activeNotesRef.current.get(noteId)
        if (active && activeNotesRef.current.delete(noteId)) {
          try { active.player?.triggerRelease?.(active.note, Tone.now()) } catch (_) {}
        }
      }, delayMs + durationMs)
      return [startTimer, endTimer]
    })
}

/**
 * Looping variant: re-arms each region iteration ~250ms before its boundary
 * so notes re-trigger on every loop (timers are wall-clock absolute).
 */
function scheduleLoopedNotes(notes, regionBeats, tempo, resumeRegionBeat, timerRef, activeNotesRef) {
  if (!notes.length || regionBeats <= 0) return
  const beatToMs = 60000 / tempo
  const t0 = performance.now()
  const origin = resumeRegionBeat
  let iter = 0

  const scheduleIteration = () => {
    const iterBase = iter * regionBeats
    for (const note of notes) {
      const absStart = iterBase + note.start
      const absEnd = iterBase + Math.min(note.start + note.duration, regionBeats)
      if (absEnd <= origin || absEnd <= absStart) continue
      const startEff = Math.max(absStart, iter === 0 ? origin : absStart)
      const noteId = `${note.id || `${note.note}-${note.start}`}-i${iter}`
      const velocity = Math.min(Math.max((note.velocity ?? 0.8) * Math.pow(10, (note.volume ?? 0) / 20), 0), 1)
      const player = audioEngine.getPlayer(note.instrument)
      const startDelay = Math.max(0, t0 + (startEff - origin) * beatToMs - performance.now())
      const endDelay = Math.max(50, t0 + (absEnd - origin) * beatToMs - performance.now())
      timerRef.current.push(window.setTimeout(() => {
        if (!player) return
        player.triggerAttack(note.note, Tone.now(), velocity)
        activeNotesRef.current.set(noteId, { note: note.note, player })
      }, startDelay))
      timerRef.current.push(window.setTimeout(() => {
        const active = activeNotesRef.current.get(noteId)
        if (active && activeNotesRef.current.delete(noteId)) {
          try { active.player?.triggerRelease?.(active.note, Tone.now()) } catch (_) {}
        }
      }, endDelay))
    }
    // Arm the next iteration shortly before this one ends
    const nextBoundary = (iter + 1) * regionBeats
    const msToNext = t0 + (nextBoundary - origin) * beatToMs - performance.now() - 250
    timerRef.current.push(window.setTimeout(() => { iter += 1; scheduleIteration() }, Math.max(0, msToNext)))
  }
  scheduleIteration()
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
  const [isInitialized, setIsInitialized] = useState(false)
  const [loading, setLoading] = useState(true)
  const [audioPreparing, setAudioPreparing] = useState(false)
  const [error, setError] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [showResumeOverlay, setShowResumeOverlay] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [transcriptionOpen, setTranscriptionOpen] = useState(false)
  const [loadingInstruments, setLoadingInstruments] = useState(() => new Set())

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
    const rawBefore = Tone.context.rawContext
    const isClosed = Tone.context.state === 'closed' || rawBefore?.state === 'closed'
    if (force && isClosed) {
      resetAudioStateAfterContextChange()
      Tone.setContext(new Tone.Context({ latencyHint }))
    }
    const rawContext = Tone.context.rawContext
    if (start) {
      await Tone.start()
      if (Tone.context.state !== 'running') await Tone.context.resume()
      if (rawContext?.state !== 'running') await rawContext.resume()
      if (Tone.context.state === 'closed' || rawContext?.state === 'closed') {
        throw new Error('Audio context could not be reopened.')
      }
    } else if (Tone.context.state === 'closed' || rawContext?.state === 'closed') {
      Tone.setContext(new Tone.Context({ latencyHint }))
    }
    const contextChanged = Boolean(lastRawContextRef.current && lastRawContextRef.current !== rawContext)
    if (contextChanged) resetAudioStateAfterContextChange()
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
    audioEngine.stop()
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
    setPlaybackState('stopped')
  }, [])

  const pausePlayback = useCallback(() => {
    if (playbackState !== 'playing') return
    const { startBeat, effectiveTempo } = currentRegionRef.current
    const elapsedBeats = Math.max(0, (Tone.now() - playbackStartTimeRef.current) * effectiveTempo / 60)
    pausedBeatRef.current = startBeat + elapsedBeats
    clearTimerList(noteTimersRef)
    if (stopTimerRef.current) { window.clearTimeout(stopTimerRef.current); stopTimerRef.current = null }
    audioEngine.pause({ releaseActiveNotes: false })
    audioEngine.stopDrone()
    dronePlayingRef.current = false
    releaseActiveNotes(activeNotesRef)
    audioPlayerRef.current?.stop()
    setPlaybackState('paused')
  }, [playbackState])

  // ── Playback recovery (watchdog, ported) ─────────────────────────────────

  const recoverAudioGraphForRetry = useCallback(async (attempt = 1) => {
    audioEngine.dispose()
    setIsInitialized(false)
    try { Tone.Transport.cancel() } catch (_) {}
    try { Tone.Transport.stop() } catch (_) {}
    lastRawContextRef.current = null
    const { rawContext } = await ensureFreshAudioContext({ force: true, latencyHint: attempt >= 2 ? 'interactive' : 'playback' })
    await new Promise(r => window.setTimeout(r, 80))
    if (Tone.context.state !== 'running') await Tone.context.resume()
    if (rawContext?.state !== 'running') await rawContext.resume()
    await audioEngine.initialize({ loadDefaultPiano: false })
    await audioEngine.loadInstrument('synth', SYNTH_CONFIG)
    lastAudioReinitializedAtRef.current = Date.now()
    setIsInitialized(true)
  }, [ensureFreshAudioContext])

  const verifyPlaybackStarted = useCallback((playbackToken, before) => {
    if (playbackWatchdogTimerRef.current) window.clearTimeout(playbackWatchdogTimerRef.current)
    playbackWatchdogTimerRef.current = window.setTimeout(async () => {
      if (playbackToken !== playbackTokenRef.current || document.visibilityState !== 'visible') return
      const rawContext = Tone.context.rawContext
      const rawAdvanced = rawContext ? rawContext.currentTime > before.rawTime + 0.15 : false
      const ticksAdvanced = Tone.Transport.ticks > before.transportTicks + 2
      const cursorAdvanced = cursorRef.current > before.cursorPosition + 0.001
      if (Tone.context.state === 'running' && rawAdvanced && (ticksAdvanced || cursorAdvanced)) {
        playbackRecoveryAttemptRef.current = 0
        return
      }
      // First: try a plain resume before rebuilding
      if (playbackRecoveryAttemptRef.current === 0) {
        playbackRecoveryAttemptRef.current = 1
        try {
          if (Tone.context.state !== 'running') await Tone.context.resume()
          if (rawContext?.state !== 'running') await rawContext.resume()
          await new Promise(r => window.setTimeout(r, 200))
          if (playbackToken !== playbackTokenRef.current) return
          const nowAdvanced = Tone.context.rawContext ? Tone.context.rawContext.currentTime > rawContext.currentTime + 0.1 : false
          if (Tone.context.state === 'running' && nowAdvanced && Tone.Transport.ticks > before.transportTicks + 2) {
            playbackRecoveryAttemptRef.current = 0
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
    }, 900)
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
      const audioContext = Tone.context.rawContext

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
        if (Tone.context.state === 'closed' || Tone.context.rawContext?.state === 'closed') {
          await recoverAudioGraphForRetry(0)
        } else {
          if (Tone.context.state !== 'running') await Tone.context.resume()
          if (Tone.context.rawContext?.state !== 'running') await Tone.context.rawContext.resume()
          lastAudioReinitializedAtRef.current = Date.now()
        }
      }
      const playbackToken = playbackTokenRef.current
      if (!audioEngine.isInitialized) {
        await audioEngine.initialize({ loadDefaultPiano: false })
        await audioEngine.loadInstrument('synth', SYNTH_CONFIG)
        setIsInitialized(true)
      }

      // Initialize the audio player against the current context
      if (audioPlayerRef.current && audioPlayerRef.current.audioContext !== audioContext) {
        try { audioPlayerRef.current.gainNode?.disconnect() } catch (_) {}
        audioPlayerRef.current.audioContext = null
        audioPlayerRef.current.workletReady = false
      }
      if (audioPlayerRef.current && !audioPlayerRef.current.audioContext) {
        await audioPlayerRef.current.initialize(audioContext)
      }
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
      Tone.Transport.timeSignature = beatsPerBarFromTimeSignature(s.timeSignature)
      audioEngine.totalTicks = Math.round(regionBeats * Tone.Transport.PPQ)
      Tone.Transport.position = `${Math.round(resumeRegionBeat * Tone.Transport.PPQ)}i`

      // MIDI notes for the selected source
      let midiNotes = []
      if (usesMelody) midiNotes = midiNotes.concat(sliceRegion(notes, us.melodyVolume, us.melodyInstrument))
      if (usesChords) midiNotes = midiNotes.concat(sliceRegion(chordsNotes, us.chordsVolume, us.chordsInstrument))

      if (!isLoopingRef.current) audioEngine.scheduleStopAtBeats(regionBeats)
      else audioEngine.setLoopEnabledBeats(true, regionBeats)

      if (midiNotes.length) {
        if (isLoopingRef.current) {
          scheduleLoopedNotes(midiNotes, regionBeats, effectiveTempo, resumeRegionBeat, noteTimersRef, activeNotesRef)
        } else {
          scheduleNotes(midiNotes, effectiveTempo, resumeRegionBeat, noteTimersRef, activeNotesRef)
        }
      }

      const playbackStartedFrom = {
        rawTime: audioContext?.currentTime || 0,
        transportTicks: Tone.Transport.ticks,
        cursorPosition: cursorRef.current,
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

      setPlaybackState('playing')
      verifyPlaybackStarted(playbackToken, playbackStartedFrom)
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
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return
      const toneState = Tone.context.state
      const rawState = Tone.context.rawContext?.state
      if (toneState === 'closed' || rawState === 'closed') {
        stopPlayback()
        setShowResumeOverlay(true)
        return
      }
      if (toneState === 'suspended' || rawState === 'suspended') {
        try {
          await Tone.context.resume()
          if (Tone.context.rawContext?.state === 'suspended') await Tone.context.rawContext.resume()
          lastAudioReinitializedAtRef.current = Date.now()
        } catch (_) {
          stopPlayback()
          setShowResumeOverlay(true)
        }
      } else {
        lastAudioReinitializedAtRef.current = Date.now()
      }
    }
    const handlePageHide = () => { if (playbackState === 'playing') stopPlayback() }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [stopPlayback, playbackState])

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
        const ctx = Tone.context.rawContext
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
      if (Tone.context.state !== 'running') await ensureFreshAudioContext()
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
  }, [ensureFreshAudioContext, ensureInstrument, mode])

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
      <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-3 px-3 pb-6 pt-3 sm:px-5">

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
