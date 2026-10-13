// droneBaker.js — render a seamless stereo drone loop via OfflineAudioContext.
//
// Sonofield-style drone: instead of sustaining N live synth voices, a ~10s
// stereo AudioBuffer is baked once (detuned partials + filtered-noise air +
// slow LP drift) and looped — the texture of a recorded pad with zero
// shipped assets. Buffers are keyed by octave band and retuned with
// playbackRate (±6 st per band, imperceptible on a pad). AudioBuffers are
// context-agnostic, so the cache survives Tone context rebuilds.

const DRONE_LOOP_SECONDS = 10
const DRONE_CROSSFADE_SECONDS = 0.75
const DRONE_BAND_BASE = 110 // A2 — band references at 110·2^n
const DRONE_BAND_MIN = -1   // 55 Hz ref  → covers ~39–78 Hz
const DRONE_BAND_MAX = 3    // 880 Hz ref → covers ~622–1245 Hz
const DRONE_CACHE_MAX = 4

export function droneBandIndex(freq) {
  const b = Math.round(Math.log2(freq / DRONE_BAND_BASE))
  return Math.max(DRONE_BAND_MIN, Math.min(DRONE_BAND_MAX, b))
}

export function droneBandRef(band) {
  return DRONE_BAND_BASE * Math.pow(2, band)
}

// The one voicing definition — consumed by renderDroneLoop (loop bake for
// the live path) and by sectionBounce's inline segment render (media path).
// Two renderers, one spec: if they drifted, the live↔media drone handoff
// would jump in timbre.
export function droneVoicingSpec() {
  return {
    // Two decorrelated sides (different detune, panned ±0.55) — real stereo
    // width a mono source + panner can't produce.
    sides: [{ pan: -0.55, det: -4 }, { pan: 0.55, det: 4 }],
    partials: [
      { ratio: 1.0,   amp: 0.15  },  // fundamental
      { ratio: 1.002, amp: 0.09  },  // close pair → slow beat
      { ratio: 2.0,   amp: 0.09  },  // octave
      { ratio: 3.005, amp: 0.05  },  // octave + fifth
      { ratio: 4.0,   amp: 0.025 },  // high-octave shimmer
    ],
    // Decorrelated filtered-noise "air" bed, unique per side.
    noise: { gain: 0.012, filterRatio: 5, q: 0.4, panScale: 0.8, maxSec: 2 },
    // Slow LP sweep gives the pad gentle brightness movement.
    lp: { q: 0.5, startRatio: 7, endRatio: 10 },
  }
}

// OfflineAudioContext can construct fine yet render silence or throw on
// some platforms — every rendered path (drone loops, section bounces)
// silently degrades when that happens (legacy drone takes over, media
// bounce falls back to WebAudio). Probe once with a tiny render so the
// failure is detected and logged instead of discovered per-call.
let _offlineProbe = null
export function offlineRenderProbe() {
  if (!_offlineProbe) {
    _offlineProbe = (async () => {
      try {
        const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext
        if (!OfflineCtx || !OfflineCtx.prototype?.createStereoPanner) return false
        const off = new OfflineCtx(1, 128, 44100)
        const o = off.createOscillator()
        o.frequency.value = 440
        o.connect(off.destination)
        o.start(0)
        const d = (await off.startRendering()).getChannelData(0)
        for (let i = 0; i < d.length; i++) if (d[i] !== 0) return true
        return false
      } catch (_) {
        return false
      }
    })()
    _offlineProbe.then((ok) => {
      if (!ok) console.warn('[audio] offline render probe failed — baked drone + media bounce will fall back')
    })
  }
  return _offlineProbe
}

// band → Promise<AudioBuffer|null>, deduped and LRU-capped at module scope.
const droneLoopCache = new Map()
let _warnedBake = false

export function droneLoopPromise(band, sampleRate = 44100) {
  return offlineRenderProbe().then((ok) => {
    if (!ok) return null
    let p = droneLoopCache.get(band)
    if (!p) {
      p = renderDroneLoop(droneBandRef(band), sampleRate)
        .then((buf) => {
          // A render that resolves to silence is as useless as a throw —
          // evict so a later call can retry.
          if (!buf || bufferPeak(buf) < 1e-4) {
            droneLoopCache.delete(band)
            return null
          }
          return buf
        })
        .catch((err) => {
          droneLoopCache.delete(band)
          if (!_warnedBake) {
            _warnedBake = true
            console.warn('[audio] drone loop render failed — using legacy drone', err)
          }
          return null
        })
      droneLoopCache.set(band, p)
    }
    // LRU touch + cap
    droneLoopCache.delete(band)
    droneLoopCache.set(band, p)
    while (droneLoopCache.size > DRONE_CACHE_MAX) {
      droneLoopCache.delete(droneLoopCache.keys().next().value)
    }
    return p
  })
}

// Sparse scan is plenty for a silence check on a dense pad texture.
function bufferPeak(buf) {
  let peak = 0
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < d.length; i += 64) {
      const a = Math.abs(d[i])
      if (a > peak) peak = a
    }
  }
  return peak
}

async function renderDroneLoop(refFreq, sampleRate) {
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext
  if (!OfflineCtx || !OfflineCtx.prototype?.createStereoPanner) return null

  const spec = droneVoicingSpec()
  const bodyLen = Math.round(DRONE_LOOP_SECONDS * sampleRate)
  const tailLen = Math.round(DRONE_CROSSFADE_SECONDS * sampleRate)
  const off = new OfflineCtx(2, bodyLen + tailLen, sampleRate)
  const dur = (bodyLen + tailLen) / sampleRate

  const lp = off.createBiquadFilter()
  lp.type = 'lowpass'
  lp.Q.value = spec.lp.q
  lp.frequency.setValueAtTime(refFreq * spec.lp.startRatio, 0)
  lp.frequency.linearRampToValueAtTime(refFreq * spec.lp.endRatio, dur)
  lp.connect(off.destination)

  for (const side of spec.sides) {
    const pan = off.createStereoPanner()
    pan.pan.value = side.pan
    pan.connect(lp)
    for (const p of spec.partials) {
      const o = off.createOscillator()
      o.type = 'sine'
      o.frequency.value = refFreq * p.ratio
      o.detune.value = side.det
      const g = off.createGain()
      g.gain.value = p.amp
      o.connect(g)
      g.connect(pan)
      o.start(0)
    }
    const nLen = Math.min(spec.noise.maxSec * sampleRate, bodyLen)
    const nb = off.createBuffer(1, nLen, sampleRate)
    const nd = nb.getChannelData(0)
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1
    const ns = off.createBufferSource()
    ns.buffer = nb
    ns.loop = true
    const nf = off.createBiquadFilter()
    nf.type = 'lowpass'
    nf.frequency.value = refFreq * spec.noise.filterRatio
    nf.Q.value = spec.noise.q
    const ng = off.createGain()
    ng.gain.value = spec.noise.gain
    const np = off.createStereoPanner()
    np.pan.value = side.pan * spec.noise.panScale
    ns.connect(nf)
    nf.connect(ng)
    ng.connect(np)
    np.connect(lp)
    ns.start(0)
  }

  const rendered = await off.startRendering()
  // Fold the rendered tail into the head so the loop wraps seamlessly:
  // out[i<X] = head[i]·(i/X) + tail[i]·(1−i/X) — position 0 continues what
  // follows position N, so the wrap has no phase discontinuity.
  const out = off.createBuffer(2, bodyLen, sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch)
    const dst = out.getChannelData(ch)
    for (let i = 0; i < bodyLen; i++) dst[i] = src[i]
    for (let i = 0; i < tailLen; i++) {
      const t = i / tailLen
      dst[i] = src[i] * t + src[bodyLen + i] * (1 - t)
    }
  }
  return out
}
