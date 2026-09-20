import * as MidiNS from '@tonejs/midi'
import { exportToMidi, importFromMidi } from '../packages/common/src/lib/midiUtils.js'

const Midi = MidiNS.Midi || MidiNS.default?.Midi

function assertClose(actual, expected, label) {
  if (Math.abs(actual - expected) > 0.0001) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

console.log('🧪 Starting MIDI Import/Export Timing Tests\n')

const timeSignature = { numerator: 12, denominator: 8 }
const exportedBlob = exportToMidi([
  { note: 'C4', start: 0, duration: 1, velocity: 0.8 }
], 112, '1/8', 0, 'C', 'Major', timeSignature)
const exportedBuffer = await exportedBlob.arrayBuffer()
const exportedMidi = new Midi(exportedBuffer)
const exportedNote = exportedMidi.tracks[0].notes[0]

assertClose(exportedNote.durationTicks, exportedMidi.header.ppq, '12/8 exported one-quarter-note duration ticks')

const importedExport = await importFromMidi(exportedBuffer, 120)
assertClose(importedExport.notes[0].duration, 1, '12/8 round-trip imported duration')
assertClose(importedExport.tempo, 112, '12/8 round-trip project tempo')

const externalMidi = new Midi()
externalMidi.header.setTempo(168)
externalMidi.header.timeSignatures.push({ timeSignature: [12, 8], ticks: 0 })
externalMidi.addTrack().addNote({ name: 'D4', ticks: 0, durationTicks: externalMidi.header.ppq, velocity: 0.8 })

const importedExternal = await importFromMidi(externalMidi.toArray().buffer, 120)
assertClose(importedExternal.notes[0].duration, 1, '12/8 external MIDI imported duration')
assertClose(importedExternal.tempo, 112, '12/8 external MIDI project tempo')

const legacyEarMasterMidi = new Midi()
legacyEarMasterMidi.header.setTempo(168)
legacyEarMasterMidi.header.timeSignatures.push({ timeSignature: [12, 8], ticks: 0 })
const legacyTrack = legacyEarMasterMidi.addTrack()
legacyTrack.name = 'TimeDivision:1/8;PickupBeats:0;Key:C;KeyMode:Major;TimeSignature:12/8'
legacyTrack.addNote({ name: 'E4', time: 0, duration: 60 / 112, velocity: 0.8 })

const importedLegacy = await importFromMidi(legacyEarMasterMidi.toArray().buffer, 120)
assertClose(importedLegacy.notes[0].duration, 1, '12/8 legacy EarMasterPro imported duration')
assertClose(importedLegacy.tempo, 112, '12/8 legacy EarMasterPro project tempo')

console.log('🎉 All MIDI Import/Export Timing Tests Passed!')
