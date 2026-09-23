/**
 * Scale Degree Analysis tests — real vitest suite.
 *
 * Tests computeScaleDegrees across keys/modes: degree labels and
 * diatonic/non-diatonic classification via modulo arithmetic.
 */

import { describe, it, expect } from 'vitest'
import { computeScaleDegrees } from '../apps/web/src/hooks/useScaleDegreeAnalysis.js'

const createNotes = (pitches) =>
  pitches.map((pitch, i) => ({
    id: `note-${i}`,
    note: pitch,
    start: i * 0.5,
    duration: 0.5,
    velocity: 0.8,
  }))

const extractDegrees = (notes) => notes.map(n => n.degree_info?.scale_degree)
const extractDiatonic = (notes) => notes.map(n => n.degree_info?.is_diatonic)

describe('computeScaleDegrees — degree labels', () => {
  it.each([
    ['C', ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5']],
    ['G', ['G4', 'A4', 'B4', 'C5', 'D5', 'E5', 'F#5', 'G5']],
    ['D', ['D4', 'E4', 'F#4', 'G4', 'A4', 'B4', 'C#5', 'D5']],
    ['F#', ['F#4', 'G#4', 'A#4', 'B4', 'C#5', 'D#5', 'E#5', 'F#5']],
    ['A#', ['A#4', 'C5', 'D5', 'D#5', 'F5', 'G5', 'A5', 'A#5']],
  ])('labels the %s major scale 1..7', (key, pitches) => {
    const out = computeScaleDegrees(createNotes(pitches), key, 'Major')
    expect(extractDegrees(out)).toEqual(['1', '2', '3', '4', '5', '6', '7', '1'])
    expect(extractDiatonic(out)).toEqual(pitches.map(() => true))
  })

  it.each([
    ['A', ['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5']],
    ['E', ['E4', 'F#4', 'G4', 'A4', 'B4', 'C5', 'D5', 'E5']],
    ['C#', ['C#4', 'D#4', 'E4', 'F#4', 'G#4', 'A4', 'B4', 'C#5']],
  ])('labels the %s natural minor scale 1,2,b3,4,5,b6,b7', (key, pitches) => {
    const out = computeScaleDegrees(createNotes(pitches), key, 'Minor')
    expect(extractDegrees(out)).toEqual(['1', '2', 'b3', '4', '5', 'b6', 'b7', '1'])
    expect(extractDiatonic(out)).toEqual(pitches.map(() => true))
  })

  it('labels the full chromatic scale in C major', () => {
    const out = computeScaleDegrees(
      createNotes(['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4']),
      'C', 'Major')
    expect(extractDegrees(out)).toEqual(['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'])
  })

  it('labels the same pitch class across octaves identically', () => {
    const out = computeScaleDegrees(createNotes(['C3', 'C4', 'C5', 'C6']), 'C', 'Major')
    expect(extractDegrees(out)).toEqual(['1', '1', '1', '1'])
  })
})

describe('computeScaleDegrees — diatonic flags', () => {
  it('flags chromatic notes non-diatonic in C major', () => {
    const out = computeScaleDegrees(createNotes(['C4', 'C#4', 'D4', 'D#4']), 'C', 'Major')
    expect(extractDegrees(out)).toEqual(['1', 'b2', '2', 'b3'])
    expect(extractDiatonic(out)).toEqual([true, false, true, false])
  })

  it('flags non-diatonic notes across the C major scale', () => {
    const out = computeScaleDegrees(createNotes(['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4']), 'C', 'Major')
    expect(extractDiatonic(out)).toEqual([true, false, true, false, true, true, false])
  })

  it('flags non-diatonic notes in A minor', () => {
    const out = computeScaleDegrees(createNotes(['A4', 'A#4', 'B4', 'C5', 'C#5', 'D5', 'D#5']), 'A', 'Minor')
    expect(extractDegrees(out)).toEqual(['1', 'b2', '2', 'b3', '3', '4', '#4'])
    expect(extractDiatonic(out)).toEqual([true, false, true, true, false, true, false])
  })

  it('flags modal notes diatonic in G dorian', () => {
    // G dorian: G A Bb C D E F — Bb (A#3) and F are diatonic, G# is not.
    const out = computeScaleDegrees(createNotes(['G3', 'A3', 'A#3', 'C4', 'D4', 'E4', 'F4', 'G#3']), 'G', 'Dorian')
    expect(extractDegrees(out)).toEqual(['1', '2', 'b3', '4', '5', '6', 'b7', 'b2'])
    expect(extractDiatonic(out)).toEqual([true, true, true, true, true, true, true, false])
  })

  it('flags modal notes diatonic in F lydian and D mixolydian', () => {
    // F lydian: F G A B C D E — B is diatonic (unlike F major's Bb).
    const lydian = computeScaleDegrees(createNotes(['F4', 'B4', 'A#4']), 'F', 'Lydian')
    expect(extractDegrees(lydian)).toEqual(['1', '#4', '4'])
    expect(extractDiatonic(lydian)).toEqual([true, true, false])
    // D mixolydian: D E F# G A B C — C natural is diatonic (unlike D major's C#).
    const mixo = computeScaleDegrees(createNotes(['D4', 'C4', 'C#4']), 'D', 'Mixolydian')
    expect(extractDegrees(mixo)).toEqual(['1', 'b7', '7'])
    expect(extractDiatonic(mixo)).toEqual([true, true, false])
  })

  it('unknown modes fall back to major', () => {
    const out = computeScaleDegrees(createNotes(['G4', 'F4', 'F#4']), 'G', 'Whatever')
    expect(extractDiatonic(out)).toEqual([true, false, true])
  })
})
