/**
 * carplayScheduler.js — Adaptive Web Audio API Look-Ahead Scheduler
 * optimized for iOS WebKit + Wireless CarPlay (5GHz Wi-Fi / Skoda MIB3)
 * and Bluetooth A2DP high-jitter environments.
 *
 * Why standard look-ahead schedulers stutter on Wireless CarPlay:
 * 1. On iOS Safari/WebKit, `AudioContext.outputLatency` is `undefined`, so
 *    static `outputLatency`-based look-ahead calculations always read 0 and
 *    stay stuck at a small ~0.4-0.6s window.
 * 2. Wireless CarPlay routes audio over a 5GHz Wi-Fi RTSP stream while the
 *    iPhone simultaneously encodes 60fps H.264 CarPlay video. Under this load
 *    (or when the iPhone screen locks), WebKit coalesces main-thread
 *    `setInterval` timers up to 300-800ms AND advances `ctx.currentTime` in
 *    stepped 200-450ms bursts as the MIB3 Wi-Fi jitter buffer drains.
 *
 * How AdaptiveAudioScheduler solves this:
 * - Drives wake-up ticks from an inline Blob Web Worker (`60ms` cadence),
 *   which runs off the main UI/GPU thread and is not coalesced during
 *   CarPlay screen projection. Falls back cleanly to `setInterval` if
 *   Worker/Blob is unavailable (e.g. Node unit tests).
 * - Measures real-time clock skew `|dtWall - dtAudio|` and stepped audio
 *   clock bursts on every tick:
 *   * Low-jitter route (phone speaker): stays at `baseLookaheadSec` (0.50s).
 *   * High-jitter route (CarPlay Wi-Fi / Bluetooth burst): immediately widens
 *     `lookaheadSec` up to `maxLookaheadSec` (2.2s) and holds it with a slow
 *     exponential decay (tau ~ 15s) so packet drops never starve the queue.
 */

export const DEFAULT_BASE_LOOKAHEAD_S = 0.50
export const DEFAULT_MAX_LOOKAHEAD_S = 2.20
export const DEFAULT_TICK_MS = 60
const JITTER_SPIKE_THRESHOLD_S = 0.035 // 35ms skew between wall & audio clock
const WALL_STALL_THRESHOLD_S = 0.140   // 140ms main-thread/worker timer stall
const JITTER_DECAY_TAU_S = 15.0        // hold widened window across Wi-Fi bursts

/**
 * Create a high-precision interval ticker backed by an inline Web Worker,
 * with automatic fallback to global setInterval.
 */
export function createWorkerTimer(callback, intervalMs = DEFAULT_TICK_MS) {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const code = `
        let id = null;
        self.onmessage = (e) => {
          if (e.data && e.data.cmd === 'start') {
            if (id) clearInterval(id);
            id = setInterval(() => self.postMessage('tick'), e.data.ms || 60);
          } else if (e.data && e.data.cmd === 'stop') {
            if (id) { clearInterval(id); id = null; }
          }
        };
      `
      const blob = new Blob([code], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      const worker = new Worker(url)
      worker.onmessage = () => callback()
      worker.postMessage({ cmd: 'start', ms: intervalMs })
      return {
        kind: 'worker',
        stop() {
          try { worker.postMessage({ cmd: 'stop' }) } catch (_) {}
          try { worker.terminate() } catch (_) {}
          try { URL.revokeObjectURL(url) } catch (_) {}
        },
      }
    } catch (_) {
      // Fall through to standard setInterval
    }
  }

  const timerId = setInterval(callback, intervalMs)
  return {
    kind: 'interval',
    stop() {
      clearInterval(timerId)
    },
  }
}

/**
 * Adaptive look-ahead scheduler for sample-accurate Web Audio note & event
 * queueing under variable wireless jitter.
 */
export class AdaptiveAudioScheduler {
  constructor({
    audioContext,
    baseLookaheadSec = DEFAULT_BASE_LOOKAHEAD_S,
    maxLookaheadSec = DEFAULT_MAX_LOOKAHEAD_S,
    tickMs = DEFAULT_TICK_MS,
    nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  } = {}) {
    this.ctx = audioContext
    this.baseLookaheadSec = baseLookaheadSec
    this.maxLookaheadSec = maxLookaheadSec
    this.tickMs = tickMs
    this._nowMs = nowMs

    const reportedLatency = (audioContext?.outputLatency || 0) + (audioContext?.baseLatency || 0)
    this.peakJitterSec = reportedLatency > 0.05 ? reportedLatency : 0
    this.lookaheadSec = Math.min(
      this.maxLookaheadSec,
      Math.max(this.baseLookaheadSec, this.baseLookaheadSec + this.peakJitterSec * 2.5)
    )

    this._lastWallMs = null
    this._lastAudioSec = null
    this._stalledAudioTicks = 0
    this._timer = null
    this._onTick = null
    this.running = false
  }

  /**
   * Observe one clock sample (wallMs vs audioContext.currentTime) and update
   * the adaptive look-ahead horizon. Exposed for deterministic unit testing.
   */
  observeClock(wallMs = this._nowMs(), audioSec = this.ctx?.currentTime ?? 0) {
    if (this._lastWallMs !== null && this._lastAudioSec !== null) {
      const dtWall = Math.max(0, (wallMs - this._lastWallMs) / 1000)
      const dtAudio = Math.max(0, audioSec - this._lastAudioSec)
      const clockSkew = Math.abs(dtWall - dtAudio)

      // Detect frozen audio clock ticks (CarPlay Wi-Fi packet buffer filling
      // before advancing currentTime in a large step).
      if (dtWall > 0.03 && dtAudio < 0.002) {
        this._stalledAudioTicks += 1
      } else {
        this._stalledAudioTicks = 0
      }

      const timerOverrun = Math.max(0, dtWall - (this.tickMs / 1000))
      let measuredSpike = 0
      if (clockSkew > JITTER_SPIKE_THRESHOLD_S) {
        measuredSpike = Math.max(measuredSpike, clockSkew)
      }
      if (dtWall > WALL_STALL_THRESHOLD_S) {
        measuredSpike = Math.max(measuredSpike, timerOverrun)
      }
      if (this._stalledAudioTicks >= 2) {
        measuredSpike = Math.max(measuredSpike, this._stalledAudioTicks * (this.tickMs / 1000))
      }

      // Exponential decay of prior peak jitter, instantaneous jump on new spike
      const decay = Math.exp(-dtWall / JITTER_DECAY_TAU_S)
      this.peakJitterSec = Math.max(measuredSpike, this.peakJitterSec * decay)

      const reportedLatency = (this.ctx?.outputLatency || 0) + (this.ctx?.baseLatency || 0)
      const effectiveJitter = Math.max(this.peakJitterSec, reportedLatency)

      // Scale lookahead: 0.5s baseline -> up to 2.2s under CarPlay Wi-Fi jitter
      const target = effectiveJitter > JITTER_SPIKE_THRESHOLD_S
        ? Math.max(1.2, this.baseLookaheadSec + effectiveJitter * 4.0)
        : this.baseLookaheadSec + effectiveJitter * 2.0

      this.lookaheadSec = Math.min(this.maxLookaheadSec, Math.max(this.baseLookaheadSec, target))
    }

    this._lastWallMs = wallMs
    this._lastAudioSec = audioSec
    return this.lookaheadSec
  }

  /**
   * Start the worker-backed scheduler loop.
   * `onTick({ audioTime, lookaheadSec, horizonAudioTime })` runs immediately
   * and on every wake-up tick.
   */
  start(onTick) {
    this.stop()
    this._onTick = onTick
    this.running = true
    this._lastWallMs = this._nowMs()
    this._lastAudioSec = this.ctx?.currentTime ?? 0
    this._stalledAudioTicks = 0

    const step = () => {
      if (!this.running) return
      const audioTime = this.ctx?.currentTime ?? 0
      const lookaheadSec = this.observeClock(this._nowMs(), audioTime)
      if (this._onTick) {
        this._onTick({
          audioTime,
          lookaheadSec,
          horizonAudioTime: audioTime + lookaheadSec,
        })
      }
    }

    step()
    this._timer = createWorkerTimer(step, this.tickMs)
  }

  stop() {
    this.running = false
    this._onTick = null
    if (this._timer) {
      this._timer.stop()
      this._timer = null
    }
  }
}
