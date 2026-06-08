import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { motion, useMotionValue } from 'framer-motion'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const generateNoteRange = (lowestOctave, highestOctave) => {
  const notes = []
  for (let octave = highestOctave; octave >= lowestOctave; octave--) {
    for (let i = NOTE_NAMES.length - 1; i >= 0; i--) {
      notes.push(`${NOTE_NAMES[i]}${octave}`)
    }
  }
  return notes
}

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

const CELL_HEIGHT = 20
const INITIAL_BEAT_WIDTH = 40
const BEATS_PER_BAR = 4

const NoteBlock = memo(({ noteData, beatWidth, CELL_HEIGHT, noteRange, handleNoteMouseDown }) => {
  const noteIndex = noteRange.indexOf(noteData.note)
  if (noteIndex === -1) return null

  const left = noteData.start * beatWidth
  const width = noteData.duration * beatWidth
  const top = noteIndex * CELL_HEIGHT

  return (
    <div
      key={noteData.id}
      className={`note-block absolute rounded cursor-move transition-colors ${
        noteData.selected ? 'bg-blue-500 ring-2 ring-blue-300' : 'bg-primary/80 hover:bg-primary'
      }`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${CELL_HEIGHT}px`,
        zIndex: noteData.selected ? 20 : 10
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (noteData.onDelete) noteData.onDelete(noteData.id)
      }}
    >
      <div 
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20"
        onMouseDown={(e) => handleNoteMouseDown(e, noteData.id, 'start', noteData.start, noteData.duration)}
      />
      <div 
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20"
        onMouseDown={(e) => handleNoteMouseDown(e, noteData.id, 'end', noteData.start, noteData.duration)}
      />
    </div>
  )
})

NoteBlock.displayName = 'NoteBlock'

const BAR_LABEL_HEIGHT = 20

function PianoRoll({ 
  bars = 4, 
  timeDivision = '1/4',
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
  onRegionChange
}) {
  const containerRef = useRef(null)
  const gridRef = useRef(null)
  const playheadX = useMotionValue(0)
  
  const [dragState, setDragState] = useState(null)
  const hasDraggedRef = useRef(false)
  const historySavedRef = useRef(false)

  const divisionsPerBar = {
    '1/1': 1,
    '1/2': 2,
    '1/4': 4,
    '1/8': 8,
    '1/16': 16,
    '1/32': 32
  }
  
  const divisions = divisionsPerBar[timeDivision] || 4
  const beatsPerDivision = BEATS_PER_BAR / divisions
  
  const beatWidth = INITIAL_BEAT_WIDTH * zoom
  const barWidth = BEATS_PER_BAR * beatWidth
  const divisionWidth = barWidth / divisions
  const totalDivisions = bars * divisions
  const gridWidth = bars * barWidth

  const midiToNoteName = useCallback((midiNum) => {
    const octave = Math.floor(midiNum / 12) - 1
    const semitone = midiNum % 12
    return `${NOTE_NAMES[semitone]}${octave}`
  }, [])

  const noteRange = useMemo(() => {
    const range = []
    for (let i = highestNote; i >= lowestNote; i--) {
      range.push(midiToNoteName(i))
    }
    return range
  }, [highestNote, lowestNote, midiToNoteName])

  const isBlackKey = (note) => {
    return note.includes('#') || note.includes('b')
  }

  const getNoteColor = (noteName) => {
    if (noteName.startsWith('C') && !noteName.includes('#')) {
      return 'border-l-2 border-l-blue-500/30'
    }
    return ''
  }

  useEffect(() => {
    if (showPlayhead) {
      // Playhead tracks within the active region:
      // transport progress 0→1 maps to regionStart→regionEnd of the grid
      const regionStartPxLocal = regionStart * gridWidth
      const regionEndPxLocal   = regionEnd   * gridWidth
      const position = regionStartPxLocal + cursorPosition * (regionEndPxLocal - regionStartPxLocal)
      playheadX.set(position)
    }
  }, [cursorPosition, gridWidth, playheadX, showPlayhead, regionStart, regionEnd])


  const handleRowMouseDown = (e, note) => {
    if (dragState) return
    if (e.target.closest('.note-block')) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const rawBeat = x / beatWidth
    
    const startBeat = Math.floor(rawBeat / beatsPerDivision) * beatsPerDivision
    if (onNoteAdd) {
      onNoteAdd(note, startBeat, beatsPerDivision)
    }
  }

  const handleNoteMouseDown = (e, id, type, originalStart, originalDuration, originalNoteIndex) => {
    e.stopPropagation()
    if (e.button !== 0) return

    if (onNotesSelect) {
      const isMulti = e.shiftKey || e.ctrlKey || e.metaKey
      onNotesSelect([id], !isMulti)
    }

    hasDraggedRef.current = false
    historySavedRef.current = false
    setDragState({
      id,
      type,
      startX: e.clientX,
      startY: e.clientY,
      originalStart,
      originalDuration,
      originalNoteIndex
    })
  }

  useEffect(() => {
    if (!dragState) return

    const handleMouseMove = (e) => {
      const deltaX = e.clientX - dragState.startX
      if (!hasDraggedRef.current && Math.abs(deltaX) > 3) {
        hasDraggedRef.current = true
        if (!historySavedRef.current && onDragStart) {
          onDragStart()
          historySavedRef.current = true
        }
      }
      
      if (!hasDraggedRef.current) return

      const deltaBeats = deltaX / beatWidth
      const deltaY = e.clientY - dragState.startY
      
      let newStart = dragState.originalStart
      let newDuration = dragState.originalDuration
      let newNoteName = undefined

      if (dragState.type === 'end') {
        let rawDuration = dragState.originalDuration + deltaBeats
        if (snapToGrid) {
          rawDuration = Math.round(rawDuration / beatsPerDivision) * beatsPerDivision
        }
        newDuration = Math.max(snapToGrid ? beatsPerDivision : 0.1, rawDuration)
      } else if (dragState.type === 'start') {
        let rawStart = dragState.originalStart + deltaBeats
        if (snapToGrid) {
          rawStart = Math.round(rawStart / beatsPerDivision) * beatsPerDivision
        }
        
        const endPosition = dragState.originalStart + dragState.originalDuration
        newStart = Math.max(0, Math.min(rawStart, endPosition - (snapToGrid ? beatsPerDivision : 0.1)))
        newDuration = endPosition - newStart
      } else if (dragState.type === 'move') {
        let rawStart = dragState.originalStart + deltaBeats
        if (snapToGrid) {
          rawStart = Math.round(rawStart / beatsPerDivision) * beatsPerDivision
        }
        newStart = Math.max(0, rawStart)

        if (dragState.originalNoteIndex !== undefined) {
          const deltaRows = Math.round(deltaY / CELL_HEIGHT)
          const newIndex = Math.max(0, Math.min(noteRange.length - 1, dragState.originalNoteIndex + deltaRows))
          newNoteName = noteRange[newIndex]
        }
      }

      if (onNoteUpdate) {
        onNoteUpdate(dragState.id, { start: newStart, duration: newDuration, ...(newNoteName && { note: newNoteName }) })
      }
    }

    const handleMouseUp = () => {
      setDragState(null)
      if (hasDraggedRef.current && onDragEnd) {
        onDragEnd()
      }
      setTimeout(() => {
        hasDraggedRef.current = false
        historySavedRef.current = false
      }, 0)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragState, beatWidth, zoom, snapToGrid, onNoteUpdate, onDragStart, onDragEnd, beatsPerDivision, noteRange])

  const gridHeight = noteRange.length * CELL_HEIGHT



  // ── Region handle drag logic (snaps to current time division) ──────────
  const regionDragRef = useRef(null)

  const handleRegionMouseDown = useCallback((e, handle) => {
    e.preventDefault()
    e.stopPropagation()

    // Capture the grid container's left edge so we can compute absolute px
    const gridRect = gridRef.current?.getBoundingClientRect()
    const gridLeft = gridRect ? gridRect.left : 0

    const snapFraction = divisionWidth / gridWidth   // one division in [0,1]
    const minGap = snapFraction                       // handles must stay ≥ 1 division apart

    const onMove = (ev) => {
      const rawPx = ev.clientX - gridLeft
      const rawFraction = rawPx / gridWidth
      // Snap to nearest division
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
  }, [regionStart, regionEnd, gridWidth, divisionWidth, bars, onRegionChange, gridRef])

  const regionStartPx = regionStart * gridWidth
  const regionEndPx   = regionEnd   * gridWidth

  return (
    <div 
      ref={containerRef}
      className="relative bg-background"
      style={{ minWidth: `${gridWidth + 120}px` }}
    >
      <div className="flex">
        {/* ── Pitch label column ── */}
        <div className="sticky left-0 z-20 bg-card border-r-2 border-border" style={{ width: '120px' }}>
            <div style={{ height: `${BAR_LABEL_HEIGHT}px` }} className="bg-background border-b border-border/50" />
            {noteRange.map((note) => (
              <div
                key={note}
                className={`relative flex items-center justify-end pr-1 text-xs border-b border-border/30 ${
                  isBlackKey(note)
                    ? 'bg-slate-900 text-muted-foreground'
                    : 'bg-slate-800 text-foreground'
                } ${getNoteColor(note)}`}
                style={{ height: `${CELL_HEIGHT}px` }}
              >
                <span className="relative z-40 font-mono text-[10px] font-medium text-right w-full pr-1 leading-none">{note}</span>
              </div>
            ))}
          </div>

        {/* ── Grid + region ruler ── */}
        <div 
          ref={gridRef}
          className="relative"
          style={{ 
            width: `${gridWidth}px`,
            height: `${noteRange.length * CELL_HEIGHT + BAR_LABEL_HEIGHT}px`,
            paddingTop: `${BAR_LABEL_HEIGHT}px`
          }}
        >
          {/* Bar lines */}
          {Array.from({ length: bars + 1 }).map((_, barIndex) => (
            <div
              key={`bar-line-${barIndex}`}
              className="absolute top-0 bottom-0 border-l-2 border-border z-10 pointer-events-none"
              style={{ left: `${barIndex * barWidth}px` }}
            />
          ))}

          {/* Division lines */}
          {Array.from({ length: totalDivisions + 1 }).map((_, divIndex) => {
            const isBarStart = divIndex % divisions === 0
            if (isBarStart) return null
            return (
              <div
                key={`div-line-${divIndex}`}
                className="absolute top-0 bottom-0 border-l border-border/20 z-5 pointer-events-none"
                style={{ left: `${divIndex * divisionWidth}px` }}
              />
            )
          })}

          {/* Note rows */}
          {noteRange.map((note, idx) => (
            <div 
              key={`row-${note}`} 
              className="flex absolute w-full"
              style={{ 
                height: `${CELL_HEIGHT}px`,
                top: `${idx * CELL_HEIGHT + BAR_LABEL_HEIGHT}px`
              }}
              onMouseDown={(e) => handleRowMouseDown(e, note)}
            >
              {Array.from({ length: totalDivisions }).map((_, divIndex) => (
                <div
                  key={`cell-${note}-${divIndex}`}
                  className={`border-b border-border/20 hover:bg-primary/10 transition-colors ${
                    isBlackKey(note) ? 'bg-slate-900/40' : 'bg-slate-800/30'
                  }`}
                  style={{ 
                    width: `${divisionWidth}px`,
                    height: `${CELL_HEIGHT}px`
                  }}
                />
              ))}
            </div>
          ))}

          {/* Inactive region overlays (outside active region) */}
          {regionStart > 0 && (
            <div
              className="absolute top-0 bottom-0 pointer-events-none z-10"
              style={{
                left: 0,
                width: `${regionStartPx}px`,
                background: 'rgba(0,0,0,0.38)'
              }}
            />
          )}
          {regionEnd < 1 && (
            <div
              className="absolute top-0 bottom-0 pointer-events-none z-10"
              style={{
                left: `${regionEndPx}px`,
                right: 0,
                background: 'rgba(0,0,0,0.38)'
              }}
            />
          )}

          {/* Active region bar-label tint */}
          <div
            className="absolute pointer-events-none z-20"
            style={{
              top: 0,
              left: `${regionStartPx}px`,
              width: `${regionEndPx - regionStartPx}px`,
              height: `${BAR_LABEL_HEIGHT}px`,
              background: 'rgba(56,189,248,0.08)',
              borderBottom: '1px solid rgba(56,189,248,0.35)'
            }}
          />

          {/* Handle full-height guide lines through note grid */}
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

          {/* Notes */}
          {notes.map((noteData) => {
            const noteIndex = noteRange.findIndex(n => n === noteData.note)
            if (noteIndex === -1) return null
            
            const isDragging = dragState?.id === noteData.id
            const isSelected = noteData.selected

            return (
              <div
                key={noteData.id}
                className={`note-block absolute rounded-sm transition-colors z-10 ${
                  isSelected ? 'bg-primary border-2 border-white ring-1 ring-primary/50' : 'bg-primary/80 border border-primary'
                } ${isDragging ? 'opacity-70' : 'hover:bg-primary'}`}
                style={{
                  left: `${noteData.start * beatWidth}px`,
                  top: `${noteIndex * CELL_HEIGHT + 2 + BAR_LABEL_HEIGHT}px`,
                  width: `${noteData.duration * beatWidth}px`,
                  height: `${CELL_HEIGHT - 4}px`,
                  cursor: 'pointer'
                }}
                onMouseDown={(e) => handleNoteMouseDown(e, noteData.id, 'move', noteData.start, noteData.duration, noteIndex)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (onNoteDelete) onNoteDelete(noteData.id)
                }}
                onClick={(e) => {
                  if (!hasDraggedRef.current) e.stopPropagation()
                }}
              >
                <div 
                  className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20"
                  onMouseDown={(e) => handleNoteMouseDown(e, noteData.id, 'start', noteData.start, noteData.duration)}
                />
                <div 
                  className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20"
                  onMouseDown={(e) => handleNoteMouseDown(e, noteData.id, 'end', noteData.start, noteData.duration)}
                />
              </div>
            )
          })}

          {/* Playhead */}
          {showPlayhead && (
            <motion.div
              className="absolute top-0 bottom-0 w-1 bg-red-500 z-30 pointer-events-none"
              style={{ 
                x: playheadX,
                boxShadow: '0 0 12px rgba(239, 68, 68, 0.8)',
                opacity: 0.9
              }}
            />
          )}

          {/* ── Bar-label ruler (with region handles) ── */}
          <div
            className="absolute left-0 right-0 z-40 select-none"
            style={{ top: 0, height: `${BAR_LABEL_HEIGHT}px` }}
          >
            {/* Bar numbers */}
            {Array.from({ length: bars }).map((_, barIndex) => (
              <div
                key={`bar-${barIndex}`}
                className="absolute text-xs font-semibold text-muted-foreground flex items-center pl-1"
                style={{ 
                  left: `${barIndex * barWidth}px`,
                  width: `${barWidth}px`,
                  height: '100%',
                  pointerEvents: 'none'
                }}
              >
                {barIndex + 1}
              </div>
            ))}

            {/* Region start handle — thin cyan line + top notch tab */}
            <div
              className="absolute top-0 z-50 cursor-ew-resize group"
              style={{ left: `${regionStartPx}px`, width: 0, height: `${BAR_LABEL_HEIGHT}px` }}
              onMouseDown={(e) => handleRegionMouseDown(e, 'start')}
            >
              {/* Vertical line */}
              <div className="absolute top-0 bottom-0 pointer-events-none group-hover:opacity-100 transition-opacity"
                style={{ left: '-1px', width: '2px', background: 'rgba(56,189,248,0.85)', boxShadow: '0 0 4px rgba(56,189,248,0.5)' }}
              />
              {/* Tab cap — hangs off the top */}
              <div className="absolute pointer-events-none group-hover:bg-sky-300 transition-colors"
                style={{
                  top: 0, left: '-5px',
                  width: '10px', height: '10px',
                  background: 'rgba(56,189,248,0.85)',
                  borderRadius: '2px 2px 0 0',
                  boxShadow: '0 0 4px rgba(56,189,248,0.4)'
                }}
              />
              {/* Invisible wider hit area */}
              <div className="absolute top-0 bottom-0" style={{ left: '-7px', width: '14px' }} />
            </div>

            {/* Region end handle — thin cyan line + top notch tab */}
            <div
              className="absolute top-0 z-50 cursor-ew-resize group"
              style={{ left: `${regionEndPx}px`, width: 0, height: `${BAR_LABEL_HEIGHT}px` }}
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

export default PianoRoll
