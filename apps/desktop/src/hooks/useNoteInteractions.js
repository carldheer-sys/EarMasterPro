import { useState, useCallback, useRef } from 'react'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const CELL_HEIGHT = 20

/**
 * Custom hook for note interaction logic (edit mode only)
 * Handles mouse clicks, drags, resizing, adding, deleting notes
 */
export function useNoteInteractions({
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
  enabled = true  // Allow hook to be called but disabled when not in edit mode
}) {
  const [dragState, setDragState] = useState(null)
  const [cursorStyle, setCursorStyle] = useState('crosshair')
  const hasDraggedRef = useRef(false)
  const historySavedRef = useRef(false)

  // Coordinate conversion utilities
  const beatToX = useCallback((beat, bw) => beat * bw, [])
  const xToBeat = useCallback((x, bw) => x / bw, [])
  
  const midiToY = useCallback((midiNum, lowest, highest) => {
    const range = highest - lowest + 1
    const index = highest - midiNum
    return index * CELL_HEIGHT
  }, [])
  
  const yToMidi = useCallback((y, lowest, highest) => {
    const range = highest - lowest + 1
    const index = Math.floor(y / CELL_HEIGHT)
    return Math.max(lowest, Math.min(highest, highest - index))
  }, [])
  
  const midiToNoteName = useCallback((midiNum) => {
    const octave = Math.floor(midiNum / 12) - 1
    const pitch = NOTE_NAMES[midiNum % 12]
    return `${pitch}${octave}`
  }, [])
  
  const noteToMidi = useCallback((noteName) => {
    const match = noteName.match(/^([A-G]#?)(-?\d+)$/)
    if (!match) return 60
    const [, pitch, octave] = match
    const pitchClass = NOTE_NAMES.indexOf(pitch)
    return (parseInt(octave) + 1) * 12 + pitchClass
  }, [])
  
  const snapToBeat = useCallback((beat) => {
    if (!snapToGrid) return beat
    return Math.round(beat / beatsPerDivision) * beatsPerDivision
  }, [snapToGrid, beatsPerDivision])

  // Mouse move handler for cursor changes
  const handleCanvasMouseMove = useCallback((e, canvasRef) => {
    if (!enabled) return
    if (dragState) return
    
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    
    const midiNum = yToMidi(y, lowestNote, highestNote)
    
    // Check if hovering over note edge
    let isOnEdge = false
    const edgeThreshold = 8
    
    for (let note of notes) {
      const noteMidi = noteToMidi(note.note)
      if (noteMidi !== midiNum) continue
      
      const noteX = beatToX(note.start, beatWidth)
      const noteW = note.duration * beatWidth
      
      if (x >= noteX && x <= noteX + noteW) {
        if (x - noteX < edgeThreshold || noteX + noteW - x < edgeThreshold) {
          isOnEdge = true
          break
        }
      }
    }
    
    setCursorStyle(isOnEdge ? 'ew-resize' : 'crosshair')
  }, [enabled, notes, beatWidth, lowestNote, highestNote, dragState, beatToX, yToMidi, noteToMidi])

  // Mouse down handler
  const handleCanvasMouseDown = useCallback((e, canvasRef) => {
    if (!enabled) return
    if (dragState) return
    
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    
    const beat = xToBeat(x, beatWidth)
    const midiNum = yToMidi(y, lowestNote, highestNote)
    const noteName = midiToNoteName(midiNum)
    
    // Find clicked note
    const edgeThreshold = 8
    let clickedNote = null
    let edgeType = null
    
    for (let note of notes) {
      const noteMidi = noteToMidi(note.note)
      if (noteMidi !== midiNum) continue
      
      const noteX = beatToX(note.start, beatWidth)
      const noteW = note.duration * beatWidth
      
      if (x >= noteX && x <= noteX + noteW) {
        clickedNote = note
        
        if (x - noteX < edgeThreshold) {
          edgeType = 'start'
        } else if (noteX + noteW - x < edgeThreshold) {
          edgeType = 'end'
        }
        break
      }
    }
    
    hasDraggedRef.current = false
    historySavedRef.current = false
    
    if (clickedNote) {
      // Start dragging or resizing existing note
      if (!clickedNote.selected && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        onNotesSelect?.([clickedNote.id])
      } else if (!dragState && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        // If it's already selected and we shift-click, toggle it
        onNotesSelect?.([clickedNote.id], false, false)
      }
      
      // If we shift clicked to deselect, don't start a drag
      if ((e.shiftKey || e.metaKey || e.ctrlKey) && clickedNote.selected) {
        return
      }

      setDragState({
        type: edgeType || 'move',
        noteIds: clickedNote.selected || e.shiftKey
          ? notes.filter(n => n.selected || n.id === clickedNote.id).map(n => n.id)
          : [clickedNote.id],
        startBeat: beat,
        startMidi: midiNum,
        originalNotes: clickedNote.selected || e.shiftKey
          ? notes.filter(n => n.selected || n.id === clickedNote.id).map(n => ({ ...n }))
          : [{ ...clickedNote }]
      })
    } else {
      if (e.shiftKey) {
        // Start marquee selection
        setDragState({
          type: 'marquee',
          startX: x,
          startY: y,
          currentX: x,
          currentY: y,
          initialSelectedIds: new Set(notes.filter(n => n.selected).map(n => n.id))
        })
      } else {
        // Clear selection if clicking empty space without Shift
        if (!e.shiftKey && notes.some(n => n.selected)) {
          onNotesSelect?.([], true)
        }
        
        // Add new note centered on click position
        const duration = beatsPerDivision
        const centeredStart = beat - duration / 2
        const snappedBeat = snapToBeat(Math.max(0, centeredStart))
        
        onNoteAdd?.(noteName, snappedBeat, duration)
      }
    }
  }, [enabled, dragState, beatWidth, lowestNote, highestNote, notes, snapToBeat, beatsPerDivision, 
      xToBeat, yToMidi, midiToNoteName, noteToMidi, beatToX, onNotesSelect, onNoteAdd])

  // Double click handler for delete
  const handleCanvasDoubleClick = useCallback((e, canvasRef) => {
    if (!enabled) return
    const canvas = canvasRef.current
    if (!canvas) return
    
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    
    const midiNum = yToMidi(y, lowestNote, highestNote)
    
    // Find double-clicked note
    for (let note of notes) {
      const noteMidi = noteToMidi(note.note)
      if (noteMidi !== midiNum) continue
      
      const noteX = beatToX(note.start, beatWidth)
      const noteW = note.duration * beatWidth
      
      if (x >= noteX && x <= noteX + noteW) {
        onNoteDelete?.(note.id)
        break
      }
    }
  }, [enabled, notes, beatWidth, lowestNote, highestNote, yToMidi, noteToMidi, beatToX, onNoteDelete])

  // Global mouse move handler for dragging
  const handleGlobalMouseMove = useCallback((e) => {
    if (!enabled) return
    if (!dragState) return
    
    hasDraggedRef.current = true
    
    if (!historySavedRef.current) {
      onDragStart?.()
      historySavedRef.current = true
    }
    
    // Calculate delta in musical coordinates
    const rect = e.target.getBoundingClientRect?.() || { left: 0, top: 0 }
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    
    if (dragState.type === 'marquee') {
      const newX = e.clientX - rect.left
      const newY = e.clientY - rect.top
      
      setDragState(prev => ({
        ...prev,
        currentX: newX,
        currentY: newY
      }))

      // Calculate selection box
      const minX = Math.min(dragState.startX, newX)
      const maxX = Math.max(dragState.startX, newX)
      const minY = Math.min(dragState.startY, newY)
      const maxY = Math.max(dragState.startY, newY)

      const minBeat = xToBeat(minX, beatWidth)
      const maxBeat = xToBeat(maxX, beatWidth)
      const maxMidi = yToMidi(minY, lowestNote, highestNote) // smaller Y = higher pitch
      const minMidi = yToMidi(maxY, lowestNote, highestNote)

      // Find all notes intersecting the box
      const selectedIds = new Set(dragState.initialSelectedIds)
      
      notes.forEach(note => {
        const noteMidi = noteToMidi(note.note)
        const noteStartBeat = note.start
        const noteEndBeat = note.start + note.duration
        
        const intersectsTime = noteStartBeat <= maxBeat && noteEndBeat >= minBeat
        const intersectsPitch = noteMidi >= minMidi && noteMidi <= maxMidi
        
        if (intersectsTime && intersectsPitch) {
          selectedIds.add(note.id)
        } else if (!dragState.initialSelectedIds.has(note.id)) {
          selectedIds.delete(note.id)
        }
      })
      
      // We need a way to update selection in real-time. We can call onNotesSelect 
      // with all currently selected IDs, and exclusive = true so it replaces.
      onNotesSelect?.(Array.from(selectedIds), true, false)
      
      return
    }

    const currentBeat = xToBeat(x, beatWidth)
    const currentMidi = yToMidi(y, lowestNote, highestNote)
    
    const beatDelta = currentBeat - dragState.startBeat
    const midiDelta = currentMidi - dragState.startMidi
    
    if (dragState.type === 'move') {
      // Move notes
      dragState.noteIds.forEach((noteId, i) => {
        const original = dragState.originalNotes[i]
        const newStart = snapToBeat(original.start + beatDelta)
        const newMidi = original ? noteToMidi(original.note) + midiDelta : currentMidi
        const newNote = midiToNoteName(Math.max(lowestNote, Math.min(highestNote, newMidi)))
        
        onNoteUpdate?.(noteId, {
          start: Math.max(0, newStart),
          note: newNote
        })
      })
    } else if (dragState.type === 'start') {
      // Resize from start
      dragState.noteIds.forEach((noteId, i) => {
        const original = dragState.originalNotes[i]
        const newStart = snapToBeat(original.start + beatDelta)
        const newDuration = Math.max(beatsPerDivision, original.duration - (newStart - original.start))
        
        onNoteUpdate?.(noteId, {
          start: Math.max(0, newStart),
          duration: newDuration
        })
      })
    } else if (dragState.type === 'end') {
      // Resize from end
      dragState.noteIds.forEach((noteId, i) => {
        const original = dragState.originalNotes[i]
        const newEnd = snapToBeat(original.start + original.duration + beatDelta)
        const newDuration = Math.max(beatsPerDivision, newEnd - original.start)
        
        onNoteUpdate?.(noteId, { duration: newDuration })
      })
    }
  }, [enabled, dragState, beatWidth, lowestNote, highestNote, snapToBeat, beatsPerDivision,
      xToBeat, yToMidi, noteToMidi, midiToNoteName, onDragStart, onNoteUpdate, notes])

  // Global mouse up handler
  const handleGlobalMouseUp = useCallback(() => {
    if (!enabled) return
    if (dragState) {
      if (hasDraggedRef.current) {
        onDragEnd?.()
      }
      setDragState(null)
    }
  }, [enabled, dragState, onDragEnd])

  return {
    dragState,
    cursorStyle,
    handleCanvasMouseMove,
    handleCanvasMouseDown,
    handleCanvasDoubleClick,
    handleGlobalMouseMove,
    handleGlobalMouseUp
  }
}
