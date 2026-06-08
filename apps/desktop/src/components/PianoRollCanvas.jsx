import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import * as Tone from 'tone'
import { useScaleDegreeAnalysis } from '@/hooks/useScaleDegreeAnalysis'
import { useNoteNameAnalysis } from '@/hooks/useNoteNameAnalysis'
import { useHarmonyAnalysis } from '@/hooks/useHarmonyAnalysis'
import { useNoteInteractions } from '@/hooks/useNoteInteractions'
import { beatsPerBarFromTimeSignature, beatsPerDivisionFromTimeDivision, DEFAULT_TIME_SIGNATURE } from '@common/lib/midiUtils'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const CELL_HEIGHT = 20
const INITIAL_BEAT_WIDTH = 40
const BAR_LABEL_HEIGHT = 20

// ═══════════════════════════════════════════════════════════════
// COORDINATE MAPPING UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Convert musical beat (time) to canvas X coordinate
 */
const beatToX = (beat, beatWidth) => beat * beatWidth

/**
 * Convert canvas X coordinate to musical beat (time)
 */
const xToBeat = (x, beatWidth) => x / beatWidth

/**
 * Convert MIDI note number to canvas Y coordinate
 * @param midiNum - MIDI note number (0-127)
 * @param lowestNote - Lowest visible MIDI note
 * @param highestNote - Highest visible MIDI note
 * @returns Y coordinate (0 = top of canvas)
 */
const midiToY = (midiNum, lowestNote, highestNote) => {
  // Inverted: highestNote is at top (y=0), lowestNote at bottom
  const noteIndex = highestNote - midiNum
  return noteIndex * CELL_HEIGHT
}

/**
 * Convert canvas Y coordinate to MIDI note number
 */
const yToMidi = (y, lowestNote, highestNote) => {
  const noteIndex = Math.floor(y / CELL_HEIGHT)
  return highestNote - noteIndex
}

/**
 * Convert note name to MIDI number
 */
const noteToMidi = (note) => {
  if (!note || typeof note !== 'string') return -Infinity
  const match = note.match(/^([A-Ga-g])(#{0,2}|b?)(\d+)$/)
  if (!match) return -Infinity
  let [, letter, accidental, octaveStr] = match
  letter = letter.toUpperCase()
  const normalized = `${letter}${accidental}`
  const pitchClass = NOTE_NAMES.indexOf(normalized)
  if (pitchClass < 0) return -Infinity
  const octave = parseInt(octaveStr, 10)
  return (octave + 1) * 12 + pitchClass
}

/**
 * Convert MIDI number to note name
 */
const midiToNoteName = (midiNum) => {
  const octave = Math.floor(midiNum / 12) - 1
  const semitone = midiNum % 12
  return `${NOTE_NAMES[semitone]}${octave}`
}

/**
 * Check if note is a black key
 */
const isBlackKey = (midiNum) => {
  const semitone = midiNum % 12
  return [1, 3, 6, 8, 10].includes(semitone) // C#, D#, F#, G#, A#
}

/**
 * Check if note is C (for visual markers)
 */
const isCNote = (midiNum) => {
  return midiNum % 12 === 0
}

// ═══════════════════════════════════════════════════════════════
// CANVAS RENDERING FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Render the piano roll grid (background, rows, bar/division lines)
 */
function renderGrid(ctx, {
  width, height, beatWidth, barWidth, divisionWidth,
  bars, lowestNote, highestNote, dpr, pickupBeats, beatsPerBar, beatsPerDivision
}) {
  const totalNotes = highestNote - lowestNote + 1
  
  // Clear canvas
  ctx.clearRect(0, 0, width, height)
  
  // Draw note rows (alternating colors for black/white keys)
  for (let i = 0; i < totalNotes; i++) {
    const midiNum = highestNote - i
    const y = i * CELL_HEIGHT
    
    if (isBlackKey(midiNum)) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.4)' // bg-slate-900/40
    } else {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.3)' // bg-slate-800/30
    }
    ctx.fillRect(0, y, width, CELL_HEIGHT)
    
    // Horizontal lines between notes
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.2)'
    ctx.lineWidth = 1 / dpr
    ctx.beginPath()
    ctx.moveTo(0, y + CELL_HEIGHT)
    ctx.lineTo(width, y + CELL_HEIGHT)
    ctx.stroke()
    
    // C note marker (left edge)
    if (isCNote(midiNum)) {
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)'
      ctx.lineWidth = 2 / dpr
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(0, y + CELL_HEIGHT)
      ctx.stroke()
    }
  }
  
  // Draw bar lines (thick vertical lines)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)'
  ctx.lineWidth = 2 / dpr
  ctx.beginPath()
  
  if (pickupBeats > 0) {
    ctx.moveTo(0, 0)
    ctx.lineTo(0, height)
  }
  
  for (let barIndex = 0; barIndex <= bars; barIndex++) {
    const x = (pickupBeats + barIndex * beatsPerBar) * beatWidth
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
  }
  ctx.stroke()
  
  // Draw division lines (thin vertical lines)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = 1 / dpr
  ctx.beginPath()
  const totalBeats = pickupBeats + bars * beatsPerBar
  const totalDivisions = Math.floor(totalBeats / beatsPerDivision)
  
  for (let divIndex = 0; divIndex <= totalDivisions; divIndex++) {
    const beat = divIndex * beatsPerDivision
    if (beat > totalBeats + 0.0001) continue
    const isBarLine = beat === 0 || (beat >= pickupBeats && Math.abs(((beat - pickupBeats) / beatsPerBar) - Math.round((beat - pickupBeats) / beatsPerBar)) < 0.0001)
    if (isBarLine) continue
    
    const x = beat * beatWidth
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
  }
  ctx.stroke()
}

/**
 * Render notes onto canvas with viewport culling
 * Now includes optional scale degree labels
 */
function renderNotes(ctx, {
  notes, beatWidth, lowestNote, highestNote,
  viewportStartBeat, viewportEndBeat, selectedNotes, dpr, showAnalysis, analysisMode = 'scale-degrees', noteOpacity = 1.0
}) {
  // Only render notes within viewport (with small buffer)
  const buffer = 2 // beats before/after viewport
  const visibleNotes = notes.filter(note => {
    const noteEnd = note.start + note.duration
    return noteEnd >= (viewportStartBeat - buffer) && note.start <= (viewportEndBeat + buffer)
  })
  
  const cornerRadius = 3
  
  visibleNotes.forEach(note => {
    const midiNum = noteToMidi(note.note)
    if (midiNum < lowestNote || midiNum > highestNote) return
    
    const x = beatToX(note.start, beatWidth)
    const y = midiToY(midiNum, lowestNote, highestNote)
    const w = note.duration * beatWidth
    const h = CELL_HEIGHT - 4 // 2px padding top/bottom
    
    const isSelected = selectedNotes.has(note.id)
    
    // Draw rounded rectangle
    ctx.beginPath()
    ctx.moveTo(x + cornerRadius, y + 2)
    ctx.lineTo(x + w - cornerRadius, y + 2)
    ctx.quadraticCurveTo(x + w, y + 2, x + w, y + 2 + cornerRadius)
    ctx.lineTo(x + w, y + 2 + h - cornerRadius)
    ctx.quadraticCurveTo(x + w, y + 2 + h, x + w - cornerRadius, y + 2 + h)
    ctx.lineTo(x + cornerRadius, y + 2 + h)
    ctx.quadraticCurveTo(x, y + 2 + h, x, y + 2 + h - cornerRadius)
    ctx.lineTo(x, y + 2 + cornerRadius)
    ctx.quadraticCurveTo(x, y + 2, x + cornerRadius, y + 2)
    ctx.closePath()
    
    // Fill with white/selection color (with opacity)
    if (isSelected) {
      ctx.fillStyle = `rgba(255, 255, 255, ${noteOpacity})`
      ctx.fill()
      
      // Blue selection ring - thicker for better visibility
      ctx.strokeStyle = `rgba(59, 130, 246, ${noteOpacity})`
      ctx.lineWidth = 4 / dpr
      ctx.stroke()
    } else {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * noteOpacity})`
      ctx.fill()
      
      // Subtle border
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 * noteOpacity})`
      ctx.lineWidth = 1 / dpr
      ctx.stroke()
    }
    
    // Render analysis label if analysis is enabled
    if (showAnalysis) {
      let label = null
      let isNonDiatonic = false
      let isHarmonyLabel = false // chord/RN labels use different placement

      // Determine label based on what analysis data is available
      if (note.degree_info?.scale_degree) {
        // Scale degree mode — every note gets a label
        label = note.degree_info.scale_degree
        isNonDiatonic = note.degree_info.is_diatonic === false
      } else if (note.note_name) {
        // Note name mode — every note gets a label
        label = note.note_name
        isNonDiatonic = false
      } else if (note.chord_info && note.is_top_note) {
        // Chord / Roman numeral mode — top note only
        isHarmonyLabel = true
        isNonDiatonic = !note.chord_info.is_diatonic
        if (analysisMode === 'roman-numerals') {
          label = note.chord_info.roman_numeral
        } else {
          label = note.chord_info.chord_label
        }
      }

      if (label) {
        // Harmony labels use a slightly larger font and sit above the note
        ctx.font = isHarmonyLabel ? `bold 12px sans-serif` : `bold 11px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'

        // Color: red for non-diatonic, white for diatonic
        ctx.fillStyle = isNonDiatonic ? 'rgb(239, 68, 68)' : 'rgb(255, 255, 255)'

        // Draw text above the note (centered horizontally)
        const textX = x + w / 2
        const textY = y - 6  // 6px above the note

        // Add slight shadow for readability
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
        ctx.shadowBlur = 3
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 1

        ctx.fillText(label, textX, textY)

        // Reset shadow
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
      }
    }
  })
}

/**
 * Render region overlay (dimmed areas outside active region)
 */
function renderRegionOverlay(ctx, {
  width, height, regionStartPx, regionEndPx
}) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.38)'
  
  // Left inactive region
  if (regionStartPx > 0) {
    ctx.fillRect(0, 0, regionStartPx, height)
  }
  
  // Right inactive region
  if (regionEndPx < width) {
    ctx.fillRect(regionEndPx, 0, width - regionEndPx, height)
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

function PianoRollCanvas({
  bars = 4,
  timeDivision = '1/4',
  timeSignature = DEFAULT_TIME_SIGNATURE,
  pickupBeats = 0,
  isPlaying = false,
  onNoteAdd,
  onNoteUpdate,
  onNoteDelete,
  onNotesSelect,
  onDragStart,
  onDragEnd,
  notes = [],
  cursorPosition = 0,
  lowestNote = 36,
  highestNote = 60,
  snapToGrid = true,
  showPlayhead = false,
  zoom = 1,
  regionStart = 0,
  regionEnd = 1,
  onRegionChange,
  autoScroll = true,
  mode = 'edit', // 'edit' | 'read-only'
  showAnalysis = false,
  analysisMode = 'scale-degrees', // 'notes' | 'scale-degrees' | 'chords' | 'roman-numerals'
  tonic = 'C',
  keyMode = 'Major',
  noteOpacity = 1.0,
  activeMidiKeys = new Set()
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const gridRef = useRef(null)
  const playheadRef = useRef(null)
  const scrollContainerRef = useRef(null)
  const animationFrameRef = useRef(null)
  const hasInitialScrolledRef = useRef(false)
  
  const [scrollLeft, setScrollLeft] = useState(0)

  const beatsPerBar = beatsPerBarFromTimeSignature(timeSignature)
  const beatsPerDivision = beatsPerDivisionFromTimeDivision(timeDivision, timeSignature)
  const beatWidth = INITIAL_BEAT_WIDTH * zoom
  
  // Analysis hooks - calculate based on analysisMode
  const notesWithScaleDegrees = useScaleDegreeAnalysis(notes, tonic, keyMode)
  const notesWithNoteNames = useNoteNameAnalysis(notes, tonic, keyMode)
  const harmonyEnabled = showAnalysis && (analysisMode === 'chords' || analysisMode === 'roman-numerals')
  const { chordMap } = useHarmonyAnalysis(notes, tonic, keyMode, harmonyEnabled)

  // For chords/roman-numerals: compute the top note (highest MIDI) per start time
  const topNoteIdPerStart = useMemo(() => {
    if (!harmonyEnabled) return new Set()
    const byStart = {}
    for (const note of notes) {
      const key = Math.round(note.start * 1000) / 1000
      const midi = noteToMidi(note.note)
      if (!byStart[key] || midi > byStart[key].midi) {
        byStart[key] = { id: note.id, midi }
      }
    }
    return new Set(Object.values(byStart).map(v => v.id))
  }, [notes, harmonyEnabled])

  // Attach chord_info to each note
  const notesWithAnalysis = useMemo(() => {
    if (analysisMode === 'notes') {
      return notesWithNoteNames
    } else if (analysisMode === 'scale-degrees') {
      return notesWithScaleDegrees
    } else if (analysisMode === 'chords' || analysisMode === 'roman-numerals') {
      return notes.map(note => {
        const startKey = Math.round(note.start * 1000) / 1000
        const chordEvent = chordMap[startKey]
        return {
          ...note,
          chord_info: chordEvent || null,
          is_top_note: topNoteIdPerStart.has(note.id),
        }
      })
    }
    return notes
  }, [analysisMode, notesWithNoteNames, notesWithScaleDegrees, notes, chordMap, topNoteIdPerStart])
  
  // Note interactions (always call hook, but only enabled in edit mode)
  const interactions = useNoteInteractions({
    notes,
    beatWidth,
    lowestNote,
    highestNote,
    snapToGrid,
    beatsPerDivision,
    onNoteAdd,
    onNoteUpdate,
    onNoteDelete,
    onNotesSelect,
    onDragStart,
    onDragEnd,
    enabled: mode === 'edit'
  })
  const barWidth = beatsPerBar * beatWidth
  const divisionWidth = beatsPerDivision * beatWidth
  const totalGridBeats = pickupBeats + bars * beatsPerBar
  const gridWidth = totalGridBeats * beatWidth
  const gridHeight = (highestNote - lowestNote + 1) * CELL_HEIGHT

  // Generate note range for labels
  const noteRange = useMemo(() => {
    const range = []
    for (let i = highestNote; i >= lowestNote; i--) {
      range.push(midiToNoteName(i))
    }
    return range
  }, [highestNote, lowestNote])

  // Selected notes set for fast lookup
  const selectedNotes = useMemo(() => {
    return new Set(notes.filter(n => n.selected).map(n => n.id))
  }, [notes])

  // High-performance playhead animation loop (60fps, no React re-renders)
  useEffect(() => {
    if (!isPlaying || !showPlayhead) {
      // Cancel animation loop when stopped
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      // Reset initial scroll flag when playback stops
      hasInitialScrolledRef.current = false
      return
    }

    const regionStartPx = regionStart * gridWidth
    const regionEndPx = regionEnd * gridWidth
    const regionWidthPx = regionEndPx - regionStartPx
    
    // Get scroll container for auto-scroll
    const scrollContainer = scrollContainerRef.current
    
    // Initial scroll: center playhead at 50% when playback starts if it's off-screen
    if (autoScroll && scrollContainer && !hasInitialScrolledRef.current) {
      hasInitialScrolledRef.current = true
      
      const transportTicks = Tone.Transport.ticks
      // Calculate totalTicks based on active region duration
      const regionBeats = (regionEnd - regionStart) * totalGridBeats
      const totalTicks = Tone.Transport.PPQ * regionBeats
      const progress = totalTicks > 0 ? Math.min(transportTicks / totalTicks, 1) : 0
      const playheadPx = regionStartPx + progress * regionWidthPx
      
      const containerWidth = scrollContainer.offsetWidth
      const currentScroll = scrollContainer.scrollLeft
      const playheadRelativeToViewport = playheadPx - currentScroll
      
      // Check if playhead is off-screen (outside viewport)
      if (playheadRelativeToViewport < 0 || playheadRelativeToViewport > containerWidth) {
        // Center playhead at 50%, but don't scroll past the beginning
        const targetScroll = Math.max(0, playheadPx - containerWidth * 0.5)
        scrollContainer.scrollLeft = targetScroll
      }
    }
    
    const updatePlayhead = () => {
      if (!isPlaying) return
      
      // Query Tone.Transport for current position
      const transportTicks = Tone.Transport.ticks
      // Calculate totalTicks based on active region duration
      const regionBeats = (regionEnd - regionStart) * totalGridBeats
      const totalTicks = Tone.Transport.PPQ * regionBeats
      
      // Calculate playhead position within active region
      // Transport goes from 0 to totalTicks during playback of the active region
      const progress = totalTicks > 0 ? Math.min(transportTicks / totalTicks, 1) : 0
      const playheadPx = regionStartPx + progress * regionWidthPx
      
      // Update playhead DOM element directly (no React state)
      if (playheadRef.current) {
        playheadRef.current.style.transform = `translateX(${playheadPx}px)`
      }
      
      // Auto-scroll to keep playhead centered at 50% viewport
      if (autoScroll && scrollContainer) {
        const containerWidth = scrollContainer.offsetWidth
        const currentScroll = scrollContainer.scrollLeft
        const playheadRelativeToViewport = playheadPx - currentScroll
        
        // If playhead is past 50% of viewport width, scroll to keep it centered
        const scrollThreshold = containerWidth * 0.5
        if (playheadRelativeToViewport > scrollThreshold) {
          // Center at 50%, but don't scroll past the beginning (0)
          const targetScroll = Math.max(0, playheadPx - containerWidth * 0.5)
          scrollContainer.scrollLeft = targetScroll
        }
        // Also handle case where playhead goes off-screen to the left
        else if (playheadRelativeToViewport < 0) {
          const targetScroll = Math.max(0, playheadPx - containerWidth * 0.5)
          scrollContainer.scrollLeft = targetScroll
        }
      }
      
      // Continue animation loop
      animationFrameRef.current = requestAnimationFrame(updatePlayhead)
    }
    
    // Start animation loop
    animationFrameRef.current = requestAnimationFrame(updatePlayhead)
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [isPlaying, showPlayhead, regionStart, regionEnd, gridWidth, bars, autoScroll])

  // Track scroll position for viewport culling and store scroll container ref
  useEffect(() => {
    // Find the scrollable container by traversing up the DOM
    let element = gridRef.current
    let scrollableContainer = null
    
    while (element && element !== document.body) {
      const overflowX = window.getComputedStyle(element).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') {
        scrollableContainer = element
        break
      }
      element = element.parentElement
    }
    
    if (!scrollableContainer) return
    
    scrollContainerRef.current = scrollableContainer
    
    const handleScroll = () => {
      setScrollLeft(scrollableContainer.scrollLeft)
    }
    
    scrollableContainer.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollableContainer.removeEventListener('scroll', handleScroll)
  }, [])

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    // Handle device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1
    const width = gridWidth
    const height = gridHeight
    
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    
    ctx.scale(dpr, dpr)
    
    // Calculate viewport for virtualization
    const viewportWidth = containerRef.current?.offsetWidth || 1000
    const viewportStartBeat = xToBeat(scrollLeft, beatWidth)
    const viewportEndBeat = xToBeat(scrollLeft + viewportWidth, beatWidth)
    
    // Render grid
    renderGrid(ctx, {
      width, height, beatWidth, barWidth, divisionWidth,
      bars, lowestNote, highestNote, dpr, pickupBeats, beatsPerBar, beatsPerDivision
    })
    
    // Render notes (with viewport culling and optional analysis)
    renderNotes(ctx, {
      notes: notesWithAnalysis, beatWidth, lowestNote, highestNote,
      viewportStartBeat, viewportEndBeat, selectedNotes, dpr, showAnalysis, analysisMode, noteOpacity
    })
    
    // Render region overlay
    const regionStartPx = regionStart * gridWidth
    const regionEndPx = regionEnd * gridWidth
    renderRegionOverlay(ctx, {
      width, height, regionStartPx, regionEndPx
    })
    
  }, [notesWithAnalysis, beatWidth, barWidth, divisionWidth, bars, beatsPerBar, beatsPerDivision, gridWidth, gridHeight,
      lowestNote, highestNote, selectedNotes, regionStart, regionEnd, scrollLeft, zoom, showAnalysis, noteOpacity])

  // ═══════════════════════════════════════════════════════════════
  // INTERACTION HANDLERS (Edit mode only)
  // ═══════════════════════════════════════════════════════════════

  // Global mouse handlers for dragging (edit mode only)
  useEffect(() => {
    if (mode !== 'edit' || !interactions?.dragState) return

    window.addEventListener('mousemove', interactions.handleGlobalMouseMove)
    window.addEventListener('mouseup', interactions.handleGlobalMouseUp)
    return () => {
      window.removeEventListener('mousemove', interactions.handleGlobalMouseMove)
      window.removeEventListener('mouseup', interactions.handleGlobalMouseUp)
    }
  }, [mode, interactions?.dragState, interactions?.handleGlobalMouseMove, interactions?.handleGlobalMouseUp])

  // Region handle drag logic
  const regionDragRef = useRef(null)
  const handleRegionMouseDown = useCallback((e, handle) => {
    e.preventDefault()
    e.stopPropagation()

    const gridRect = gridRef.current?.getBoundingClientRect()
    const gridLeft = gridRect ? gridRect.left : 0

    const snapFraction = divisionWidth / gridWidth
    const minGap = snapFraction

    const onMove = (ev) => {
      const rawPx = ev.clientX - gridLeft
      const rawFraction = rawPx / gridWidth
      const snapped = Math.round(rawFraction / snapFraction) * snapFraction

      if (handle === 'start') {
        const next = Math.max(0, Math.min(regionEnd - minGap, snapped))
        onRegionChange?.(next, regionEnd)
      } else {
        const next = Math.min(1, Math.max(regionStart + minGap, snapped))
        onRegionChange?.(regionStart, next)
      }
    }

    const onUp = () => {
      regionDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [regionStart, regionEnd, gridWidth, divisionWidth, onRegionChange])

  const regionStartPx = regionStart * gridWidth
  const regionEndPx = regionEnd * gridWidth

  const isBlackKeyNote = (note) => note.includes('#') || note.includes('b')
  const getNoteColor = (noteName) => {
    if (noteName.startsWith('C') && !noteName.includes('#')) {
      return 'border-l-2 border-l-blue-500/30'
    }
    return ''
  }

  return (
    <div 
      ref={containerRef}
      className="relative bg-background"
      style={{ minWidth: `${gridWidth + 120}px` }}
    >
      <div className="flex">
        {/* ── Sticky pitch label column ── */}
        <div className="sticky left-0 z-20 bg-card border-r-2 border-border" style={{ width: '120px' }}>
          <div style={{ height: `${BAR_LABEL_HEIGHT}px` }} className="bg-background border-b border-border/50" />
          {noteRange.map((note) => (
            <div
              key={note}
              className={`relative flex items-center justify-end pr-1 text-xs border-b border-border/30 ${
                isBlackKeyNote(note)
                  ? 'bg-slate-900 text-muted-foreground'
                  : 'bg-slate-800 text-foreground'
              } ${getNoteColor(note)} ${activeMidiKeys.has(note) ? 'z-30' : ''}`}
              style={{ height: `${CELL_HEIGHT}px` }}
            >
              {activeMidiKeys.has(note) && (
                <div className="pointer-events-none absolute inset-[3px] rounded-sm ring-2 ring-primary/80 shadow-[0_0_12px_rgba(99,102,241,0.8),0_0_24px_rgba(99,102,241,0.5)] animate-pulse" />
              )}
              <span className="relative z-40 font-mono text-[10px] font-medium text-right w-full pr-1 leading-none">{note}</span>
            </div>
          ))}
        </div>

        {/* ── Canvas grid area ── */}
        <div 
          ref={gridRef}
          className="relative"
          style={{ 
            width: `${gridWidth}px`,
            height: `${gridHeight + BAR_LABEL_HEIGHT}px`,
            paddingTop: `${BAR_LABEL_HEIGHT}px`
          }}
        >
          {/* Main canvas */}
          <canvas
            ref={canvasRef}
            className="absolute"
            style={{ 
              left: 0,
              top: `${BAR_LABEL_HEIGHT}px`,
              imageRendering: 'crisp-edges',
              cursor: mode === 'edit' ? (interactions?.cursorStyle || 'crosshair') : 'default'
            }}
            onMouseDown={mode === 'edit' ? (e) => interactions?.handleCanvasMouseDown(e, canvasRef) : undefined}
            onMouseMove={mode === 'edit' ? (e) => interactions?.handleCanvasMouseMove(e, canvasRef) : undefined}
            onDoubleClick={mode === 'edit' ? (e) => interactions?.handleCanvasDoubleClick(e, canvasRef) : undefined}
          />

          {/* Marquee Selection Box */}
          {mode === 'edit' && interactions?.dragState?.type === 'marquee' && (
            <div
              className="absolute pointer-events-none z-30 border border-blue-500 bg-blue-500/20"
              style={{
                left: Math.min(interactions.dragState.startX, interactions.dragState.currentX),
                top: Math.min(interactions.dragState.startY, interactions.dragState.currentY) + BAR_LABEL_HEIGHT,
                width: Math.abs(interactions.dragState.currentX - interactions.dragState.startX),
                height: Math.abs(interactions.dragState.currentY - interactions.dragState.startY),
              }}
            />
          )}

          {/* Region guide lines (overlay on canvas) */}
          <div className="absolute pointer-events-none z-20"
            style={{
              top: `${BAR_LABEL_HEIGHT}px`, bottom: 0,
              left: `${regionStartPx - 1}px`, width: '2px',
              background: 'rgba(56,189,248,0.4)'
            }}
          />
          <div className="absolute pointer-events-none z-20"
            style={{
              top: `${BAR_LABEL_HEIGHT}px`, bottom: 0,
              left: `${regionEndPx - 1}px`, width: '2px',
              background: 'rgba(56,189,248,0.4)'
            }}
          />

          {/* Playhead (ref-based DOM overlay, updated via requestAnimationFrame) */}
          {showPlayhead && (
            <div
              ref={playheadRef}
              className="absolute bottom-0 w-1 bg-red-500 z-30 pointer-events-none"
              style={{ 
                top: `${BAR_LABEL_HEIGHT}px`,
                left: 0,
                boxShadow: '0 0 12px rgba(239, 68, 68, 0.8)',
                opacity: 0.9,
                willChange: 'transform'
              }}
            />
          )}

          {/* ── Bar-label ruler (with region handles) ── */}
          <div
            className="absolute left-0 right-0 z-40 select-none"
            style={{ top: 0, height: `${BAR_LABEL_HEIGHT}px` }}
          >
            {/* Active region highlight */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: `${regionStartPx}px`,
                width: `${regionEndPx - regionStartPx}px`,
                height: '100%',
                background: 'rgba(56,189,248,0.08)',
                borderBottom: '1px solid rgba(56,189,248,0.35)'
              }}
            />

            {/* Bar numbers */}
            {Array.from({ length: bars }).map((_, barIndex) => (
              <div
                key={`bar-${barIndex}`}
                className="absolute text-xs font-semibold text-muted-foreground flex items-center pl-1"
                style={{ 
                  left: `${(pickupBeats + barIndex * beatsPerBar) * beatWidth}px`,
                  width: `${barWidth}px`,
                  height: '100%',
                  pointerEvents: 'none'
                }}
              >
                {barIndex + 1}
              </div>
            ))}

            {/* Region start handle */}
            <div
              className="absolute top-0 z-50 cursor-ew-resize group"
              style={{ left: `${regionStartPx}px`, width: 0, height: '100%' }}
              onMouseDown={(e) => handleRegionMouseDown(e, 'start')}
            >
              <div className="absolute top-0 bottom-0 pointer-events-none group-hover:opacity-100 transition-opacity"
                style={{ left: '-1px', width: '2px', background: 'rgba(56,189,248,0.85)', boxShadow: '0 0 4px rgba(56,189,248,0.5)' }}
              />
              <div className="absolute pointer-events-none group-hover:bg-sky-300 transition-colors"
                style={{
                  top: 0, left: '-5px',
                  width: '10px', height: '10px',
                  background: 'rgba(56,189,248,0.85)',
                  borderRadius: '2px 2px 0 0',
                  boxShadow: '0 0 4px rgba(56,189,248,0.4)'
                }}
              />
              <div className="absolute top-0 bottom-0" style={{ left: '-7px', width: '14px' }} />
            </div>

            {/* Region end handle */}
            <div
              className="absolute top-0 z-50 cursor-ew-resize group"
              style={{ left: `${regionEndPx}px`, width: 0, height: '100%' }}
              onMouseDown={(e) => handleRegionMouseDown(e, 'end')}
            >
              <div className="absolute top-0 bottom-0 pointer-events-none group-hover:opacity-100 transition-opacity"
                style={{ left: '-1px', width: '2px', background: 'rgba(56,189,248,0.85)', boxShadow: '0 0 4px rgba(56,189,248,0.5)' }}
              />
              <div className="absolute pointer-events-none group-hover:bg-sky-300 transition-colors"
                style={{
                  top: 0, left: '-5px',
                  width: '10px', height: '10px',
                  background: 'rgba(56,189,248,0.85)',
                  borderRadius: '2px 2px 0 0',
                  boxShadow: '0 0 4px rgba(56,189,248,0.4)'
                }}
              />
              <div className="absolute top-0 bottom-0" style={{ left: '-7px', width: '14px' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default PianoRollCanvas
