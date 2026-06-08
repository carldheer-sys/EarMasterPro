import { Midi } from '@tonejs/midi'

const FLAT_TO_SHARP_KEYS = {
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
  Cb: 'B'
}

const SHARP_TO_FLAT_KEYS = {
  'C#': 'Db',
  'D#': 'Eb',
  'F#': 'Gb',
  'G#': 'Ab',
  'A#': 'Bb'
}

function normalizeKeyName(key) {
  return FLAT_TO_SHARP_KEYS[key] || key || 'C'
}

function normalizeKeyMode(mode) {
  return String(mode || 'major').toLowerCase() === 'minor' ? 'Minor' : 'Major'
}

export const DEFAULT_TIME_SIGNATURE = { numerator: 4, denominator: 4 }

export function normalizeTimeSignature(timeSignature) {
  const numerator = Math.max(1, Math.round(Number(timeSignature?.numerator) || DEFAULT_TIME_SIGNATURE.numerator))
  const denominator = Number(timeSignature?.denominator) === 8 ? 8 : 4
  return { numerator, denominator }
}

export function timeSignatureToString(timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  return `${normalized.numerator}/${normalized.denominator}`
}

export function parseTimeSignature(value) {
  if (typeof value === 'string') {
    const match = value.match(/^(\d+)\/(4|8)$/)
    if (match) {
      return normalizeTimeSignature({ numerator: parseInt(match[1], 10), denominator: parseInt(match[2], 10) })
    }
  }
  if (Array.isArray(value)) {
    return normalizeTimeSignature({ numerator: value[0], denominator: value[1] })
  }
  return normalizeTimeSignature(value)
}

export function beatsPerBarFromTimeSignature(timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  return normalized.numerator * (4 / normalized.denominator)
}

export function isCompoundTimeSignature(timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  return [6, 9, 12].includes(normalized.numerator)
}

export function getInternalBpm(projectBpm, timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  const { numerator, denominator } = normalized
  
  if (isCompoundTimeSignature(timeSignature)) {
    // Compound reference note relative to a quarter note is:
    // For denominator 8, the reference is a dotted quarter note (1.5 quarter notes).
    // For denominator 4, the reference is a dotted half note (3.0 quarter notes).
    const multiplier = 1.5 * (8 / denominator)
    return projectBpm * multiplier
  } else {
    // Simple reference note relative to a quarter note is 4 / denominator.
    // For denominator 8 (like 7/8), reference is eighth note (0.5 quarter notes).
    // For denominator 4 (like 4/4), reference is quarter note (1.0 quarter notes).
    return projectBpm * (4 / denominator)
  }
}

export function getProjectBpm(internalBpm, timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  const { numerator, denominator } = normalized
  
  if (isCompoundTimeSignature(timeSignature)) {
    const multiplier = 1.5 * (8 / denominator)
    return Math.round(internalBpm / multiplier)
  } else {
    return Math.round(internalBpm / (4 / denominator))
  }
}

export function getMainBeatsPerBar(timeSignature) {
  const normalized = normalizeTimeSignature(timeSignature)
  const { numerator } = normalized
  
  if (isCompoundTimeSignature(timeSignature)) {
    return numerator / 3
  } else {
    return numerator
  }
}

export function beatsPerDivisionFromTimeDivision(timeDivision, timeSignature = DEFAULT_TIME_SIGNATURE) {
  const match = String(timeDivision || '1/4').match(/^1\/(1|2|4|8|16|32)$/)
  const divisionDenominator = match ? Number(match[1]) : 4
  
  const normalizedTS = normalizeTimeSignature(timeSignature)
  const { numerator, denominator } = normalizedTS
  
  // For compound meters over 8 (numerator is a multiple of 3, denominator is 8)
  if (denominator === 8 && numerator % 3 === 0) {
    const mainBeatBeats = 1.5 // A dotted quarter note is 1.5 quarter notes
    
    if (divisionDenominator === 4) {
      // In compound meters, '1/4' (quarter division) represents the main beat of the bar, which is a dotted quarter note (1.5 beats)
      return mainBeatBeats
    } else if (divisionDenominator === 2) {
      // '1/2' represents two main beats, i.e., a dotted half note (3.0 beats)
      return mainBeatBeats * 2
    } else if (divisionDenominator === 1) {
      // '1/1' represents the entire bar
      return numerator * 0.5
    } else {
      // '1/8', '1/16', '1/32' are standard eighth, sixteenth, etc. notes
      return 4 / divisionDenominator
    }
  }
  
  // For other meters over 8 (e.g., 5/8, 7/8)
  if (denominator === 8) {
    if (divisionDenominator === 1) {
      // '1/1' represents the entire bar
      return numerator * 0.5
    } else {
      // Other divisions are standard quarter, eighth, sixteenth, etc. notes
      return 4 / divisionDenominator
    }
  }
  
  // For standard/simple meters over 4 (e.g. 4/4, 3/4, 5/4)
  if (divisionDenominator === 1) {
    // '1/1' represents the entire bar
    return numerator
  }
  
  return 4 / divisionDenominator
}

export const exportToMidi = (notes, tempo, timeDivision = '1/8', pickupBeats = 0, key = 'C', keyMode = 'Major', timeSignature = DEFAULT_TIME_SIGNATURE) => {
  const midi = new Midi()
  const track = midi.addTrack()
  const normalizedKeyMode = normalizeKeyMode(keyMode)
  const midiKey = SHARP_TO_FLAT_KEYS[key] || key || 'C'
  const normalizedTimeSignature = normalizeTimeSignature(timeSignature)
  
  if (midi.header) {
    const internalTempo = getInternalBpm(tempo, timeSignature)
    midi.header.setTempo(internalTempo)
    midi.header.timeSignatures.push({
      timeSignature: [normalizedTimeSignature.numerator, normalizedTimeSignature.denominator],
      ticks: 0
    })
    midi.header.keySignatures.push({
      key: midiKey,
      scale: normalizedKeyMode.toLowerCase(),
      ticks: 0
    })
  }
  
  // Store timeDivision and pickupBeats as track name metadata (MIDI doesn't have a standard field for this)
  track.name = `TimeDivision:${timeDivision};PickupBeats:${pickupBeats};Key:${key};KeyMode:${normalizedKeyMode};TimeSignature:${timeSignatureToString(normalizedTimeSignature)}`
  
  const beatsPerSecond = tempo / 60
  const secondsPerBeat = 1 / beatsPerSecond
  
  notes.forEach(noteData => {
    const time = noteData.start * secondsPerBeat
    const duration = noteData.duration * secondsPerBeat
    
    track.addNote({
      name: noteData.note,
      time: time,
      duration: duration,
      velocity: noteData.velocity || 0.8
    })
  })
  
  const midiData = midi.toArray()
  return new Blob([midiData], { type: 'audio/midi' })
}

export const saveMidiFile = async (blob, defaultName = "my_sequence") => {
  try {
    if ('showSaveFilePicker' in window) {
      const filename = `${defaultName}.mid`
      
      // Get last used directory from localStorage
      let startIn = 'downloads'
      try {
        const lastDirHandle = await getLastMidiDirectory()
        if (lastDirHandle) {
          startIn = lastDirHandle
        }
      } catch (e) {
        // Fallback to downloads if we can't access the last directory
      }
      
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: filename,
        startIn,
        types: [{
          description: 'MIDI files',
          accept: { 'audio/midi': ['.mid', '.midi'] }
        }]
      })
      
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()
      
      // Remember this directory for next time
      await saveLastMidiDirectory(fileHandle)
      
    } else {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.style.display = 'none'
      a.href = url
      a.download = `${defaultName}.mid`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    }
  } catch (error) {
    console.error('Error saving file:', error)
    throw error
  }
}

const noteNameToMidi = (noteName) => {
  const noteMap = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 }
  const match = noteName.match(/^([A-G])(#|b)?(\d+)$/)
  if (!match) return 60
  
  const [, note, accidental, octave] = match
  let semitone = noteMap[note]
  if (accidental === '#') semitone += 1
  if (accidental === 'b') semitone -= 1
  
  return (parseInt(octave) + 1) * 12 + semitone
}

// Helper functions to remember last directory
const LAST_MIDI_DIR_KEY = 'earmaster_last_midi_directory'

async function saveLastMidiDirectory(fileHandle) {
  try {
    // Store the parent directory handle
    const permission = await fileHandle.queryPermission({ mode: 'read' })
    if (permission === 'granted' || permission === 'prompt') {
      // We can't directly serialize FileSystemDirectoryHandle, but we can request it again
      // For now, just store a flag that we had a recent directory
      localStorage.setItem(LAST_MIDI_DIR_KEY, 'true')
    }
  } catch (e) {
    // Ignore errors
  }
}

async function getLastMidiDirectory() {
  // The File System Access API doesn't allow us to persist directory handles easily
  // So we'll just return null and let the browser remember via its own mechanisms
  return null
}

export const importFromMidi = async (arrayBuffer, currentTempo) => {
  try {
    const midi = new Midi(arrayBuffer)
    
    const trackWithNotes = midi.tracks.find(t => t.notes.length > 0)
    
    if (!trackWithNotes) {
      throw new Error("No notes found in the MIDI file.")
    }
    
    const midiTempo = midi.header?.tempos?.length > 0 ? midi.header.tempos[0].bpm : currentTempo
    
    // Try to extract timeDivision and pickupBeats from track name metadata
    let timeDivision = '1/8' // default
    let pickupBeats = 0 // default
    let timeSignature = parseTimeSignature(midi.header?.timeSignatures?.[0]?.timeSignature || DEFAULT_TIME_SIGNATURE)
    
    let key = normalizeKeyName(midi.header?.keySignatures?.[0]?.key || 'C')
    let keyMode = normalizeKeyMode(midi.header?.keySignatures?.[0]?.scale)
    
    if (trackWithNotes.name) {
      const parts = trackWithNotes.name.split(';')
      parts.forEach(part => {
        if (part.startsWith('TimeDivision:')) {
          timeDivision = part.replace('TimeDivision:', '')
        } else if (part.startsWith('PickupBeats:')) {
          pickupBeats = parseFloat(part.replace('PickupBeats:', ''))
        } else if (part.startsWith('Key:')) {
          key = normalizeKeyName(part.replace('Key:', ''))
        } else if (part.startsWith('KeyMode:')) {
          keyMode = normalizeKeyMode(part.replace('KeyMode:', ''))
        } else if (part.startsWith('TimeSignature:')) {
          timeSignature = parseTimeSignature(part.replace('TimeSignature:', ''))
        }
      })
      // Backwards compatibility for old format
      if (trackWithNotes.name.startsWith('TimeDivision:') && !trackWithNotes.name.includes(';')) {
        timeDivision = trackWithNotes.name.replace('TimeDivision:', '')
      }
    }
    
    const beatsPerSecond = midiTempo / 60
    const secondsPerBeat = 1 / beatsPerSecond
    
    let maxBeat = 0
    let lowestMidi = 127
    let highestMidi = 0
    
    const importedNotes = trackWithNotes.notes.map(note => {
      const startBeat = note.time / secondsPerBeat
      const durationBeat = note.duration / secondsPerBeat
      
      const endBeat = startBeat + durationBeat
      if (endBeat > maxBeat) {
        maxBeat = endBeat
      }
      
      const midiNum = noteNameToMidi(note.name)
      if (midiNum < lowestMidi) lowestMidi = midiNum
      if (midiNum > highestMidi) highestMidi = midiNum
      
      return {
        id: Math.random().toString(36).substr(2, 9),
        note: note.name,
        start: startBeat,
        duration: durationBeat,
        velocity: note.velocity
      }
    })
    
    const requiredBars = Math.ceil(maxBeat / beatsPerBarFromTimeSignature(timeSignature))
    const bars = Math.max(1, requiredBars)
    
    const lowestNote = Math.max(0, lowestMidi - 6)
    const highestNote = Math.min(107, highestMidi + 6)
    
    return {
      notes: importedNotes,
      bars,
      tempo: getProjectBpm(midiTempo, timeSignature),
      timeDivision,
      timeSignature,
      pickupBeats,
      key,
      keyMode,
      lowestNote,
      highestNote
    }
  } catch (error) {
    console.error("Error parsing MIDI file:", error)
    throw error
  }
}
