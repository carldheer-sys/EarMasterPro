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

// band → Promise<AudioBuffer>, deduped and LRU-capped at module scope.
const droneLoopCache = new Map()

export function droneLoopPromise(band, sampleRate = 44100) {
  let p = droneLoopCache.get(band)
  if (!p) {
    p = renderDroneLoop(droneBandRef(band), sampleRate).catch(() => null)
    droneLoopCache.set(band, p)
  }
  // LRU touch + cap
  droneLoopCache.delete(band)
  droneLoopCache.set(band, p)
  while (droneLoopCache.size > DRONE_CACHE_MAX) {
    droneLoopCache.delete(droneLoopCache.keys().next().value)
  }
  return p
}

async function renderDroneLoop(refFreq, sampleRate) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineCtx || !OfflineCtx.prototype?.createStereoPanner) return null

  const bodyLen = Math.round(DRONE_LOOP_SECONDS * sampleRate)
  const tailLen = Math.round(DRONE_CROSSFADE_SECONDS * sampleRate)
  const off = new OfflineCtx(2, bodyLen + tailLen, sampleRate)
  const dur = (bodyLen + tailLen) / sampleRate

  // Slow LP sweep gives the pad gentle brightness movement across the loop.
  const lp = off.createBiquadFilter()
  lp.type = 'lowpass'
  lp.Q.value = 0.5
  lp.frequency.setValueAtTime(refFreq * 7, 0)
  lp.frequency.linearRampToValueAtTime(refFreq * 10, dur)
  lp.connect(off.destination)

  // Two decorrelated sides (different detune, panned ±0.55) — real stereo
  // width a mono source + panner can't produce. Matches the old 4-layer
  // drone voicing: fundamental / octave / fifth / high octave.
  const SIDES = [{ pan: -0.55, det: -4 }, { pan: 0.55, det: 4 }]
  const PARTIALS = [
    { ratio: 1.0,   amp: 0.15 },  // fundamental
    { ratio: 1.002, amp: 0.09 },  // close pair → slow beat
    { ratio: 2.0,   amp: 0.09 },  // octave
    { ratio: 3.005, amp: 0.05 },  // octave + fifth
    { ratio: 4.0,   amp: 0.025 }, // high-octave shimmer
  ]
  for (const side of SIDES) {
    const pan = off.createStereoPanner()
    pan.pan.value = side.pan
    pan.connect(lp)
    for (const p of PARTIALS) {
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
    // Decorrelated filtered-noise "air" bed, unique per side.
    const nLen = Math.min(2 * sampleRate, bodyLen)
    const nb = off.createBuffer(1, nLen, sampleRate)
    const nd = nb.getChannelData(0)
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1
    const ns = off.createBufferSource()
    ns.buffer = nb
    ns.loop = true
    const nf = off.createBiquadFilter()
    nf.type = 'lowpass'
    nf.frequency.value = refFreq * 5
    nf.Q.value = 0.4
    const ng = off.createGain()
    ng.gain.value = 0.012
    const np = off.createStereoPanner()
    np.pan.value = side.pan * 0.8
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
