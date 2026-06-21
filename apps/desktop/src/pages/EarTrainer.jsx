import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, Square, ArrowLeft, Repeat, Settings, ChevronDown, ChevronUp, Upload, Lock, FolderOpen, Save, ChevronsRight, FileMusic, Eye, ListTree, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import PianoRoll from '@/components/PianoRollCanvas'
import BackendControl from '@/components/BackendControl'
import audioEngine from '@common/lib/audioEngine'
import { GranularPlayer } from '@common/lib/granularPlayer'
import { solfegePlayer } from '@common/lib/solfegePlayer'
import { beatsPerBarFromTimeSignature, DEFAULT_TIME_SIGNATURE, importFromMidi, normalizeTimeSignature, timeSignatureToString, getInternalBpm } from '@common/lib/midiUtils'
import { parseSessionTitle } from '@common/lib/sessionManager'
import { ToastContainer } from '@/components/Toast'
import { useMIDIInput } from '@/hooks/useMIDIInput'
import { useTheme } from '@/hooks/useTheme'
import { BACKEND_URL } from '@/lib/backend'
import * as Tone from 'tone'

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function EarTrainer() {
  const navigate = useNavigate()
  const { isDark, toggleTheme } = useTheme()

  // Settings (some fixed, some from MIDI import)
  const [tempo, setTempo] = useState(120)
  const [selectedKey, setSelectedKey] = useState('C')
  const [keyMode, setKeyMode] = useState('Major')
  const [bars, setBars] = useState(4)
  const [timeDivision, setTimeDivision] = useState('1/4')
  const [timeSignature, setTimeSignature] = useState(DEFAULT_TIME_SIGNATURE)
  
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLooping, setIsLooping] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [cursorPosition, setCursorPosition] = useState(0)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  const zoomCenterBeatRef = useRef(null)
  const [melodyVolume, setMelodyVolume] = useState(0)
  const [backgroundVolume, setBackgroundVolume] = useState(0)
  const [autoScroll, setAutoScroll] = useState(false)
  const [showAnalysis, setShowAnalysis] = useState(false)
  const [melodyAnalysisMode, setMelodyAnalysisMode] = useState('scale-degrees') // 'notes' | 'scale-degrees'
  const [chordsAnalysisMode, setChordsAnalysisMode] = useState('chords') // 'chords' | 'roman-numerals'
  
  // Export settings
  const [exportMelody, setExportMelody] = useState(true)
  const [exportChords, setExportChords] = useState(true)
  const [showExportSettings, setShowExportSettings] = useState(false)
  
  const [notes, setNotes] = useState([])
  const [lowestNote, setLowestNote] = useState(36)
  const [highestNote, setHighestNote] = useState(60)
  
  const [regionStart, setRegionStart] = useState(0)
  const [regionEnd, setRegionEnd] = useState(1)
  
  // Session management
  const [sessionName, setSessionName] = useState('Untitled Session')
  const [sessionTitle, setSessionTitle] = useState('Untitled Session')
  
  // File upload states and file references
  const [midiFileUploaded, setMidiFileUploaded] = useState(false)
  const [vocalsFileUploaded, setVocalsFileUploaded] = useState(false)
  const [uploadedMidiFile, setUploadedMidiFile] = useState(null)
  const [uploadedVocalsFile, setUploadedVocalsFile] = useState(null)
  const [uploadedDroneFile, setUploadedDroneFile] = useState(null)
  const [uploadedChordsMidiFile, setUploadedChordsMidiFile] = useState(null)
  const [uploadedInstrumentalsFile, setUploadedInstrumentalsFile] = useState(null)
  const [backgroundFileUploaded, setBackgroundFileUploaded] = useState(false)
  
  // Ear trainer specific settings
  const [melodyMode, setMelodyMode] = useState(null) // 'pitches', 'solfege', 'vocals', null
  const [instrument, setInstrument] = useState('piano')
  const [chordsInstrument, setChordsInstrument] = useState('piano')
  const [backgroundTrack, setBackgroundTrack] = useState('none') // 'none', 'drone', 'chords', 'instrumentals'
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0) // 1.0, 0.75, 0.5, 0.25
  
  // Dropdown states
  const [showMelodyMenu, setShowMelodyMenu] = useState(false)
  const [showInstrumentMenu, setShowInstrumentMenu] = useState(false)
  const [showChordsInstrumentMenu, setShowChordsInstrumentMenu] = useState(false)
  const [showBackgroundMenu, setShowBackgroundMenu] = useState(false)
  const [showMidiMenu, setShowMidiMenu] = useState(false)
  const [showMelodyAnalysisMenu, setShowMelodyAnalysisMenu] = useState(false)
  const [showChordsAnalysisMenu, setShowChordsAnalysisMenu] = useState(false)
  
  // MIDI display selection
  const [displayedMidiTrack, setDisplayedMidiTrack] = useState('melody') // 'melody' or 'chords'

  // Toast notifications
  const [toasts, setToasts] = useState([])
  const showToast = useCallback((message, type = 'success', duration = 3000) => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type, duration }])
  }, [])
  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])
  
  // Background audio buffers (state, for re-render triggers)
  const [droneAudioBuffer, setDroneAudioBuffer] = useState(null)
  const [chordsNotes, setChordsNotes] = useState([])
  const [instrumentalsAudioBuffer, setInstrumentalsAudioBuffer] = useState(null)
  const [vocalsAudioBuffer, setVocalsAudioBuffer] = useState(null)

  // GranularPlayer instances (refs, not state - mutable objects)
  const dronePlayerRef = useRef(null)
  const instrumentalsPlayerRef = useRef(null)
  const vocalsPlayerRef = useRef(null)
  
  // Track which background files are uploaded
  const [droneUploaded, setDroneUploaded] = useState(false)
  const [chordsMidiUploaded, setChordsMidiUploaded] = useState(false)
  const [instrumentalsUploaded, setInstrumentalsUploaded] = useState(false)
  
  // Note range for chords (separate from melody)
  const [chordsLowestNote, setChordsLowestNote] = useState(48) // C3
  const [chordsHighestNote, setChordsHighestNote] = useState(72) // C5

  const mainScrollRef = useRef(null)
  const melodyMenuRef = useRef(null)
  const backgroundMenuRef = useRef(null)
  const instrumentMenuRef = useRef(null)
  const chordsInstrumentMenuRef = useRef(null)
  const midiMenuRef = useRef(null)
  const melodyAnalysisMenuRef = useRef(null)
  const chordsAnalysisMenuRef = useRef(null)
  const granularInitializedRef = useRef(false)
  const midiFileInputRef = useRef(null)
  const vocalsFileInputRef = useRef(null)
  const droneFileInputRef = useRef(null)
  const chordsMidiFileInputRef = useRef(null)
  const instrumentalsFileInputRef = useRef(null)
  const audioStopEventRef = useRef(null)
  const sessionFileInputRef = useRef(null)
  const lastRawContextRef = useRef(null)
  const playbackWatchdogTimerRef = useRef(null)

  const configs = {
    'synth': { volume: -8 },
    'piano': { attack: 0.02, release: 1, volume: -6 },
    'violin': { attack: 0.1, release: 1.2, volume: -4 },
    'flute': { attack: 0.08, release: 0.8, volume: -2 },
    'clarinet': { attack: 0.05, release: 0.5, volume: -4 },
    'guitar-acoustic': { attack: 0.01, release: 1.2, volume: -4 }
  }

  const beatsPerBar = beatsPerBarFromTimeSignature(timeSignature)

  useEffect(() => {
    const init = async () => {
      try {
        await audioEngine.initialize()
        await audioEngine.loadInstrument('piano', { attack: 0.02, release: 1, volume: -6 })
        await audioEngine.loadInstrument('synth', { volume: -8 })
        lastRawContextRef.current = Tone.context.rawContext
        setIsInitialized(true)
      } catch (error) {
        console.error('Failed to initialize audio:', error)
      }
    }
    init()
    
    return () => {
      if (audioEngine.isInitialized) {
        audioEngine.dispose()
      }
    }
  }, [])

  useEffect(() => {
    audioEngine.setTempo(tempo, timeSignature)
  }, [tempo, timeSignature])

  // Update session title when session name changes
  useEffect(() => {
    setSessionTitle(parseSessionTitle(sessionName))
  }, [sessionName])

  useEffect(() => {
    audioEngine.onCursorUpdate = setCursorPosition
  }, [])

  useEffect(() => {
    if (isInitialized) {
      audioEngine.setVolume(melodyVolume)
    }
  }, [melodyVolume, isInitialized])

  useEffect(() => {
    if (dronePlayerRef.current) dronePlayerRef.current.volume = backgroundVolume
    if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.volume = backgroundVolume
  }, [backgroundVolume])

  useEffect(() => {
    if (vocalsPlayerRef.current) vocalsPlayerRef.current.volume = melodyVolume
  }, [melodyVolume])

  // Set up MIDI keyboard input for live playing
  const { activeKeys: activeMidiKeys } = useMIDIInput({ enabled: true, instrument, isPlaying })

  // Click outside handlers
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (melodyMenuRef.current && !melodyMenuRef.current.contains(e.target)) {
        setShowMelodyMenu(false)
      }
      if (backgroundMenuRef.current && !backgroundMenuRef.current.contains(e.target)) {
        setShowBackgroundMenu(false)
      }
      if (instrumentMenuRef.current && !instrumentMenuRef.current.contains(e.target)) {
        setShowInstrumentMenu(false)
      }
      if (chordsInstrumentMenuRef.current && !chordsInstrumentMenuRef.current.contains(e.target)) {
        setShowChordsInstrumentMenu(false)
      }
      if (midiMenuRef.current && !midiMenuRef.current.contains(e.target)) {
        setShowMidiMenu(false)
      }
      if (melodyAnalysisMenuRef.current && !melodyAnalysisMenuRef.current.contains(e.target)) {
        setShowMelodyAnalysisMenu(false)
      }
      if (chordsAnalysisMenuRef.current && !chordsAnalysisMenuRef.current.contains(e.target)) {
        setShowChordsAnalysisMenu(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleStop = useCallback(() => {
    if (playbackWatchdogTimerRef.current) {
      window.clearTimeout(playbackWatchdogTimerRef.current)
      playbackWatchdogTimerRef.current = null
    }
    audioEngine.stop()
    if (dronePlayerRef.current) dronePlayerRef.current.stop()
    if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.stop()
    if (vocalsPlayerRef.current) vocalsPlayerRef.current.stop()
    solfegePlayer.stop()
    setIsPlaying(false)
    setCursorPosition(0)
  }, [])

  const ensurePlaybackAudio = useCallback(async () => {
    const { contextChanged, rawContext } = await audioEngine.ensureActive({ loadDefaultPiano: false })
    if (contextChanged || lastRawContextRef.current !== rawContext) {
      await audioEngine.loadInstrument('piano', { attack: 0.02, release: 1, volume: -6 })
      await audioEngine.loadInstrument('synth', { volume: -8 })
      if (instrument) await audioEngine.loadInstrument(instrument, configs[instrument] || {})
      if (chordsInstrument) await audioEngine.loadInstrument(chordsInstrument, configs[chordsInstrument] || {})
      granularInitializedRef.current = false
      lastRawContextRef.current = rawContext
    }

    const initPlayer = async (ref, volume) => {
      if (ref.current) {
        await ref.current.initialize(rawContext)
        ref.current.volume = volume
      }
    }
    const players = [dronePlayerRef.current, instrumentalsPlayerRef.current, vocalsPlayerRef.current].filter(Boolean)
    const needsGranularInit = !granularInitializedRef.current || players.some(player => player.audioContext !== rawContext)
    if (needsGranularInit) {
      await Promise.all([
        initPlayer(dronePlayerRef, backgroundVolume),
        initPlayer(instrumentalsPlayerRef, backgroundVolume),
        initPlayer(vocalsPlayerRef, melodyVolume)
      ])
      granularInitializedRef.current = true
    }
    setIsInitialized(true)
    return rawContext
  }, [instrument, chordsInstrument, backgroundVolume, melodyVolume])

  const handlePlay = useCallback(async () => {
    if (!isInitialized && !audioEngine.isInitialized) return

    let toneRawContext
    try {
      toneRawContext = await ensurePlaybackAudio()
    } catch (error) {
      console.error('Failed to prepare audio playback:', error)
      showToast('Audio playback could not be recovered. Please try again.', 'error')
      return
    }

    const totalBeats = bars * beatsPerBar
    const startBeat = regionStart * totalBeats
    const endBeat = regionEnd * totalBeats
    const regionBeats = endBeat - startBeat

    const internalTempo = getInternalBpm(tempo, timeSignature)
    // Transport runs at tempo*playbackSpeed BPM.
    // Wall-clock duration of the region = regionBeats / (tempo*playbackSpeed/60)
    const effectiveBps = (internalTempo * playbackSpeed) / 60
    const wallClockDuration = regionBeats / effectiveBps

    // Filter + remap notes into region — only notes that START within the region
    const regionNotes = notes
      .filter(n => n.start >= startBeat - 1e-6 && n.start < endBeat)
      .map(n => ({
        ...n,
        start: n.start - startBeat,
        duration: Math.min(n.start + n.duration, endBeat) - n.start
      }))

    // Clear everything before scheduling
    audioEngine.clearScheduledNotes()

    // Set totalTicks for playhead (exact region beats)
    const ppq = 192
    audioEngine.totalTicks = Math.round(regionBeats * ppq)

    // Apply playback speed to tempo
    audioEngine.setTempo(tempo * playbackSpeed, timeSignature)

    // Combine all MIDI notes (melody + chords) into a single array for scheduling
    let allMidiNotes = []

    // Add melody notes if melody mode is pitches
    if (melodyMode === 'pitches') {
      const melodyNotesWithSettings = regionNotes.map(n => ({
        ...n,
        instrument,
        volume: melodyVolume
      }))
      allMidiNotes = allMidiNotes.concat(melodyNotesWithSettings)
    }

    // ── Chords background: MIDI-based playback with chosen instrument ──
    if (backgroundTrack === 'chords' && chordsNotes.length > 0) {
      const regionChordsNotes = chordsNotes
        .filter(n => n.start >= startBeat - 1e-6 && n.start < endBeat)
        .map(n => ({
          ...n,
          start: n.start - startBeat,
          instrument: chordsInstrument,
          volume: backgroundVolume
        }))
      allMidiNotes = allMidiNotes.concat(regionChordsNotes)
    }

    // Schedule all MIDI notes together (melody + chords) BEFORE starting Transport
    // so that the note at tick 0 is not missed
    if (allMidiNotes.length > 0) {
      Tone.Transport.timeSignature = beatsPerBar
      audioEngine.scheduleNotes(allMidiNotes, timeDivision, Math.ceil(regionBeats / beatsPerBar), instrument, melodyVolume)
      audioEngine.totalTicks = Math.round(regionBeats * ppq)
    }

    // ── Drone background: pure MIDI synth, scheduled before Transport starts ──
    if (backgroundTrack === 'drone') {
      audioEngine.scheduleDroneNotes(selectedKey, regionBeats, backgroundVolume)
    }

    // Schedule stop or loop in BEATS (transport-time) so it fires at the correct
    // wall-clock moment regardless of playbackSpeed.
    if (!isLooping) {
      audioEngine.scheduleStopAtBeats(regionBeats)
    } else {
      audioEngine.setLoopEnabledBeats(true, regionBeats)
    }

    // Start Transport — all MIDI notes are already scheduled on the Transport timeline
    await audioEngine.start()

    // ── Solfege playback ──
    // IMPORTANT: scheduled AFTER audioEngine.start() so the Transport is already
    // running and Tone.context.rawContext.currentTime is a stable reference.
    if (melodyMode === 'solfege' && regionNotes.length > 0) {
      const toneRawCtx = toneRawContext
      if (!solfegePlayer._ctx || solfegePlayer._ctx !== toneRawCtx) {
        await solfegePlayer.initialize(toneRawCtx)
      }
      if (!solfegePlayer.isReady()) {
        await solfegePlayer.loadAll()
      }
      solfegePlayer.volume = melodyVolume
      const toneStartTime = toneRawCtx.currentTime + Tone.context.lookAhead
      const scaledTempo = tempo * playbackSpeed
      solfegePlayer.scheduleNotes(regionNotes, selectedKey, scaledTempo, toneStartTime)
    }

    // Play vocals audio if melody mode is vocals
    if (melodyMode === 'vocals' && vocalsPlayerRef.current && vocalsAudioBuffer) {
      const player = vocalsPlayerRef.current
      const normalBps = internalTempo / 60
      const bufferOffsetSeconds = startBeat / normalBps
      const regionDurationInBuffer = regionBeats / normalBps

      const loopStartSec = bufferOffsetSeconds
      const loopEndSec = bufferOffsetSeconds + regionDurationInBuffer

      const onEnded = () => { handleStop() }

      player.start(
        playbackSpeed,
        bufferOffsetSeconds,
        isLooping,
        loopStartSec,
        loopEndSec,
        isLooping ? null : onEnded
      )
    }

    // ── Background audio: GranularPlayer (pitch-preserving time-stretch) ──
    let activePlayerRef = null
    let activeBuffer = null
    if (backgroundTrack === 'instrumentals' && instrumentalsPlayerRef.current) {
      activePlayerRef = instrumentalsPlayerRef; activeBuffer = instrumentalsAudioBuffer
    }

    if (activePlayerRef && activeBuffer) {
      const player = activePlayerRef.current
      const normalBps = internalTempo / 60
      const bufferOffsetSeconds = startBeat / normalBps
      const regionDurationInBuffer = regionBeats / normalBps

      const loopStartSec = bufferOffsetSeconds
      const loopEndSec = bufferOffsetSeconds + regionDurationInBuffer

      const onEnded = () => { handleStop() }

      player.start(
        playbackSpeed,
        bufferOffsetSeconds,
        isLooping,
        loopStartSec,
        loopEndSec,
        isLooping ? null : onEnded
      )
    }

    const playbackStartedFrom = {
      rawTime: toneRawContext?.currentTime || 0,
      transportTicks: Tone.Transport.ticks,
      cursorPosition
    }
    setIsPlaying(true)

    if (playbackWatchdogTimerRef.current) window.clearTimeout(playbackWatchdogTimerRef.current)
    playbackWatchdogTimerRef.current = window.setTimeout(async () => {
      const rawContext = Tone.context.rawContext
      const rawAdvanced = rawContext ? rawContext.currentTime > playbackStartedFrom.rawTime + 0.15 : false
      const ticksAdvanced = Tone.Transport.ticks > playbackStartedFrom.transportTicks + 2
      const cursorAdvanced = cursorPosition > playbackStartedFrom.cursorPosition + 0.001
      if (Tone.context.state === 'running' && rawAdvanced && (ticksAdvanced || cursorAdvanced)) return
      try {
        console.warn('[EarTrainer] Playback stalled; rebuilding audio context')
        audioEngine.stop()
        if (dronePlayerRef.current) dronePlayerRef.current.stop()
        if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.stop()
        if (vocalsPlayerRef.current) vocalsPlayerRef.current.stop()
        solfegePlayer.stop()
        setIsPlaying(false)
        granularInitializedRef.current = false
        await audioEngine.ensureActive({ forceRebuild: true, loadDefaultPiano: false })
        lastRawContextRef.current = Tone.context.rawContext
        setIsInitialized(false)
        await audioEngine.loadInstrument('piano', { attack: 0.02, release: 1, volume: -6 })
        await audioEngine.loadInstrument('synth', { volume: -8 })
        setIsInitialized(true)
        window.setTimeout(() => handlePlay(), 150)
      } catch (error) {
        console.error('Automatic audio recovery failed:', error)
        showToast('Audio playback stalled and could not be recovered automatically. Please try pressing Play again.', 'error')
      }
    }, 900)
  }, [isInitialized, notes, timeDivision, bars, beatsPerBar, melodyVolume, isLooping, instrument,
      chordsNotes, chordsInstrument, instrumentalsAudioBuffer, vocalsAudioBuffer, backgroundTrack,
      backgroundVolume, tempo, regionStart, regionEnd, melodyMode, playbackSpeed, selectedKey, ensurePlaybackAudio, cursorPosition, showToast])


  const handleLoopToggle = useCallback(() => {
    setIsLooping(prev => !prev)
  }, [])

  // Load instrument when it changes
  useEffect(() => {
    if (isInitialized && instrument) {
      const config = configs[instrument] || {}
      audioEngine.loadInstrument(instrument, config)
    }
  }, [instrument, isInitialized])

  // Load chords instrument when it changes
  useEffect(() => {
    if (isInitialized && chordsInstrument) {
      const config = configs[chordsInstrument] || {}
      audioEngine.loadInstrument(chordsInstrument, config)
    }
  }, [chordsInstrument, isInitialized])

  const changeMelodyMode = useCallback((mode) => {
    // Stop playback if currently playing to apply changes immediately
    if (isPlaying) {
      audioEngine.stop()
      if (dronePlayerRef.current) dronePlayerRef.current.stop()
      if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.stop()
      if (vocalsPlayerRef.current) vocalsPlayerRef.current.stop()
      setIsPlaying(false)
    }
    setMelodyMode(mode)
    setShowMelodyMenu(false)
  }, [isPlaying])

  const changeBackgroundTrack = useCallback((track) => {
    // Stop playback if currently playing to apply changes immediately
    if (isPlaying) {
      audioEngine.stop()
      if (dronePlayerRef.current) dronePlayerRef.current.stop()
      if (chordsPlayerRef.current) chordsPlayerRef.current.stop()
      if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.stop()
      setIsPlaying(false)
    }
    setBackgroundTrack(track)
    setShowBackgroundMenu(false)
  }, [isPlaying])

  const changePlaybackSpeed = useCallback((direction) => {
    setPlaybackSpeed(prev => {
      const speeds = [0.25, 0.5, 0.75, 1.0]
      const currentIndex = speeds.indexOf(prev)
      let newIndex = currentIndex
      
      if (direction === 'up' && currentIndex < speeds.length - 1) {
        newIndex = currentIndex + 1
      } else if (direction === 'down' && currentIndex > 0) {
        newIndex = currentIndex - 1
      }
      
      return speeds[newIndex]
    })
  }, [])

  const handleSaveSession = useCallback(async () => {
    try {
      // Helper: file → base64 with size in MB
      const encodeFile = async (file) => {
        const arrayBuffer = await file.arrayBuffer()
        let binary = ''
        const bytes = new Uint8Array(arrayBuffer)
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
        return {
          name: file.name,
          type: file.type,
          'size (MB)': parseFloat((file.size / (1024 * 1024)).toFixed(3)),
          data: btoa(binary)
        }
      }

      // Build session package
      const sessionPackage = {
        version: '1.0',
        sessionName: sessionName,
        settings: {
          key: selectedKey,
          keyMode,
          tempo,
          timeSignature,
          bars,
          timeDivision,
          playbackSpeed,
          instrument,
          melodyMode: melodyMode || 'none',
          backgroundTrack,
          melodyVolume,
          backgroundVolume,
          regionStart,
          regionEnd,
          isLooping
        },
        notes: notes || [],
        noteRange: { lowestNote, highestNote },
        files: {
          midi: uploadedMidiFile ? 'Melody.mid' : '',
          vocals: uploadedVocalsFile ? `Vocals.${uploadedVocalsFile.name.split('.').pop()}` : '',
          drone: uploadedDroneFile ? `Drone.${uploadedDroneFile.name.split('.').pop()}` : '',
          chordsMidi: uploadedChordsMidiFile ? `Chords.${uploadedChordsMidiFile.name.split('.').pop()}` : '',
          instrumentals: uploadedInstrumentalsFile ? `Instrumentals.${uploadedInstrumentalsFile.name.split('.').pop()}` : ''
        },
        chordsNotes: chordsNotes || [],
        chordsInstrument,
        chordsNoteRange: { lowest: chordsLowestNote, highest: chordsHighestNote },
        embeddedFiles: {}
      }

      if (uploadedMidiFile) sessionPackage.embeddedFiles.midi = await encodeFile(uploadedMidiFile)
      if (uploadedVocalsFile) sessionPackage.embeddedFiles.vocals = await encodeFile(uploadedVocalsFile)
      if (uploadedDroneFile) sessionPackage.embeddedFiles.drone = await encodeFile(uploadedDroneFile)
      if (uploadedChordsMidiFile) sessionPackage.embeddedFiles.chordsMidi = await encodeFile(uploadedChordsMidiFile)
      if (uploadedInstrumentalsFile) sessionPackage.embeddedFiles.instrumentals = await encodeFile(uploadedInstrumentalsFile)

      // Use native file picker to save
      const suggestedName = sessionName !== 'Untitled Session' ? `${sessionName}.eartrainer.json` : 'session.eartrainer.json'
      const jsonString = JSON.stringify(sessionPackage, null, 2)

      // 1. Try Tauri native save dialog
      const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || null
      if (tauriInvoke) {
        const bytes = Array.from(new TextEncoder().encode(jsonString))
        const savedPath = await tauriInvoke('save_session_file', { defaultName: suggestedName, bytes })
        if (savedPath) {
          const savedName = savedPath.split('/').pop().replace('.eartrainer.json', '').replace('.json', '')
          setSessionName(savedName)
          showToast(`Session "${savedName}" saved successfully!`, 'success')
        }
        return
      }

      // 2. Try File System Access API (web browsers)
      if ('showSaveFilePicker' in window) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName,
          types: [{
            description: 'EarTrainer Session',
            accept: { 'application/json': ['.eartrainer.json'] }
          }]
        })

        const writable = await fileHandle.createWritable()
        await writable.write(jsonString)
        await writable.close()

        const savedName = fileHandle.name.replace('.eartrainer.json', '')
        setSessionName(savedName)
        showToast(`Session "${savedName}" saved successfully!`, 'success')
        return
      }

      // 3. Fallback: download via anchor element
      const blob = new Blob([jsonString], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.style.display = 'none'
      a.href = url
      a.download = suggestedName
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
      const savedName = suggestedName.replace('.eartrainer.json', '')
      setSessionName(savedName)
      showToast(`Session "${savedName}" saved successfully!`, 'success')
    } catch (error) {
      if (error.name === 'AbortError') return
      console.error('Error saving session:', error)
      showToast('Failed to save session: ' + error.message, 'error')
    }
  }, [sessionName, selectedKey, keyMode, tempo, bars, timeDivision, timeSignature, playbackSpeed, instrument,
      melodyMode, backgroundTrack, melodyVolume, backgroundVolume, regionStart, regionEnd,
      isLooping, notes, lowestNote, highestNote, uploadedMidiFile, uploadedVocalsFile,
      uploadedDroneFile, uploadedChordsMidiFile, uploadedInstrumentalsFile, chordsNotes, chordsInstrument,
      chordsLowestNote, chordsHighestNote, showToast])

  const handleLoadSession = useCallback(() => {
    sessionFileInputRef.current?.click()
  }, [])

  const handleLoadSessionFile = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (sessionFileInputRef.current) sessionFileInputRef.current.value = ''

    try {
      const text = await file.text()
      const pkg = JSON.parse(text)

      // Decode base64-encoded embedded file back to a File object
      const decodeFile = ({ name, type, data }) => {
        const binaryStr = atob(data)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        return new File([bytes.buffer], name, { type })
      }

      const loadedName = file.name.replace('.eartrainer.json', '') || pkg.sessionName || 'Untitled Session'
      const sd = pkg.settings || {}
      const ef = pkg.embeddedFiles || {}
      await audioEngine.ensureActive({ loadDefaultPiano: false })

      // Restore all settings
      console.log('[Session Load] Settings from file:', sd)
      if (sd.key !== undefined) setSelectedKey(sd.key)
      if (sd.keyMode !== undefined) setKeyMode(sd.keyMode)
      if (sd.tempo !== undefined) setTempo(sd.tempo)
      if (sd.bars !== undefined) setBars(sd.bars)
      if (sd.timeDivision !== undefined) setTimeDivision(sd.timeDivision)
      if (sd.timeSignature !== undefined) setTimeSignature(normalizeTimeSignature(sd.timeSignature))
      if (sd.playbackSpeed !== undefined) setPlaybackSpeed(sd.playbackSpeed)
      if (sd.instrument !== undefined) setInstrument(sd.instrument)
      if (sd.melodyMode !== undefined) setMelodyMode(sd.melodyMode)
      if (sd.backgroundTrack !== undefined) setBackgroundTrack(sd.backgroundTrack)
      if (sd.melodyVolume !== undefined) setMelodyVolume(sd.melodyVolume)
      if (sd.backgroundVolume !== undefined) setBackgroundVolume(sd.backgroundVolume)
      if (sd.regionStart !== undefined) setRegionStart(sd.regionStart)
      if (sd.regionEnd !== undefined) setRegionEnd(sd.regionEnd)
      if (sd.isLooping !== undefined) setIsLooping(sd.isLooping)
      setNotes(pkg.notes || [])
      setLowestNote(pkg.noteRange?.lowestNote ?? 36)
      setHighestNote(pkg.noteRange?.highestNote ?? 84)
      setSessionName(loadedName)

      // MIDI file
      if (ef.midi) {
        const f = decodeFile(ef.midi)
        setUploadedMidiFile(f)
        setMidiFileUploaded(true)
      } else {
        setUploadedMidiFile(null)
        setMidiFileUploaded(false)
      }

      // Vocals file
      if (ef.vocals) {
        const f = decodeFile(ef.vocals)
        setUploadedVocalsFile(f)
        setVocalsFileUploaded(true)
      } else {
        setUploadedVocalsFile(null)
        setVocalsFileUploaded(false)
      }

      const vol = sd.backgroundVolume ?? 0

      // Helper: create a GranularPlayer from a decoded AudioBuffer
      const makePlayer = (buf) => {
        const p = new GranularPlayer()
        p.loadBuffer(buf)
        p._pendingVolume = vol
        return p
      }

      // Drone
      if (ef.drone) {
        const f = decodeFile(ef.drone)
        const ab = await f.arrayBuffer()
        const buf = await Tone.context.decodeAudioData(ab)
        if (dronePlayerRef.current) dronePlayerRef.current.dispose()
        dronePlayerRef.current = makePlayer(buf)
        granularInitializedRef.current = false
        setDroneAudioBuffer(buf)
        setDroneUploaded(true)
        setUploadedDroneFile(f)
      } else {
        if (dronePlayerRef.current) { dronePlayerRef.current.dispose(); dronePlayerRef.current = null }
        setDroneAudioBuffer(null)
        setDroneUploaded(false)
        setUploadedDroneFile(null)
      }

      // Chords MIDI
      if (ef.chordsMidi) {
        const f = decodeFile(ef.chordsMidi)
        setUploadedChordsMidiFile(f)
        setChordsMidiUploaded(true)
      } else {
        setUploadedChordsMidiFile(null)
        setChordsMidiUploaded(false)
      }
      
      // Load chords notes if present
      if (pkg.chordsNotes) {
        setChordsNotes(pkg.chordsNotes)
      } else {
        setChordsNotes([])
      }
      
      // Load chords note range if present
      if (pkg.chordsNoteRange) {
        setChordsLowestNote(pkg.chordsNoteRange.lowest)
        setChordsHighestNote(pkg.chordsNoteRange.highest)
      }
      
      // Load chords instrument if present
      if (pkg.chordsInstrument) {
        setChordsInstrument(pkg.chordsInstrument)
      }

      // Instrumentals
      if (ef.instrumentals) {
        const f = decodeFile(ef.instrumentals)
        const ab = await f.arrayBuffer()
        const buf = await Tone.context.decodeAudioData(ab)
        if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.dispose()
        instrumentalsPlayerRef.current = makePlayer(buf)
        granularInitializedRef.current = false
        setInstrumentalsAudioBuffer(buf)
        setInstrumentalsUploaded(true)
        setUploadedInstrumentalsFile(f)
      } else {
        if (instrumentalsPlayerRef.current) { instrumentalsPlayerRef.current.dispose(); instrumentalsPlayerRef.current = null }
        setInstrumentalsAudioBuffer(null)
        setInstrumentalsUploaded(false)
        setUploadedInstrumentalsFile(null)
      }

      showToast(`Session "${parseSessionTitle(loadedName)}" loaded!`, 'success')
    } catch (error) {
      console.error('Error loading session:', error)
      showToast('Failed to load session: ' + error.message, 'error')
    }
  }, [showToast])

  // Export Grand Staff (melody + harmony) to MusicXML via backend
  const handleExportMusicXML = useCallback(async () => {
    try {
      // Check if at least one export option is enabled
      if (!exportMelody && !exportChords) {
        showToast('Please enable at least one export option (Melody or Chords)', 'error')
        return
      }

      const keyStr = `${selectedKey} ${keyMode}`
      const title = sessionTitle !== 'Untitled Session' ? sessionTitle : 'Exported Melody'

      // ── Scale degree helpers ─────────────────────────────────────────────
      const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
      const MAJOR_DEGREE_MAP = {
        0: '1', 1: 'b2', 2: '2', 3: 'b3', 4: '3', 5: '4',
        6: '#4', 7: '5', 8: 'b6', 9: '6', 10: 'b7', 11: '7'
      }
      const MINOR_DEGREE_MAP = {
        0: '1', 1: 'b2', 2: '2', 3: 'b3', 4: '3', 5: '4',
        6: '#4', 7: '5', 8: 'b6', 9: '6', 10: 'b7', 11: '7'
      }
      const degreeMap = keyMode.toLowerCase() === 'minor' ? MINOR_DEGREE_MAP : MAJOR_DEGREE_MAP

      const getPitchClass = (noteName) => {
        if (!noteName || typeof noteName !== 'string') return 0
        const match = noteName.match(/^([A-G])(#|b)?/i)
        if (!match) return 0
        let [, letter, accidental] = match
        letter = letter.toUpperCase()
        let pc = NOTE_NAMES.indexOf(letter)
        if (accidental === '#') pc = (pc + 1) % 12
        if (accidental === 'b') pc = (pc + 11) % 12
        return pc
      }

      const tonicPitchClass = getPitchClass(selectedKey)

      // ── Part 1: melody notes with scale degrees (only if enabled) ─────────
      const melodyNotesForExport = exportMelody ? notes.map(note => {
        const pitchClass = getPitchClass(note.note)
        const chromaticDistance = (pitchClass - tonicPitchClass + 12) % 12
        return {
          pitch: note.note,
          start: note.start,
          duration: note.duration,
          scale_degree: degreeMap[chromaticDistance] || null,
          is_diatonic: [0, 2, 4, 5, 7, 9, 11].includes(chromaticDistance),
        }
      }) : []

      // ── Part 2: chord notes (only if enabled) ─────────────────────────────
      const chordNotesForExport = exportChords ? chordsNotes.map(note => ({
        pitch: note.note,
        start: note.start,
        duration: note.duration,
      })) : []

      // ── Part 2 annotations: fetch harmony analysis for chord notes ────────
      let chordAnnotations = []
      if (exportChords && chordsNotes.length > 0) {
        const harmonyPayload = {
          notes: chordsNotes.map(n => ({ note: n.note, start: n.start, duration: n.duration })),
          key: keyStr,
        }
        const harmRes = await fetch(`${BACKEND_URL}/analyze/harmony`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(harmonyPayload),
        })
        if (harmRes.ok) {
          const harmData = await harmRes.json()
          chordAnnotations = (harmData.chord_events || []).map(ev => ({
            start: ev.start,
            chord_label: ev.chord_label,
            roman_numeral: ev.roman_numeral,
            is_diatonic: ev.is_diatonic,
          }))
        } else {
          console.warn('[MusicXML Export] Harmony analysis failed, exporting without annotations')
        }
      }

      // ── Build export payload ──────────────────────────────────────────────
      const exportData = {
        notes: melodyNotesForExport,
        chordNotes: chordNotesForExport,
        chordAnnotations,
        key: keyStr,
        tempo,
        timeSignature: timeSignatureToString(timeSignature),
        pickupBeats: 0,
        title,
        composer: 'EarMasterPro',
      }

      console.log('[MusicXML Export] Sending Grand Staff payload:', exportData)

      const response = await fetch(`${BACKEND_URL}/export/musicxml`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exportData),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Export failed: ${response.status} - ${errorText}`)
      }

      // Download the file
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/\s+/g, '_')}.musicxml`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)

      showToast(`MusicXML exported: "${title}.musicxml"`, 'success')
    } catch (error) {
      console.error('Error exporting MusicXML:', error)
      showToast('Failed to export MusicXML: ' + error.message, 'error')
    }
  }, [notes, chordsNotes, selectedKey, keyMode, tempo, timeSignature, sessionTitle, exportMelody, exportChords, showToast])

  const handleExportAnalysis = useCallback(async () => {
    try {
      if (!exportMelody && !exportChords) {
        showToast('Please enable at least one export option (Melody or Chords)', 'error')
        return
      }

      const title = sessionTitle !== 'Untitled Session' ? sessionTitle : 'Exported Analysis'
      const titleParts = title.split(' - ')
      const artist = titleParts.length > 1 ? titleParts[0] : ''
      const songTitle = titleParts.length > 1 ? titleParts[1] : title
      const songSection = titleParts.length > 2 ? titleParts.slice(2).join(' - ') : ''
      const keyStr = `${selectedKey} ${keyMode}`
      const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
      const degreeMap = {
        0: '1', 1: 'b2', 2: '2', 3: 'b3', 4: '3', 5: '4',
        6: '#4', 7: '5', 8: 'b6', 9: '6', 10: 'b7', 11: '7'
      }
      const getPitchClass = (noteName) => {
        const match = String(noteName || '').match(/^([A-G])(#|b)?/i)
        if (!match) return 0
        let pc = noteNames.indexOf(match[1].toUpperCase())
        if (match[2] === '#') pc = (pc + 1) % 12
        if (match[2] === 'b') pc = (pc + 11) % 12
        return pc
      }
      const buildSpacedLine = (events, labelGetter) => {
        const sorted = [...events].sort((a, b) => a.start - b.start)
        const parts = []
        let previousEnd = null
        for (const event of sorted) {
          if (previousEnd !== null && event.start > previousEnd + 0.001) parts.push('-')
          parts.push(labelGetter(event))
          previousEnd = Math.max(previousEnd ?? 0, event.start + (event.duration || 0))
        }
        return parts.join(' ')
      }

      const lines = [
        `Title: ${songTitle}`,
        `Artist: ${artist || '-'}`,
        `Song Section: ${songSection || '-'}`,
        `Tempo: ${tempo} BPM | Time Signature: ${timeSignatureToString(timeSignature)} | Key: ${keyStr}`
      ]

      if (exportMelody) {
        const tonicPitchClass = getPitchClass(selectedKey)
        const melodyLine = buildSpacedLine(notes, note => degreeMap[(getPitchClass(note.note) - tonicPitchClass + 12) % 12])
        lines.push('', 'Melody:', melodyLine || '(no melody notes)')
      }

      if (exportChords) {
        let chordEvents = []
        if (chordsNotes.length > 0) {
          const response = await fetch(`${BACKEND_URL}/analyze/harmony`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              notes: chordsNotes.map(n => ({ note: n.note, start: n.start, duration: n.duration })),
              key: keyStr,
            }),
          })
          if (!response.ok) throw new Error(`Harmony analysis failed: ${response.status}`)
          const data = await response.json()
          chordEvents = data.chord_events || []
        }
        const chordsLine = buildSpacedLine(chordEvents.map(event => ({ ...event, duration: beatsPerBar })), event => event.roman_numeral || event.chord_label || '?')
        lines.push('', 'Chords:', chordsLine || '(no chord analysis)')
      }

      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/\s+/g, '_')}_analysis.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
      showToast(`Analysis exported: "${a.download}"`, 'success')
    } catch (error) {
      console.error('Error exporting analysis:', error)
      showToast('Failed to export analysis: ' + error.message, 'error')
    }
  }, [notes, chordsNotes, selectedKey, keyMode, tempo, timeSignature, sessionTitle, exportMelody, exportChords, beatsPerBar, showToast])

  // Close export settings dropdown when clicking outside
  useEffect(() => {
    if (!showExportSettings) return
    
    const handleClickOutside = (e) => {
      if (!e.target.closest('.export-settings-dropdown')) {
        setShowExportSettings(false)
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showExportSettings])

  const handleMidiUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    
    // Validate file extension
    const fileName = file.name.toLowerCase()
    if (!fileName.endsWith('.mid') && !fileName.endsWith('.midi')) {
      alert('Error: Please upload a valid MIDI file (.mid or .midi)')
      e.target.value = ''
      return
    }
    
    try {
      const arrayBuffer = await file.arrayBuffer()
      const {
        notes: importedNotes,
        bars: importedBars,
        tempo: importedTempo,
        timeDivision: importedTimeDivision,
        timeSignature: importedTimeSignature,
        key: importedKey,
        keyMode: importedKeyMode,
        lowestNote: importedLowestNote,
        highestNote: importedHighestNote
      } = await importFromMidi(arrayBuffer, tempo)
      
      setNotes(importedNotes)
      setBars(importedBars)
      setTempo(importedTempo)
      setTimeDivision(importedTimeDivision)
      setTimeSignature(normalizeTimeSignature(importedTimeSignature))
      setSelectedKey(importedKey)
      setKeyMode(importedKeyMode)
      setLowestNote(importedLowestNote)
      setHighestNote(importedHighestNote)
      setMidiFileUploaded(true)
      setUploadedMidiFile(file)
      setMelodyMode('pitches')
      
      console.log(`MIDI file loaded: ${importedNotes.length} notes, ${importedBars} bars, ${importedTempo} BPM`)
    } catch (error) {
      console.error('Error parsing MIDI file:', error)
      alert('Error: Failed to parse MIDI file. Please ensure it is a valid MIDI file.')
      e.target.value = ''
    }
  }, [tempo])

  const handleVocalsUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    
    // Validate audio file
    const validExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']
    const fileName = file.name.toLowerCase()
    const isValid = validExtensions.some(ext => fileName.endsWith(ext))
    
    if (!isValid) {
      alert('Error: Please upload a valid audio file (.mp3, .wav, .ogg, .m4a, .aac, or .flac)')
      e.target.value = ''
      return
    }
    
    try {
      const arrayBuffer = await file.arrayBuffer()
      await audioEngine.ensureActive({ loadDefaultPiano: false })
      const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer)

      // Create a GranularPlayer and load the buffer into it.
      // Initialization (AudioWorklet registration) happens lazily on first play.
      const player = new GranularPlayer()
      player.loadBuffer(audioBuffer)
      // Pre-set volume so it's correct when play is called
      player._pendingVolume = melodyVolume

      if (vocalsPlayerRef.current) vocalsPlayerRef.current.dispose()
      vocalsPlayerRef.current = player
      granularInitializedRef.current = false // force re-init on next play
      setVocalsAudioBuffer(audioBuffer)
      setVocalsFileUploaded(true)
      setUploadedVocalsFile(file)
      setMelodyMode('vocals')
      console.log('Vocals file uploaded:', file.name)
    } catch (error) {
      console.error('Error loading vocals file:', error)
      alert('Error: Failed to load audio file. Please ensure it is a valid audio file.')
      e.target.value = ''
    }
  }, [melodyVolume])

  const handleChordsMidiUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    
    // Validate file extension
    const fileName = file.name.toLowerCase()
    if (!fileName.endsWith('.mid') && !fileName.endsWith('.midi')) {
      alert('Error: Please upload a valid MIDI file (.mid or .midi)')
      e.target.value = ''
      return
    }
    
    try {
      const arrayBuffer = await file.arrayBuffer()
      const {
        notes: importedNotes,
        timeSignature: importedTimeSignature,
        lowestNote: importedLowestNote,
        highestNote: importedHighestNote
      } = await importFromMidi(arrayBuffer, tempo)
      
      setChordsNotes(importedNotes)
      setTimeSignature(normalizeTimeSignature(importedTimeSignature))
      setChordsLowestNote(importedLowestNote)
      setChordsHighestNote(importedHighestNote)
      setChordsMidiUploaded(true)
      setUploadedChordsMidiFile(file)
      setBackgroundTrack('chords')
      
      console.log(`Chords MIDI file loaded: ${importedNotes.length} notes`)
    } catch (error) {
      console.error('Error parsing chords MIDI file:', error)
      alert('Error: Failed to parse MIDI file. Please ensure it is a valid MIDI file.')
      e.target.value = ''
    }
  }, [tempo])

  const handleBackgroundUpload = useCallback(async (e, trackType) => {
    const file = e.target.files?.[0]
    if (!file) return
    
    const validExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']
    const fileName = file.name.toLowerCase()
    const isValid = validExtensions.some(ext => fileName.endsWith(ext))
    
    if (!isValid) {
      alert('Error: Please upload a valid audio file (.mp3, .wav, .ogg, .m4a, .aac, or .flac)')
      e.target.value = ''
      return
    }
    
    try {
      const arrayBuffer = await file.arrayBuffer()
      await audioEngine.ensureActive({ loadDefaultPiano: false })
      const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer)

      // Create a GranularPlayer and load the buffer into it.
      // Initialization (AudioWorklet registration) happens lazily on first play.
      const player = new GranularPlayer()
      player.loadBuffer(audioBuffer)
      // Pre-set volume so it's correct when play is called
      player._pendingVolume = backgroundVolume

      if (trackType === 'drone') {
        if (dronePlayerRef.current) dronePlayerRef.current.dispose()
        dronePlayerRef.current = player
        granularInitializedRef.current = false // force re-init on next play
        setDroneAudioBuffer(audioBuffer)
        setDroneUploaded(true)
        setUploadedDroneFile(file)
        setBackgroundTrack('drone')
      } else if (trackType === 'instrumentals') {
        if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.dispose()
        instrumentalsPlayerRef.current = player
        granularInitializedRef.current = false
        setInstrumentalsAudioBuffer(audioBuffer)
        setInstrumentalsUploaded(true)
        setUploadedInstrumentalsFile(file)
        setBackgroundTrack('instrumentals')
      }
    } catch (error) {
      console.error('Error loading background audio:', error)
      alert('Error: Failed to load audio file. Please ensure it is a valid audio file.')
      e.target.value = ''
    }
  }, [backgroundVolume])

  useEffect(() => {
    const scrollEl = mainScrollRef.current
    if (!scrollEl) return

    const handleWheel = (e) => {
      const isZoom = e.ctrlKey || e.metaKey
      const isHorizontal = !isZoom && (Math.abs(e.deltaX) > 0 || e.shiftKey)

      if (isZoom) {
        e.preventDefault()
        // Calculate the beat at the CENTER of the viewport before zoom
        const containerWidth = scrollEl.offsetWidth
        const centerCanvasX = scrollEl.scrollLeft + (containerWidth / 2) - 120
        const oldBeatWidth = 40 * zoomRef.current
        zoomCenterBeatRef.current = centerCanvasX / oldBeatWidth

        setZoom(prev => {
          const factor = e.deltaY > 0 ? 0.9 : 1.1
          return Math.max(0.5, Math.min(3, prev * factor))
        })
      } else if (isHorizontal) {
        e.preventDefault()
        const delta = Math.abs(e.deltaX) > 0 ? e.deltaX : e.deltaY
        scrollEl.scrollLeft += delta
      }
    }

    scrollEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', handleWheel)
  }, [])

  // Adjust scroll position synchronously after zoom changes to prevent flicker.
  useLayoutEffect(() => {
    if (zoomCenterBeatRef.current === null) return
    const scrollEl = mainScrollRef.current
    if (!scrollEl) return
    const containerWidth = scrollEl.offsetWidth
    const newBeatWidth = 40 * zoom
    const newCenterCanvasX = zoomCenterBeatRef.current * newBeatWidth
    const newScrollLeft = newCenterCanvasX - (containerWidth / 2) + 120
    scrollEl.scrollLeft = Math.max(0, newScrollLeft)
    zoomCenterBeatRef.current = null
  }, [zoom])

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.code === 'Space') {
        e.preventDefault()
        if (isPlaying) {
          handleStop()
        } else {
          handlePlay()
        }
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [isPlaying, handlePlay, handleStop])

  const melodyModeLabels = {
    'none': 'None',
    'pitches': 'Pitches',
    'solfege': 'Solfege',
    'vocals': 'Vocals'
  }

  const backgroundTrackLabels = {
    'none': 'None',
    'drone': 'Drone',
    'chords': 'Chords',
    'instrumentals': 'Instrumentals'
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <div className="border-b border-border bg-card px-4 py-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="shrink-0 text-lg font-semibold">Ear Training</h1>
            
            <div className="h-6 w-px bg-border" />
            
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium">Tempo:</span>
              <span className="text-sm text-muted-foreground">{tempo} BPM</span>
            </div>
            
            <div className="h-6 w-px bg-border" />
            
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium">Key:</span>
              <span className="text-sm text-muted-foreground">{selectedKey} {keyMode}</span>
            </div>

            <div className="h-6 w-px bg-border" />

            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium">Time:</span>
              <span className="text-sm text-muted-foreground">{timeSignatureToString(timeSignature)}</span>
            </div>
          </div>
          
          <h1 className="max-w-[34rem] truncate px-4 text-center text-xl font-semibold text-white">{sessionTitle}</h1>
          
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={handleLoadSession}>
              <FolderOpen className="w-4 h-4 mr-1" /> Open Session
            </Button>
            <Button variant="outline" size="sm" onClick={handleSaveSession}>
              <Save className="w-4 h-4 mr-1" /> Save Session
            </Button>
            <div className="flex items-center gap-1 relative">
              <Button variant="outline" size="sm" onClick={handleExportMusicXML} disabled={notes.length === 0}>
                <FileMusic className="w-4 h-4 mr-1" /> Export MusicXML
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportAnalysis} disabled={notes.length === 0 && chordsNotes.length === 0}>
                <FileMusic className="w-4 h-4 mr-1" /> Export Analysis
              </Button>
              <div className="relative export-settings-dropdown">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => setShowExportSettings(!showExportSettings)}
                  className="px-2"
                >
                  <Settings className="w-4 h-4" />
                </Button>
                {showExportSettings && (
                  <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-md shadow-lg z-50 min-w-[160px]">
                    <div className="p-2 space-y-2">
                      <div className="text-xs font-medium text-muted-foreground px-2 py-1">Export Options</div>
                      <button
                        onClick={() => setExportMelody(!exportMelody)}
                        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-accent rounded text-sm"
                      >
                        <span>Melody</span>
                        <div className={`w-4 h-4 rounded border ${exportMelody ? 'bg-primary border-primary' : 'border-muted-foreground'} flex items-center justify-center`}>
                          {exportMelody && <span className="text-primary-foreground text-xs">✓</span>}
                        </div>
                      </button>
                      <button
                        onClick={() => setExportChords(!exportChords)}
                        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-accent rounded text-sm"
                      >
                        <span>Chords</span>
                        <div className={`w-4 h-4 rounded border ${exportChords ? 'bg-primary border-primary' : 'border-muted-foreground'} flex items-center justify-center`}>
                          {exportChords && <span className="text-primary-foreground text-xs">✓</span>}
                        </div>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <BackendControl />
          </div>
        </div>
      </div>

      <div className="border-b border-border bg-card px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button 
              variant="ghost" 
              size="icon"
              onClick={handlePlay}
              className={isPlaying ? 'bg-white text-black hover:bg-white/90' : ''}
            >
              <Play className="w-4 h-4" />
            </Button>
            
            <Button 
              variant="ghost" 
              size="icon"
              onClick={handleStop}
            >
              <Square className="w-4 h-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={handleLoopToggle}
              className={isLooping ? 'bg-white text-black hover:bg-white/90' : ''}
              title="Loop playback"
            >
              <Repeat className="w-4 h-4" />
            </Button>
            
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAutoScroll(!autoScroll)}
              className={autoScroll ? 'bg-white text-black hover:bg-white/90' : ''}
              title="Auto-scroll during playback"
            >
              <ChevronsRight className="w-4 h-4" />
            </Button>

            <div className="h-6 w-px bg-border mx-1" />

            {/* Melody Mode Dropdown */}
            <div className="relative" ref={melodyMenuRef}>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setShowMelodyMenu(!showMelodyMenu)}
              >
                Melody: {melodyMode ? melodyModeLabels[melodyMode] : 'None'} <ChevronDown className="w-4 h-4 ml-1" />
              </Button>
              {showMelodyMenu && (
                <div className="absolute top-full mt-1 left-0 bg-card border border-border rounded-md shadow-lg z-50 min-w-[240px]">
                  <button 
                    className="w-full px-4 py-2 text-left hover:bg-accent text-sm"
                    onClick={() => changeMelodyMode('none')}
                  >
                    None
                  </button>
                  <div className="flex items-center justify-between px-4 py-2 hover:bg-accent">
                    <button 
                      className={`flex-1 text-left text-sm ${!midiFileUploaded ? 'text-muted-foreground' : ''}`}
                      onClick={() => midiFileUploaded && changeMelodyMode('pitches')}
                      disabled={!midiFileUploaded}
                    >
                      {!midiFileUploaded && <Lock className="w-3 h-3 inline mr-1" />}
                      Pitches
                    </button>
                    {midiFileUploaded && (
                      <div className="relative" ref={instrumentMenuRef}>
                        <button
                          className="p-1 hover:bg-accent-foreground/10 rounded"
                          onClick={(e) => {
                            e.stopPropagation()
                            setShowInstrumentMenu(!showInstrumentMenu)
                          }}
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        {showInstrumentMenu && (
                          <div className="absolute top-0 left-full ml-1 bg-card border border-border rounded-md shadow-lg min-w-[150px]">
                            {Object.keys(configs).map(inst => (
                              <button
                                key={inst}
                                className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                                  instrument === inst ? 'bg-accent' : ''
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setInstrument(inst)
                                  setShowInstrumentMenu(false)
                                }}
                              >
                                {inst.charAt(0).toUpperCase() + inst.slice(1)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {midiFileUploaded && (
                      <div className="relative" ref={melodyAnalysisMenuRef}>
                        <button
                          className="p-1 hover:bg-accent-foreground/10 rounded ml-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            setShowMelodyAnalysisMenu(!showMelodyAnalysisMenu)
                          }}
                        >
                          <ListTree className="w-4 h-4" />
                        </button>
                        {showMelodyAnalysisMenu && (
                          <div className="absolute top-0 left-full ml-1 bg-card border border-border rounded-md shadow-lg min-w-[150px]">
                            <button
                              className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                                melodyAnalysisMode === 'notes' ? 'bg-accent' : ''
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setMelodyAnalysisMode('notes')
                                setShowMelodyAnalysisMenu(false)
                              }}
                            >
                              Notes
                            </button>
                            <button
                              className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                                melodyAnalysisMode === 'scale-degrees' ? 'bg-accent' : ''
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setMelodyAnalysisMode('scale-degrees')
                                setShowMelodyAnalysisMenu(false)
                              }}
                            >
                              Scale Degrees
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {!midiFileUploaded && (
                      <button
                        className="p-1 rounded ml-2 text-muted-foreground cursor-not-allowed"
                        disabled
                      >
                        <ListTree className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      className="p-1 hover:bg-accent-foreground/10 rounded ml-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        midiFileInputRef.current?.click()
                      }}
                    >
                      <Upload className="w-4 h-4" />
                    </button>
                  </div>
                  <button 
                    className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${!midiFileUploaded ? 'text-muted-foreground' : ''}`}
                    onClick={() => midiFileUploaded && changeMelodyMode('solfege')}
                    disabled={!midiFileUploaded}
                  >
                    {!midiFileUploaded && <Lock className="w-3 h-3 inline mr-1" />}
                    Solfege
                  </button>
                  <div className="flex items-center justify-between px-4 py-2 hover:bg-accent">
                    <button 
                      className={`flex-1 text-left text-sm ${!vocalsFileUploaded ? 'text-muted-foreground' : ''}`}
                      onClick={() => vocalsFileUploaded && changeMelodyMode('vocals')}
                      disabled={!vocalsFileUploaded}
                    >
                      {!vocalsFileUploaded && <Lock className="w-3 h-3 inline mr-1" />}
                      Vocals
                    </button>
                    <button
                      className="p-1 hover:bg-accent-foreground/10 rounded"
                      onClick={(e) => {
                        e.stopPropagation()
                        vocalsFileInputRef.current?.click()
                      }}
                    >
                      <Upload className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
            <input
              ref={midiFileInputRef}
              type="file"
              accept=".mid,.midi"
              onChange={handleMidiUpload}
              className="hidden"
            />
            <input
              ref={vocalsFileInputRef}
              type="file"
              accept="audio/*"
              onChange={handleVocalsUpload}
              className="hidden"
            />

            <div className="h-6 w-px bg-border mx-1" />

            {/* Background Track Dropdown */}
            <div className="relative" ref={backgroundMenuRef}>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setShowBackgroundMenu(!showBackgroundMenu)}
              >
                Background: {backgroundTrackLabels[backgroundTrack]} <ChevronDown className="w-4 h-4 ml-1" />
              </Button>
              {showBackgroundMenu && (
                <div className="absolute top-full mt-1 left-0 bg-card border border-border rounded-md shadow-lg z-50 min-w-[220px]">
                  <button 
                    className="w-full px-4 py-2 text-left hover:bg-accent text-sm"
                    onClick={() => changeBackgroundTrack('none')}
                  >
                    None
                  </button>
                  <button 
                    className="w-full px-4 py-2 text-left hover:bg-accent text-sm"
                    onClick={() => changeBackgroundTrack('drone')}
                  >
                    Drone
                  </button>
                  <div className="flex items-center justify-between px-4 py-2 hover:bg-accent">
                    <button 
                      className={`flex-1 text-left text-sm ${!chordsMidiUploaded ? 'text-muted-foreground' : ''}`}
                      onClick={() => chordsMidiUploaded && changeBackgroundTrack('chords')}
                      disabled={!chordsMidiUploaded}
                    >
                      {!chordsMidiUploaded && <Lock className="w-3 h-3 inline mr-1" />}
                      Chords
                    </button>
                    {chordsMidiUploaded && (
                      <div className="relative" ref={chordsInstrumentMenuRef}>
                        <button
                          className="p-1 hover:bg-accent-foreground/10 rounded"
                          onClick={(e) => {
                            e.stopPropagation()
                            setShowChordsInstrumentMenu(!showChordsInstrumentMenu)
                          }}
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        {showChordsInstrumentMenu && (
                          <div className="absolute top-0 left-full ml-1 bg-card border border-border rounded-md shadow-lg min-w-[150px]">
                            {Object.keys(configs).map(inst => (
                              <button
                                key={inst}
                                className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                                  chordsInstrument === inst ? 'bg-accent' : ''
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setChordsInstrument(inst)
                                  setShowChordsInstrumentMenu(false)
                                }}
                              >
                                {inst.charAt(0).toUpperCase() + inst.slice(1)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {chordsMidiUploaded && (
                      <div className="relative" ref={chordsAnalysisMenuRef}>
                        <button
                          className="p-1 hover:bg-accent-foreground/10 rounded ml-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            setShowChordsAnalysisMenu(!showChordsAnalysisMenu)
                          }}
                        >
                          <ListTree className="w-4 h-4" />
                        </button>
                        {showChordsAnalysisMenu && (
                          <div className="absolute top-0 left-full ml-1 bg-card border border-border rounded-md shadow-lg min-w-[150px]">
                            <button
                              className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                                chordsAnalysisMode === 'chords' ? 'bg-accent' : ''
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setChordsAnalysisMode('chords')
                                setShowChordsAnalysisMenu(false)
                              }}
                            >
                              Chords
                            </button>
                            <button
                              className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                                chordsAnalysisMode === 'roman-numerals' ? 'bg-accent' : ''
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setChordsAnalysisMode('roman-numerals')
                                setShowChordsAnalysisMenu(false)
                              }}
                            >
                              Roman Numerals
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {!chordsMidiUploaded && (
                      <button
                        className="p-1 rounded ml-2 text-muted-foreground cursor-not-allowed"
                        disabled
                      >
                        <ListTree className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      className="p-1 hover:bg-accent-foreground/10 rounded ml-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        chordsMidiFileInputRef.current?.click()
                      }}
                    >
                      <Upload className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2 hover:bg-accent">
                    <button 
                      className={`flex-1 text-left text-sm ${!instrumentalsUploaded ? 'text-muted-foreground' : ''}`}
                      onClick={() => instrumentalsUploaded && changeBackgroundTrack('instrumentals')}
                      disabled={!instrumentalsUploaded}
                    >
                      {!instrumentalsUploaded && <Lock className="w-3 h-3 inline mr-1" />}
                      Instrumentals
                    </button>
                    <button
                      className="p-1 hover:bg-accent-foreground/10 rounded"
                      onClick={(e) => {
                        e.stopPropagation()
                        instrumentalsFileInputRef.current?.click()
                      }}
                    >
                      <Upload className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
            <input
              ref={chordsMidiFileInputRef}
              type="file"
              accept=".mid,.midi"
              onChange={handleChordsMidiUpload}
              className="hidden"
            />
            <input
              ref={instrumentalsFileInputRef}
              type="file"
              accept="audio/*"
              onChange={(e) => handleBackgroundUpload(e, 'instrumentals')}
              className="hidden"
            />

            <input
              ref={sessionFileInputRef}
              type="file"
              accept=".json,.eartrainer.json"
              onChange={handleLoadSessionFile}
              className="hidden"
            />

            <div className="h-6 w-px bg-border mx-1" />

            {/* Playback Speed Control */}
            <div className="flex items-center">
              <span className="text-sm font-medium mr-1">Speed:</span>
              <Button 
                variant="ghost" 
                size="icon"
                className="h-8 w-8"
                onClick={() => changePlaybackSpeed('down')}
                disabled={playbackSpeed === 0.25}
              >
                <ChevronDown className="w-4 h-4" />
              </Button>
              <span className="text-sm font-medium min-w-[40px] text-center">x{playbackSpeed}</span>
              <Button 
                variant="ghost" 
                size="icon"
                className="h-8 w-8"
                onClick={() => changePlaybackSpeed('up')}
                disabled={playbackSpeed === 1.0}
              >
                <ChevronUp className="w-4 h-4" />
              </Button>
            </div>

            <div className="h-6 w-px bg-border mx-1" />

            <Button 
              variant={showAnalysis ? "secondary" : "outline"} 
              size="sm" 
              onClick={() => setShowAnalysis(!showAnalysis)}
            >
              Show Analysis
            </Button>
            
            <div className="relative" ref={midiMenuRef}>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setShowMidiMenu(!showMidiMenu)}
              >
                <Eye className="w-4 h-4 mr-1" />
                Show MIDI <ChevronDown className="w-4 h-4 ml-1" />
              </Button>
              {showMidiMenu && (
                <div className="absolute top-full mt-1 left-0 bg-card border border-border rounded-md shadow-lg z-50 min-w-[150px]">
                  <button 
                    className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                      !midiFileUploaded ? 'text-muted-foreground cursor-not-allowed' : ''
                    } ${displayedMidiTrack === 'melody' ? 'bg-accent' : ''}`}
                    onClick={() => {
                      if (midiFileUploaded) {
                        setDisplayedMidiTrack('melody')
                        setShowMidiMenu(false)
                      }
                    }}
                    disabled={!midiFileUploaded}
                  >
                    {!midiFileUploaded && <Lock className="w-3 h-3 inline mr-1" />}
                    Melody
                  </button>
                  <button 
                    className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                      !chordsMidiUploaded ? 'text-muted-foreground cursor-not-allowed' : ''
                    } ${displayedMidiTrack === 'chords' ? 'bg-accent' : ''}`}
                    onClick={() => {
                      if (chordsMidiUploaded) {
                        setDisplayedMidiTrack('chords')
                        setShowMidiMenu(false)
                      }
                    }}
                    disabled={!chordsMidiUploaded}
                  >
                    {!chordsMidiUploaded && <Lock className="w-3 h-3 inline mr-1" />}
                    Chords
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm">Melody Vol:</span>
              <Slider
                value={[melodyVolume]}
                onValueChange={([v]) => setMelodyVolume(v)}
                min={-30}
                max={6}
                step={1}
                className="w-24"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm">Background Vol:</span>
              <Slider
                value={[backgroundVolume]}
                onValueChange={([v]) => setBackgroundVolume(v)}
                min={-30}
                max={6}
                step={1}
                className="w-24"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <div 
            ref={mainScrollRef}
            className="h-full overflow-y-auto overflow-x-auto"
          >
            <div className="flex flex-col" style={{ minWidth: 'max-content' }}>
              <PianoRoll
                bars={bars}
                timeDivision={timeDivision}
                timeSignature={timeSignature}
                pickupBeats={0}
                isPlaying={isPlaying}
                notes={displayedMidiTrack === 'melody' ? notes : chordsNotes}
                cursorPosition={cursorPosition}
                lowestNote={displayedMidiTrack === 'melody' ? lowestNote : chordsLowestNote}
                highestNote={displayedMidiTrack === 'melody' ? highestNote : chordsHighestNote}
                snapToGrid={false}
                showPlayhead={isPlaying}
                zoom={zoom}
                regionStart={regionStart}
                regionEnd={regionEnd}
                onRegionChange={(start, end) => {
                  setRegionStart(start)
                  setRegionEnd(end)
                }}
                autoScroll={autoScroll}
                mode="read-only"
                showAnalysis={showAnalysis}
                analysisMode={displayedMidiTrack === 'melody' ? melodyAnalysisMode : chordsAnalysisMode}
                tonic={selectedKey}
                keyMode={keyMode}
                noteOpacity={(melodyMode === 'none' || melodyMode === 'vocals') ? 0.3 : 1.0}
                activeMidiKeys={activeMidiKeys}
                isDark={isDark}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-border bg-card px-4 py-2">
        <div className="text-xs text-muted-foreground flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span>{notes.length} notes | {selectedKey} {keyMode} | {timeSignatureToString(timeSignature)} | {tempo} BPM (x{playbackSpeed})</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="h-7 w-7"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
          </div>
          <span>Space to play/stop • Cmd/Ctrl+Scroll to zoom • Shift+Scroll to pan</span>
        </div>
      </div>
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  )
}

export default EarTrainer
