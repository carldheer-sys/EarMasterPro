import * as Tone from 'tone'
import SampleLibrary from './Tonejs-Instruments'
import { getInternalBpm, normalizeKeyName } from './midiUtils'
import { droneBandIndex, droneBandRef, droneLoopPromise } from './droneBaker'

// MIDI note number → note name (middle C = C4 = 60)
const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const DRONE_FILE_STEMS = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']

// Module-level caches survive AudioEngine.dispose() and context rebuilds:
// 1. sampleArrayBufferCache: instrument → Map(noteName → ArrayBuffer)
// 2. sampleAudioBufferCache: instrument → Map(noteName → AudioBuffer)
//    AudioBuffers in Web Audio are context-independent, so a context rebuild
//    reuses already-decoded buffers in <1ms instead of re-decoding 16-28 MP3s.
const sampleArrayBufferCache = {}
const sampleAudioBufferCache = {}
const SAMPLE_BASE_URL = 'https://nbrosowsky.github.io/tonejs-instruments/samples/'
const SONOFIELD_SYNTH_BASE_URL = '/samples/sonofield-synth/'
const SONOFIELD_DRONE_BASE_URL = '/samples/sonofield-drone/'
const FETCH_CONCURRENCY = 8
const DECODE_CONCURRENCY = 8
const SAMPLE_FETCH_TIMEOUT_MS = 6000

// Module-level caches for the 12 Sonofield stereo drone loops (/samples/sonofield-drone/*.mp3)
const droneArrayBufferCache = new Map() // stem → ArrayBuffer
const droneAudioBufferCache = new Map() // stem → AudioBuffer
const droneLoadPromises = new Map()     // stem → Promise<AudioBuffer|null>

export function tonicToDroneStem(tonic) {
  const idx = MIDI_NOTE_NAMES.indexOf(normalizeKeyName(tonic))
  return DRONE_FILE_STEMS[idx >= 0 ? idx : 9]
}

function fetchWithTimeout(url, timeoutMs = SAMPLE_FETCH_TIMEOUT_MS) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  return fetch(url, controller ? { signal: controller.signal } : undefined)
    .finally(() => { if (timer) clearTimeout(timer) })
}

// Generated (non-sampled) instrument definitions, created as Tone.PolySynths.
// Note: 'synth' ALSO has a 16-zone Sonofield SF2 sample map in SampleLibrary;
// its SYNTH_TYPES entry serves as the instant zero-latency fallback while the
// local samples decode (or in headless/unit-test environments).
export const SYNTH_TYPES = {
  synth: {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.1, sustain: 0.4, release: 0.3 },
    volume: -6,
  },
  pad: {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
    envelope: { attack: 0.3, decay: 0.5, sustain: 0.7, release: 2.2 },
    volume: -12,
    filter: 2200,
  },
}

// Per-instrument defaults for the sample-based sounds.
// 'synth' uses the extracted Sonofield SF2 stereo multisamples (~0.3s release).
export const INSTRUMENT_CONFIGS = {
  synth: { attack: 0.005, release: 0.3, volume: -4 },
  pad: { volume: -10 },
  piano: { attack: 0.02, release: 1, volume: -6 },
  violin: { attack: 0.1, release: 1.2, volume: -4 },
  flute: { attack: 0.08, release: 0.8, volume: -2 },
  clarinet: { attack: 0.05, release: 0.5, volume: -4 },
  organ: { attack: 0.02, release: 0.8, volume: -6 },
  'guitar-acoustic': { attack: 0.002, release: 0.8, volume: -4 },
  harp: { attack: 0.001, release: 1.2, volume: -4 },
  cello: { attack: 0.05, release: 1, volume: -4 },
  trumpet: { attack: 0.05, release: 0.6, volume: -6 },
  'bass-electric': { attack: 0.01, release: 0.8, volume: -4 },
}

// Ordered list for the settings pickers
export const INSTRUMENT_OPTIONS = [
  'synth', 'pad', 'piano', 'organ', 'guitar-acoustic', 'harp',
  'cello', 'violin', 'flute', 'clarinet', 'trumpet', 'bass-electric',
]

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1
  return MIDI_NOTE_NAMES[midi % 12] + octave
}

/**
 * Race an AudioContext.resume() (or Tone.start()) against a timeout.
 * iOS Safari can leave resume() pending forever on interrupted contexts —
 * awaiting it bare would hang playback setup permanently.
 */
export function resumeWithTimeout(promise, ms = 1500) {
  return Promise.race([
    Promise.resolve(promise).then(() => true).catch(() => false),
    new Promise(resolve => setTimeout(() => resolve(false), ms)),
  ])
}

/** A context state from which audio cannot currently flow. */
export function isContextBlocked(state) {
  return state === 'suspended' || state === 'interrupted' || state === 'closed'
}

// Whether the CURRENT Tone context was created before any user activation.
// Tone's import-time context is always born pre-gesture; contexts swapped in
// later are post-activation once any gesture has occurred (hasBeenActive is
// sticky). Such pre-activation contexts can report 'running' while their
// render thread never starts (headless builds; iOS after restores).
let contextCreatedPreActivation = true

/**
 * Whether the current context was born before the first user gesture and is
 * currently blocked. resume() on such a context can stay pending forever —
 * inside a live gesture the reliable move is to swap it immediately rather
 * than burn the transient-activation window on resume timeouts.
 */
export function isPreActivationBlockedContext() {
  return contextCreatedPreActivation
    && (isContextBlocked(Tone.getContext().state) || isContextBlocked(Tone.getContext().rawContext?.state))
}
// Whether the current context's clock has been observed advancing — i.e. it
// has demonstrably rendered audio, not just reported 'running'.
let contextRenderProven = false

function observeContextRendered() {
  if (!contextRenderProven && Tone.getContext()?.rawContext?.currentTime > 0.005) {
    contextRenderProven = true
  }
  return contextRenderProven
}

/**
 * Replace the global Tone context with a fresh one and close the previous
 * raw context. iOS only allows a handful of live AudioContexts — rebuilding
 * without closing leaks one every time and eventually kills audio for good.
 */
export function swapToneContext(latencyHint = 'playback') {
  const prevRaw = Tone.getContext()?.rawContext
  Tone.setContext(new Tone.Context({ latencyHint }))
  contextCreatedPreActivation = !(navigator.userActivation?.hasBeenActive ?? true)
  contextRenderProven = false
  Tone.getContext().lookAhead = 0.1
  if (prevRaw && prevRaw !== Tone.getContext().rawContext && prevRaw.state !== 'closed') {
    try { const p = prevRaw.close(); p?.catch?.(() => {}) } catch (_) {}
  }
  return Tone.getContext().rawContext
}

// Tonic name → MIDI note number at octave 2
export function tonicToMidi(tonic, octave = 2) {
  const idx = MIDI_NOTE_NAMES.indexOf(normalizeKeyName(tonic))
  if (idx === -1) return 45 // fallback A2
  return (octave + 1) * 12 + idx
}

class AudioEngine {
  constructor() {
    this.samplers = {}
    this.synths = {}
    this.midiGain = null  // Tone.Volume node for MIDI-only volume control
    this.fxCompressor = null  // glue compressor (helps phone speakers)
    this.fxLimiter = null     // final peak safety before the destination
    this.fxReverb = null      // parallel 100%-wet send
    this.fxReverbSend = null  // send level into the reverb
    this.isInitialized = false
    this.cursorPosition = 0
    this.onCursorUpdate = null
    this.onPlaybackComplete = null
    this.scheduledEvents = []
    this.stopEventId = null
    this.animationFrameId = null
    this.totalTicks = 0
    this.instrumentConfigs = {}
    this.rawContext = null
    this.lastActiveAt = Date.now()
    this.staleContextMs = 20 * 60 * 1000
    this.keepaliveIntervalId = null
    this.silentKeepalive = null   // Gain(0) destination tap for the keepalive source
    this.silentSource = null      // looping silent buffer that keeps the graph active
    
    // Look-ahead scheduling
    this.lookAheadWindow = 1.0 // seconds (1000ms)
    this.schedulerIntervalId = null
    this.allNotes = [] // Full note list for look-ahead scheduling
    this.currentNoteIndex = 0 // Track which notes have been scheduled
    this.activeNotes = [] // Track currently playing notes for cleanup

    // Drone synth layers
    this.droneSynths = []
    this.droneLfos = []
    this.droneGains = []          // per-layer gain nodes (must be disposed with the drone)
    this.droneScheduledEvents = []
    this.droneSources = []        // looped buffer sources (baked-loop drone path)
    this._droneEpoch = 0          // bumped on stop — aborts in-flight loop renders

    // Instrument loading: dedupe concurrent loads and remember instruments
    // with no sample map so they don't re-warn on every play.
    this.instrumentLoads = {}
    this._byteWarmups = {}
    this.missingInstruments = new Set()
    
    // Live MIDI keyboard notes (for real-time playing)
    this.liveMidiNotes = {}
  }

  // ─── Live MIDI Keyboard Input ────────────────────────────────────────────

  /**
   * Start playing a note from MIDI keyboard input (real-time, not scheduled)
   * @param {string} noteName - Note name (e.g., 'C4', 'F#3')
   * @param {number} velocity - MIDI velocity (0-127)
   * @param {string} instrument - Instrument name (default: 'piano')
   */
  startNote(noteName, velocity = 100, instrument = 'piano') {
    // Fire-and-forget context recovery if needed
    if (Tone.getContext()?.state !== 'running' || !this.isInitialized) {
      this.ensureActive({ loadDefaultPiano: false }).catch(() => {})
    }
    if (!this.isInitialized) return

    try {
      const noteId = `${noteName}_${instrument}`
      
      // Stop any existing note with same name/instrument
      if (this.liveMidiNotes[noteId]) {
        this.stopNote(noteName, instrument)
      }
      
      const normalizedVelocity = Math.max(0, Math.min(1, velocity / 127))
      this.unmuteNotes()
      const player = this.getPlayer(instrument)
      if (player) {
        player.triggerAttack(noteName, Tone.now(), normalizedVelocity)
        this.liveMidiNotes[noteId] = { player, instrument }
      }
    } catch (error) {
      console.warn('Failed to start note:', error)
    }
  }

  /**
   * Stop playing a note from MIDI keyboard input
   * @param {string} noteName - Note name (e.g., 'C4', 'F#3')
   * @param {string} instrument - Instrument name (default: 'piano')
   */
  stopNote(noteName, instrument = 'piano') {
    if (!this.isInitialized) return
    
    try {
      const noteId = `${noteName}_${instrument}`
      const liveNote = this.liveMidiNotes[noteId]

      if (liveNote) {
        try { liveNote.player.triggerRelease(noteName, Tone.now()) } catch (_) {}
        delete this.liveMidiNotes[noteId]
      }
    } catch (error) {
      console.warn('Failed to stop note:', error)
    }
  }

  /**
   * Stop all live MIDI notes (useful when stopping playback or switching instruments)
   */
  stopAllLiveNotes() {
    Object.keys(this.liveMidiNotes).forEach(noteId => {
      try {
        const liveNote = this.liveMidiNotes[noteId]
        liveNote?.player?.triggerRelease?.(noteId.split('_')[0], Tone.now())
      } catch (_) {
        // Ignore errors from already released notes
      }
    })
    this.liveMidiNotes = {}
  }

  async initialize(options = {}) {
    // Dedupe concurrent initializes — mount-init + play-init + ensureActive
    // can overlap; two interleaved runs cross-wire midiGain/analyser nodes.
    if (this._initPromise) return this._initPromise
    const task = this._initializeInner(options)
    this._initPromise = task
    try {
      await task
    } finally {
      this._initPromise = null
    }
  }

  async _initializeInner(options = {}) {
    const rawContext = Tone.getContext()?.rawContext
    if (this.isInitialized && this.rawContext === rawContext && Tone.getContext().state !== 'closed' && rawContext?.state !== 'closed') return
    if (this.isInitialized) this.dispose()

    try {
      const latencyHint = options.latencyHint || 'playback'
      // Set latencyHint to 'playback' for stability with large MIDI sequences
      if (!Tone.getContext()._initialized || Tone.getContext().state === 'closed' || Tone.getContext().rawContext?.state === 'closed') {
        swapToneContext(latencyHint)
      }

      Tone.getContext().lookAhead = 0.1

      // Silent keepalive: a looping *silent buffer source* through a 0-gain
      // node keeps the render graph nominally active. (A bare Gain node with
      // no input does nothing — iOS would still suspend an idle context.)
      if (!this.silentSource) {
        const raw = Tone.getContext().rawContext
        this.silentKeepalive = raw.createGain()
        this.silentKeepalive.gain.value = 0
        this.silentKeepalive.connect(raw.destination)
        this.silentSource = raw.createBufferSource()
        this.silentSource.buffer = raw.createBuffer(1, raw.sampleRate, raw.sampleRate)
        this.silentSource.loop = true
        this.silentSource.connect(this.silentKeepalive)
        try { this.silentSource.start() } catch (_) {}
      }

      // MIDI-only gain node → mastering FX chain → Destination.
      //   midiGain → compressor → limiter → destination
      // Matches Sonofield (reverbSend=0) and SingMasterPro: no ConvolverNode
      // reverb (which previously ran an OfflineContext render inside
      // initialize() and taxed the mobile audio render thread over Bluetooth).
      // The limiter is the last stage so summed voices can't clip the output.
      this.midiGain = new Tone.Volume(-3)
      this.noteGain = new Tone.Gain(1).connect(this.midiGain)
      this.fxCompressor = new Tone.Compressor({ threshold: -18, ratio: 2.5, attack: 0.01, release: 0.2 })
      this.fxLimiter = new Tone.Limiter(-1.5)
      this.midiGain.connect(this.fxCompressor)
      this.fxCompressor.connect(this.fxLimiter)
      this.fxLimiter.toDestination()

      // Output tap for the silence watchdog: routed into silentKeepalive
      // (0-gain → destination) so WebKit's pull-based audio graph always
      // pulls through the AnalyserNode.
      try {
        this.outputAnalyser = Tone.getContext().createAnalyser()
        this.outputAnalyser.fftSize = 256
        this.outputAnalyser.smoothingTimeConstant = 0
        this.midiGain.connect(this.outputAnalyser)
        const anNative = this.outputAnalyser?._nativeAudioNode ?? this.outputAnalyser
        const kaNative = this.silentKeepalive?._nativeAudioNode ?? this.silentKeepalive
        if (anNative && kaNative) anNative.connect?.(kaNative)
      } catch (_) {
        this.outputAnalyser = null
      }

      // Always build the lightweight synth fallback synchronously so
      // getPlayer('synth') is non-null in 0ms while the Sonofield SF2
      // stereo samples load (or in headless/unit tests).
      this._buildSynthVoice('synth', this.instrumentConfigs['synth'] || INSTRUMENT_CONFIGS.synth)

      if (options.loadDefaultPiano === true) {
        await this.loadInstrument('piano', INSTRUMENT_CONFIGS.piano)
      }

      Tone.getTransport().bpm.value = 120
      Tone.getTransport().timeSignature = 4
      Tone.getTransport().loop = false

      this.rawContext = Tone.getContext().rawContext
      this.lastActiveAt = Date.now()
      this.isInitialized = true
      this.startKeepalive()
      console.log('Audio engine initialized with playback latency hint')
    } catch (error) {
      console.error('Failed to initialize audio engine:', error)
      throw error
    }
  }

  async ensureActive(options = {}) {
    // Dedupe: a concurrent ensureActive (e.g. keyboard fire-and-forget during
    // play setup) must not interleave dispose/swap with an in-flight one.
    if (this._ensurePromise) return this._ensurePromise
    const task = this._ensureActiveInner(options)
    this._ensurePromise = task
    try {
      return await task
    } finally {
      this._ensurePromise = null
    }
  }

  async _ensureActiveInner(options = {}) {
    const latencyHint = options.latencyHint || 'playback'
    const loadDefaultPiano = options.loadDefaultPiano === true
    const rawBefore = Tone.getContext()?.rawContext
    const toneState = Tone.getContext()?.state
    const rawState = rawBefore?.state
    const stale = this.isInitialized && Date.now() - this.lastActiveAt > this.staleContextMs
    const forceRebuild = options.forceRebuild || stale || toneState === 'closed' || rawState === 'closed'
    let contextChanged = false

    try {
      // 'playback' bypasses the iOS mute switch during playback. EarTrainer
      // switches to 'ambient' on pause/stop/background so the Now-Playing
      // banner is only eligible while audio is actually running.
      if (navigator.audioSession) navigator.audioSession.type = 'playback'
    } catch (_) {}

    const savedInstrumentConfigs = { ...this.instrumentConfigs }

    if (forceRebuild) {
      this.dispose()
      swapToneContext(latencyHint)
      contextChanged = true
    }

    if (!this.isInitialized) {
      await this.initialize({ loadDefaultPiano, latencyHint })
      contextChanged = contextChanged || this.rawContext !== rawBefore
    } else if (this.rawContext && this.rawContext !== Tone.getContext().rawContext) {
      this.dispose()
      await this.initialize({ loadDefaultPiano, latencyHint })
      contextChanged = true
    }

    // A context created before the first user gesture can leave resume()
    // pending forever (iOS 'interrupted'; also cold audio services). Inside a
    // live gesture the reliable move is to swap it out immediately — a fresh
    // in-gesture context starts running in ~100ms — rather than waiting out
    // the 1.5s resume timeout below on a context that can never answer.
    if (navigator.userActivation?.isActive && isPreActivationBlockedContext()) {
      this.dispose()
      swapToneContext(latencyHint)
      await this.initialize({ loadDefaultPiano, latencyHint })
      contextChanged = true
    }

    // Timeout-guarded resume: on iOS a resume() promise can hang forever on an
    // interrupted context — never await it bare.
    await resumeWithTimeout(Tone.start())
    if (Tone.getContext().state !== 'running') await resumeWithTimeout(Tone.getContext().resume())
    if (Tone.getContext().rawContext?.state !== 'running') await resumeWithTimeout(Tone.getContext().rawContext.resume())

    // Still blocked (suspended/interrupted/closed): rebuild the context once
    // and retry — the caller is usually inside a user gesture here.
    if (isContextBlocked(Tone.getContext().state) || isContextBlocked(Tone.getContext().rawContext?.state)) {
      this.dispose()
      swapToneContext(latencyHint)
      await this.initialize({ loadDefaultPiano, latencyHint })
      await resumeWithTimeout(Tone.start())
      if (Tone.getContext().state !== 'running') await resumeWithTimeout(Tone.getContext().resume())
      if (Tone.getContext().rawContext?.state !== 'running') await resumeWithTimeout(Tone.getContext().rawContext.resume())
      contextChanged = true
    }

    // A context created before the first user gesture can report 'running'
    // while its render thread never actually starts (headless builds; iOS
    // after restores). Inside a user gesture, give it a short window to prove
    // the clock advances — if it doesn't, replace it while activation is
    // still live so the fresh context can start rendering immediately.
    if (contextCreatedPreActivation && !contextRenderProven
        && Tone.getContext().rawContext?.state === 'running'
        && navigator.userActivation?.isActive) {
      await new Promise(r => setTimeout(r, 120))
      if (!observeContextRendered() && Tone.getContext().rawContext?.state === 'running') {
        this.dispose()
        swapToneContext(latencyHint)
        await this.initialize({ loadDefaultPiano, latencyHint })
        await resumeWithTimeout(Tone.start())
        if (Tone.getContext().state !== 'running') await resumeWithTimeout(Tone.getContext().resume())
        if (Tone.getContext().rawContext?.state !== 'running') await resumeWithTimeout(Tone.getContext().rawContext.resume())
        contextChanged = true
      }
    }

    // Reload all previously configured instruments after a context rebuild.
    // Runs AFTER the blocked-retry above so post-swap engines get them too.
    if (contextChanged && Object.keys(savedInstrumentConfigs).length > 0) {
      for (const [inst, cfg] of Object.entries(savedInstrumentConfigs)) {
        if (!this.samplers[inst] && !this.synths[inst]) {
          try { await this.loadInstrument(inst, cfg) } catch (e) { console.warn(`[AudioEngine] Failed to reload instrument ${inst}:`, e) }
        }
      }
    }

    this.rawContext = Tone.getContext().rawContext
    this.lastActiveAt = Date.now()
    return { contextChanged, rawContext: Tone.getContext().rawContext }
  }

  async startAudioContext() {
    try {
      await this.ensureActive()
      return true
    } catch (error) {
      console.error('Failed to start audio context:', error)
      return false
    }
  }

  startKeepalive() {
    this.stopKeepalive()
    this.keepaliveIntervalId = setInterval(async () => {
      try {
        if (document.hidden) return  // don't fight an OS/deliberate suspend
        const rawCtx = Tone.getContext()?.rawContext
        if (!rawCtx) return
        if (rawCtx.state === 'suspended' || rawCtx.state === 'interrupted') {
          await resumeWithTimeout(rawCtx.resume(), 800)
        }
        if (Tone.getContext()?.state === 'suspended' || Tone.getContext()?.state === 'interrupted') {
          await resumeWithTimeout(Tone.getContext().resume(), 800)
        }
        observeContextRendered()
        if (rawCtx.state === 'running' && this.isInitialized) {
          this.lastActiveAt = Date.now()
        }
      } catch (e) {
        console.warn('[AudioEngine] Keepalive error:', e)
      }
    }, 5000)
  }

  stopKeepalive() {
    if (this.keepaliveIntervalId) {
      clearInterval(this.keepaliveIntervalId)
      this.keepaliveIntervalId = null
    }
  }

  /**
   * RMS of the signal tapped off midiGain (see outputAnalyser in initialize).
   * Uses getByteTimeDomainData first because getFloatTimeDomainData returns
   * zeros on iOS Safari (verified in SingMasterPro). Falls back to float
   * domain for mock/test contexts.
   */
  getOutputLevel() {
    const a = this.outputAnalyser
    if (!a) return 0
    try {
      const n = a.fftSize || 256
      if (!this._analyserBytes || this._analyserBytes.length !== n) {
        this._analyserBytes = new Uint8Array(n)
      }
      if (typeof a.getByteTimeDomainData === 'function') {
        a.getByteTimeDomainData(this._analyserBytes)
        let sum = 0
        for (let i = 0; i < n; i++) {
          const v = (this._analyserBytes[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / n)
        if (rms > 0) return rms
      }
      if (typeof a.getFloatTimeDomainData === 'function') {
        const buf = new Float32Array(n)
        a.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < n; i++) sum += buf[i] * buf[i]
        return Math.sqrt(sum / n)
      }
      return 0
    } catch (_) {
      return 0
    }
  }

  setTempo(bpm, timeSignature = null) {
    if (Tone.getTransport()) {
      const internalBpm = timeSignature ? getInternalBpm(bpm, timeSignature) : bpm
      Tone.getTransport().bpm.value = internalBpm
    }
  }

  setLoopLength(bars) {
    if (Tone.getTransport()) {
      this.totalTicks = bars * Tone.getTransport().timeSignature * Tone.getTransport().PPQ
    }
  }

  setLoopEnabled(enabled, bars = 4) {
    if (!Tone.getTransport()) return
    Tone.getTransport().loop = enabled
    if (enabled) {
      const loopLength = `${bars}m`
      Tone.getTransport().loopEnd = loopLength
    }
  }

  // Set loop with exact beat duration for precise region looping
  setLoopEnabledBeats(enabled, beats) {
    if (!Tone.getTransport()) return
    Tone.getTransport().loop = enabled
    if (enabled) {
      // Convert beats to ticks for precise loop point
      const loopTicks = Math.round(beats * Tone.getTransport().PPQ)
      Tone.getTransport().loopEnd = `${loopTicks}i`
    }
  }

  // Controls MIDI volume ONLY (not the reference audio player)
  setVolume(volumeDb) {
    if (this.midiGain) {
      this.midiGain.volume.value = volumeDb
    }
  }

  async loadInstrument(instrument, config = {}) {
    this.instrumentConfigs[instrument] = config

    // Dedupe concurrent loads — a second call joins the in-flight promise.
    if (this.instrumentLoads[instrument]) return this.instrumentLoads[instrument]

    const task = this._loadInstrumentInner(instrument, config)
    this.instrumentLoads[instrument] = task
    try {
      await task
    } finally {
      delete this.instrumentLoads[instrument]
    }
  }

  _buildSynthVoice(instrument, config = {}) {
    const def = SYNTH_TYPES[instrument]
    if (!def || !this.midiGain) return null
    if (this.synths[instrument]) {
      if (config.volume !== undefined) this.synths[instrument].volume.value = config.volume
      return this.synths[instrument]
    }
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: def.oscillator,
      envelope: def.envelope,
    })
    const chorus = new Tone.Chorus(1.2, 4, 0.5).start()
    chorus.wet.value = 0.2
    chorus.connect(this.noteGain || this.midiGain)
    if (def.filter) {
      const filter = new Tone.Filter(def.filter, 'lowpass').connect(chorus)
      synth.connect(filter)
      synth.filterNode = filter
    } else {
      synth.connect(chorus)
    }
    synth.chorusNode = chorus
    synth.volume.value = config.volume !== undefined ? config.volume : def.volume
    this.synths[instrument] = synth
    return synth
  }

  async _loadInstrumentInner(instrument, config) {
    if (SYNTH_TYPES[instrument]) {
      this._buildSynthVoice(instrument, config)
      // Purely synthesized instruments (e.g. 'pad') stop here; 'synth' also
      // has a 16-zone Sonofield SF2 sample map in SampleLibrary and upgrades
      // to a Tone.Sampler once its local stereo samples finish decoding.
      if (!SampleLibrary[instrument]) {
        this.applyInstrumentConfig(instrument, config)
        return
      }
    }

    if (this.samplers[instrument]) {
      this.applyInstrumentConfig(instrument, config)
      return
    }

    const noteMap = SampleLibrary[instrument]
    if (!noteMap) {
      if (!this.missingInstruments.has(instrument)) {
        this.missingInstruments.add(instrument)
        console.warn(`[AudioEngine] No sample map for instrument: ${instrument}`)
      }
      return
    }

    if (!sampleAudioBufferCache[instrument]) {
      sampleAudioBufferCache[instrument] = new Map()
    }
    const decodedCache = sampleAudioBufferCache[instrument]
    const noteKeys = Object.keys(noteMap)
    const missingNotes = noteKeys.filter(n => !decodedCache.has(n))

    if (missingNotes.length > 0) {
      const byteCache = await this._ensureSampleBytes(instrument)
      const rawCtx = Tone.getContext()?.rawContext
      if (rawCtx) {
        for (let i = 0; i < missingNotes.length; i += DECODE_CONCURRENCY) {
          const batch = missingNotes.slice(i, i + DECODE_CONCURRENCY)
          await Promise.all(batch.map(async (note) => {
            if (decodedCache.has(note)) return
            const arrayBuffer = byteCache.get(note)
            if (!arrayBuffer) return
            try {
              const decoded = await rawCtx.decodeAudioData(arrayBuffer.slice(0))
              decodedCache.set(note, decoded)
            } catch (e) {
              console.warn(`[AudioEngine] Failed to decode ${instrument}/${note}:`, e.message)
            }
          }))
        }
      }
    }

    const decodedUrls = {}
    for (const note of noteKeys) {
      const buf = decodedCache.get(note)
      if (buf) decodedUrls[note] = buf
    }

    if (Object.keys(decodedUrls).length === 0) {
      this.applyInstrumentConfig(instrument, config)
      return
    }

    if (!this.midiGain) return

    // Create sampler from pre-decoded AudioBuffers — synchronous, zero network
    const sampler = new Tone.Sampler({
      urls: decodedUrls,
      attack: config.attack ?? INSTRUMENT_CONFIGS[instrument]?.attack ?? 0.005,
      release: config.release ?? INSTRUMENT_CONFIGS[instrument]?.release ?? 0.3,
    })
    if (instrument === 'synth') {
      // Sonofield Preset 1 'Synth' global zone: chorusSend = 200 (20% wet)
      const chorus = new Tone.Chorus(1.2, 4, 0.5).start()
      chorus.wet.value = 0.2
      chorus.connect(this.noteGain || this.midiGain)
      sampler.connect(chorus)
      sampler.chorusNode = chorus
      if (!this._loggedSonofieldSynth) {
        this._loggedSonofieldSynth = true
        console.info('[audio] synth: Sonofield SF2 stereo multisamples loaded')
      }
    } else {
      sampler.connect(this.noteGain || this.midiGain)
    }
    this.samplers[instrument] = sampler
    this.applyInstrumentConfig(instrument, config)
  }

  // Fetch (but don't decode) an instrument's samples into the module-level
  // ArrayBuffer cache + SW cache. Deduped per instrument.
  _ensureSampleBytes(instrument) {
    const noteMap = SampleLibrary[instrument]
    if (!noteMap) return Promise.resolve(new Map())
    if (this._byteWarmups[instrument]) return this._byteWarmups[instrument]
    const task = this._ensureSampleBytesInner(instrument, noteMap)
    this._byteWarmups[instrument] = task
    return task.finally(() => { delete this._byteWarmups[instrument] })
  }

  async _ensureSampleBytesInner(instrument, noteMap) {
    if (!sampleArrayBufferCache[instrument]) {
      sampleArrayBufferCache[instrument] = new Map()
    }
    const cache = sampleArrayBufferCache[instrument]
    const uncached = Object.keys(noteMap).filter((note) => !cache.has(note))
    const baseUrl = instrument === 'synth'
      ? SONOFIELD_SYNTH_BASE_URL
      : SAMPLE_BASE_URL + instrument + '/'

    if (uncached.length > 0) {
      for (let i = 0; i < uncached.length; i += FETCH_CONCURRENCY) {
        const batch = uncached.slice(i, i + FETCH_CONCURRENCY)
        await Promise.all(batch.map(async (note) => {
          if (cache.has(note)) return
          const url = baseUrl + noteMap[note]
          try {
            const response = await fetchWithTimeout(url)
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const ct = response.headers?.get?.('content-type') || ''
            if (ct.includes('text/html')) throw new Error('SPA HTML fallback')
            const buffer = await response.arrayBuffer()
            cache.set(note, buffer)
          } catch (e) {
            console.warn(`[AudioEngine] Failed to fetch ${instrument}/${note}:`, e.message)
          }
        }))
      }
    }
    return cache
  }

  // Fire-and-forget sample warmup for a configured instrument.
  prefetchInstrumentBytes(instrument) {
    if (!SampleLibrary[instrument]) return
    this._ensureSampleBytes(instrument).catch(() => {})
  }

  ensureInstrumentBytes(instrument) {
    return this._ensureSampleBytes(instrument)
  }

  applyInstrumentConfig(instrument, config = {}) {
    const synth = this.synths[instrument]
    if (synth && config.volume !== undefined) {
      synth.volume.value = config.volume
    }

    const sampler = this.samplers[instrument]
    if (!sampler) return

    if (config.volume !== undefined) {
      sampler.volume.value = config.volume
    }
    if (config.attack !== undefined) {
      sampler.attack = config.attack
    }
    if (config.release !== undefined) {
      sampler.release = config.release
    }
  }

  setInstrumentConfig(instrument, config = {}) {
    this.instrumentConfigs[instrument] = config
    this.applyInstrumentConfig(instrument, config)
    this.prefetchInstrumentBytes(instrument)
  }

  /**
   * Restore the noteGain bus to unity before starting playback or auditioning
   * a note (silenceNotes() ramps it to 0 on pause/stop so queued lookahead
   * notes cannot bleed through after the user taps Pause).
   */
  unmuteNotes() {
    if (!this.noteGain) return
    try {
      const now = Tone.immediate()
      this.noteGain.gain.cancelScheduledValues(now)
      this.noteGain.gain.setValueAtTime(1, now)
    } catch (_) {}
  }

  /**
   * Immediately silence all melodic/harmonic note instruments (without
   * touching the tonic drone on midiGain). Ramps noteGain to 0 over 10ms
   * starting at Tone.immediate() (not Tone.now(), which is +100ms lookAhead!),
   * stops all active/queued Tone.Sampler buffer sources, and resets
   * Tone.PolySynth instances so internal context.setTimeout future attacks
   * from the lookahead window are aborted (`this.disposed === true`).
   */
  silenceNotes() {
    const now = Tone.immediate()
    if (this.noteGain) {
      try {
        this.noteGain.gain.cancelScheduledValues(now)
        this.noteGain.gain.setTargetAtTime(0, now, 0.004)
      } catch (_) {}
    }
    for (const sampler of Object.values(this.samplers)) {
      try { sampler.releaseAll?.(now) } catch (_) {}
      // Also stop any sources still tracked in _activeSources
      try {
        sampler._activeSources?.forEach((sources) => {
          while (sources.length) {
            const src = sources.shift()
            try { src.stop(now) } catch (_) {}
            try { src._source?.disconnect?.() } catch (_) {}
          }
        })
      } catch (_) {}
    }
    // PolySynth schedules future attacks via context.setTimeout and only
    // skips them when `this.disposed` is true — recreate active PolySynths
    // in place (<0.2ms, zero sample decoding) so queued future attacks
    // cannot fire after pause/stop.
    const synthEntries = Object.entries(this.synths)
    if (synthEntries.length && this.midiGain) {
      this.synths = {}
      for (const [name, oldSynth] of synthEntries) {
        try { oldSynth.releaseAll?.(now) } catch (_) {}
        setTimeout(() => {
          try { oldSynth.filterNode?.dispose() } catch (_) {}
          try { oldSynth.chorusNode?.dispose() } catch (_) {}
          try { oldSynth.dispose() } catch (_) {}
        }, 40)
        this._buildSynthVoice(name, this.instrumentConfigs[name] || INSTRUMENT_CONFIGS[name] || {})
      }
    }
  }

  async start(startBeat = 0) {
    if (!this.isInitialized) await this.initialize()
    
    const contextStarted = await this.startAudioContext()
    if (!contextStarted) throw new Error('Audio context could not be started')

    this.unmuteNotes()
    Tone.getTransport().position = `${Math.round(startBeat * Tone.getTransport().PPQ)}i`
    Tone.getTransport().start()
    this.lastActiveAt = Date.now()
    
    this.startPositionTracking()
    this.startLookAheadScheduler()
  }

  stop() {
    this.stopPositionTracking()
    this.stopLookAheadScheduler()
    try { this.silenceNotes() } catch (_) {}
    try { this.killAllActiveNotes() } catch (_) {}
    try { this.stopAllLiveNotes() } catch (_) {}
    try { this.stopDrone() } catch (_) {}
    try { Tone.getTransport().stop() } catch (_) {}
    try { Tone.getTransport().position = 0 } catch (_) {}
    this.cursorPosition = 0
    if (this.onCursorUpdate) this.onCursorUpdate(0)
  }

  pause({ releaseActiveNotes = true } = {}) {
    this.stopPositionTracking()
    this.stopLookAheadScheduler()
    try { this.silenceNotes() } catch (_) {}
    if (releaseActiveNotes) {
      try { this.killAllActiveNotes() } catch (_) {}
    }
    try { Tone.getTransport().pause() } catch (_) {}
  }

  startPositionTracking = () => {
    this.stopPositionTracking()
    let lastUpdate = 0
    const throttleMs = 16
    
    const updateLoop = (timestamp) => {
      if (Tone.getTransport().state === 'started' && this.totalTicks > 0) {
        if (timestamp - lastUpdate >= throttleMs) {
          let progress = Tone.getTransport().ticks / this.totalTicks
          
          if (progress > 1) progress = 1
          
          this.cursorPosition = progress
          if (this.onCursorUpdate) this.onCursorUpdate(progress)
          lastUpdate = timestamp
        }
      }
      this.animationFrameId = requestAnimationFrame(updateLoop)
    }
    
    this.animationFrameId = requestAnimationFrame(updateLoop)
  }

  stopPositionTracking() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  // Resolve an instrument name to a playable node: loaded sampler (including
  // the Sonofield 'synth' sampler) → own synth → default 'synth' → 'piano'.
  getPlayer(instrument) {
    const player = this.samplers[instrument] || this.synths[instrument]
    if (player) return player
    const fallback = this.samplers['synth'] || this.synths['synth'] || this.samplers['piano'] || null
    // Surface silent substitutions — a missing map used to masquerade as synth.
    if (fallback && !this.missingInstruments.has(instrument)) {
      this.missingInstruments.add(instrument)
      console.warn(`[AudioEngine] No player for '${instrument}' — falling back to default`)
    }
    return fallback
  }

  async playNote(noteName, duration = '8n', instrument = 'piano') {
    try {
      await this.ensureActive({ loadDefaultPiano: false })

      // Reload instrument if it was lost during a context rebuild
      if (!this.synths[instrument] && !this.samplers[instrument] && this.instrumentConfigs[instrument]) {
        await this.loadInstrument(instrument, this.instrumentConfigs[instrument])
      }

      this.unmuteNotes()
      const player = this.getPlayer(instrument)
      if (player) {
        player.triggerAttackRelease(noteName, duration, Tone.now(), 0.8)
      }
    } catch (error) {
      console.warn('Failed to play note:', error)
    }
  }

  scheduleNotes(notes, timeDivision, bars = 4, instrument = 'piano', trackVolume = 0) {
    const beatsPerBar = Tone.getTransport().timeSignature
    const ppq = Tone.getTransport().PPQ
    
    this.totalTicks = bars * beatsPerBar * ppq
    
    if (notes.length === 0) {
      console.log('[AudioEngine.scheduleNotes] No notes to schedule, returning early')
      return
    }

    // Store notes for look-ahead scheduling
    // CRITICAL: Sort by start time so notes are scheduled in chronological order
    // Each note can have its own instrument and volume settings
    this.allNotes = notes
      .map(noteData => {
        // Use per-note instrument/volume if provided, otherwise use defaults
        const noteInstrument = noteData.instrument || instrument
        const noteVolume = noteData.volume !== undefined ? noteData.volume : trackVolume
        
        let instrumentObj = this.getPlayer(noteInstrument)
        if (!instrumentObj) {
          console.warn(`[AudioEngine] Instrument ${noteInstrument} not loaded`)
        }
        
        const volumeMultiplier = Math.pow(10, noteVolume / 20)
        
        return {
          ...noteData,
          instrument: instrumentObj,
          volumeMultiplier,
          ppq
        }
      })
      .filter(noteData => noteData.instrument)
      .sort((a, b) => a.start - b.start)  // Sort by start time ascending
    this.currentNoteIndex = 0

    // Initial batch schedule (will be supplemented by look-ahead scheduler)
    this.scheduleLookAheadBatch()
  }

  scheduleLookAheadBatch() {
    if (this.allNotes.length === 0) return
    
    const currentTime = Tone.getTransport().seconds
    const ppq = Tone.getTransport().PPQ
    const tempo = Tone.getTransport().bpm.value
    const secondsPerBeat = 60 / tempo
    
    // Schedule notes within look-ahead window
    while (this.currentNoteIndex < this.allNotes.length) {
      const noteData = this.allNotes[this.currentNoteIndex]
      const noteStartSeconds = noteData.start * secondsPerBeat
      
      // If note is beyond look-ahead window, stop scheduling
      if (noteStartSeconds > currentTime + this.lookAheadWindow) {
        break
      }
      
      const startBeat = noteData.start
      const durationBeats = noteData.duration
      const startTick = Math.round(startBeat * ppq)
      const durationTicks = Math.round(durationBeats * ppq)
      const baseVelocity = noteData.velocity !== undefined ? noteData.velocity : 0.8
      const finalVelocity = Math.min(Math.max(baseVelocity * noteData.volumeMultiplier, 0), 1)
      
      const eventId = Tone.getTransport().schedule((time) => {
        noteData.instrument.triggerAttackRelease(
          noteData.note,
          durationTicks + "i",
          time,
          finalVelocity
        )
        // Track active note for cleanup (released wholesale by
        // killAllActiveNotes — no per-note setTimeout, which was pure churn)
        this.activeNotes.push({ instrument: noteData.instrument, note: noteData.note })
      }, startTick + "i")
      
      this.scheduledEvents.push({ id: eventId, tick: startTick })
      this.currentNoteIndex++
    }
  }

  startLookAheadScheduler() {
    this.stopLookAheadScheduler()
    
    // Run scheduler every 250ms to keep scheduling ahead
    this.schedulerIntervalId = setInterval(() => {
      if (Tone.getTransport().state === 'started') {
        this.scheduleLookAheadBatch()
        this.cleanupPassedEvents()
      }
    }, 250)
  }

  stopLookAheadScheduler() {
    if (this.schedulerIntervalId) {
      clearInterval(this.schedulerIntervalId)
      this.schedulerIntervalId = null
    }
  }

  cleanupPassedEvents() {
    const currentTick = Tone.getTransport().ticks
    
    // Remove events that have already been triggered
    this.scheduledEvents = this.scheduledEvents.filter(event => {
      if (event.tick < currentTick - 1000) { // 1000 tick buffer
        Tone.getTransport().clear(event.id)
        return false
      }
      return true
    })
  }

  killAllActiveNotes() {
    // Immediately release all currently playing notes
    this.activeNotes.forEach(activeNote => {
      try {
        if (activeNote.instrument && activeNote.instrument.releaseAll) {
          activeNote.instrument.releaseAll()
        }
      } catch (e) {
        // Ignore errors from already released notes
      }
    })
    this.activeNotes = []
  }

  clearScheduledNotes() {
    // CRITICAL: Stop the look-ahead scheduler FIRST to prevent it from scheduling more notes
    this.stopLookAheadScheduler()

    if (this.stopEventId !== null) {
      try { Tone.getTransport().clear(this.stopEventId) } catch (_) {}
      this.stopEventId = null
    }

    this.scheduledEvents.forEach((event) => {
      try { Tone.getTransport().clear(event.id || event) } catch (_) {}
    })
    this.scheduledEvents = []
    this.allNotes = []
    this.currentNoteIndex = 0
    this.killAllActiveNotes()
  }

  scheduleStopEvent(bars = 4) {
    if (!Tone.getTransport()) return
    const stopTime = `${bars}m`
    if (this.stopEventId !== null) {
      Tone.getTransport().clear(this.stopEventId)
    }
    this.stopEventId = Tone.getTransport().schedule((time) => {
      this.stop()
      if (this.onPlaybackComplete) this.onPlaybackComplete()
    }, stopTime)
  }

  // Stop after an exact duration in seconds from transport position 0.
  scheduleStopAtSeconds(durationSeconds) {
    if (!Tone.getTransport()) return
    if (this.stopEventId !== null) {
      Tone.getTransport().clear(this.stopEventId)
    }
    this.stopEventId = Tone.getTransport().schedule((time) => {
      this.stop()
      if (this.onPlaybackComplete) this.onPlaybackComplete()
    }, `${durationSeconds}`)
  }

  // Stop after an exact number of beats from transport position 0.
  // Schedules in ticks so the stop fires at the correct wall-clock time
  // regardless of the current BPM (i.e. tempo * playbackSpeed).
  scheduleStopAtBeats(beats) {
    if (!Tone.getTransport()) return
    if (this.stopEventId !== null) {
      Tone.getTransport().clear(this.stopEventId)
    }
    const ticks = Math.round(beats * Tone.getTransport().PPQ)
    this.stopEventId = Tone.getTransport().schedule((time) => {
      this.stop()
      if (this.onPlaybackComplete) this.onPlaybackComplete()
    }, `${ticks}i`)
  }

  // ─── Drone ────────────────────────────────────────────────────────────────

  /**
   * Fetch + decode the real Sonofield stereo drone loop for `tonic`
   * (/samples/sonofield-drone/<stem>.mp3). Cached at module level as both
   * ArrayBuffer and AudioBuffer so context rebuilds and repeat visits are
   * synchronous (0ms).
   */
  ensureDroneBuffer(tonic) {
    const stem = tonicToDroneStem(tonic)
    const cached = droneAudioBufferCache.get(stem)
    if (cached) return Promise.resolve(cached)
    const inflight = droneLoadPromises.get(stem)
    if (inflight) return inflight

    const task = (async () => {
      try {
        let ab = droneArrayBufferCache.get(stem)
        if (!ab) {
          const url = `${SONOFIELD_DRONE_BASE_URL}${stem}.mp3`
          const res = await fetchWithTimeout(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const ct = res.headers?.get?.('content-type') || ''
          if (ct.includes('text/html')) throw new Error('SPA HTML fallback')
          ab = await res.arrayBuffer()
          droneArrayBufferCache.set(stem, ab)
        }
        const rawCtx = Tone.getContext()?.rawContext
        if (!rawCtx) return null
        const decoded = await rawCtx.decodeAudioData(ab.slice(0))
        droneAudioBufferCache.set(stem, decoded)
        return decoded
      } catch (_) {
        return null
      } finally {
        droneLoadPromises.delete(stem)
      }
    })()

    droneLoadPromises.set(stem, task)
    return task
  }

  /** Warm a tonic's Sonofield drone loop in the background (called at section load). */
  prefetchDrone(tonic) {
    if (!tonic) return
    this.ensureDroneBuffer(tonic).catch(() => {})
  }

  /**
   * Start the tonic drone across regionBeats.
   *
   * Primary path: real Sonofield SF2 stereo drone sample for the tonic
   * (/samples/sonofield-drone/<stem>.mp3), looped seamlessly inside its
   * pre-crossfaded [0.1s .. 14.1s] window with a smooth ~0.5s attack swell.
   * If already decoded in droneAudioBufferCache, starts synchronously in 0ms.
   * Fallback path: offline-baked loop (droneBaker) → 4-layer synth pad.
   */
  scheduleDroneNotes(tonic, regionBeats, volumeDb = 0) {
    this.stopDrone()

    const stem = tonicToDroneStem(tonic)
    const epoch = ++this._droneEpoch

    // Fast synchronous path when the tonic's Sonofield drone is already cached
    const cached = droneAudioBufferCache.get(stem)
    if (cached && this.midiGain) {
      this._startSonofieldDrone(cached, volumeDb)
      return
    }

    const midi = tonicToMidi(tonic, 2)
    const freq = 440 * Math.pow(2, (midi - 69) / 12)
    const band = droneBandIndex(freq)
    const sr = Tone.getContext()?.rawContext?.sampleRate || 44100

    this.ensureDroneBuffer(tonic).then((buffer) => {
      if (epoch !== this._droneEpoch || !this.midiGain) return
      if (buffer) {
        this._startSonofieldDrone(buffer, volumeDb)
        return
      }
      return droneLoopPromise(band, sr).then((baked) => {
        if (epoch !== this._droneEpoch || !this.midiGain) return
        if (baked) {
          this._startDroneLoop(baked, freq, band, volumeDb)
        } else {
          this._scheduleDroneSynthFallback(tonic, regionBeats, volumeDb)
        }
      })
    }).catch(() => {
      if (epoch === this._droneEpoch && this.midiGain) {
        this._scheduleDroneSynthFallback(tonic, regionBeats, volumeDb)
      }
    })
  }

  _startSonofieldDrone(buffer, volumeDb) {
    const src = new Tone.ToneBufferSource(buffer)
    src.loop = true
    if (buffer.duration > 2) {
      src.loopStart = 0.1
      src.loopEnd = Math.min(buffer.duration - 0.1, 14.1)
    }
    const g = new Tone.Gain(0).connect(this.midiGain)
    g.gain.setTargetAtTime(Math.pow(10, (volumeDb + 2) / 20), Tone.now(), 0.15)
    src.connect(g)
    src.start()
    this.droneSources.push(src)
    this.droneGains.push(g)
    if (!this._loggedSonofieldDrone) {
      this._loggedSonofieldDrone = true
      console.info('[audio] drone: Sonofield SF2 stereo sample loop')
    }
  }

  // Looped buffer → Tone.Gain → midiGain. Level sits ~3dB OVER the voice
  // bus offset (volumeDb +3dB): the baked texture already carries the octave /
  // fifth / shimmer partials the 4-layer synth stack used to add, and a sine
  // bed reads far quieter than a pitched voice at equal RMS. The gain swells
  // in (τ≈0.15s → ~0.45s to settle) instead of bumping on at full level —
  // the paused-drone handoff and mid-song key changes stay seamless.
  _startDroneLoop(buffer, freq, band, volumeDb) {
    const src = new Tone.ToneBufferSource(buffer)
    src.loop = true
    src.playbackRate.value = freq / droneBandRef(band)
    const g = new Tone.Gain(0).connect(this.midiGain)
    g.gain.setTargetAtTime(Math.pow(10, (volumeDb + 3) / 20), Tone.now(), 0.15)
    src.connect(g)
    src.start()
    this.droneSources.push(src)
    this.droneGains.push(g)
    if (!this._loggedBakedDrone) {
      this._loggedBakedDrone = true
      console.info('[audio] drone: baked loop')
    }
  }

  // Legacy 4-layer pad — kept as the fallback when OfflineAudioContext is
  // unavailable or the bake fails.
  _scheduleDroneSynthFallback(tonic, regionBeats, volumeDb = 0) {
    if (!this._warnedDroneFallback) {
      this._warnedDroneFallback = true
      console.warn('[audio] drone: baked loop unavailable — legacy synth fallback')
    }
    const fundamental = tonicToMidi(tonic, 2)           // e.g. A2 = 45
    const octave      = fundamental + 12                 // A3
    const fifth       = fundamental + 19                 // E3 (perfect 5th above A2)
    const highOctave  = fundamental + 24                 // A4

    // Layer config: [midiNote, gainDb, lfoFreqHz, lfoDepth (0-1 of gain), oscillatorType]
    const layers = [
      { midi: fundamental, gainDb: volumeDb - 3,  lfoHz: 0.07,  lfoDepth: 0.001, type: 'sine'     },
      { midi: octave,      gainDb: volumeDb - 7,  lfoHz: 0.09,  lfoDepth: 0.001, type: 'sine'     },
      { midi: fifth,       gainDb: volumeDb - 6,  lfoHz: 0.05,  lfoDepth: 0.001, type: 'triangle' },
      { midi: highOctave,  gainDb: volumeDb - 14, lfoHz: 0.08,  lfoDepth: 0.001, type: 'sine'     },
    ]

    const ppq   = Tone.getTransport().PPQ
    const ticks = Math.round(regionBeats * ppq)
    // Duration string in ticks — covers the full region
    const durTicks = ticks + 'i'

    for (const layer of layers) {
      const noteName = midiToNoteName(layer.midi)
      const baseGain = Math.pow(10, layer.gainDb / 20)

      // Slow tremolo LFO on a dedicated gain node — tracked so stopDrone
      // can dispose it; otherwise every drone start leaks nodes on midiGain.
      const lfoGain = new Tone.Gain(baseGain).connect(this.midiGain)
      this.droneGains.push(lfoGain)

      const lfo = new Tone.LFO({
        frequency: layer.lfoHz,
        min: baseGain * (1 - layer.lfoDepth),
        max: baseGain * (1 + layer.lfoDepth),
        type: 'sine',
      })
      lfo.connect(lfoGain.gain)
      lfo.start()
      this.droneLfos.push(lfo)

      // Rich pad synth: detuned oscillators + long attack/release
      const synth = new Tone.Synth({
        oscillator: {
          type: 'fatsine',
          count: 2,
          spread: 3,
        },
        envelope: {
          attack:  0.1,
          decay:   0.5,
          sustain: 0.9,
          release: 2.0,
        },
      }).connect(lfoGain)

      synth.triggerAttack(noteName, Tone.now(), 0.9)

      this.droneSynths.push(synth)
    }
  }

  stopDrone() {
    this._droneEpoch++ // abort any in-flight loop render/attach

    // Clear scheduled Transport events
    for (const id of this.droneScheduledEvents) {
      try { Tone.getTransport().clear(id) } catch (_) {}
    }
    this.droneScheduledEvents = []

    // Stop and dispose LFOs
    for (const lfo of this.droneLfos) {
      try { lfo.stop(); lfo.dispose() } catch (_) {}
    }
    this.droneLfos = []

    // Release and dispose synths
    for (const s of this.droneSynths) {
      try { s.triggerRelease(); s.dispose() } catch (_) {}
    }
    this.droneSynths = []

    // Short release ramp on the per-drone gains (~0.25s) so loop sources
    // and pad layers stop without a click; dispose is deferred so the tail
    // can actually play out.
    const now = Tone.now()
    const retiringSources = this.droneSources.splice(0)
    const retiringGains = this.droneGains.splice(0)
    for (const g of retiringGains) {
      try { g.gain.setTargetAtTime(0, now, 0.08) } catch (_) {}
    }
    for (const s of retiringSources) {
      try { s.stop(now + 0.3) } catch (_) {}
    }
    if (retiringSources.length || retiringGains.length) {
      setTimeout(() => {
        for (const s of retiringSources) { try { s.dispose() } catch (_) {} }
        for (const g of retiringGains) { try { g.dispose() } catch (_) {} }
      }, 500)
    }
  }

  dispose() {
    try { this.clearScheduledNotes() } catch (_) {}
    try { this.stopDrone() } catch (_) {}
    this.stopPositionTracking()
    this.stopLookAheadScheduler()
    try { this.killAllActiveNotes() } catch (_) {}
    // Clean up any live MIDI notes
    this.liveMidiNotes = {}
    Object.values(this.samplers).forEach(sampler => {
      try { sampler.chorusNode?.dispose() } catch (_) {}
      try { sampler.dispose() } catch (_) {}
    })
    Object.values(this.synths).forEach(synth => {
      try { synth.filterNode?.dispose() } catch (_) {}
      try { synth.chorusNode?.dispose() } catch (_) {}
      try { synth.dispose() } catch (_) {}
    })
    this.samplers = {}
    this.synths = {}
    for (const key of ['fxCompressor', 'fxLimiter', 'fxReverbSend', 'fxReverb', 'outputAnalyser']) {
      try { this[key]?.dispose() } catch (_) {}
      this[key] = null
    }
    if (this.noteGain) {
      try { this.noteGain.dispose() } catch (_) {}
      this.noteGain = null
    }
    if (this.midiGain) {
      try { this.midiGain.dispose() } catch (_) {}
      this.midiGain = null
    }
    if (this.silentSource) {
      try { this.silentSource.stop() } catch (_) {}
      try { this.silentSource.disconnect() } catch (_) {}
      this.silentSource = null
    }
    if (this.silentKeepalive) {
      try { this.silentKeepalive.disconnect() } catch (_) {}
      this.silentKeepalive = null
    }
    try { Tone.getTransport().stop() } catch (_) {}
    this.stopKeepalive()
    this.rawContext = null
    this.lastActiveAt = Date.now()
    this.isInitialized = false
  }
}

export const audioEngine = new AudioEngine()
export default audioEngine

if (typeof window !== 'undefined') window.audioEngine = audioEngine
