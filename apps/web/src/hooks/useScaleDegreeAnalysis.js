import { useMemo } from 'react'
import { normalizeKeyName, keyAtBeat } from '@common/lib/midiUtils'

/**
 * Calculate scale degrees for notes based on a tonic
 * Uses modulo arithmetic: (note - tonic) mod 12
 * Maps degrees to labels like "1", "b2", "#2", "b3", "3", etc.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Map MIDI note number to pitch class (0-11)
const midiToPitchClass = (midiNote) => {
  return midiNote % 12
}

// Convert note name to pitch class (flat-aware: 'Bb' → 10)
const noteNameToPitchClass = (noteName) => {
  const index = NOTE_NAMES.indexOf(normalizeKeyName(noteName))
  return index >= 0 ? index : 0
}

// Map chromatic distance to scale degree label
// Based on common music theory conventions
const degreeMap = {
  0: '1',      // Unison/Tonic
  1: 'b2',     // Minor 2nd
  2: '2',      // Major 2nd
  3: 'b3',     // Minor 3rd
  4: '3',      // Major 3rd
  5: '4',      // Perfect 4th
  6: '#4',     // Tritone/Augmented 4th
  7: '5',      // Perfect 5th
  8: 'b6',     // Minor 6th
  9: '6',      // Major 6th
  10: 'b7',    // Minor 7th
  11: '7'      // Major 7th
}

// Determine if a degree is diatonic in major scale
const isDiatonicMajor = (chromaticDistance) => {
  return [0, 2, 4, 5, 7, 9, 11].includes(chromaticDistance)
}

// Determine if a degree is diatonic in minor scale (natural minor)
const isDiatonicMinor = (chromaticDistance) => {
  return [0, 2, 3, 5, 7, 8, 10].includes(chromaticDistance)
}

/**
 * Pure computation: annotate notes with scale-degree info.
 * `keyEvents` (optional [{beat, key, keyMode}]) resolves the active key per
 * note for sections with key changes.
 */
export function computeScaleDegrees(notes, tonic, mode = 'Major', keyEvents = null) {
  if (!notes || notes.length === 0) return []

  // Convert tonic to pitch class
  const baseTonicPc = typeof tonic === 'string' ? noteNameToPitchClass(tonic) : tonic % 12

  // Calculate scale degree for each note
  return notes.map(note => {
    // Defensive check: ensure note and note.note exist and are valid
    if (!note || !note.note) {
      return note
    }

    // Resolve the key active at this note's beat (supports key changes)
    let tonicPitchClass = baseTonicPc
    let noteMode = mode
    if (keyEvents && keyEvents.length > 1) {
      const k = keyAtBeat(keyEvents, note.start, tonic, mode)
      tonicPitchClass = noteNameToPitchClass(k.key)
      noteMode = k.keyMode
    }

    // Ensure note.note is a string
    const noteName = typeof note.note === 'string' ? note.note : String(note.note)

    // Extract MIDI note number from note name (e.g., "C4" -> 60)
    const midiNote = noteNameToMidi(noteName)
    const pitchClass = midiToPitchClass(midiNote)

    // Calculate chromatic distance from tonic
    const chromaticDistance = (pitchClass - tonicPitchClass + 12) % 12

    // Map to scale degree label
    const scaleDegree = degreeMap[chromaticDistance]

    // Check if diatonic
    const isDiatonic = noteMode === 'Major'
      ? isDiatonicMajor(chromaticDistance)
      : isDiatonicMinor(chromaticDistance)

    return {
      ...note,
      degree_info: {
        scale_degree: scaleDegree,
        chromatic_distance: chromaticDistance,
        is_diatonic: isDiatonic
      }
    }
  })
}

export function useScaleDegreeAnalysis(notes, tonic, mode = 'Major', keyEvents = null) {
  return useMemo(
    () => computeScaleDegrees(notes, tonic, mode, keyEvents),
    [notes, tonic, mode, keyEvents]
  )
}

// Helper: Convert note name to MIDI number
// Format: "C4" = 60, "A4" = 69, etc. Handles sharps, flats, and double
// accidentals (E# = F, Bb, G##, …) — same semantics as PianoRoll's parser.
function noteNameToMidi(noteName) {
  // Defensive check: ensure noteName is a string
  if (typeof noteName !== 'string') {
    return 60 // Default to C4
  }

  // Extract note name and octave
  const match = noteName.match(/^([A-Ga-g])(#{0,2}|b{0,2})(-?\d+)$/)
  if (!match) {
    return 60 // Default to C4
  }

  const letter = match[1].toUpperCase()
  const octave = parseInt(match[3], 10)

  // Base pitch class of the letter, then apply accidentals
  let pitchClass = NOTE_NAMES.indexOf(letter)
  if (pitchClass < 0) return 60
  for (const ch of match[2]) pitchClass += ch === '#' ? 1 : -1

  // Calculate MIDI note: (octave + 1) * 12 + pitchClass
  return (octave + 1) * 12 + pitchClass
}
