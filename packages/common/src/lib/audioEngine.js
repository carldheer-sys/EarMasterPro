import * as Tone from 'tone'
import SampleLibrary from './Tonejs-Instruments'
import { getInternalBpm } from './midiUtils'

// MIDI note number → note name (middle C = C4 = 60)
const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1
  return MIDI_NOTE_NAMES[midi % 12] + octave
}

// Tonic name → MIDI note number at octave 2
function tonicToMidi(tonic, octave = 2) {
  const idx = MIDI_NOTE_NAMES.indexOf(tonic)
  if (idx === -1) return 45 // fallback A2
  return (octave + 1) * 12 + idx
}

class AudioEngine {
  constructor() {
    this.samplers = {}
    this.synths = {}
    this.midiGain = null  // Tone.Volume node for MIDI-only volume control
    this.isInitialized = false
    this.cursorPosition = 0
    this.onCursorUpdate = null
    this.onPlaybackComplete = null
    this.scheduledEvents = []
    this.stopEventId = null
    this.animationFrameId = null
    this.totalTicks = 0
    this.instrumentConfigs = {}
    
    // Look-ahead scheduling
    this.lookAheadWindow = 1.0 // seconds (1000ms)
    this.schedulerIntervalId = null
    this.allNotes = [] // Full note list for look-ahead scheduling
    this.currentNoteIndex = 0 // Track which notes have been scheduled
    this.activeNotes = [] // Track currently playing notes for cleanup

    // Drone synth layers
    this.droneSynths = []
    this.droneLfos = []
    this.droneScheduledEvents = []
    
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
    if (!this.isInitialized) return
    
    try {
      const noteId = `${noteName}_${instrument}`
      
      // Stop any existing note with same name/instrument
      if (this.liveMidiNotes[noteId]) {
        this.stopNote(noteName, instrument)
      }
      
      const normalizedVelocity = Math.max(0, Math.min(1, velocity / 127))
      
      if (instrument === 'synth') {
        const synth = this.synths['synth']
        if (synth) {
          synth.triggerAttack(noteName, Tone.now(), normalizedVelocity)
          this.liveMidiNotes[noteId] = { synth, instrument }
        }
      } else {
        const sampler = this.samplers[instrument] || this.samplers['piano']
        if (sampler) {
          sampler.triggerAttack(noteName, Tone.now(), normalizedVelocity)
          this.liveMidiNotes[noteId] = { sampler, instrument }
        }
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
        if (liveNote.synth) {
          liveNote.synth.triggerRelease(Tone.now())
        } else if (liveNote.sampler) {
          liveNote.sampler.triggerRelease(noteName, Tone.now())
        }
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
      const liveNote = this.liveMidiNotes[noteId]
      try {
        if (liveNote.synth) {
          liveNote.synth.triggerRelease(Tone.now())
        } else if (liveNote.sampler) {
          // For samplers, we need to release all active voices
          liveNote.sampler.releaseAll(Tone.now())
        }
      } catch (error) {
        // Ignore errors from already released notes
      }
    })
    this.liveMidiNotes = {}
  }

  async initialize(options = {}) {
    if (this.isInitialized) return

    try {
      // Set latencyHint to 'playback' for stability with large MIDI sequences
      if (!Tone.context._initialized) {
        await Tone.setContext(new Tone.Context({ latencyHint: 'playback' }))
      }
      
      Tone.context.lookAhead = 0.05

      // MIDI-only gain node. All samplers/synths connect here → Destination.
      // refAudioPlayer connects directly to Destination, so setVolume()
      // on this node only affects MIDI, never the audio reference track.
      this.midiGain = new Tone.Volume(0).toDestination()

      if (options.loadDefaultPiano !== false) {
        await this.loadInstrument('piano', { attack: 0.02, release: 1, volume: -6 })
      }

      Tone.Transport.bpm.value = 120
      Tone.Transport.timeSignature = 4
      Tone.Transport.loop = false

      this.isInitialized = true
      console.log('Audio engine initialized with playback latency hint')
    } catch (error) {
      console.error('Failed to initialize audio engine:', error)
      throw error
    }
  }

  async startAudioContext() {
    if (!this.isInitialized) {
      await this.initialize()
    }
    
    try {
      if (Tone.context.state !== 'running') {
        await Tone.start()
        console.log('Audio context started')
      }
      return true
    } catch (error) {
      console.error('Failed to start audio context:', error)
      return false
    }
  }

  setTempo(bpm, timeSignature = null) {
    if (Tone.Transport) {
      const internalBpm = timeSignature ? getInternalBpm(bpm, timeSignature) : bpm
      Tone.Transport.bpm.value = internalBpm
      console.log(`[AudioEngine] Set tempo: project BPM = ${bpm}, internal BPM = ${internalBpm}`)
    }
  }

  setLoopLength(bars) {
    if (Tone.Transport) {
      this.totalTicks = bars * Tone.Transport.timeSignature * Tone.Transport.PPQ
    }
  }

  setLoopEnabled(enabled, bars = 4) {
    if (!Tone.Transport) return
    Tone.Transport.loop = enabled
    if (enabled) {
      const loopLength = `${bars}m`
      Tone.Transport.loopEnd = loopLength
    }
  }

  // Set loop with exact beat duration for precise region looping
  setLoopEnabledBeats(enabled, beats) {
    if (!Tone.Transport) return
    Tone.Transport.loop = enabled
    if (enabled) {
      // Convert beats to ticks for precise loop point
      const loopTicks = Math.round(beats * Tone.Transport.PPQ)
      Tone.Transport.loopEnd = `${loopTicks}i`
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
    
    if (instrument === 'synth') {
      if (this.synths['synth']) {
        this.applyInstrumentConfig(instrument, config)
        return Promise.resolve()
      }
      
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: {
          attack: 0.005,
          decay: 0.1,
          sustain: 0.4,
          release: 1
        }
      }).connect(this.midiGain)
      
      synth.volume.value = config.volume !== undefined ? config.volume : -6
      this.synths['synth'] = synth
      return Promise.resolve()
    }
    
    if (this.samplers[instrument]) {
      this.applyInstrumentConfig(instrument, config)
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const sampler = SampleLibrary.load({
        instruments: instrument,
        baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/',
        onload: () => {
          sampler.connect(this.midiGain)
          this.samplers[instrument] = sampler
          this.applyInstrumentConfig(instrument, config)
          resolve()
        }
      })
    })
  }

  applyInstrumentConfig(instrument, config = {}) {
    if (instrument === 'synth') {
      const synth = this.synths['synth']
      if (!synth) return
      if (config.volume !== undefined) {
        synth.volume.value = config.volume
      }
      return
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
  }

  async start(startBeat = 0) {
    if (!this.isInitialized) await this.initialize()
    
    await this.startAudioContext()
    
    console.log('[AudioEngine] start() called, allNotes.length:', this.allNotes.length)
    
    Tone.Transport.position = `${Math.round(startBeat * Tone.Transport.PPQ)}i`
    Tone.Transport.start()
    
    this.startPositionTracking()
    this.startLookAheadScheduler()
  }

  stop() {
    this.stopPositionTracking()
    this.stopLookAheadScheduler()
    try { this.killAllActiveNotes() } catch (_) {}
    try { this.stopDrone() } catch (_) {}
    try { Tone.Transport.stop() } catch (_) {}
    try { Tone.Transport.position = 0 } catch (_) {}
    this.cursorPosition = 0
    if (this.onCursorUpdate) this.onCursorUpdate(0)
  }

  pause({ releaseActiveNotes = true } = {}) {
    this.stopPositionTracking()
    this.stopLookAheadScheduler()
    if (releaseActiveNotes) {
      try { this.killAllActiveNotes() } catch (_) {}
    }
    try { Tone.Transport.pause() } catch (_) {}
  }

  startPositionTracking = () => {
    this.stopPositionTracking()
    let lastUpdate = 0
    const throttleMs = 16
    
    const updateLoop = (timestamp) => {
      if (Tone.Transport.state === 'started' && this.totalTicks > 0) {
        if (timestamp - lastUpdate >= throttleMs) {
          let progress = Tone.Transport.ticks / this.totalTicks
          
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

  async playNote(noteName, duration = '8n', instrument = 'piano') {
    if (!this.isInitialized) return
    
    try {
      await this.startAudioContext()
      
      if (instrument === 'synth') {
        const synth = this.synths['synth']
        if (synth) {
          synth.triggerAttackRelease(noteName, duration, Tone.now(), 0.8)
        }
        return
      }
      
      const sampler = this.samplers[instrument] || this.samplers['piano']
      if (sampler) {
        sampler.triggerAttackRelease(noteName, duration, Tone.now(), 0.8)
      }
    } catch (error) {
      console.warn('Failed to play note:', error)
    }
  }

  scheduleNotes(notes, timeDivision, bars = 4, instrument = 'piano', trackVolume = 0) {
    console.log('[AudioEngine.scheduleNotes] Called with', notes.length, 'notes')
    console.log('[AudioEngine.scheduleNotes] First 3 notes:', notes.slice(0, 3).map(n => ({ id: n.id, note: n.note, start: n.start })))
    
    const beatsPerBar = Tone.Transport.timeSignature
    const ppq = Tone.Transport.PPQ
    
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
        
        let instrumentObj
        if (noteInstrument === 'synth') {
          instrumentObj = this.synths['synth']
        } else {
          instrumentObj = this.samplers[noteInstrument] || this.samplers['piano']
        }
        
        if (!instrumentObj) {
          console.warn(`[AudioEngine] Instrument ${noteInstrument} not found, using piano`)
          instrumentObj = this.samplers['piano']
          if (!instrumentObj) instrumentObj = this.synths['synth']
        }
        
        const volumeMultiplier = Math.pow(10, noteVolume / 20)
        
        return {
          ...noteData,
          instrument: instrumentObj,
          volumeMultiplier,
          ppq
        }
      })
      .sort((a, b) => a.start - b.start)  // Sort by start time ascending
    this.currentNoteIndex = 0
    
    console.log('[AudioEngine.scheduleNotes] Stored and sorted', this.allNotes.length, 'notes')
    
    // Initial batch schedule (will be supplemented by look-ahead scheduler)
    this.scheduleLookAheadBatch()
  }

  scheduleLookAheadBatch() {
    if (this.allNotes.length === 0) return
    
    const currentTime = Tone.Transport.seconds
    const ppq = Tone.Transport.PPQ
    const tempo = Tone.Transport.bpm.value
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
      
      const eventId = Tone.Transport.schedule((time) => {
        noteData.instrument.triggerAttackRelease(
          noteData.note,
          durationTicks + "i",
          time,
          finalVelocity
        )
        
        // Track active note for cleanup
        const activeNote = { instrument: noteData.instrument, note: noteData.note }
        this.activeNotes.push(activeNote)
        
        // Auto-dispose after note finishes
        const durationSeconds = durationBeats * secondsPerBeat
        setTimeout(() => {
          const index = this.activeNotes.indexOf(activeNote)
          if (index > -1) this.activeNotes.splice(index, 1)
        }, durationSeconds * 1000)
      }, startTick + "i")
      
      this.scheduledEvents.push({ id: eventId, tick: startTick })
      this.currentNoteIndex++
    }
  }

  startLookAheadScheduler() {
    this.stopLookAheadScheduler()
    
    // Run scheduler every 250ms to keep scheduling ahead
    this.schedulerIntervalId = setInterval(() => {
      if (Tone.Transport.state === 'started') {
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
    const currentTick = Tone.Transport.ticks
    
    // Remove events that have already been triggered
    this.scheduledEvents = this.scheduledEvents.filter(event => {
      if (event.tick < currentTick - 1000) { // 1000 tick buffer
        Tone.Transport.clear(event.id)
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
    console.log('[AudioEngine] clearScheduledNotes called')
    console.log('[AudioEngine] - allNotes.length before:', this.allNotes.length)
    console.log('[AudioEngine] - scheduledEvents.length before:', this.scheduledEvents.length)
    
    // CRITICAL: Stop the look-ahead scheduler FIRST to prevent it from scheduling more notes
    this.stopLookAheadScheduler()
    
    if (this.stopEventId !== null) {
      console.log('[AudioEngine] - Clearing stopEventId:', this.stopEventId)
      try { Tone.Transport.clear(this.stopEventId) } catch (_) {}
      this.stopEventId = null
    }
    
    console.log('[AudioEngine] - Clearing', this.scheduledEvents.length, 'scheduled events')
    this.scheduledEvents.forEach((event, idx) => {
      console.log(`[AudioEngine] - Clearing event ${idx}: id=${event.id}, tick=${event.tick}`)
      try { Tone.Transport.clear(event.id || event) } catch (_) {}
    })
    this.scheduledEvents = []
    this.allNotes = []
    this.currentNoteIndex = 0
    this.killAllActiveNotes()
    
    console.log('[AudioEngine] clearScheduledNotes done')
    console.log('[AudioEngine] - allNotes.length after:', this.allNotes.length)
    console.log('[AudioEngine] - scheduledEvents.length after:', this.scheduledEvents.length)
  }

  scheduleStopEvent(bars = 4) {
    if (!Tone.Transport) return
    const stopTime = `${bars}m`
    if (this.stopEventId !== null) {
      Tone.Transport.clear(this.stopEventId)
    }
    this.stopEventId = Tone.Transport.schedule((time) => {
      this.stop()
      if (this.onPlaybackComplete) this.onPlaybackComplete()
    }, stopTime)
  }

  // Stop after an exact duration in seconds from transport position 0.
  scheduleStopAtSeconds(durationSeconds) {
    if (!Tone.Transport) return
    if (this.stopEventId !== null) {
      Tone.Transport.clear(this.stopEventId)
    }
    this.stopEventId = Tone.Transport.schedule((time) => {
      this.stop()
      if (this.onPlaybackComplete) this.onPlaybackComplete()
    }, `${durationSeconds}`)
  }

  // Stop after an exact number of beats from transport position 0.
  // Schedules in ticks so the stop fires at the correct wall-clock time
  // regardless of the current BPM (i.e. tempo * playbackSpeed).
  scheduleStopAtBeats(beats) {
    if (!Tone.Transport) return
    if (this.stopEventId !== null) {
      Tone.Transport.clear(this.stopEventId)
    }
    const ticks = Math.round(beats * Tone.Transport.PPQ)
    this.stopEventId = Tone.Transport.schedule((time) => {
      this.stop()
      if (this.onPlaybackComplete) this.onPlaybackComplete()
    }, `${ticks}i`)
  }

  // ─── Drone ────────────────────────────────────────────────────────────────

  /**
   * Build and start a lush pad drone for the given tonic across regionBeats.
   *
   * Layers (all routed through midiGain for the Background Volume slider):
   *   1. Fundamental  – tonic2  (e.g. A2)  – slow sine-ish wave, full body
   *   2. Octave       – tonic3  (e.g. A3)  – adds warmth, slightly softer
   *   3. Perfect 5th  – fifth3  (e.g. E3)  – classic harmonic richness
   *   4. 2nd octave   – tonic4  (e.g. A4)  – airy shimmer, very soft
   *
   * Each layer has a slow LFO (0.05–0.15 Hz) on gain to create gentle
   * volume undulation that makes the drone feel alive.
   *
   * @param {string} tonic       - Key name e.g. 'A', 'C#'
   * @param {number} regionBeats - Duration in beats at the current transport tempo
   * @param {number} volumeDb    - Master volume in dB (from backgroundVolume slider)
   */
  scheduleDroneNotes(tonic, regionBeats, volumeDb = 0) {
    this.stopDrone()

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

    const ppq   = Tone.Transport.PPQ
    const ticks = Math.round(regionBeats * ppq)
    // Duration string in ticks — covers the full region
    const durTicks = ticks + 'i'

    for (const layer of layers) {
      const noteName = midiToNoteName(layer.midi)
      const baseGain = Math.pow(10, layer.gainDb / 20)

      // Slow tremolo LFO on a dedicated gain node
      const lfoGain = new Tone.Gain(baseGain).connect(this.midiGain)

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
    // Clear scheduled Transport events
    for (const id of this.droneScheduledEvents) {
      try { Tone.Transport.clear(id) } catch (_) {}
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
  }

  dispose() {
    try { this.clearScheduledNotes() } catch (_) {}
    try { this.stopDrone() } catch (_) {}
    this.stopPositionTracking()
    this.stopLookAheadScheduler()
    try { this.killAllActiveNotes() } catch (_) {}
    // Clean up any live MIDI notes
    this.liveMidiNotes = {}
    Object.values(this.samplers).forEach(sampler => { try { sampler.dispose() } catch (_) {} })
    Object.values(this.synths).forEach(synth => { try { synth.dispose() } catch (_) {} })
    this.samplers = {}
    this.synths = {}
    if (this.midiGain) {
      try { this.midiGain.dispose() } catch (_) {}
      this.midiGain = null
    }
    try { Tone.Transport.stop() } catch (_) {}
    this.isInitialized = false
  }
}

export const audioEngine = new AudioEngine()
export default audioEngine
