/**
 * GranularPlayer
 * Pitch-preserving time-stretched audio playback via AudioWorklet.
 * Falls back to standard AudioBufferSourceNode at 1x speed.
 * Works in all modern browsers and mobile WebView (iOS/Android).
 */
export class GranularPlayer {
  constructor() {
    this.audioContext = null
    this.workletNode = null
    this.gainNode = null
    this.workletReady = false
    this.audioBuffer = null
    this.sampleRate = 44100

    // Playback config
    this.speed = 1.0
    this.volumeDb = 0
    this.loop = false
    this.loopStartSample = 0
    this.loopEndSample = 0

    // Fallback path (speed === 1.0): use standard source node
    this.sourceNode = null
    this.usingFallback = false

    // Scheduled stop timer
    this._stopTimeout = null
    this._onEnded = null
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Must be called once to register the worklet module. */
  async initialize(audioContext) {
    if (!audioContext) {
      throw new Error('GranularPlayer.initialize requires an audioContext')
    }

    // Validate it has required AudioContext methods
    if (typeof audioContext.createGain !== 'function' || !audioContext.destination) {
      throw new Error('GranularPlayer.initialize requires a valid AudioContext')
    }

    // play() and the contextEpoch effect can both call this after a context
    // swap — serialize so the second caller observes the finished binding
    // instead of double-initializing.
    while (this._initTask) {
      try { await this._initTask } catch (_) {}
    }
    if (this.audioContext === audioContext && this.gainNode) return

    const task = this._initializeContext(audioContext)
    this._initTask = task
    try { await task } finally { if (this._initTask === task) this._initTask = null }
  }

  async _initializeContext(audioContext) {
    if (this.audioContext && this.audioContext !== audioContext) {
      this.stop()
      if (this.gainNode) { try { this.gainNode.disconnect() } catch (_) {} ; this.gainNode = null }
      if (this.workletNode) {
        this.workletNode.port.onmessage = null
        try { this.workletNode.disconnect() } catch (_) {}
        this.workletNode = null
      }
      this._loadedBuffer = null
      this.workletReady = false
    }

    this.audioContext = audioContext
    this.sampleRate = audioContext.sampleRate
    // Tone wraps AudioContext via standardized-audio-context — unwrap for
    // APIs that require a true BaseAudioContext (AudioWorkletNode).
    this._nativeContext = audioContext._nativeContext ?? audioContext

    // Gain node used for volume control
    this.gainNode = audioContext.createGain()
    // Apply any volume that was set before initialization
    if (this._pendingVolume !== undefined) {
      this.volumeDb = this._pendingVolume
    }
    this.gainNode.gain.value = this._dbToLinear(this.volumeDb)
    this.gainNode.connect(audioContext.destination)

    try {
      await audioContext.audioWorklet.addModule('/granular-processor.js')
      this.workletReady = true
      console.log('[GranularPlayer] AudioWorklet initialized successfully')
    } catch (err) {
      console.warn('[GranularPlayer] AudioWorklet unavailable, will use fallback:', err)
      this.workletReady = false
    }
  }

  /** Load an AudioBuffer. Extracts raw channel data for the worklet. */
  loadBuffer(audioBuffer) {
    this.audioBuffer = audioBuffer
    this.sampleRate = audioBuffer.sampleRate
  }

  set volume(db) {
    this.volumeDb = db
    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(
        this._dbToLinear(db),
        this.audioContext?.currentTime ?? 0,
        0.01
      )
    }
  }

  get volume() { return this.volumeDb }

  /**
   * Start playback.
   * @param {number} speed         - Playback speed (0.25 – 1.0)
   * @param {number} offsetSeconds - Where in the buffer to start (in source-buffer seconds)
   * @param {boolean} loop
   * @param {number} loopStartSeconds - Loop start in source-buffer seconds
   * @param {number} loopEndSeconds   - Loop end in source-buffer seconds
   * @param {function} onEnded     - Called when non-looping playback finishes naturally
   */
  start(speed = 1.0, offsetSeconds = 0, loop = false, loopStartSeconds = 0, loopEndSeconds = 0, onEnded = null) {
    if (!this.audioBuffer) {
      console.warn('[GranularPlayer] Cannot start: no audio buffer loaded')
      return
    }
    if (!this.audioContext) {
      console.error('[GranularPlayer] Cannot start: not initialized. Call initialize() first.')
      return
    }
    
    this.stop()

    this.speed = speed
    this.loop = loop
    this._onEnded = onEnded

    const clampedOffsetSeconds = Math.max(0, Math.min(offsetSeconds, Math.max(0, this.audioBuffer.duration - 0.01)))
    const offsetSamples = Math.floor(clampedOffsetSeconds * this.sampleRate)
    const loopStartSample = Math.floor(loopStartSeconds * this.sampleRate)
    const loopEndSample = Math.floor(loopEndSeconds * this.sampleRate) || this.audioBuffer.length

    // Use standard node at 1x speed (perfect quality, no overhead)
    if (speed === 1.0 || !this.workletReady) {
      this._startFallback(speed, clampedOffsetSeconds, loop, loopStartSeconds, loopEndSeconds, onEnded)
      return
    }

    // Granular path
    this._startGranular(speed, offsetSamples, loop, loopStartSample, loopEndSample, onEnded)
  }

  stop() {
    if (this._stopTimeout) { clearTimeout(this._stopTimeout); this._stopTimeout = null }

    if (this.usingFallback && this.sourceNode) {
      this.sourceNode.onended = null
      try { this.sourceNode.stop(); this.sourceNode.disconnect() } catch (_) {}
      this.sourceNode = null
    }

    // Keep the worklet node alive across starts — the processor just goes
    // silent. Recreating it per play used to re-send the whole audio buffer.
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: 'stop' }) } catch (_) {}
    }

    this.usingFallback = false
    this._onEnded = null
  }

  dispose() {
    this.stop()
    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      try { this.workletNode.disconnect() } catch (_) {}
      this.workletNode = null
    }
    this._loadedBuffer = null
    if (this.gainNode) { try { this.gainNode.disconnect() } catch (_) {} ; this.gainNode = null }
    this.audioContext = null
    this.audioBuffer = null
    this.workletReady = false
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _startFallback(speed, offsetSeconds, loop, loopStartSeconds, loopEndSeconds, onEnded) {
    this.usingFallback = true
    const ctx = this.audioContext

    const src = ctx.createBufferSource()
    src.buffer = this.audioBuffer
    src.playbackRate.value = speed
    src.loop = loop
    if (loop) {
      src.loopStart = loopStartSeconds
      src.loopEnd = loopEndSeconds || this.audioBuffer.duration
    }
    src.connect(this.gainNode)

    if (onEnded && !loop) src.onended = () => onEnded()

    src.start(0, offsetSeconds)
    this.sourceNode = src
    if (!loop) {
      const endSeconds = loopEndSeconds || this.audioBuffer.duration
      const durationMs = Math.max(0, (endSeconds - offsetSeconds) / Math.max(speed, 0.01) * 1000)
      if (Number.isFinite(durationMs) && durationMs > 0) {
        this._stopTimeout = setTimeout(() => {
          this._stopTimeout = null
          src.onended = null
          try { src.stop() } catch (_) {}
          if (onEnded) onEnded()
        }, durationMs)
      }
    }
  }

  _startGranular(speed, offsetSamples, loop, loopStartSample, loopEndSample, onEnded) {
    const buf = this.audioBuffer
    // AudioWorkletNode requires the NATIVE context — audioContext may be a
    // standardized-audio-context wrapper (what Tone.context.rawContext returns)
    const nativeCtx = this._nativeContext ?? this.audioContext
    const nativeGain = this.gainNode?._nativeAudioNode ?? this.gainNode

    // Reuse the worklet node across starts; recreate only if missing or the
    // channel count changed (outputChannelCount is fixed at construction).
    let node = this.workletNode
    if (node && buf.numberOfChannels !== this._nodeChannels) {
      node.port.onmessage = null
      try { node.disconnect() } catch (_) {}
      node = null
      this._loadedBuffer = null
    }
    if (!node) {
      node = new AudioWorkletNode(nativeCtx, 'granular-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [buf.numberOfChannels]
      })
      node.connect(nativeGain)
      this.workletNode = node
      this._nodeChannels = buf.numberOfChannels
      this._loadedBuffer = null
    }
    node.port.onmessage = (e) => {
      if (e.data?.type === 'ended' && this._onEnded) this._onEnded()
    }

    // Send channel data ONLY when the buffer changed — previously every start
    // slice()ed + structured-cloned ~25–50MB into the worklet, stalling the
    // main thread on every Play press (worst on mobile).
    if (buf !== this._loadedBuffer) {
      const channelData = []
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        channelData.push(buf.getChannelData(ch).slice())
      }
      node.port.postMessage({
        type: 'load',
        channelData,
        sampleRate: this.sampleRate,
        offsetSamples
      })
      this._loadedBuffer = buf
    }

    node.port.postMessage({
      type: 'loop',
      enabled: loop,
      loopStartSample,
      loopEndSample
    })

    // 'play' carries the seek offset — no separate load needed on restart
    node.port.postMessage({ type: 'play', speed, offsetSamples })
  }

  _dbToLinear(db) {
    return Math.pow(10, db / 20)
  }
}
