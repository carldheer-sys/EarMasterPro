/**
 * GranularProcessor – pitch-preserving time-stretch via streaming OLA.
 *
 * Design:
 *   grainSize = 4096 (~93 ms @ 44100 Hz)   — large enough for coherent pitch
 *   hopOut    = grainSize / 2 = 2048        — 50% overlap; Hann sums to 1.0
 *   hopIn     = hopOut * speed              — speed<1 → slower; speed=0.5 → 2× stretch
 *
 * State machine: one "active grain" fills the output ring-buffer.
 * Every hopOut output samples we:
 *   1. shift the ring-buffer left by hopOut  (slide window forward)
 *   2. clear the new back half
 *   3. overlap-add the next grain into the full ring-buffer
 *   4. advance readPos by hopIn
 *
 * No buffer-overrun: grains are always written into [0..grainSize-1].
 */
class GranularProcessor extends AudioWorkletProcessor {
  constructor () {
    super()
    this.bufs         = []     // per-channel Float32Array source data
    this.nch          = 1
    this.totalSamples = 0

    this.playing = false
    this.speed   = 1.0

    this.gs      = 4096   // grain size (set in _setup)
    this.hopOut  = 2048   // output hop
    this.hopIn   = 2048   // input hop  = hopOut * speed

    this.readPos   = 0    // source read head (integer)
    this.outPos    = 0    // how many samples consumed from ring so far

    // ring[ch] is grainSize wide; we always read from [0..hopOut-1]
    this.ring = null

    this.loopOn    = false
    this.loopStart = 0
    this.loopEnd   = 0

    this.hann = null

    this.port.onmessage = ({ data: m }) => {
      switch (m.type) {
        case 'load':
          this.bufs         = m.channelData.map(a => new Float32Array(a))
          this.nch          = this.bufs.length
          this.totalSamples = this.bufs[0]?.length ?? 0
          this.readPos      = m.offsetSamples ?? 0
          this._setup(m.sampleRate ?? sampleRate)
          break
        case 'play':
          this.speed   = Math.max(0.1, Math.min(2.0, m.speed ?? 1.0))
          this.hopIn   = Math.round(this.hopOut * this.speed)
          if (m.offsetSamples != null) this.readPos = m.offsetSamples   // seek+play in one msg
          this.playing = true
          this._prime()
          break
        case 'seek':
          this.readPos = m.offsetSamples ?? this.readPos
          this.outPos  = 0
          if (this.ring) for (const r of this.ring) r.fill(0)
          break
        case 'stop':
          this.playing = false
          this.readPos = 0
          this.outPos  = 0
          if (this.ring) for (const r of this.ring) r.fill(0)
          break
        case 'loop':
          this.loopOn    = m.enabled
          this.loopStart = m.loopStartSample ?? 0
          this.loopEnd   = m.loopEndSample   ?? this.totalSamples
          break
      }
    }
  }

  _setup (sr) {
    // nearest power-of-2 to ~93 ms
    let g = 1
    const target = Math.round(sr * 0.093)
    while (g < target) g <<= 1
    this.gs     = g
    this.hopOut = g >> 1
    this.hopIn  = Math.round(this.hopOut * (this.speed || 1.0))

    // Hann window
    this.hann = new Float32Array(g)
    for (let i = 0; i < g; i++)
      this.hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (g - 1)))

    // Ring buffer: grainSize wide, one per channel
    this.ring   = Array.from({ length: this.nch }, () => new Float32Array(g))
    this.outPos = 0
  }

  // ── source sample with bounds/loop handling ─────────────────────────────────
  _s (ch, i) {
    const end = this.loopOn ? this.loopEnd : this.totalSamples
    if (i < 0 || i >= end) return 0
    return this.bufs[ch][i]
  }

  // ── add one full Hann-windowed grain at srcPos into ring ────────────────────
  _addGrain (srcPos) {
    const gs = this.gs, hann = this.hann
    const src = Math.round(srcPos)
    for (let ch = 0; ch < this.nch; ch++) {
      const r = this.ring[ch]
      for (let i = 0; i < gs; i++)
        r[i] += this._s(ch, src + i) * hann[i]
    }
  }

  // ── prime: seed the ring so _advance() is in a clean state ─────────────────
  // We position readPos one hopIn BEFORE the actual start, then call _advance()
  // once. This means:
  //   - ring[0..hop-1]  = tail of grain at (startPos - hopIn), windowed
  //   - ring[hop..gs-1] = head of grain at startPos, windowed
  // which is exactly the correct initial OLA state.
  _prime () {
    if (!this.ring || !this.bufs.length) { this.playing = false; return }
    const startPos = this.readPos
    // Step readPos back by one hopIn so first _advance() lands on startPos
    this.readPos = startPos - this.hopIn

    // Fill ring with grain at (startPos - hopIn)
    for (const r of this.ring) r.fill(0)
    this._addGrain(this.readPos)
    this.outPos = this.hopOut   // pretend we've already consumed the front half

    // Now advance once: this sets readPos = startPos and adds grain at startPos
    this._advance()
    // outPos is now 0 — ready to output from the correct position
  }

  // ── advance: slide ring, add next grain ─────────────────────────────────────
  _advance () {
    const hop = this.hopOut
    const gs  = this.gs
    const end = this.loopOn ? this.loopEnd : this.totalSamples

    // Advance source
    this.readPos += this.hopIn

    // End / loop check
    if (this.readPos >= end - gs) {
      if (this.loopOn) {
        this.readPos = this.loopStart
      } else {
        this.playing = false
        this.port.postMessage({ type: 'ended' })
        return
      }
    }

    // Slide ring left by hopOut; zero back half
    for (const r of this.ring) {
      r.copyWithin(0, hop)
      r.fill(0, hop)
    }

    // OLA: add new grain into the full ring.
    // Its first hopOut samples overlap the shifted tail; its second half is fresh.
    this._addGrain(this.readPos)
    this.outPos = 0
  }

  // ── AudioWorklet process ─────────────────────────────────────────────────────
  process (inputs, outputs) {
    const out = outputs[0]
    if (!out?.length) return true
    const N = out[0].length

    if (!this.playing || !this.ring) {
      for (const ch of out) ch.fill(0)
      return true
    }

    for (let f = 0; f < N; f++) {
      if (this.outPos >= this.hopOut) {
        this._advance()
        if (!this.playing) {
          for (let c = 0; c < out.length; c++)
            for (let ff = f; ff < N; ff++) out[c][ff] = 0
          return true
        }
      }
      for (let c = 0; c < out.length; c++) {
        const rc = Math.min(c, this.nch - 1)
        out[c][f] = this.ring[rc][this.outPos]
      }
      this.outPos++
    }
    return true
  }
}

registerProcessor('granular-processor', GranularProcessor)
