// mediaPlayback.js — play rendered audio through HTMLAudioElement instead of
// the Web Audio render thread.
//
// Why: on iOS + Bluetooth the AudioContext output path underruns periodically
// (the ~1s dropouts). HTMLAudioElement uses the OS media pipeline (AVPlayer
// class) with deep buffering — the same path that never stutters for music
// apps. Everything audible while "playing a section" goes through <audio>;
// WebAudio remains for live keyboard notes and as the fallback path.
//
// Gains are baked into the WAV itself — iOS makes el.volume read-only, so
// per-track loudness cannot live in the element.

/** Duck-typed buffer: AudioBuffer or {numberOfChannels,length,sampleRate,getChannelData}. */

/**
 * Encode an AudioBuffer (or duck-typed equivalent) to a 16-bit PCM WAV Blob,
 * applying `gainLinear` while interleaving (baked-in loudness normalisation).
 * Returns null for empty input.
 */
export function encodeWavPcm16(buffer, gainLinear = 1) {
  if (!buffer || buffer.length === 0) return null
  const nCh = Math.min(2, buffer.numberOfChannels || 1)
  const n = buffer.length
  const sr = buffer.sampleRate | 0
  const bytesPerSample = 2
  const dataSize = n * nCh * bytesPerSample
  const ab = new ArrayBuffer(44 + dataSize)
  const v = new DataView(ab)
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)          // fmt chunk size
  v.setUint16(20, 1, true)           // PCM
  v.setUint16(22, nCh, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * nCh * bytesPerSample, true)
  v.setUint16(32, nCh * bytesPerSample, true)
  v.setUint16(34, 16, true)
  writeStr(36, 'data')
  v.setUint32(40, dataSize, true)
  const chans = []
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)))
  let off = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i] * gainLinear))
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}

/**
 * Offline pitch-preserving time-stretch via overlap-add — the same algorithm
 * as public/granular-processor.js (grain 4096 / hopOut 2048 / Hann COLA),
 * rendered synchronously so a slowed section can ship as a WAV file. Used for
 * speeds HTMLAudioElement.playbackRate can't reach with preservesPitch (0.25x).
 * Returns a duck-typed buffer usable with encodeWavPcm16.
 */
export function stretchBufferOla(buffer, speed, { grainSize = 4096, hopOut = 2048 } = {}) {
  const nCh = Math.min(2, buffer.numberOfChannels || 1)
  const total = buffer.length
  const sr = buffer.sampleRate
  const hopIn = Math.max(1, Math.round(hopOut * speed))
  const hann = new Float32Array(grainSize)
  for (let i = 0; i < grainSize; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)))
  const outLen = Math.ceil(total / speed) + grainSize
  const channels = []
  for (let c = 0; c < nCh; c++) {
    const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
    const out = new Float32Array(outLen)
    for (let rp = 0, wp = 0; rp + grainSize < total && wp + grainSize < outLen; rp += hopIn, wp += hopOut) {
      for (let i = 0; i < grainSize; i++) out[wp + i] += src[rp + i] * hann[i]
    }
    channels.push(out)
  }
  return {
    numberOfChannels: nCh,
    length: outLen,
    sampleRate: sr,
    getChannelData: (i) => channels[i],
  }
}

const LOOP_OVERLAP_S = 0.04     // B starts this early to hide the A/B hand-off
const WATCH_MS = 30             // boundary check cadence

/**
 * Region/loop playback over HTMLAudioElement with two elements (A/B) so a
 * loop hand-off is a micro-overlap, not a gap. Both elements stay loaded on
 * the same blob URL — seeking is local and fast.
 */
export class MediaSongPlayer {
  constructor() {
    this._els = [new Audio(), new Audio()]
    for (const el of this._els) {
      el.preload = 'auto'
      el.preservesPitch = true
      try { el.webkitPreservesPitch = true } catch (_) {}
    }
    this._active = 0
    this._timer = null
    this._bounds = null         // {endSec}
    this._loop = null           // {startSec, endSec}
    this._onEnded = null
    this._primed = false        // iOS unlock: elements play outside gestures
    this._blobUrls = new Set()  // owned object URLs (revoked on dispose)
  }

  get el() { return this._els[this._active] }
  get playing() { return !this.el.paused }
  get positionSec() { return this.el.currentTime }

  /** Point both elements at a blob URL. */
  load(url) {
    if (this._els[0].src === url) return
    this.stop()
    for (const el of this._els) {
      el.src = url
      // Force fetch/decode NOW — a blob URL resolves instantly and a loaded
      // standby element honours the loop-boundary seek; a lazy one can drop
      // the currentTime assignment and restart from its last position.
      try { el.load() } catch (_) {}
    }
  }

  /** Track an object URL this player created so dispose() can revoke it. */
  ownBlobUrl(url) { this._blobUrls.add(url) }

  /**
   * @param offsetSec   media position to start from
   * @param loopStartSec/loopEndSec  region bounds in media seconds
   * @param looping     wrap at loopEndSec → loopStartSec via the idle element
   * @param playbackRate  el.playbackRate (pitch preserved by default)
   * @param onEnded     called once when a non-looping play crosses loopEndSec
   */
  async start({ offsetSec = 0, loopStartSec = 0, loopEndSec = 0, looping = false, playbackRate = 1, onEnded = null } = {}) {
    const el = this.el
    el.playbackRate = playbackRate
    this._loop = looping ? { startSec: loopStartSec, endSec: loopEndSec } : null
    this._bounds = { endSec: loopEndSec }
    this._onEnded = onEnded
    await this._ensureReady(el, offsetSec)
    // Seek AFTER ready — el.load() inside _ensureReady (and iOS discarding a
    // paused element's buffers) resets currentTime to 0; a pre-ready seek can
    // silently land nowhere, which is exactly the "resumes from 0" bug.
    el.currentTime = offsetSec
    await el.play()
    // Verify the seek stuck — Safari can ignore a currentTime assignment that
    // raced a late load; re-issue it once if the position is still near 0.
    if (Math.abs(el.currentTime - offsetSec) > 0.6) el.currentTime = offsetSec
    this._startWatch()
  }

  /**
   * iOS unlock: an element that has never successfully played can have its
   * later play() calls rejected once the user-activation window has lapsed
   * (e.g. an awaited render before start). Playing a 1-frame silent WAV in
   * the live gesture unlocks the element for the rest of the session — call
   * once while the gesture is still active.
   */
  async prime() {
    if (this._primed) return
    this._primed = true
    const silent = encodeWavPcm16({ numberOfChannels: 1, length: 1, sampleRate: 8000, getChannelData: () => new Float32Array(1) }, 1)
    if (!silent) return
    const url = URL.createObjectURL(silent)
    this.ownBlobUrl(url)
    for (const el of this._els) {
      try {
        const prevSrc = el.src
        el.src = url
        el.currentTime = 0
        await el.play()
        el.pause()
        if (prevSrc) el.src = prevSrc
      } catch (_) {}
    }
  }

  _ensureReady(el, offsetSec) {
    if (el.readyState >= 2) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        cleanup()
        // Re-apply the target after any load()/metadata cycle — a late load
        // resets the position and a pre-ready seek may be dropped entirely.
        try { el.currentTime = offsetSec } catch (_) {}
        resolve()
      }
      const cleanup = () => {
        el.removeEventListener('loadeddata', done)
        el.removeEventListener('canplay', done)
        clearTimeout(t)
      }
      el.addEventListener('loadeddata', done)
      el.addEventListener('canplay', done)
      const t = setTimeout(done, 1500)
      try { el.load() } catch (_) {}
    })
  }

  _startWatch() {
    this._stopWatch()
    this._timer = setInterval(() => this._tick(), WATCH_MS)
  }

  _stopWatch() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  _tick() {
    const el = this.el
    if (el.paused || !this._bounds) return
    const end = this._bounds.endSec
    if (this._loop) {
      const other = this._els[1 - this._active]
      // Pre-start the standby element just before the boundary — the ~40ms
      // overlap reads as a clean hand-off; a same-instant seek leaves a gap.
      if (el.currentTime >= end - LOOP_OVERLAP_S && other.paused) {
        other.playbackRate = el.playbackRate
        other.currentTime = this._loop.startSec
        const p = other.play(); p?.catch?.(() => {})
      }
      if (el.currentTime >= end) {
        el.pause()
        this._active = 1 - this._active
      }
      return
    }
    if (el.currentTime >= end || el.ended) {
      el.pause()
      this._stopWatch()
      const cb = this._onEnded; this._onEnded = null
      cb?.()
    }
  }

  pause() {
    this._stopWatch()
    // Pause BOTH elements — a standby pre-started inside the loop-overlap
    // window would otherwise keep sounding through the pause.
    for (const el of this._els) { try { el.pause() } catch (_) {} }
  }

  stop() {
    this._stopWatch()
    this._loop = null
    this._bounds = null
    this._onEnded = null
    for (const el of this._els) {
      try { el.pause() } catch (_) {}
    }
  }

  /** Resume from the element's own paused position. */
  async resume({ loopStartSec = 0, loopEndSec = 0, looping = false, onEnded = null } = {}) {
    const el = this.el
    this._loop = looping ? { startSec: loopStartSec, endSec: loopEndSec } : null
    this._bounds = { endSec: loopEndSec }
    this._onEnded = onEnded
    await el.play()
    this._startWatch()
  }

  dispose() {
    this.stop()
    for (const url of this._blobUrls) { try { URL.revokeObjectURL(url) } catch (_) {} }
    this._blobUrls.clear()
    for (const el of this._els) {
      try { el.removeAttribute('src'); el.load() } catch (_) {}
    }
  }
}
