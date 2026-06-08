import { useMemo } from 'react'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * Convert note name to MIDI number
 */
const noteToMidi = (note) => {
  if (!note || typeof note !== 'string') return -1
  const match = note.match(/^([A-Ga-g])(#|b?)(\d+)$/)
  if (!match) return -1
  let [, letter, accidental, octaveStr] = match
  letter = letter.toUpperCase()
  const normalized = `${letter}${accidental}`
  const pitchClass = NOTE_NAMES.indexOf(normalized)
  if (pitchClass < 0) return -1
  const octave = parseInt(octaveStr, 10)
  return (octave + 1) * 12 + pitchClass
}

// Key signature definitions: which notes should be sharp/flat
const KEY_SIGNATURES = {
  // Major keys
  'C': { sharps: [], flats: [] },
  'G': { sharps: ['F'], flats: [] },
  'D': { sharps: ['F', 'C'], flats: [] },
  'A': { sharps: ['F', 'C', 'G'], flats: [] },
  'E': { sharps: ['F', 'C', 'G', 'D'], flats: [] },
  'B': { sharps: ['F', 'C', 'G', 'D', 'A'], flats: [] },
  'F#': { sharps: ['F', 'C', 'G', 'D', 'A', 'E'], flats: [] },
  'C#': { sharps: ['F', 'C', 'G', 'D', 'A', 'E', 'B'], flats: [] },
  'F': { sharps: [], flats: ['B'] },
  'Bb': { sharps: [], flats: ['B', 'E'] },
  'Eb': { sharps: [], flats: ['B', 'E', 'A'] },
  'Ab': { sharps: [], flats: ['B', 'E', 'A', 'D'] },
  'Db': { sharps: [], flats: ['B', 'E', 'A', 'D', 'G'] },
  'Gb': { sharps: [], flats: ['B', 'E', 'A', 'D', 'G', 'C'] },
  'Cb': { sharps: [], flats: ['B', 'E', 'A', 'D', 'G', 'C', 'F'] },
}

// Enharmonic equivalents mapping
const ENHARMONIC_MAP = {
  'C#': 'Db',
  'D#': 'Eb',
  'F#': 'Gb',
  'G#': 'Ab',
  'A#': 'Bb',
  'Db': 'C#',
  'Eb': 'D#',
  'Gb': 'F#',
  'Ab': 'G#',
  'Bb': 'A#',
}

/**
 * Convert MIDI note to enharmonic note name based on key signature
 */
function getEnharmonicNoteName(midiNum, key, keyMode) {
  const octave = Math.floor(midiNum / 12) - 1
  const semitone = midiNum % 12
  let noteName = NOTE_NAMES[semitone]
  
  // Get key signature (use relative minor for minor keys)
  let keySignature = KEY_SIGNATURES[key]
  
  if (keyMode === 'Minor') {
    // Convert to relative major for key signature lookup
    const minorToMajor = {
      'A': 'C', 'E': 'G', 'B': 'D', 'F#': 'A', 'C#': 'E', 'G#': 'B', 'D#': 'F#', 'A#': 'C#',
      'D': 'F', 'G': 'Bb', 'C': 'Eb', 'F': 'Ab', 'Bb': 'Db', 'Eb': 'Gb', 'Ab': 'Cb'
    }
    const relativeMajor = minorToMajor[key] || 'C'
    keySignature = KEY_SIGNATURES[relativeMajor] || { sharps: [], flats: [] }
  }
  
  if (!keySignature) {
    keySignature = { sharps: [], flats: [] }
  }
  
  // Check if this note should use enharmonic spelling
  if (noteName.includes('#') || noteName.includes('b')) {
    const baseNote = noteName[0]
    
    // If key uses flats and note is sharp, convert to flat
    if (noteName.includes('#') && keySignature.flats.length > 0) {
      const flatEquivalent = ENHARMONIC_MAP[noteName]
      if (flatEquivalent) {
        noteName = flatEquivalent
      }
    }
    // If key uses sharps and note is flat, convert to sharp
    else if (noteName.includes('b') && keySignature.sharps.length > 0) {
      const sharpEquivalent = ENHARMONIC_MAP[noteName]
      if (sharpEquivalent) {
        noteName = sharpEquivalent
      }
    }
  }
  
  // Return note name without octave
  return noteName
}

/**
 * Hook to add note name analysis to notes based on key signature
 */
export function useNoteNameAnalysis(notes, tonic, keyMode) {
  return useMemo(() => {
    if (!notes || notes.length === 0) return []
    
    return notes.map(note => {
      const midiNum = typeof note.note === 'string' 
        ? noteToMidi(note.note)
        : note.note
      
      if (midiNum < 0) return { ...note, note_name: '?' }
      
      const noteName = getEnharmonicNoteName(midiNum, tonic, keyMode)
      
      return {
        ...note,
        note_name: noteName
      }
    })
  }, [notes, tonic, keyMode])
}
