import { describe, it, expect } from 'vitest'
import { computeScaleDegrees } from '../apps/web/src/hooks/useScaleDegreeAnalysis.js'
import { buildMeterTimeline, detectTimeDivision, keyAtBeat } from '@common/lib/midiUtils.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/catalog')
const load = (rel) => JSON.parse(readFileSync(path.join(base, rel), 'utf8'))

describe('keyEvents — Die with a Smile chorus (trimmed at the key change)', () => {
  const s = load('Bruno Mars - Die with a Smile/chorus/session.eartrainer.json')

  it('is single-key F# minor — the A-major material is excluded', () => {
    expect(s.keyEvents).toEqual([{ beat: 0, key: 'F#', keyMode: 'Minor' }])
  })

  it('all content ends at or before beat 43 (the key-change boundary)', () => {
    const end = Math.max(
      ...s.notes.map(n => n.start + n.duration),
      ...s.chordsNotes.map(n => n.start + n.duration),
    )
    expect(end).toBeLessThanOrEqual(43)
  })

  it('starts with a partial 2/8 pickup bar, then 6/8', () => {
    expect(s.meterEvents).toEqual([
      { beat: 0, numerator: 2, denominator: 8 },
      { beat: 1, numerator: 6, denominator: 8 },
    ])
  })
})

describe('keyEvents — per-beat key resolution (synthetic F#m → A @43)', () => {
  const keyEvents = [
    { beat: 0, key: 'F#', keyMode: 'Minor' },
    { beat: 43, key: 'A', keyMode: 'Major' },
  ]

  it('keyAtBeat resolves the right key per beat', () => {
    expect(keyAtBeat(keyEvents, 0).key).toBe('F#')
    expect(keyAtBeat(keyEvents, 42.999).key).toBe('F#')
    expect(keyAtBeat(keyEvents, 43).key).toBe('A')
    expect(keyAtBeat(keyEvents, 100).key).toBe('A')
  })

  it('labels melody degrees in the active key across the change', () => {
    const notes = [
      { id: 'a', note: 'A3', start: 41, duration: 1, velocity: 0.8 },
      { id: 'b', note: 'G#3', start: 43, duration: 1, velocity: 0.8 },
      { id: 'c', note: 'C#5', start: 47.5, duration: 1, velocity: 0.8 },
    ]
    const analyzed = computeScaleDegrees(notes, 'F#', 'Minor', keyEvents)
    // A3 at 41 (before change): b3 of F# minor
    expect(analyzed[0].degree_info.scale_degree).toBe('b3')
    expect(analyzed[0].degree_info.is_diatonic).toBe(true)
    // G#3 at 43 (at change): 7 of A major (would be 2 in F# minor)
    expect(analyzed[1].degree_info.scale_degree).toBe('7')
    // C#5 at 47.5 (after change): 3 of A major (would be 5 in F# minor)
    expect(analyzed[2].degree_info.scale_degree).toBe('3')
    expect(analyzed[2].degree_info.is_diatonic).toBe(true)
  })
})

describe('meterEvents — The Line chorus (4/4 → 2/4 @24)', () => {
  const s = load('Twenty One Pilots - The Line/chorus/session.eartrainer.json')

  it('has a meter change at beat 24', () => {
    expect(s.meterEvents).toEqual([
      { beat: 0, numerator: 4, denominator: 4 },
      { beat: 24, numerator: 2, denominator: 4 },
    ])
  })

  it('buildMeterTimeline ends at the 2/4 bar boundary (26, not 28)', () => {
    const end = Math.max(
      ...s.notes.map(n => n.start + n.duration),
      ...s.chordsNotes.map(n => n.start + n.duration),
    )
    const tl = buildMeterTimeline(s.meterEvents, end)
    expect(tl.totalBeats).toBe(26)
    expect(tl.barStarts.length).toBe(7)
    expect(tl.barStarts[6]).toMatchObject({ start: 24, numerator: 2 })
  })
})

describe('pickup windows — Ghost chorus and Die with a Smile verse', () => {
  it('Ghost chorus starts with the degree-7 pickup figure', () => {
    const s = load('Ghost - The Future is a Foreign Land/chorus/session.eartrainer.json')
    // b7 in G minor = F; three pickup notes before the downbeat D (5) at beat 6
    expect(s.notes[0]).toMatchObject({ note: 'F4', start: 2.5, duration: 0.5 })
    expect(s.notes[1]).toMatchObject({ note: 'F4', start: 3.0 })
    expect(s.notes[2]).toMatchObject({ note: 'F4', start: 3.5, duration: 2.5 })
    expect(s.notes[3]).toMatchObject({ note: 'D4', start: 6.0 })
    expect(s.settings.bars).toBe(19)
  })

  it('Die with a Smile verse includes the 5-6-1-7 pickup run', () => {
    const s = load('Bruno Mars - Die with a Smile/verse/session.eartrainer.json')
    expect(s.notes[0]).toMatchObject({ note: 'E4', start: 1.0, duration: 0.25 })
    expect(s.notes.slice(0, 4).map(n => n.note)).toEqual(['E4', 'F#4', 'A4', 'G#4'])
    expect(s.settings.bars).toBe(17)
  })
})

describe('detectTimeDivision', () => {
  it('detects per-part resolution', () => {
    const doj = load('Breaking Benjamin - Diary of Jane/chorus/session.eartrainer.json')
    const ord = load('Alex Warren - Ordinary/chorus/session.eartrainer.json')
    const line = load('Twenty One Pilots - The Line/chorus/session.eartrainer.json')
    expect(detectTimeDivision(doj.notes)).toBe('1/16')
    expect(detectTimeDivision(doj.chordsNotes)).toBe('1/4')
    expect(detectTimeDivision(ord.notes)).toBe('1/8')
    expect(detectTimeDivision(line.notes)).toBe('1/16')
    expect(detectTimeDivision(line.chordsNotes)).toBe('1/4')
  })
})
