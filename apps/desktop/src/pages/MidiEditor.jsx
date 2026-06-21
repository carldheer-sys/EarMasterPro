import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, Pause, Square, ArrowLeft, Repeat, FileDown, FileUp, Undo2, Redo2, Trash2, Settings, Volume2, Music, ChevronsRight, ChevronDown, ListTree, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DualSlider } from '@/components/ui/DualSlider'
import PianoRoll from '@/components/PianoRollCanvas'
import ReferenceTrack from '@/components/ReferenceTrack'
import BackendControl from '@/components/BackendControl'
import * as Tone from 'tone'
import audioEngine from '@common/lib/audioEngine'
import { beatsPerBarFromTimeSignature, beatsPerDivisionFromTimeDivision, DEFAULT_TIME_SIGNATURE, exportToMidi, saveMidiFile, importFromMidi, normalizeTimeSignature, timeSignatureToString, getInternalBpm } from '@common/lib/midiUtils'
import { generateId } from '@common/lib/musicUtils'
import { useMIDIInput } from '@/hooks/useMIDIInput'
import { useTheme } from '@/hooks/useTheme'

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const TIME_DIVISIONS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32']
const INITIAL_BEAT_WIDTH = 40
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const CELL_HEIGHT = 20

const noteToMidiNum = (noteName) => {
  const match = noteName.match(/^([A-G]#?)(-?\d+)$/)
  if (!match) return 60
  const [, pitch, octave] = match
  const pitchClass = NOTE_NAMES.indexOf(pitch)
  return (parseInt(octave) + 1) * 12 + pitchClass
}

const midiNumToNoteName = (midiNum) => {
  const octave = Math.floor(midiNum / 12) - 1
  const pitch = NOTE_NAMES[midiNum % 12]
  return `${pitch}${octave}`
}

function MidiEditor() {
  const navigate = useNavigate()
  const fileInputRef = useRef(null)
  const { isDark, toggleTheme } = useTheme()

  const [tempo, setTempo] = useState(120)
  const [tempoInputValue, setTempoInputValue] = useState('120')
  const [selectedKey, setSelectedKey] = useState('C')
  const [keyMode, setKeyMode] = useState('Major')
  const [bars, setBars] = useState(4)
  const [barsInputValue, setBarsInputValue] = useState('4')
  const [timeDivision, setTimeDivision] = useState('1/4')
  const [timeSignature, setTimeSignature] = useState(DEFAULT_TIME_SIGNATURE)
  const [timeSignatureNumeratorInput, setTimeSignatureNumeratorInput] = useState(String(DEFAULT_TIME_SIGNATURE.numerator))
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isLooping, setIsLooping] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [cursorPosition, setCursorPosition] = useState(0)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  const [volume, setVolume] = useState(0)
  const [snapToGrid, setSnapToGrid] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  // Clipboard and paste-preview state
  const clipboardRef = useRef([])
  const [pastePreview, setPastePreview] = useState(null) // { notes: [...], offsetBeat, offsetMidi } or null
  const pasteMouseRef = useRef({ x: 0, y: 0 })
  const [isPasteMode, setIsPasteMode] = useState(false)
  const [showAnalysis, setShowAnalysis] = useState(false)
  const [analysisMode, setAnalysisMode] = useState('scale-degrees') // 'notes', 'scale-degrees', 'chords', 'roman-numerals'
  const [showAnalysisMenu, setShowAnalysisMenu] = useState(false)
  const [instrument, setInstrument] = useState('piano')
  
  const [notes, setNotes] = useState([])
  const [history, setHistory] = useState([])
  const [undoHistory, setUndoHistory] = useState([])
  const [lowestNote, setLowestNote] = useState(36)
  const [highestNote, setHighestNote] = useState(60)
  const [showRefTrack, setShowRefTrack] = useState(false)
  const [refAudioBuffer, setRefAudioBuffer] = useState(null)
  const [refAudioPlayer, setRefAudioPlayer] = useState(null)
  const [refAudioVolume, setRefAudioVolume] = useState(0)
  const [refAudioMuted, setRefAudioMuted] = useState(false)
  const [refAudioSolo, setRefAudioSolo] = useState(false)
  const [audioDelay, setAudioDelay] = useState(0)
  // Active region: fractional position 0–1 relative to total bars
  const [regionStart, setRegionStart] = useState(0)   // 0 = bar 1 start
  const [regionEnd, setRegionEnd] = useState(1)       // 1 = last bar end
  const audioFileInputRef = useRef(null)
  const mainScrollRef = useRef(null)
  const audioStopEventRef = useRef(null) // Transport event id for audio stop
  const analysisMenuRef = useRef(null)
  const lastRawContextRef = useRef(null)
  const lastPlaybackVerifiedAtRef = useRef(Date.now())
  const playbackWatchdogTimerRef = useRef(null)

  const beatWidth = INITIAL_BEAT_WIDTH * zoom
  const beatsPerBar = beatsPerBarFromTimeSignature(timeSignature)
  const beatsPerDivision = beatsPerDivisionFromTimeDivision(timeDivision, timeSignature)

  // Reset region to full extent when bars change
  useEffect(() => {
    setRegionStart(0)
    setRegionEnd(1)
  }, [bars])

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
    setTempoInputValue(String(tempo))
  }, [tempo])

  useEffect(() => {
    setBarsInputValue(String(bars))
  }, [bars])

  useEffect(() => {
    setTimeSignatureNumeratorInput(String(timeSignature.numerator))
  }, [timeSignature.numerator])

  // Click outside handler for analysis menu
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (analysisMenuRef.current && !analysisMenuRef.current.contains(e.target)) {
        setShowAnalysisMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    audioEngine.setTempo(tempo, timeSignature)
  }, [tempo, timeSignature])

  useEffect(() => {
    audioEngine.onCursorUpdate = setCursorPosition
    audioEngine.onPlaybackComplete = () => {
      setIsPlaying(false)
      if (!isLooping) {
        setCursorPosition(0)
      }
    }
  }, [isLooping])

  useEffect(() => {
    audioEngine.setLoopEnabled(isLooping, bars)
  }, [isLooping, bars])

  useEffect(() => {
    if (isInitialized && instrument) {
      const configs = {
        'synth': { volume: -5 },
        'piano': { attack: 0.02, release: 1, volume: -6 },
        'violin': { attack: 0.04, release: 1.0, volume: -4 },
        'flute': { attack: 0.04, release: 0.5, volume: -2 },
        'clarinet': { attack: 0.04, release: 0.3, volume: -4 },
        'guitar-acoustic': { attack: 0.01, release: 1.2, volume: -4 }
      }
      audioEngine.loadInstrument(instrument, configs[instrument] || {})
    }
  }, [instrument, isInitialized])

  // Set up MIDI keyboard input for live playing
  const { activeKeys: activeMidiKeys } = useMIDIInput({ enabled: true, instrument, isPlaying })

  const saveHistory = useCallback(() => {
    setHistory(prev => [...prev, notes])
    setUndoHistory([])
  }, [notes])

  const handleUndo = useCallback(() => {
    if (history.length === 0) return
    const newHistory = [...history]
    const previousState = newHistory.pop()
    setHistory(newHistory)
    setUndoHistory(prev => [...prev, notes])
    setNotes(previousState)
  }, [history, notes])

  const handleRedo = useCallback(() => {
    if (undoHistory.length === 0) return
    const newUndoHistory = [...undoHistory]
    const nextState = newUndoHistory.pop()
    setUndoHistory(newUndoHistory)
    setHistory(prev => [...prev, notes])
    setNotes(nextState)
  }, [undoHistory, notes])

  const snapNoteToGrid = useCallback((noteData) => {
    if (!snapToGrid) return noteData
    
    const snappedStart = Math.round(noteData.start / beatsPerDivision) * beatsPerDivision
    const snappedDuration = Math.max(beatsPerDivision, Math.round(noteData.duration / beatsPerDivision) * beatsPerDivision)
    
    return {
      ...noteData,
      start: snappedStart,
      duration: snappedDuration
    }
  }, [snapToGrid, beatsPerDivision])

  const handleNoteAdd = useCallback((note, start, duration) => {
    saveHistory()
    const newNote = {
      id: generateId(),
      note,
      start,
      duration,
      velocity: 0.8
    }
    
    // Polyphonic mode: remove overlapping notes on the same pitch only
    setNotes(prev => {
      const gridStep = beatsPerDivision
      const newEnd = start + duration
      
      const adjustedNotes = prev
        .map(n => {
          // Only check notes with same pitch
          if (n.note !== note) return n
          
          const nEnd = n.start + n.duration
          const isOverlapping = start < nEnd && newEnd > n.start
          
          if (!isOverlapping) return n
          
          // Shorten or remove overlapping note
          let shortened = start - n.start
          if (snapToGrid) {
            shortened = Math.floor(shortened / gridStep) * gridStep
          }
          if (shortened <= 0) return null
          return { ...n, duration: shortened }
        })
        .filter(Boolean)
      
      return [...adjustedNotes, newNote]
    })
    
    // Play preview sound
    audioEngine.playNote(note, '8n', instrument)
    
    // If playback is active, schedule this note immediately so it plays during current session
    if (isPlaying && Tone.Transport.state === 'started') {
      const totalBeats = bars * beatsPerBar
      const startBeat = regionStart * totalBeats
      const endBeat = regionEnd * totalBeats
      
      // Check if new note is within the active region
      if (start >= startBeat && start < endBeat) {
        const ppq = Tone.Transport.PPQ
        const tempo = Tone.Transport.bpm.value
        const secondsPerBeat = 60 / tempo
        
        // Remap note to region-relative position
        const regionRelativeStart = start - startBeat
        const startTick = Math.round(regionRelativeStart * ppq)
        const durationTicks = Math.round(duration * ppq)
        
        // Get the instrument object
        let instrumentObj
        if (instrument === 'synth') {
          instrumentObj = audioEngine.synths['synth']
        } else {
          instrumentObj = audioEngine.samplers[instrument] || audioEngine.samplers['piano']
        }
        
        if (instrumentObj) {
          const volumeMultiplier = Math.pow(10, volume / 20)
          const finalVelocity = Math.min(Math.max(0.8 * volumeMultiplier, 0), 1)
          
          // Schedule the note on the Transport
          const eventId = Tone.Transport.schedule((time) => {
            instrumentObj.triggerAttackRelease(
              note,
              durationTicks + "i",
              time,
              finalVelocity
            )
          }, startTick + "i")
          
          // Track this event for cleanup
          audioEngine.scheduledEvents.push({ id: eventId, tick: startTick })
        }
      }
    }
  }, [saveHistory, instrument, isPlaying, bars, beatsPerBar, beatsPerDivision, regionStart, regionEnd, volume, snapToGrid])

  const handleNoteUpdate = useCallback((id, updates) => {
    setNotes(prev => {
      const gridStep = beatsPerDivision
      
      // Apply update to target note
      let newNotes = prev.map(n => n.id === id ? { ...n, ...updates } : n)
      
      // Find the updated note and original note
      const updatedNote = newNotes.find(n => n.id === id)
      const originalNote = prev.find(n => n.id === id)
      
      if (!updatedNote || !originalNote) return prev
      
      // Determine what type of edit was made
      const isDraggingEnd = Math.abs(updatedNote.start - originalNote.start) < 0.001 && 
                           Math.abs(updatedNote.duration - originalNote.duration) > 0.001
      const isDraggingStart = Math.abs(updatedNote.start - originalNote.start) > 0.001 && 
                             Math.abs((updatedNote.start + updatedNote.duration) - (originalNote.start + originalNote.duration)) < 0.001
      const isMoving = Math.abs(updatedNote.start - originalNote.start) > 0.001 && 
                      Math.abs(updatedNote.duration - originalNote.duration) < 0.001
      
      // Resolve overlaps (polyphonic mode - only same pitch)
      const resolved = newNotes.map(n => {
        if (n.id === id) return n // Don't modify the updated note itself
        if (n.note !== updatedNote.note) return n // Only check same pitch
        
        const nEnd = n.start + n.duration
        const updatedEnd = updatedNote.start + updatedNote.duration
        const isOverlapping = updatedNote.start < nEnd && updatedEnd > n.start
        
        if (!isOverlapping) return n
        
        // Determine if this note is to the right of the original position
        let isTargetRight = n.start >= originalNote.start
        
        if (isMoving) {
          const movingRight = updatedNote.start > originalNote.start
          isTargetRight = movingRight ? (n.start >= originalNote.start) : (n.start > originalNote.start)
        } else if (isDraggingStart) {
          isTargetRight = false
        } else if (isDraggingEnd) {
          isTargetRight = true
        }
        
        if (isTargetRight) {
          // Note is to the right - move its start to end of updated note
          let newNStart = updatedEnd
          if (snapToGrid) {
            newNStart = Math.max(n.start, Math.ceil(updatedEnd / gridStep) * gridStep)
          }
          const newNDuration = nEnd - newNStart
          if (newNDuration <= 0) return null // Remove if too short
          return { ...n, start: newNStart, duration: newNDuration }
        } else {
          // Note is to the left - shorten its duration
          let shortened = updatedNote.start - n.start
          if (snapToGrid) {
            shortened = Math.floor(shortened / gridStep) * gridStep
          }
          if (shortened <= 0) return null // Remove if too short
          return { ...n, duration: shortened }
        }
      }).filter(Boolean)
      
      return resolved
    })
  }, [snapToGrid, beatsPerDivision])

  const handleNoteDelete = useCallback((id) => {
    saveHistory()
    setNotes(prev => prev.filter(n => n.id !== id))
  }, [saveHistory])

  // Handle note selection
  const handleNotesSelect = useCallback((ids, exclusive = true, toggle = false) => {
    setNotes(prev => {
      if (toggle) {
        // Toggle selection for specified IDs
        const toggledNotes = prev.map(n => {
          if (ids.includes(n.id)) {
            return { ...n, selected: !n.selected }
          }
          return n
        })
        // Play newly selected notes
        const newlySelected = toggledNotes.filter(n => n.selected && ids.includes(n.id))
        newlySelected.forEach(n => {
          audioEngine.playNote(n.note, '8n', instrument)
        })
        return toggledNotes
      }
      
      if (exclusive) {
        // Clear all selections, then select only specified IDs
        const updated = prev.map(n => ({
          ...n,
          selected: ids.includes(n.id)
        }))
        // Play the selected notes
        const selectedNotes = updated.filter(n => n.selected)
        selectedNotes.forEach(n => {
          audioEngine.playNote(n.note, '8n', instrument)
        })
        return updated
      }
      
      // Non-exclusive: add to existing selection
      const updated = prev.map(n => {
        if (ids.includes(n.id)) {
          return { ...n, selected: true }
        }
        return n
      })
      // Play the newly selected notes
      const newSelected = updated.filter(n => ids.includes(n.id))
      newSelected.forEach(n => {
        audioEngine.playNote(n.note, '8n', instrument)
      })
      return updated
    })
  }, [instrument])

  // Play all selected notes when a drag ends (notes were moved)
  const handleDragEnd = useCallback(() => {
    const selectedNotes = notes.filter(n => n.selected)
    selectedNotes.forEach(n => {
      audioEngine.playNote(n.note, '8n', instrument)
    })
  }, [notes, instrument])

  const handleSnapAllToGrid = useCallback(() => {
    if (!snapToGrid) return
    saveHistory()
    setNotes(prev => prev.map(note => snapNoteToGrid(note)))
  }, [snapToGrid, saveHistory, snapNoteToGrid])

  useEffect(() => {
    if (snapToGrid) {
      handleSnapAllToGrid()
    }
  }, [snapToGrid])

  // ── Copy selected notes to clipboard ──
  const handleCopy = useCallback(() => {
    const selected = notes.filter(n => n.selected)
    if (selected.length === 0) return
    // Find top-left-most note as anchor
    const sorted = [...selected].sort((a, b) => {
      const aMidi = noteToMidiNum(a.note)
      const bMidi = noteToMidiNum(b.note)
      if (Math.abs(a.start - b.start) < 0.001) return bMidi - aMidi // higher pitch first
      return a.start - b.start
    })
    const anchorStart = sorted[0].start
    const anchorMidi = noteToMidiNum(sorted[0].note)
    clipboardRef.current = selected.map(n => ({
      note: n.note,
      start: n.start - anchorStart,
      duration: n.duration,
      velocity: n.velocity || 0.8,
      _relMidi: noteToMidiNum(n.note) - anchorMidi
    }))
  }, [notes])

  // ── Paste: enter paste mode, notes follow mouse ──
  const handlePaste = useCallback(() => {
    if (clipboardRef.current.length === 0) return
    setIsPasteMode(true)
  }, [])

  // ── Compute paste preview from mouse position ──
  const computePastePreview = useCallback((clientX, clientY) => {
    if (clipboardRef.current.length === 0) return null
    const scrollEl = mainScrollRef.current
    if (!scrollEl) return null

    // Find the PianoRoll canvas element inside the scroll container
    const canvasEl = scrollEl.querySelector('canvas')
    if (!canvasEl) return null

    const canvasRect = canvasEl.getBoundingClientRect()
    const canvasX = clientX - canvasRect.left
    const canvasY = clientY - canvasRect.top

    if (canvasX < 0 || canvasY < 0) return null

    const bw = INITIAL_BEAT_WIDTH * zoom
    const beat = canvasX / bw
    const noteIndex = Math.floor(canvasY / CELL_HEIGHT)
    const midiNum = highestNote - noteIndex

    // Snap beat to grid if enabled
    let snappedBeat = beat
    if (snapToGrid) {
      snappedBeat = Math.round(beat / beatsPerDivision) * beatsPerDivision
    }

    // Clamp midi to visible range
    const clampedMidi = Math.max(lowestNote, Math.min(highestNote, midiNum))

    // Build preview notes
    const previewNotes = clipboardRef.current.map((cn, i) => {
      const noteMidi = clampedMidi + cn._relMidi
      let noteStart = snappedBeat + cn.start
      if (snapToGrid) {
        noteStart = Math.round(noteStart / beatsPerDivision) * beatsPerDivision
      }
      return {
        id: `preview-${i}`,
        note: midiNumToNoteName(Math.max(0, Math.min(127, noteMidi))),
        start: Math.max(0, noteStart),
        duration: cn.duration,
        velocity: cn.velocity,
        selected: false,
        isPreview: true
      }
    })

    return { notes: previewNotes, anchorBeat: snappedBeat, anchorMidi: clampedMidi }
  }, [zoom, snapToGrid, beatsPerDivision, lowestNote, highestNote])

  // ── Place pasted notes at current mouse position ──
  const handlePastePlace = useCallback(() => {
    const preview = pastePreview
    if (!preview || preview.notes.length === 0) return
    saveHistory()
    const newNotes = preview.notes.map(pn => ({
      id: generateId(),
      note: pn.note,
      start: pn.start,
      duration: pn.duration,
      velocity: pn.velocity || 0.8
    }))
    setNotes(prev => [...prev, ...newNotes])
    setIsPasteMode(false)
    setPastePreview(null)
  }, [pastePreview, saveHistory])

  // ── Cancel paste mode (Escape) ──
  const handlePasteCancel = useCallback(() => {
    setIsPasteMode(false)
    setPastePreview(null)
  }, [])

  // ── Transpose selected notes by semitone delta ──
  const handleTranspose = useCallback((semitones) => {
    const selectedIds = notes.filter(n => n.selected).map(n => n.id)
    if (selectedIds.length === 0) return
    saveHistory()
    setNotes(prev => prev.map(n => {
      if (!n.selected) return n
      const midi = noteToMidiNum(n.note) + semitones
      const clamped = Math.max(0, Math.min(127, midi))
      return { ...n, note: midiNumToNoteName(clamped) }
    }))
  }, [notes, saveHistory])

  // Clear paste preview when exiting paste mode
  useEffect(() => {
    if (!isPasteMode) {
      setPastePreview(null)
    }
  }, [isPasteMode])

  const handleClearAll = useCallback(() => {
    if (notes.length === 0) return
    console.log('[handleClearAll] Clearing all notes. Current notes count:', notes.length)
    console.log('[handleClearAll] Notes being cleared:', notes.map(n => ({ id: n.id, note: n.note, start: n.start })))
    saveHistory()
    setNotes([])
    console.log('[handleClearAll] Notes cleared. New state should be empty.')
  }, [notes, saveHistory])

  const ensurePlaybackAudio = useCallback(async () => {
    const { contextChanged, rawContext } = await audioEngine.ensureActive({ loadDefaultPiano: false })
    if (contextChanged || lastRawContextRef.current !== rawContext) {
      await audioEngine.loadInstrument('piano', { attack: 0.02, release: 1, volume: -6 })
      await audioEngine.loadInstrument('synth', { volume: -8 })
      if (instrument) {
        const configs = {
          'synth': { volume: -5 },
          'piano': { attack: 0.02, release: 1, volume: -6 },
          'violin': { attack: 0.04, release: 1.0, volume: -4 },
          'flute': { attack: 0.04, release: 0.5, volume: -2 },
          'clarinet': { attack: 0.04, release: 0.3, volume: -4 },
          'guitar-acoustic': { attack: 0.01, release: 1.2, volume: -4 }
        }
        await audioEngine.loadInstrument(instrument, configs[instrument] || {})
      }
      if (refAudioBuffer) {
        if (refAudioPlayer) {
          try { refAudioPlayer.dispose() } catch (_) {}
        }
        const player = new Tone.Player(refAudioBuffer).toDestination()
        player.loop = isLooping
        player.volume.value = refAudioSolo ? refAudioVolume : (refAudioMuted ? -Infinity : refAudioVolume)
        setRefAudioPlayer(player)
        lastRawContextRef.current = rawContext
        return player
      }
      lastRawContextRef.current = rawContext
    }
    setIsInitialized(true)
    return refAudioPlayer
  }, [instrument, refAudioBuffer, refAudioPlayer, isLooping, refAudioSolo, refAudioVolume, refAudioMuted])

  const handlePlay = useCallback(async () => {
    if (!isInitialized && !audioEngine.isInitialized) return

    console.log('[handlePlay] Starting playback. Notes in state:', notes.length)
    console.log('[handlePlay] First 5 notes:', notes.slice(0, 5).map(n => ({ id: n.id, note: n.note, start: n.start })))

    let activeRefAudioPlayer
    try {
      activeRefAudioPlayer = await ensurePlaybackAudio()
    } catch (error) {
      console.error('Failed to prepare audio playback:', error)
      alert('Audio playback could not be recovered. Please try again.')
      return
    }

    const internalTempo = getInternalBpm(tempo, timeSignature)
    const pixelsPerSecond = beatWidth * internalTempo / 60
    const audioDurationPx = refAudioBuffer ? Math.max(1, Math.ceil(refAudioBuffer.duration * pixelsPerSecond)) : 0
    const waveformOffsetPx = audioDelay * pixelsPerSecond

    const beatsPerSecond = internalTempo / 60
    const musicalBeats = bars * beatsPerBar
    const totalBeats = musicalBeats
    const startBeat = regionStart * totalBeats
    const endBeat   = regionEnd   * totalBeats
    const regionBeats = endBeat - startBeat
    const regionDurationSeconds = regionBeats / beatsPerSecond
    
    // For audio playback: calculate seconds into the audio buffer where region starts
    // The audio buffer represents the full song starting at position 0 (beginning of piano roll)
    // When regionStart = 0, we start from buffer position 0
    // When regionStart > 0, we offset by the corresponding seconds
    const regionStartSeconds = startBeat / beatsPerSecond
    const bufferOffset = Math.max(0, regionStartSeconds - audioDelay)
    const startDelay  = Math.max(0, audioDelay - regionStartSeconds)
    
    console.log('[handlePlay] Audio timing:', {
      regionStart,
      regionEnd,
      startBeat,
      totalBeats,
      regionStartSeconds,
      bufferOffset,
      startDelay,
      audioDelay
    })
    // For audio/MIDI sync: notes are remapped relative to startBeat position
    // So the audio engine totalTicks must match the visual region beats exactly
    const regionTotalBeats = endBeat - startBeat  // Total beats in the active region
    // regionDurationSeconds already calculated above as regionBeats / beatsPerSecond

    // Filter + remap notes into region — only notes that START within the region
    const regionNotes = notes
      .filter(n => n.start >= startBeat - 1e-6 && n.start < endBeat)
      .map(n => {
        return {
          ...n,
          start: n.start - startBeat,
          duration: Math.min(n.start + n.duration, endBeat) - n.start
        }
      })

    console.log('[handlePlay] Region notes to schedule:', regionNotes.length)
    console.log('[handlePlay] Region notes:', regionNotes.map(n => ({ id: n.id, note: n.note, start: n.start })))

    audioEngine.clearScheduledNotes()
    Tone.Transport.timeSignature = beatsPerBar

    // Set totalTicks to EXACT musical region beats (without pickup) so playhead progress matches audio
    const ppq = 192 // Tone.js default PPQ
    // Use regionTotalBeats for totalTicks so playhead and audio engine stay in sync
    audioEngine.totalTicks = Math.round(regionTotalBeats * ppq)
    audioEngine.scheduleNotes(regionNotes, timeDivision, Math.ceil(regionTotalBeats / beatsPerBar), instrument, volume)
    audioEngine.totalTicks = Math.round(regionTotalBeats * ppq)

    if (!isLooping) {
      audioEngine.scheduleStopAtSeconds(regionDurationSeconds)
    } else {
      // Use exact beat duration for precise loop synchronization
      // Use regionTotalBeats (matching the visual/playhead) for consistent timing
      audioEngine.setLoopEnabledBeats(true, regionTotalBeats)
    }

    const playbackStartedFrom = {
      rawTime: Tone.context.rawContext?.currentTime || 0,
      transportTicks: Tone.Transport.ticks,
      cursorPosition
    }
    await audioEngine.start()

    // ── Audio player: always driven by Transport so it stays in sync ──
    if (activeRefAudioPlayer && showRefTrack) {
      // Clear any previous Transport stop event for audio
      if (audioStopEventRef.current !== null) {
        Tone.Transport.clear(audioStopEventRef.current)
        audioStopEventRef.current = null
      }

      // Offset into the audio buffer where the region starts
      // Use startBeat (relative to beginning of piano roll) for audio timing
      const regionStartSeconds = startBeat / beatsPerSecond
      // Effective delay: user audioDelay shifts waveform relative to transport t=0
      const bufferOffset = Math.max(0, regionStartSeconds - audioDelay)
      const startDelay  = Math.max(0, audioDelay - regionStartSeconds)

      if (isLooping) {
        // Configure player to loop between the two region points in the buffer
        activeRefAudioPlayer.loop = true
        activeRefAudioPlayer.loopStart = bufferOffset
        activeRefAudioPlayer.loopEnd   = bufferOffset + regionDurationSeconds
      } else {
        activeRefAudioPlayer.loop = false
        // Schedule audio stop at exact region end on the Transport timeline
        audioStopEventRef.current = Tone.Transport.schedule(() => {
          try { activeRefAudioPlayer.stop() } catch (_) {}
        }, `${regionDurationSeconds}`)
      }

      console.log('[handlePlay] Starting audio player:', {
        bufferOffset,
        startDelay,
        regionDurationSeconds,
        isLooping
      })
      activeRefAudioPlayer.start(`+${startDelay}`, bufferOffset)
    }

    setIsPlaying(true)
    setIsPaused(false)

    if (playbackWatchdogTimerRef.current) window.clearTimeout(playbackWatchdogTimerRef.current)
    playbackWatchdogTimerRef.current = window.setTimeout(async () => {
      const rawContext = Tone.context.rawContext
      const rawAdvanced = rawContext ? rawContext.currentTime > playbackStartedFrom.rawTime + 0.15 : false
      const ticksAdvanced = Tone.Transport.ticks > playbackStartedFrom.transportTicks + 2
      const cursorAdvanced = cursorPosition > playbackStartedFrom.cursorPosition + 0.001
      if (Tone.context.state === 'running' && rawAdvanced && (ticksAdvanced || cursorAdvanced)) {
        lastPlaybackVerifiedAtRef.current = Date.now()
        return
      }
      try {
        console.warn('[MidiEditor] Playback stalled; rebuilding audio context')
        if (audioStopEventRef.current !== null) {
          Tone.Transport.clear(audioStopEventRef.current)
          audioStopEventRef.current = null
        }
        audioEngine.stop()
        if (activeRefAudioPlayer) {
          try { activeRefAudioPlayer.stop() } catch (_) {}
        }
        setIsPlaying(false)
        setIsPaused(false)
        await audioEngine.ensureActive({ forceRebuild: true, loadDefaultPiano: false })
        lastRawContextRef.current = Tone.context.rawContext
        setIsInitialized(false)
        await audioEngine.loadInstrument('piano', { attack: 0.02, release: 1, volume: -6 })
        await audioEngine.loadInstrument('synth', { volume: -8 })
        setIsInitialized(true)
        window.setTimeout(() => handlePlay(), 150)
      } catch (error) {
        console.error('Automatic audio recovery failed:', error)
        alert('Audio playback stalled and could not be recovered automatically. Please try pressing Play again.')
      }
    }, 900)
  }, [isInitialized, notes, timeDivision, bars, beatsPerBar, volume, isLooping, instrument, showRefTrack, audioDelay, tempo, timeSignature, regionStart, regionEnd, ensurePlaybackAudio, cursorPosition])

  const handleStop = useCallback(() => {
    if (playbackWatchdogTimerRef.current) {
      window.clearTimeout(playbackWatchdogTimerRef.current)
      playbackWatchdogTimerRef.current = null
    }
    // Clear the scheduled audio stop event if it exists
    if (audioStopEventRef.current !== null) {
      Tone.Transport.clear(audioStopEventRef.current)
      audioStopEventRef.current = null
    }
    audioEngine.stop()
    if (refAudioPlayer) {
      try { refAudioPlayer.stop() } catch (_) {}
    }
    setIsPlaying(false)
    setIsPaused(false)
  }, [refAudioPlayer])

  const handleExport = useCallback(async () => {
    if (notes.length === 0) {
      alert('No notes to export!')
      return
    }

    try {
      const blob = exportToMidi(notes, tempo, timeDivision, 0, selectedKey, keyMode, timeSignature)
      await saveMidiFile(blob, 'ear_master_pro_sequence')
    } catch (error) {
      console.error('Export failed:', error)
      alert('Failed to export MIDI file')
    }
  }, [notes, tempo, timeDivision, selectedKey, keyMode, timeSignature])

  const handleImport = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

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
      
      saveHistory()
      setNotes(importedNotes)
      setBars(importedBars)
      setTempo(importedTempo)
      setTimeDivision(importedTimeDivision)
      setTimeSignature(normalizeTimeSignature(importedTimeSignature))
      setSelectedKey(importedKey)
      setKeyMode(importedKeyMode)
      setLowestNote(importedLowestNote)
      setHighestNote(importedHighestNote)
    } catch (error) {
      console.error('Import failed:', error)
      alert('Failed to import MIDI file')
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [tempo, saveHistory])

  const handleAudioImport = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const arrayBuffer = await file.arrayBuffer()
      await audioEngine.ensureActive({ loadDefaultPiano: false })
      const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer)
      
      setRefAudioBuffer(audioBuffer)
      
      if (refAudioPlayer) {
        refAudioPlayer.dispose()
      }
      
      const player = new Tone.Player(audioBuffer).toDestination()
      player.loop = isLooping
      // Playback length is determined by active region - use full bars count, not affected by pickup
      const internalTempo = getInternalBpm(tempo, timeSignature)
      const totalMusicalDuration = (bars * beatsPerBar * 60) / internalTempo
      player.loopEnd = Math.min(totalMusicalDuration, audioBuffer.duration)
      setRefAudioPlayer(player)
      setShowRefTrack(true)
    } catch (error) {
      console.error('Failed to load audio file:', error)
      alert('Failed to load audio file')
    }

    if (audioFileInputRef.current) {
      audioFileInputRef.current.value = ''
    }
  }, [bars, beatsPerBar, tempo, isLooping, refAudioPlayer])

  useEffect(() => {
    if (refAudioPlayer && refAudioBuffer) {
      refAudioPlayer.loop = isLooping
      // Playback length is determined by active region - use full bars count
      const internalTempo = getInternalBpm(tempo, timeSignature)
      const totalMusicalDuration = (bars * beatsPerBar * 60) / internalTempo
      const maxDuration = refAudioBuffer.duration
      refAudioPlayer.loopEnd = Math.min(totalMusicalDuration, maxDuration)
    }
  }, [isLooping, bars, beatsPerBar, tempo, timeSignature, refAudioPlayer, refAudioBuffer])


  useEffect(() => {
    if (refAudioPlayer) {
      if (refAudioSolo) {
        refAudioPlayer.volume.value = refAudioVolume
      } else {
        refAudioPlayer.volume.value = refAudioMuted ? -Infinity : refAudioVolume
      }
    }
  }, [refAudioMuted, refAudioVolume, refAudioPlayer, refAudioSolo])

  useEffect(() => {
    if (refAudioSolo) {
      audioEngine.setVolume(-Infinity)
    } else {
      audioEngine.setVolume(volume)
    }
  }, [refAudioSolo, volume])

  const handleRefAudioMuteToggle = useCallback(() => {
    const newMuted = !refAudioMuted
    setRefAudioMuted(newMuted)
    if (newMuted) setRefAudioSolo(false)
  }, [refAudioMuted])

  const handleRefAudioSoloToggle = useCallback(() => {
    const newSolo = !refAudioSolo
    setRefAudioSolo(newSolo)
    if (newSolo) setRefAudioMuted(false)
  }, [refAudioSolo])

  // Wheel handler attached directly to the scroll container (non-passive).
  // On macOS, Shift+vertical scroll is converted by the OS into a horizontal
  // wheel event (deltaX, shiftKey=false). We intercept ALL horizontal intent
  // (deltaX !== 0 OR shiftKey+deltaY) and drive scrollLeft ourselves.
  // overflow-x is set to 'hidden' on the container so the browser never
  // consumes horizontal scroll natively — our handler owns it completely.
  const zoomCenterBeatRef = useRef(null)

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
        // The canvas starts after the 120px sticky label column
        const centerCanvasX = scrollEl.scrollLeft + (containerWidth / 2) - 120
        const oldBeatWidth = INITIAL_BEAT_WIDTH * zoomRef.current
        zoomCenterBeatRef.current = centerCanvasX / oldBeatWidth

        setZoom(prev => {
          const factor = e.deltaY > 0 ? 0.9 : 1.1
          return Math.max(0.5, Math.min(3, prev * factor))
        })
      } else if (isHorizontal) {
        e.preventDefault()
        // deltaX from OS Shift+scroll, or shiftKey+deltaY as fallback
        const delta = Math.abs(e.deltaX) > 0 ? e.deltaX : e.deltaY
        scrollEl.scrollLeft += delta
      }
      // plain vertical scroll: let browser handle natively (no preventDefault)
    }

    scrollEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', handleWheel)
  }, [])

  // Adjust scroll position synchronously after zoom changes to prevent flicker.
  // useLayoutEffect runs after DOM updates but BEFORE the browser paints,
  // so the user never sees an intermediate frame with wrong scroll position.
  useLayoutEffect(() => {
    if (zoomCenterBeatRef.current === null) return
    const scrollEl = mainScrollRef.current
    if (!scrollEl) return
    const containerWidth = scrollEl.offsetWidth
    const newBeatWidth = INITIAL_BEAT_WIDTH * zoom
    // Position scroll so the same beat stays at the center of the viewport
    const newCenterCanvasX = zoomCenterBeatRef.current * newBeatWidth
    const newScrollLeft = newCenterCanvasX - (containerWidth / 2) + 120
    scrollEl.scrollLeft = Math.max(0, newScrollLeft)
    zoomCenterBeatRef.current = null
  }, [zoom])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        e.preventDefault()
        if (isPlaying) {
          handleStop()
        } else {
          handlePlay()
        }
      }
      
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        handleUndo()
      }
      
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault()
        handleRedo()
      }
      
      // Delete/Backspace to delete selected notes
      if ((e.key === 'Delete' || e.key === 'Backspace') && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        e.preventDefault()
        const selectedNoteIds = notes.filter(n => n.selected).map(n => n.id)
        if (selectedNoteIds.length > 0) {
          saveHistory()
          setNotes(prev => prev.filter(n => !selectedNoteIds.includes(n.id)))
        }
      }

      // Copy selected notes
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        e.preventDefault()
        handleCopy()
      }

      // Paste: enter paste mode
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        e.preventDefault()
        handlePaste()
      }

      // Escape: cancel paste mode
      if (e.key === 'Escape' && isPasteMode) {
        e.preventDefault()
        handlePasteCancel()
      }

      // Arrow keys: transpose selected notes
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        e.preventDefault()
        const semitones = e.key === 'ArrowUp' ? 1 : -1
        const octaveMultiplier = (e.metaKey || e.ctrlKey) ? 12 : 1
        handleTranspose(semitones * octaveMultiplier)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isPlaying, handlePlay, handleStop, handleUndo, handleRedo, notes, saveHistory, handleCopy, handlePaste, handlePasteCancel, handleTranspose, isPasteMode])

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="border-b border-border bg-card">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/')}
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-2xl font-bold">MIDI Editor</h1>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Tempo:</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={tempoInputValue}
                onChange={(e) => setTempoInputValue(e.target.value)}
                onBlur={() => {
                  const v = parseInt(tempoInputValue, 10)
                  if (!isNaN(v) && v >= 20 && v <= 400) {
                    setTempo(v)
                    setTempoInputValue(String(v))
                  } else {
                    setTempoInputValue(String(tempo))
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.target.blur()
                  }
                }}
                className="w-14 px-2 py-1 text-sm rounded border border-border bg-background text-foreground text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                style={{ MozAppearance: 'textfield' }}
              />
              <div className="flex flex-col">
                <button onClick={() => setTempo(t => Math.min(400, t + 1))} className="h-4 w-5 flex items-center justify-center rounded-t bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] leading-none border border-border">▲</button>
                <button onClick={() => setTempo(t => Math.max(20, t - 1))} className="h-4 w-5 flex items-center justify-center rounded-b bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] leading-none border-x border-b border-border">▼</button>
              </div>
              <span className="text-sm text-muted-foreground">BPM</span>
            </div>

            <div className="h-6 w-px bg-border" />

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Time:</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={timeSignatureNumeratorInput}
                onChange={(e) => setTimeSignatureNumeratorInput(e.target.value)}
                onBlur={() => {
                  const numerator = parseInt(timeSignatureNumeratorInput, 10)
                  if (!isNaN(numerator) && numerator >= 1) {
                    setTimeSignature(prev => normalizeTimeSignature({ ...prev, numerator }))
                    setTimeSignatureNumeratorInput(String(numerator))
                  } else {
                    setTimeSignatureNumeratorInput(String(timeSignature.numerator))
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.target.blur()
                  }
                }}
                className="w-12 px-2 py-1 text-sm rounded border border-border bg-background text-foreground text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                style={{ MozAppearance: 'textfield' }}
              />
              <div className="flex flex-col">
                <button
                  onClick={() => setTimeSignature(prev => normalizeTimeSignature({ ...prev, numerator: prev.numerator + 1 }))}
                  className="h-4 w-5 flex items-center justify-center rounded-t bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] leading-none border border-border"
                >
                  ▲
                </button>
                <button
                  onClick={() => setTimeSignature(prev => normalizeTimeSignature({ ...prev, numerator: Math.max(1, prev.numerator - 1) }))}
                  className="h-4 w-5 flex items-center justify-center rounded-b bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] leading-none border-x border-b border-border"
                >
                  ▼
                </button>
              </div>
              <span className="text-sm text-muted-foreground">/</span>
              <Select
                value={String(timeSignature.denominator)}
                onChange={(e) => setTimeSignature(prev => normalizeTimeSignature({ ...prev, denominator: parseInt(e.target.value, 10) }))}
                className="h-8 w-16 px-2 py-1"
              >
                <option value="4">4</option>
                <option value="8">8</option>
              </Select>
            </div>

            <div className="h-6 w-px bg-border" />

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Key:</label>
              <Select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} className="h-8 w-20 px-2 py-1">
                {KEYS.map(key => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </Select>
              <Select value={keyMode} onChange={(e) => setKeyMode(e.target.value)} className="h-8 w-24 px-2 py-1">
                <option value="Major">Major</option>
                <option value="Minor">Minor</option>
              </Select>
            </div>

            <div className="h-6 w-px bg-border" />

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Bars:</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={barsInputValue}
                onChange={(e) => setBarsInputValue(e.target.value)}
                onBlur={() => {
                  const v = parseInt(barsInputValue, 10)
                  if (!isNaN(v) && v >= 1) {
                    setBars(v)
                    setBarsInputValue(String(v))
                  } else {
                    setBarsInputValue(String(bars))
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.target.blur()
                  }
                }}
                className="w-12 px-2 py-1 text-sm rounded border border-border bg-background text-foreground text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                style={{ MozAppearance: 'textfield' }}
              />
              <div className="flex flex-col">
                <button onClick={() => setBars(b => b + 1)} className="h-4 w-5 flex items-center justify-center rounded-t bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] leading-none border border-border">▲</button>
                <button onClick={() => setBars(b => Math.max(1, b - 1))} className="h-4 w-5 flex items-center justify-center rounded-b bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] leading-none border-x border-b border-border">▼</button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Division:</label>
              <Select value={timeDivision} onChange={(e) => setTimeDivision(e.target.value)} className="h-8 w-20 px-2 py-1">
                {TIME_DIVISIONS.map(div => (
                  <option key={div} value={div}>{div}</option>
                ))}
              </Select>
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8">
                  <Settings className="w-4 h-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="space-y-4">
                  <h3 className="font-semibold">Workspace Settings</h3>
                  
                  <div className="space-y-3">
                    <label className="text-sm font-medium">Piano Roll Range</label>
                    <DualSlider
                      min={0}
                      max={107}
                      value={[lowestNote, highestNote]}
                      onChange={([low, high]) => {
                        setLowestNote(low)
                        setHighestNote(high)
                      }}
                      minDistance={12}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Instrument</label>
                    <Select value={instrument} onChange={(e) => setInstrument(e.target.value)} className="w-full">
                      <option value="synth">Synth</option>
                      <option value="piano">Piano</option>
                      <option value="violin">Violin</option>
                      <option value="flute">Flute</option>
                      <option value="clarinet">Clarinet</option>
                      <option value="guitar-acoustic">Guitar</option>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <Volume2 className="w-4 h-4" />
                      Volume: {volume > 0 ? '+' : ''}{volume} dB
                    </label>
                    <Slider
                      value={[volume]}
                      onValueChange={([val]) => setVolume(val)}
                      min={-20}
                      max={10}
                      step={1}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Zoom: {zoom.toFixed(1)}x</label>
                    <Slider
                      value={[zoom]}
                      onValueChange={([val]) => setZoom(val)}
                      min={0.5}
                      max={3}
                      step={0.1}
                    />
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <BackendControl />
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-muted/30 rounded-md p-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePlay}
                disabled={!isInitialized || isPlaying}
                className={`h-8 ${isPlaying ? 'bg-white text-black hover:bg-white/90' : ''}`}
              >
                <Play className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStop}
                disabled={!isInitialized || (!isPlaying && !isPaused)}
                className="h-8"
              >
                <Square className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsLooping(!isLooping)}
                className={`h-8 ${isLooping ? 'bg-white text-black hover:bg-white/90' : ''}`}
              >
                <Repeat className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAutoScroll(!autoScroll)}
                className={`h-8 px-2 ${autoScroll ? 'bg-white text-black hover:bg-white/90' : ''}`}
                title="Auto-scroll during playback"
              >
                <ChevronsRight className="w-4 h-4 mr-1" />
                <span className="text-xs">Auto</span>
              </Button>
            </div>

            <div className="h-6 w-px bg-border mx-1" />

            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRefTrack(!showRefTrack)}
              className={showRefTrack ? 'bg-white text-black hover:bg-white/90' : ''}
            >
              <Music className="w-4 h-4 mr-1" />
              Ref Track
            </Button>

            {showRefTrack && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => audioFileInputRef.current?.click()}
              >
                <FileUp className="w-4 h-4 mr-1" />
                {refAudioBuffer ? 'Change Audio' : 'Load Audio'}
              </Button>
            )}

            <input
              ref={audioFileInputRef}
              type="file"
              accept="audio/mp3,audio/wav,audio/mpeg,audio/wave"
              onChange={handleAudioImport}
              className="hidden"
            />

            <div className="h-6 w-px bg-border mx-1" />

            <Button variant="outline" size="sm" onClick={handleUndo} disabled={history.length === 0}>
              <Undo2 className="w-4 h-4 mr-1" /> Undo
            </Button>
            <Button variant="outline" size="sm" onClick={handleRedo} disabled={undoHistory.length === 0}>
              <Redo2 className="w-4 h-4 mr-1" /> Redo
            </Button>

            <div className="h-6 w-px bg-border mx-1" />

            <Button variant="outline" size="sm" onClick={handleClearAll}>
              Clear All
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowAnalysis(!showAnalysis)}
              className={showAnalysis ? 'bg-white text-black hover:bg-white/90' : ''}
            >
              Show Analysis
            </Button>
            
            <div className="relative" ref={analysisMenuRef}>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setShowAnalysisMenu(!showAnalysisMenu)}
              >
                <ListTree className="w-4 h-4 mr-1" />
                Analysis <ChevronDown className="w-4 h-4 ml-1" />
              </Button>
              {showAnalysisMenu && (
                <div className="absolute top-full mt-1 left-0 bg-card border border-border rounded-md shadow-lg z-50 min-w-[180px]">
                  <button 
                    className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                      analysisMode === 'notes' ? 'bg-accent' : ''
                    }`}
                    onClick={() => {
                      setAnalysisMode('notes')
                      setShowAnalysisMenu(false)
                    }}
                  >
                    Notes
                  </button>
                  <button 
                    className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                      analysisMode === 'scale-degrees' ? 'bg-accent' : ''
                    }`}
                    onClick={() => {
                      setAnalysisMode('scale-degrees')
                      setShowAnalysisMenu(false)
                    }}
                  >
                    Scale Degrees
                  </button>
                  <button 
                    className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                      analysisMode === 'chords' ? 'bg-accent' : ''
                    }`}
                    onClick={() => {
                      setAnalysisMode('chords')
                      setShowAnalysisMenu(false)
                    }}
                  >
                    Chords
                  </button>
                  <button 
                    className={`w-full px-4 py-2 text-left hover:bg-accent text-sm ${
                      analysisMode === 'roman-numerals' ? 'bg-accent' : ''
                    }`}
                    onClick={() => {
                      setAnalysisMode('roman-numerals')
                      setShowAnalysisMenu(false)
                    }}
                  >
                    Roman Numerals
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSnapToGrid(!snapToGrid)}
              className={snapToGrid ? 'bg-white text-black hover:bg-white/90' : ''}
            >
              Snap to Grid
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <FileUp className="w-4 h-4 mr-1" /> Import
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mid,.midi"
              onChange={handleImport}
              className="hidden"
            />
            
            <Button variant="outline" size="sm" onClick={handleExport} disabled={notes.length === 0}>
              <FileDown className="w-4 h-4 mr-1" /> Export
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 flex overflow-hidden">
          <div 
            ref={mainScrollRef}
            className={`flex-1 overflow-y-auto overflow-x-auto ${isPasteMode ? 'cursor-copy' : ''}`}
            onMouseMove={(e) => {
              if (isPasteMode) {
                pasteMouseRef.current = { x: e.clientX, y: e.clientY }
                const preview = computePastePreview(e.clientX, e.clientY)
                setPastePreview(preview)
              }
            }}
            onClick={(e) => {
              if (isPasteMode) {
                e.preventDefault()
                e.stopPropagation()
                handlePastePlace()
              }
            }}
          >
            <div className="flex flex-col" style={{ minWidth: 'max-content' }}>
              {showRefTrack && refAudioBuffer && (
                <ReferenceTrack
                  audioBuffer={refAudioBuffer}
                  bars={bars}
                  timeSignature={timeSignature}
                  tempo={tempo}
                  pickupBeats={0}
                  cursorPosition={cursorPosition}
                  showPlayhead={isPlaying || isPaused}
                  zoom={zoom}
                  audioDelay={audioDelay}
                  onAudioDelayChange={setAudioDelay}
                  volume={refAudioVolume}
                  onVolumeChange={setRefAudioVolume}
                  isMuted={refAudioMuted}
                  onMuteToggle={handleRefAudioMuteToggle}
                  isSolo={refAudioSolo}
                  onSoloToggle={handleRefAudioSoloToggle}
                  regionStart={regionStart}
                  regionEnd={regionEnd}
                />
              )}
              <PianoRoll
                bars={bars}
                timeDivision={timeDivision}
                timeSignature={timeSignature}
                pickupBeats={0}
                isPlaying={isPlaying}
                notes={isPasteMode && pastePreview ? [...notes, ...pastePreview.notes] : notes}
                cursorPosition={cursorPosition}
                lowestNote={lowestNote}
                highestNote={highestNote}
                snapToGrid={snapToGrid}
                showPlayhead={isPlaying}
                zoom={zoom}
                regionStart={regionStart}
                regionEnd={regionEnd}
                onRegionChange={(start, end) => {
                  setRegionStart(start)
                  setRegionEnd(end)
                }}
                autoScroll={autoScroll}
                mode={isPasteMode ? 'read-only' : 'edit'}
                showAnalysis={showAnalysis}
                analysisMode={analysisMode}
                tonic={selectedKey}
                keyMode={keyMode}
                activeMidiKeys={activeMidiKeys}
                onNoteAdd={handleNoteAdd}
                onNoteUpdate={handleNoteUpdate}
                onNoteDelete={handleNoteDelete}
                onNotesSelect={handleNotesSelect}
                onDragEnd={handleDragEnd}
                noteOpacity={1.0}
                isDark={isDark}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-border bg-card px-4 py-2">
        <div className="text-xs text-muted-foreground flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span>{notes.length} notes | {selectedKey} {keyMode} | {timeSignatureToString(timeSignature)} | {tempo} BPM</span>
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
          <span>Click to add notes • Drag to move • Double-click to delete • Space to play/stop • Cmd/Ctrl+Z to undo • Cmd/Ctrl+Scroll to zoom • Cmd/Ctrl+C to copy • Cmd/Ctrl+V to paste • ↑↓ to transpose</span>
        </div>
      </div>
    </div>
  )
}

export default MidiEditor
