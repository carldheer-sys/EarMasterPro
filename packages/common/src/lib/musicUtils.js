const SEMITONE_TO_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const noteToMidi = (note) => {
  const match = String(note || '').match(/^([A-G](?:#|b)?)(-?\d+)$/)
  if (!match) return null
  const [, pitchClass, octaveStr] = match
  
  const sharpIdx = SEMITONE_TO_SHARP.indexOf(pitchClass)
  const semitone = sharpIdx !== -1 ? sharpIdx : -1
  
  if (semitone === -1) return null
  return (Number(octaveStr) + 1) * 12 + semitone
}

export const midiToNote = (midi) => {
  const normalized = Math.max(0, Math.round(midi))
  const octave = Math.floor(normalized / 12) - 1
  const semitone = normalized % 12
  return `${SEMITONE_TO_SHARP[semitone]}${octave}`
}

export const generateId = () => Math.random().toString(36).substr(2, 9)
