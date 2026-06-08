/**
 * SolfegePlayer
 *
 * Plays chromatic solfege syllables at the correct pitch using Web Audio API.
 * Runs entirely in the frontend – no server dependency – mobile-compatible.
 *
 * Audio files: /samples/Solfege_<Syllable>.wav  (one file per syllable)
 * Each WAV contains 9 pitch slices, each 0.5 s long, separated by 0.5 s silence:
 *   C3  →  offset 0.0 s
 *   E3  →  offset 1.0 s
 *   Ab3 →  offset 2.0 s
 *   C4  →  offset 3.0 s
 *   E4  →  offset 4.0 s
 *   Ab4 →  offset 5.0 s
 *   C5  →  offset 6.0 s
 *   E5  →  offset 7.0 s
 *   Ab5 →  offset 8.0 s
 *
 * Pitch shifting: nearest sample (≤ 2 semitones) pitched via playbackRate = 2^(n/12).
 *
 * Syllable ↔ chromatic degree mapping (movable-Do chromatic solfege):
 *   0  = Do   1  = Ra   2  = Re   3  = Me   4  = Mi
 *   5  = Fa   6  = Fi   7  = Sol  8  = Le   9  = La  10 = Te  11 = Ti
 *
 * ADSR envelope (all times in seconds):
 *   attack  0.005 | decay 0.05 | sustain 0.9 | release 0.15
 */

// ── Constants ────────────────────────────────────────────────────────────────

// Sample pitches: MIDI number → buffer offset (seconds) within each WAV
const SAMPLE_OFFSETS = [
  { midi: 48, offset: 0.0 }, // C3
  { midi: 52, offset: 1.0 }, // E3
  { midi: 56, offset: 2.0 }, // Ab3
  { midi: 60, offset: 3.0 }, // C4
  { midi: 64, offset: 4.0 }, // E4
  { midi: 68, offset: 5.0 }, // Ab4
  { midi: 72, offset: 6.0 }, // C5
  { midi: 76, offset: 7.0 }, // E5
  { midi: 80, offset: 8.0 }, // Ab5
]

const SLICE_DURATION = 0.5 // seconds per pitch slice

// Chromatic degree (0–11) → solfege syllable name (matches filename)
const DEGREE_TO_SYLLABLE = [
  'Do', // 0  – tonic
  'Ra', // 1  – b2
  'Re', // 2  – 2
  'Me', // 3  – b3
  'Mi', // 4  – 3
  'Fa', // 5  – 4
  'Fi', // 6  – #4
  'Sol',// 7  – 5
  'Le', // 8  – b6
  'La', // 9  – 6
  'Te', // 10 – b7
  'Ti', // 11 – 7
]

// All syllable names (used for bulk loading)
const ALL_SYLLABLES = DEGREE_TO_SYLLABLE // same array, no duplicates

// Note-name helpers
const NOTE_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const NOTE_NAMES  = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteNameToMidi(name) {
  const m = name.match(/^([A-G])(#|b)?(-?\d+)$/)
  if (!m) return 60
  const pc = NOTE_CLASS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
  return (parseInt(m[3], 10) + 1) * 12 + pc
}

function noteNameToPitchClass(name) {
  const m = name.match(/^([A-G])(#|b)?/)
  if (!m) return 0
  let pc = NOTE_CLASS[m[1]]
  if (m[2] === '#') pc = (pc + 1) % 12
  if (m[2] === 'b') pc = (pc + 11) % 12
  return pc
}

// Pick the nearest sampled MIDI pitch for a target MIDI number (≤ 2 st preferred)
function nearestSample(targetMidi) {
  let best = SAMPLE_OFFSETS[0]
  let bestDist = Infinity
  for (const s of SAMPLE_OFFSETS) {
    const dist = Math.abs(targetMidi - s.midi)
    if (dist < bestDist) { bestDist = dist; best = s }
  }
  if (bestDist > 2) {
    console.warn(`[SolfegePlayer] Pitch MIDI ${targetMidi} is ${bestDist} st from nearest sample (C3–Ab5 range)`)
  }
  return { sampleMidi: best.midi, offset: best.offset, semitoneShift: targetMidi - best.midi }
}

async function readArrayBuffer(url) {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.arrayBuffer()
  } catch (fetchError) {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', url)
      xhr.responseType = 'arraybuffer'
      xhr.onload = () => {
        if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) resolve(xhr.response)
        else reject(new Error(`HTTP ${xhr.status}`))
      }
      xhr.onerror = () => reject(fetchError)
      xhr.send()
    })
  }
}

// ── SolfegePlayer class ───────────────────────────────────────────────────────

export class SolfegePlayer {
  constructor() {
    this._ctx = null
    this._masterGain = null
    /** @type {Map<string, AudioBuffer>} syllable → full decoded WAV buffer */
    this._buffers = new Map()
    this._loaded = new Set()
    this._loading = new Map() // syllable → Promise
    this._failed = new Map()
    this._lastSuccessfulUrls = new Map()

    // Default ADSR (seconds / gain level)
    this.attack  = 0.005
    this.decay   = 0.05
    this.sustain = 0.9
    this.release = 0.15

    this._volume = 0  // dB
    this._active = [] // { src, gainNode } – for stop()
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(audioContext) {
    // If context changes (e.g. Tone.js re-creates its context), reset loaded state
    // so buffers are re-decoded against the new context.
    if (this._ctx !== audioContext) {
      this._loaded.clear()
      this._loading.clear()
      this._buffers.clear()
      this._failed.clear()
      this._lastSuccessfulUrls.clear()
    }
    this._ctx = audioContext
    this._masterGain = this._ctx.createGain()
    this._masterGain.connect(this._ctx.destination)
    this._applyVolume()
  }

  get volume() { return this._volume }
  set volume(db) { this._volume = db; this._applyVolume() }

  _applyVolume() {
    if (this._masterGain) this._masterGain.gain.value = Math.pow(10, this._volume / 20)
  }

  // ── Sample loading ─────────────────────────────────────────────────────────

  /**
   * Load a single syllable WAV from /samples/Solfege_<Syllable>.wav
   * The entire file is decoded into memory once; slices are read at playback time.
   */
  _loadSyllable(syllable) {
    if (this._loaded.has(syllable)) return Promise.resolve()
    if (this._loading.has(syllable)) return this._loading.get(syllable)

    const promise = (async () => {
      const baseUrl = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'
      const filename = `samples/Solfege_${syllable}.wav`
      const candidates = [
        filename,
        `${baseUrl.replace(/\/$/, '')}/${filename}`,
        new URL(filename, window.location.href).href,
        new URL(`/${filename}`, window.location.origin).href,
        new URL(`public/${filename}`, window.location.href).href,
      ]
      let lastError = null
      try {
        let url = ''
        for (const candidate of [...new Set(candidates)]) {
          try {
            const ab = await readArrayBuffer(candidate)
            url = candidate
            const buf = await this._ctx.decodeAudioData(ab)
            this._buffers.set(syllable, buf)
            this._loaded.add(syllable)
            this._failed.delete(syllable)
            this._lastSuccessfulUrls.set(syllable, url)
            return
          } catch (e) {
            lastError = e
          }
        }
        throw lastError || new Error('No Solfege sample URL resolved')
      } catch (e) {
        this._failed.set(syllable, e?.message || String(e))
        console.error(`[SolfegePlayer] Failed to load Solfege_${syllable}.wav from:`, candidates, e)
      } finally {
        this._loading.delete(syllable)
      }
    })()

    this._loading.set(syllable, promise)
    return promise
  }

  /** Load all 12 syllables in parallel. */
  async loadAll() {
    await Promise.all(ALL_SYLLABLES.map(s => this._loadSyllable(s)))
  }

  isReady() {
    return ALL_SYLLABLES.every(s => this._loaded.has(s))
  }

  getLoadStatus() {
    return {
      loaded: this._loaded.size,
      total: ALL_SYLLABLES.length,
      failed: Array.from(this._failed.entries()),
      urls: Array.from(this._lastSuccessfulUrls.entries())
    }
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  /**
   * Play one solfege note immediately at a given AudioContext time.
   *
   * @param {string} syllable      e.g. 'Sol'
   * @param {string} noteName      e.g. 'D4'
   * @param {number} when          AudioContext time to start (seconds)
   * @param {number} duration      Desired note duration in seconds
   * @param {number} velocity      0–1 amplitude multiplier
   * @param {object} adsr          Optional ADSR override
   */
  playNote(syllable, noteName, when, duration, velocity = 0.8, adsr = {}) {
    if (!this._ctx) return null
    const buffer = this._buffers.get(syllable)
    if (!buffer) {
      console.warn(`[SolfegePlayer] Buffer not loaded for syllable "${syllable}"`)
      return null
    }

    const targetMidi = noteNameToMidi(noteName)
    const { offset, semitoneShift } = nearestSample(targetMidi)

    const attack  = adsr.attack  ?? this.attack
    const decay   = adsr.decay   ?? this.decay
    const sustain = adsr.sustain ?? this.sustain
    const release = adsr.release ?? this.release

    // ── ADSR gain envelope ──
    const gainNode = this._ctx.createGain()
    gainNode.connect(this._masterGain)

    const t0 = when
    gainNode.gain.setValueAtTime(0, t0)
    gainNode.gain.linearRampToValueAtTime(velocity, t0 + attack)
    gainNode.gain.linearRampToValueAtTime(velocity * sustain, t0 + attack + decay)
    const releaseStart = t0 + Math.max(duration - release, attack + decay)
    gainNode.gain.setValueAtTime(velocity * sustain, releaseStart)
    gainNode.gain.linearRampToValueAtTime(0, releaseStart + release)

    // ── Source node: slice the WAV using start(when, bufferOffset, sliceDuration) ──
    const src = this._ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = Math.pow(2, semitoneShift / 12)
    src.connect(gainNode)
    // Third argument caps how much of the buffer is played – important so pitch-shifted
    // audio doesn't run into the next slice; cap at SLICE_DURATION / playbackRate so
    // the *perceived* note length stays consistent regardless of pitch shift.
    const bufferSliceLength = SLICE_DURATION / src.playbackRate.value
    src.start(t0, offset, bufferSliceLength)
    src.stop(releaseStart + release + 0.05)

    const entry = { src, gainNode }
    this._active.push(entry)
    src.onended = () => {
      const idx = this._active.indexOf(entry)
      if (idx !== -1) this._active.splice(idx, 1)
    }

    return src
  }

  /**
   * Schedule a sequence of melody notes with correct solfege syllables.
   *
   * @param {Array}  notes       {note: 'G4', start: beats, duration: beats, velocity?}
   * @param {string} tonic       Key tonic, e.g. 'C', 'G', 'F#'
   * @param {number} tempo       BPM (already scaled for playback speed)
   * @param {number} startTime   AudioContext.currentTime at beat 0
   * @param {object} adsrOverride Optional ADSR override applied to every note
   */
  playHeldNote(noteName, tonic = 'C', duration = 0.45, velocity = 0.8) {
    if (!this._ctx || !this.isReady()) return null
    const tonicPc = noteNameToPitchClass(tonic)
    const notePc = noteNameToPitchClass(noteName)
    const syllable = DEGREE_TO_SYLLABLE[(notePc - tonicPc + 12) % 12]
    return this.playNote(syllable, noteName, this._ctx.currentTime, duration, velocity, { attack: 0.01, decay: 0.03, sustain: 0.95, release: 0.08 })
  }

  scheduleNotes(notes, tonic = 'C', tempo = 120, startTime = 0, adsrOverride = {}) {
    if (!this._ctx || !this.isReady()) {
      console.warn('[SolfegePlayer] Not ready – call loadAll() first')
      return
    }

    const secondsPerBeat = 60 / tempo
    const tonicPc = noteNameToPitchClass(tonic)

    for (const n of notes) {
      const notePc = noteNameToPitchClass(n.note)
      const chromaticDegree = (notePc - tonicPc + 12) % 12
      const syllable = DEGREE_TO_SYLLABLE[chromaticDegree]

      const when     = startTime + n.start * secondsPerBeat
      const duration = n.duration * secondsPerBeat

      this.playNote(syllable, n.note, when, duration, n.velocity ?? 0.8, adsrOverride)
    }
  }

  stop() {
    const now = this._ctx?.currentTime ?? 0
    for (const { src, gainNode } of [...this._active]) {
      try {
        gainNode.gain.cancelScheduledValues(now)
        gainNode.gain.linearRampToValueAtTime(0, now + 0.05)
        src.stop(now + 0.06)
      } catch (_) { /* already stopped */ }
    }
    this._active = []
  }
}

// Singleton
export const solfegePlayer = new SolfegePlayer()
