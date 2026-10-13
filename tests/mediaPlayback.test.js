/**
 * mediaPlayback.js + sectionBounce.js unit tests — the Bluetooth-safe path.
 * Real offline renders need a browser AudioContext (SAC has no native
 * OfflineAudioContext in node), so the bounce coverage is the graceful-null
 * contract that drives the WebAudio fallback; WAV/OLA/A-B-loop logic is
 * fully covered here.
 */

import { describe, it, expect, vi } from 'vitest'

// tone's ESM build doesn't resolve in node, and nothing in these code paths
// evaluates it at module scope (bounceSection returns before touching Tone
// when OfflineAudioContext is absent) — an empty namespace is enough.
vi.mock('tone', () => ({}))

import { encodeWavPcm16, encodeWavPcm16Async, stretchBufferOla, stretchBufferOlaAsync, MediaSongPlayer } from '../packages/common/src/lib/mediaPlayback.js'
import { bounceSection } from '../packages/common/src/lib/sectionBounce.js'

// Duck-typed stereo buffer — the shape encodeWavPcm16/stretchBufferOla consume.
function fakeBuffer(channels, sampleRate = 44100) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (i) => channels[Math.min(i, channels.length - 1)],
  }
}

function wavView(blob) {
  // Node Blob → DataView synchronously via arrayBuffer
  return blob.arrayBuffer().then(ab => new DataView(ab))
}

const readStr = (v, off, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(off + i)))

describe('encodeWavPcm16', () => {
  it('writes a valid RIFF/WAVE header with the right sizes', async () => {
    const buf = fakeBuffer([new Float32Array(100), new Float32Array(100)])
    const blob = encodeWavPcm16(buf, 1)
    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + 100 * 2 * 2)
    const v = await wavView(blob)
    expect(readStr(v, 0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 400)
    expect(readStr(v, 8, 4)).toBe('WAVE')
    expect(readStr(v, 12, 4)).toBe('fmt ')
    expect(v.getUint16(20, true)).toBe(1)          // PCM
    expect(v.getUint16(22, true)).toBe(2)          // stereo
    expect(v.getUint32(24, true)).toBe(44100)      // sample rate
    expect(readStr(v, 36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(400)
  })

  it('encodes PCM samples correctly and bakes gain into the samples', async () => {
    const buf = fakeBuffer([new Float32Array([0, 0.5, -0.5, 1, -1])])
    const v = await wavView(encodeWavPcm16(buf, 1))
    expect(v.getInt16(44, true)).toBe(0)
    expect(v.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff))
    expect(v.getInt16(48, true)).toBe(Math.trunc(-0.5 * 0x8000))
    expect(v.getInt16(50, true)).toBe(0x7fff)      // +1.0 saturates at max
    expect(v.getInt16(52, true)).toBe(-0x8000)     // -1.0

    const vHalf = await wavView(encodeWavPcm16(buf, 0.5))
    expect(vHalf.getInt16(46, true)).toBe(Math.trunc(0.25 * 0x7fff))
  })

  it('hard-clips samples beyond ±1 so baked gain can never wrap', async () => {
    const buf = fakeBuffer([new Float32Array([0.9])])
    const v = await wavView(encodeWavPcm16(buf, 2))
    expect(v.getInt16(44, true)).toBe(0x7fff)      // 0.9*2 clipped to +1, not wrapped
  })

  it('returns null for empty input', () => {
    expect(encodeWavPcm16(fakeBuffer([new Float32Array(0)]), 1)).toBeNull()
    expect(encodeWavPcm16(null, 1)).toBeNull()
  })
})

describe('encodeWavPcm16Async (chunked — must not freeze the UI on mobile)', () => {
  it('produces byte-identical output to the sync encoder', async () => {
    const data = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 33) * 0.7)
    const buf = fakeBuffer([data, Float32Array.from(data, v => v * 0.5)])
    const syncAb = await encodeWavPcm16(buf, 1.5).arrayBuffer()
    const asyncAb = await (await encodeWavPcm16Async(buf, 1.5, { chunkFrames: 4096 })).arrayBuffer()
    expect(new Uint8Array(asyncAb)).toEqual(new Uint8Array(syncAb))
  })

  it('returns null for empty input', async () => {
    expect(await encodeWavPcm16Async(fakeBuffer([new Float32Array(0)]), 1)).toBeNull()
  })
})

describe('stretchBufferOla', () => {
  const src = fakeBuffer([
    Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 20)),
    Float32Array.from({ length: 44100 }, (_, i) => Math.cos(i / 30)),
  ])

  it('lengthens output by ~1/speed and keeps channels + sample rate', () => {
    const out = stretchBufferOla(src, 0.25)
    expect(out.numberOfChannels).toBe(2)
    expect(out.sampleRate).toBe(44100)
    expect(out.length).toBeGreaterThanOrEqual(44100 / 0.25)
    expect(out.getChannelData(0).length).toBe(out.length)
  })

  it('produces non-silent output for non-silent input', () => {
    const out = stretchBufferOla(src, 0.5)
    let peak = 0
    const ch = out.getChannelData(0)
    for (let i = 0; i < ch.length; i += 97) peak = Math.max(peak, Math.abs(ch[i]))
    expect(peak).toBeGreaterThan(0.5)
  })
})

describe('stretchBufferOlaAsync (chunked — must not freeze the UI on mobile)', () => {
  it('produces identical output to the sync stretcher', async () => {
    const src = fakeBuffer([
      Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 20)),
      Float32Array.from({ length: 44100 }, (_, i) => Math.cos(i / 30)),
    ])
    const a = stretchBufferOla(src, 0.5)
    const b = await stretchBufferOlaAsync(src, 0.5, { chunkGrains: 8 })
    expect(b.length).toBe(a.length)
    expect(b.sampleRate).toBe(a.sampleRate)
    for (let c = 0; c < 2; c++) {
      const ca = a.getChannelData(c), cb = b.getChannelData(c)
      for (let i = 0; i < ca.length; i += 997) expect(cb[i]).toBeCloseTo(ca[i], 6)
    }
  })
})

// Minimal HTMLAudioElement stand-in: enough surface for MediaSongPlayer's
// start/pause/stop/tick logic (real elements only exist in browsers).
function fakeAudioEl() {
  const el = {
    src: '', currentTime: 0, paused: true, ended: false, readyState: 4,
    playbackRate: 1, preload: '', preservesPitch: true,
    listeners: {},
    play() { el.paused = false; return Promise.resolve() },
    pause() { el.paused = true },
    load() {},
    addEventListener(ev, fn) { (el.listeners[ev] ||= []).push(fn) },
    removeEventListener() {},
    removeAttribute() {},
  }
  return el
}

function makePlayer() {
  const p = Object.create(MediaSongPlayer.prototype)
  p._els = [fakeAudioEl(), fakeAudioEl()]
  p._active = 0
  p._timer = null
  p._bounds = null
  p._loop = null
  p._onEnded = null
  p._primed = false
  p._blobUrls = new Set()
  return p
}

describe('MediaSongPlayer A/B loop + bounds', () => {
  it('hands off to the idle element at the loop boundary', async () => {
    const p = makePlayer()
    await p.start({ offsetSec: 0, loopStartSec: 10, loopEndSec: 20, looping: true })
    const a = p._els[0], b = p._els[1]
    expect(a.paused).toBe(false)
    a.currentTime = 20.01                 // crossing the boundary
    p._tick()
    expect(a.paused).toBe(true)           // A paused
    expect(b.paused).toBe(false)          // B playing (pre-started or started now)
    expect(b.currentTime).toBe(10)        // from the loop start
    expect(p._active).toBe(1)
    p.stop()
  })

  it('pre-starts the standby inside the overlap window', async () => {
    const p = makePlayer()
    await p.start({ offsetSec: 0, loopStartSec: 0, loopEndSec: 10, looping: true })
    p._els[0].currentTime = 9.99          // within LOOP_OVERLAP_S of the end
    p._tick()
    expect(p._els[1].paused).toBe(false)  // standby already rolling
    expect(p._active).toBe(0)             // but not yet active
    p.stop()
  })

  it('fires onEnded once for non-looping playback at the boundary', async () => {
    const p = makePlayer()
    const onEnded = vi.fn()
    await p.start({ offsetSec: 0, loopEndSec: 30, looping: false, onEnded })
    p._els[0].currentTime = 30.01
    p._tick()
    p._tick()
    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(p._els[0].paused).toBe(true)
    p.stop()
  })

  it('pause() freezes position; stop() silences both elements', async () => {
    const p = makePlayer()
    await p.start({ offsetSec: 5, loopEndSec: 30, looping: false })
    p._els[0].currentTime = 12
    p.pause()
    expect(p.positionSec).toBe(12)
    p._els[1].paused = false
    p.stop()
    expect(p._els[0].paused).toBe(true)
    expect(p._els[1].paused).toBe(true)
  })

  it('load() is a no-op when the URL is unchanged, resets otherwise', async () => {
    const p = makePlayer()
    p._els[0].src = 'blob:x'; p._els[1].src = 'blob:x'
    p._els[0].paused = false
    p.load('blob:x')
    expect(p._els[0].paused).toBe(false)   // not stopped — same url
    p.load('blob:y')
    expect(p._els[0].src).toBe('blob:y')
    expect(p._els[0].paused).toBe(true)    // stopped on a real change
  })
})

describe('bounceSection graceful degradation', () => {
  it('returns null when OfflineAudioContext is unavailable', async () => {
    // Node has no OfflineAudioContext — this is exactly the "no render"
    // contract the WebAudio fallback path relies on.
    const out = await bounceSection({ notes: [{ note: 'C4', start: 0, duration: 1 }], regionBeats: 4, tempo: 120 })
    expect(out).toBeNull()
  })

  it('returns null for an empty region', async () => {
    expect(await bounceSection({ regionBeats: 0 })).toBeNull()
    expect(await bounceSection({ regionBeats: -2 })).toBeNull()
  })
})
