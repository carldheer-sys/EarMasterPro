import { describe, it, expect } from 'vitest'
import { computeScaleDegrees } from '../apps/web/src/hooks/useScaleDegreeAnalysis.js'
import { buildMeterTimeline, detectTimeDivision, keyAtBeat } from '@common/lib/midiUtils.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/catalog')
const load = (rel) => JSON.parse(readFileSync(path.join(base, rel), 'utf8'))

describe('keyEvents — Die with a Smile chorus (F#m → A @43)', () => {
  const s = load('Bruno Mars - Die with a Smile/chorus/session.eartrainer.json')

  it('has a key change at beat 43', () => {
    expect(s.keyEvents).toEqual([
      { beat: 0, key: 'F#', keyMode: 'Minor' },
      { beat: 43, key: 'A', keyMode: 'Major' },
    ])
  })

  it('keyAtBeat resolves the right key per beat', () => {
    expect(keyAtBeat(s.keyEvents, 0).key).toBe('F#')
    expect(keyAtBeat(s.keyEvents, 42.999).key).toBe('F#')
    expect(keyAtBeat(s.keyEvents, 43).key).toBe('A')
    expect(keyAtBeat(s.keyEvents, 100).key).toBe('A')
  })

  it('labels melody degrees in the active key across the change', () => {
    const analyzed = computeScaleDegrees(s.notes, 'F#', 'Minor', s.keyEvents)
    // A3 at 41 (before change): b3 of F# minor
    const aBefore = analyzed.find(n => n.note === 'A3' && n.start === 41)
    expect(aBefore?.degree_info.scale_degree).toBe('b3')
    expect(aBefore?.degree_info.is_diatonic).toBe(true)
    // G#3 at 43 (at change): 7 of A major (would be 2 in F# minor)
    const gAfter = analyzed.find(n => n.note === 'G#3' && n.start === 43)
    expect(gAfter?.degree_info.scale_degree).toBe('7')
    // C#5 at 47.5 (after change): 3 of A major (would be 5 in F# minor)
    const cAfter = analyzed.find(n => n.note === 'C#5' && n.start === 47.5)
    expect(cAfter?.degree_info.scale_degree).toBe('3')
    expect(cAfter?.degree_info.is_diatonic).toBe(true)
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
