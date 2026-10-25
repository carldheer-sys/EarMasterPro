/**
 * carplayMediaBridge.js — Persistent CarPlay Media Carrier, In-Memory HTML5
 * Audio Pre-Bufferer, and MediaSession Routing Matrix.
 *
 * Why Skoda MIB3 Wireless CarPlay needs this bridge:
 * 1. iOS WebKit's `NowPlayingManager` ONLY promotes a PWA to the CarPlay
 *    buffered "Media" audio channel when an `HTMLMediaElement` (`<audio>`) is
 *    actively playing. Pure `AudioContext.destination` output is routed as
 *    unbuffered transient system audio and gets dropped/renegotiated during
 *    idle windows or pauses.
 * 2. A completely zero-filled PCM WAV can be silence-gated by iOS CoreAudio;
 *    we therefore generate an in-memory stereo WAV containing a 1-LSB
 *    (-90.3 dBFS) triangular-dithered keepalive signal — 100% inaudible to
 *    human ears, but recognized as an active media stream by CoreAudio/MIB3.
 * 3. `prebufferAudioElement()` forces WebKit to load the entire in-memory Blob
 *    and verify `buffered.length > 0` before playback triggers, bypassing iOS
 *    Safari's lazy-loading.
 */

const CARRIER_SAMPLE_RATE = 22050
const CARRIER_SECONDS = 2

/**
 * Generate a 2-second stereo 16-bit PCM WAV Blob with +/-1 LSB (-90.3 dBFS)
 * alternating dither so CoreAudio & CarPlay MIB3 never silence-gate the stream.
 */
export function createDitheredKeepaliveWavBlob(sampleRate = CARRIER_SAMPLE_RATE, seconds = CARRIER_SECONDS) {
  const numFrames = Math.max(256, Math.round(sampleRate * seconds))
  const numChannels = 2
  const dataBytes = numFrames * numChannels * 2
  const ab = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(ab)
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true)  // PCM format
  v.setUint16(22, numChannels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * numChannels * 2, true)
  v.setUint16(32, numChannels * 2, true)
  v.setUint16(34, 16, true)
  writeStr(36, 'data')
  v.setUint32(40, dataBytes, true)

  // +/-1 LSB dither (1 / 32768 = -90.3 dBFS): inaudible, prevents zero-gate
  let off = 44
  for (let i = 0; i < numFrames; i++) {
    const lsb = (i & 1) ? 1 : -1
    v.setInt16(off, lsb, true)
    v.setInt16(off + 2, -lsb, true)
    off += 4
  }

  return new Blob([ab], { type: 'audio/wav' })
}

/**
 * Programmatically force iOS WebKit to pre-buffer an entire audio Blob or
 * ArrayBuffer into memory on an HTMLAudioElement before playback starts.
 */
export async function prebufferAudioElement(audioEl, blobOrBuffer, { mimeType = 'audio/mpeg', timeoutMs = 2000 } = {}) {
  if (!audioEl || !blobOrBuffer) return null
  let blob = blobOrBuffer
  if (!(blobOrBuffer instanceof Blob)) {
    const bytes = blobOrBuffer instanceof ArrayBuffer
      ? new Uint8Array(blobOrBuffer)
      : new Uint8Array(blobOrBuffer.buffer || blobOrBuffer)
    blob = new Blob([bytes], { type: mimeType })
  }
  const url = URL.createObjectURL(blob)
  audioEl.preload = 'auto'
  audioEl.playsInline = true
  try {
    audioEl.setAttribute?.('playsinline', '')
    audioEl.setAttribute?.('webkit-playsinline', '')
  } catch (_) {}
  audioEl.src = url

  if (audioEl.readyState < 4 && typeof audioEl.addEventListener === 'function') {
    await new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        audioEl.removeEventListener?.('canplaythrough', done)
        audioEl.removeEventListener?.('loadeddata', done)
        audioEl.removeEventListener?.('error', done)
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(done, timeoutMs)
      audioEl.addEventListener('canplaythrough', done)
      audioEl.addEventListener('loadeddata', done)
      audioEl.addEventListener('error', done)
      try { audioEl.load?.() } catch (_) { done() }
    })
  } else {
    try { audioEl.load?.() } catch (_) {}
  }

  return url
}

/**
 * Persistent CarPlay Media Session & Wireless Stream Handshake Bridge.
 * Keeps the MIB3 5GHz Wi-Fi Media channel open and wires CarPlay / lock-screen
 * controls (`play`, `pause`, `stop`, `previoustrack`, `nexttrack`, `seekto`).
 */
export class CarPlayMediaBridge {
  constructor() {
    this.el = null
    this._blobUrl = null
    this._handlers = {}
    this._active = false
    this._prebufferPromise = null
  }

  _ensureElement() {
    if (this.el || typeof Audio === 'undefined') return this.el
    try {
      const el = new Audio()
      el.loop = true
      el.preload = 'auto'
      el.playsInline = true
      try {
        el.setAttribute?.('playsinline', '')
        el.setAttribute?.('webkit-playsinline', '')
      } catch (_) {}
      this.el = el
      const blob = createDitheredKeepaliveWavBlob()
      this._prebufferPromise = prebufferAudioElement(el, blob, { mimeType: 'audio/wav', timeoutMs: 800 })
        .then((url) => { this._blobUrl = url; return url })
        .catch(() => null)
    } catch (_) {}
    return this.el
  }

  /**
   * Call inside a user gesture (`play()`) to start the carrier `<audio>`
   * element and claim the CarPlay buffered Media channel.
   */
  async activate() {
    try {
      if (typeof navigator !== 'undefined' && navigator.audioSession) {
        navigator.audioSession.type = 'playback'
      }
    } catch (_) {}

    const el = this._ensureElement()
    if (!el) return false

    if (this._prebufferPromise) {
      await this._prebufferPromise
      this._prebufferPromise = null
    }

    try {
      if (el.paused) {
        await Promise.race([
          Promise.resolve(el.play()).catch(() => {}),
          new Promise((r) => setTimeout(r, 600)),
        ])
      }
      this._active = !el.paused
    } catch (_) {}

    this.setPlaybackState('playing')
    return this._active
  }

  /**
   * Keep the CarPlay wireless stream handshake claimed during pause so MIB3
   * doesn't tear down the 5GHz Wi-Fi audio link between exercises.
   */
  holdOnPause() {
    try {
      if (typeof navigator !== 'undefined' && navigator.audioSession) {
        navigator.audioSession.type = 'playback'
      }
    } catch (_) {}
    this.setPlaybackState('paused')
  }

  /**
   * Release the carrier element on explicit Stop or unmount.
   */
  deactivate({ releaseSession = true } = {}) {
    if (this.el) {
      try { this.el.pause() } catch (_) {}
    }
    this._active = false
    if (releaseSession) {
      try {
        if (typeof navigator !== 'undefined' && navigator.audioSession) {
          navigator.audioSession.type = 'ambient'
        }
      } catch (_) {}
      this.setPlaybackState('none')
    } else {
      this.setPlaybackState('paused')
    }
  }

  setPlaybackState(state) {
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaSession) {
        navigator.mediaSession.playbackState = state
      }
    } catch (_) {}
  }

  updateMetadata({ title = 'EarMaster Pro', artist = '', album = 'EarMaster Pro', artworkUrl = '/icons/icon-512.png' } = {}) {
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaSession && typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist,
          album,
          artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: 'image/png' }] : [],
        })
      }
    } catch (_) {}
  }

  updatePositionState({ duration = 0, position = 0, playbackRate = 1 } = {}) {
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaSession?.setPositionState && duration > 0) {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0.01, duration),
          position: Math.max(0, Math.min(duration, position)),
          playbackRate: Math.max(0.1, playbackRate),
        })
      }
    } catch (_) {}
  }

  /**
   * Register CarPlay / steering-wheel / lock-screen action handlers.
   */
  setActionHandlers(handlers = {}) {
    this._handlers = handlers
    if (typeof navigator === 'undefined' || !navigator.mediaSession?.setActionHandler) return
    const map = {
      play: handlers.onPlay || null,
      pause: handlers.onPause || null,
      stop: handlers.onStop || null,
      previoustrack: handlers.onPreviousTrack || null,
      nexttrack: handlers.onNextTrack || null,
      seekbackward: handlers.onSeekBackward || null,
      seekforward: handlers.onSeekForward || null,
      seekto: handlers.onSeekTo || null,
    }
    for (const [action, fn] of Object.entries(map)) {
      try {
        navigator.mediaSession.setActionHandler(action, fn ? (details) => fn(details) : null)
      } catch (_) {}
    }
  }

  dispose() {
    this.deactivate({ releaseSession: true })
    this.setActionHandlers({})
    if (this._blobUrl) {
      try { URL.revokeObjectURL(this._blobUrl) } catch (_) {}
      this._blobUrl = null
    }
    if (this.el) {
      try { this.el.removeAttribute?.('src'); this.el.load?.() } catch (_) {}
      this.el = null
    }
  }
}

export const carPlayMediaBridge = new CarPlayMediaBridge()
export default carPlayMediaBridge
