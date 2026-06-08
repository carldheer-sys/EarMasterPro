import { useEffect, useRef, useState, useCallback } from 'react'
import * as Tone from 'tone'
import { beatsPerBarFromTimeSignature, DEFAULT_TIME_SIGNATURE, getInternalBpm } from '@common/lib/midiUtils'

const INITIAL_BEAT_WIDTH = 40

/**
 * Timing model:
 *   pixelsPerSecond = beatWidth * tempo / 60
 *   audioDurationPx = audioBuffer.duration * pixelsPerSecond
 *   waveformOffsetPx = audioDelay * pixelsPerSecond
 *
 * The waveform canvas is positioned at waveformOffsetPx within the grid area
 * (which has overflow:hidden). A positive delay shifts the waveform right
 * (audio starts later); a negative delay shifts it left (audio starts into
 * the buffer).
 *
 * The playhead travels across the grid area at cursorPosition * gridWidth,
 * independent of waveformOffsetPx, so it stays synchronized with MIDI.
 *
 * During playback:
 *   delay >= 0 → player.start("+" + delay, 0)  — audio delayed by N seconds
 *   delay <  0 → player.start("+0", |delay|)   — audio starts N seconds in
 */
export default function ReferenceTrack({
  audioBuffer,
  bars = 4,
  timeSignature = DEFAULT_TIME_SIGNATURE,
  tempo = 120,
  pickupBeats = 0,
  cursorPosition = 0,
  showPlayhead = false,
  zoom = 1,
  audioDelay = 0,
  onAudioDelayChange,
  volume = 0,
  onVolumeChange,
  isMuted = false,
  onMuteToggle,
  isSolo = false,
  onSoloToggle,
  regionStart = 0,
  regionEnd = 1
}) {
  const canvasRef = useRef(null)
  const playheadRef = useRef(null)
  const scrollContainerRef = useRef(null)
  const animationFrameRef = useRef(null)
  const [shiftHeld, setShiftHeld] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Shift') setShiftHeld(true) }
    const onKeyUp   = (e) => { if (e.key === 'Shift') setShiftHeld(false) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const handleDelayDoubleClick = useCallback(() => {
    onAudioDelayChange?.(0)
  }, [onAudioDelayChange])

  // Custom drag handler for delay slider:
  // Normal drag: 1px = 0.01s (range -10..10 over ~2000px effective)
  // Shift drag:  1px = 0.001s (10x finer)
  const delayDragRef = useRef(null)

  const handleDelayMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    delayDragRef.current = { startX: e.clientX, startDelay: audioDelay, shift: e.shiftKey }

    const onMove = (ev) => {
      const d = delayDragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      const sensitivity = d.shift ? 0.001 : 0.01
      const raw = d.startDelay + dx * sensitivity
      const clamped = Math.max(-10, Math.min(10, raw))
      const precision = d.shift ? 1000 : 100
      onAudioDelayChange?.(Math.round(clamped * precision) / precision)
    }

    const onUp = () => {
      delayDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [audioDelay, onAudioDelayChange])

  const beatWidth = INITIAL_BEAT_WIDTH * zoom
  const beatsPerBar = beatsPerBarFromTimeSignature(timeSignature)
  const barWidth = beatsPerBar * beatWidth
  const totalBeats = pickupBeats + bars * beatsPerBar
  const gridWidth = totalBeats * beatWidth

  // pixels per second at current tempo and zoom
  const internalTempo = getInternalBpm(tempo, timeSignature)
  const pixelsPerSecond = beatWidth * internalTempo / 60
  // visual pixel width of the full audio waveform
  const audioDurationPx = audioBuffer ? Math.max(1, Math.ceil(audioBuffer.duration * pixelsPerSecond)) : 0
  // horizontal offset of the waveform within the grid area
  // Waveform shifts with pickup beats so position 0 of grid aligns with audio position 0
  // It does NOT shift when the active region changes
  const waveformOffsetPx = (pickupBeats * beatWidth * 0) + (audioDelay * pixelsPerSecond)

  // Detect playback state from Tone.Transport
  useEffect(() => {
    const checkPlayback = () => {
      setIsPlaying(Tone.Transport.state === 'started')
    }
    const interval = setInterval(checkPlayback, 100)
    return () => clearInterval(interval)
  }, [])

  // Playhead animation loop - matches PianoRollCanvas approach exactly
  useEffect(() => {
    if (!isPlaying || !showPlayhead) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      return
    }

    const regionStartPx = regionStart * gridWidth
    const regionEndPx = regionEnd * gridWidth
    const regionWidthPx = regionEndPx - regionStartPx
    
    const updatePlayhead = () => {
      if (!isPlaying) return
      
      // Query Tone.Transport for current position - EXACTLY like PianoRollCanvas
      const transportTicks = Tone.Transport.ticks
      const regionBeats = (regionEnd - regionStart) * totalBeats
      const totalTicks = Tone.Transport.PPQ * regionBeats
      
      // Calculate playhead position within active region
      const progress = totalTicks > 0 ? Math.min(transportTicks / totalTicks, 1) : 0
      const playheadPx = regionStartPx + progress * regionWidthPx
      
      // Update playhead DOM element directly (no React state)
      if (playheadRef.current) {
        playheadRef.current.style.transform = `translateX(${playheadPx}px)`
      }
      
      // Continue animation loop
      animationFrameRef.current = requestAnimationFrame(updatePlayhead)
    }
    
    // Start animation loop
    animationFrameRef.current = requestAnimationFrame(updatePlayhead)
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [isPlaying, showPlayhead, regionStart, regionEnd, gridWidth, totalBeats])

  // Draw waveform whenever buffer or pixel dimensions change
  useEffect(() => {
    if (!audioBuffer || !canvasRef.current || audioDurationPx <= 0) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const W = audioDurationPx
    const H = 76

    canvas.width = W
    canvas.height = H

    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)'
    ctx.fillRect(0, 0, W, H)

    const data = audioBuffer.getChannelData(0)
    const totalSamples = data.length
    const amp = H / 2

    ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)'
    ctx.lineWidth = 1.2
    ctx.beginPath()

    for (let x = 0; x < W; x++) {
      const sampleStart = Math.floor((x / W) * totalSamples)
      const sampleEnd = Math.floor(((x + 1) / W) * totalSamples)
      let min = 1.0
      let max = -1.0
      for (let s = sampleStart; s < sampleEnd; s++) {
        const v = data[s]
        if (v < min) min = v
        if (v > max) max = v
      }
      const y1 = (1 + min) * amp
      const y2 = (1 + max) * amp
      if (x === 0) ctx.moveTo(x, y1)
      else ctx.lineTo(x, y1)
      ctx.lineTo(x, y2)
    }
    ctx.stroke()
  }, [audioBuffer, audioDurationPx])

  const delayLabel = (audioDelay > 0 ? '+' : '') + audioDelay.toFixed(2) + 's'

  return (
    <div
      className="relative border-b border-border"
      style={{ minWidth: `${gridWidth + 120}px` }}
    >
      <div className="flex" style={{ height: '104px' }}>

        {/* ── Controls panel (sticky, 120 px wide) ─────────────── */}
        <div
          className="sticky left-0 z-20 border-r-2 border-border flex flex-col"
          style={{
            width: '120px',
            background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 100%)'
          }}
        >
          {/* Top bar-label spacer — matches piano-roll bar-number strip */}
          <div style={{ height: '20px' }} className="border-b border-border/30 flex items-center justify-center">
            <span className="text-[10px] font-bold text-cyan-400 tracking-wide">REF AUDIO</span>
          </div>

          <div className="flex flex-col items-center gap-1.5 px-2 py-1.5 flex-1">
            {/* Volume row */}
            <div className="flex items-center gap-1.5 w-full">
              <span className="text-[9px] text-slate-400" style={{ width: '20px' }}>Vol</span>
              <input
                type="range" min="-40" max="10" step="1" value={volume}
                onChange={(e) => onVolumeChange?.(parseFloat(e.target.value))}
                style={{
                  width: '64px', height: '3px',
                  WebkitAppearance: 'none', appearance: 'none',
                  background: `linear-gradient(to right, #22d3ee ${((volume + 40) / 50) * 100}%, rgba(148,163,184,0.2) 0%)`,
                  borderRadius: '3px', outline: 'none', cursor: 'pointer', flexShrink: 0
                }}
              />
            </div>

            {/* M / S buttons — mutually exclusive, both always clickable */}
            <div className="flex gap-1 w-full justify-start pl-0">
              <button
                onClick={onMuteToggle}
                className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${
                  isMuted ? 'bg-red-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >M</button>
              <button
                onClick={onSoloToggle}
                className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${
                  isSolo ? 'bg-yellow-400 text-slate-900' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >S</button>
            </div>

            {/* Delay row — drag to adjust; Shift=fine (1/10th); double-click=reset */}
            <div className="flex items-center gap-1.5 w-full">
              <span className="text-[9px] text-slate-400" style={{ width: '20px' }}>Dly</span>
              {/* Custom drag track: normal=0.01s/px, Shift=0.001s/px */}
              <div
                style={{ width: '64px', height: '10px', flexShrink: 0, cursor: 'ew-resize', position: 'relative', userSelect: 'none' }}
                onMouseDown={handleDelayMouseDown}
                onDoubleClick={handleDelayDoubleClick}
              >
                {/* Track background */}
                <div style={{
                  position: 'absolute', top: '50%', left: 0, right: 0,
                  height: '3px', transform: 'translateY(-50%)',
                  borderRadius: '3px',
                  background: 'rgba(148,163,184,0.15)'
                }} />
                {/* Filled portion from centre to current value */}
                <div style={{
                  position: 'absolute', top: '50%', height: '3px', transform: 'translateY(-50%)',
                  borderRadius: '3px',
                  background: 'rgba(34,211,238,0.5)',
                  left: audioDelay >= 0 ? '50%' : `${((audioDelay + 10) / 20) * 100}%`,
                  width: `${(Math.abs(audioDelay) / 20) * 100}%`
                }} />
                {/* Thumb dot */}
                <div style={{
                  position: 'absolute', top: '50%', transform: 'translate(-50%,-50%)',
                  left: `${((audioDelay + 10) / 20) * 100}%`,
                  width: '7px', height: '7px', borderRadius: '50%',
                  background: shiftHeld ? '#fbbf24' : '#22d3ee',
                  boxShadow: shiftHeld ? '0 0 4px rgba(251,191,36,0.7)' : '0 0 4px rgba(34,211,238,0.6)'
                }} />
              </div>
            </div>
            <span className="text-[9px] text-cyan-300 font-mono">{delayLabel}</span>
          </div>
        </div>

        {/* ── Waveform area ───────────────────────────────────── */}
        <div
          className="relative overflow-hidden"
          style={{ width: `${gridWidth}px`, height: '104px' }}
        >
          {/* Bar-label top strip */}
          <div
            className="absolute left-0 right-0 top-0 z-20 border-b border-border/30"
            style={{ height: '20px', background: 'rgba(15,23,42,0.7)' }}
          >
            {Array.from({ length: bars }).map((_, i) => (
              <span
                key={i}
                className="absolute text-[10px] text-slate-500 pl-1"
                style={{ left: `${(pickupBeats + i * beatsPerBar) * beatWidth}px` }}
              >
                {i + 1}
              </span>
            ))}
          </div>

          {/* Waveform canvas — positioned by delay */}
          {audioBuffer && (
            <div
              className="absolute"
              style={{ top: '22px', left: `${waveformOffsetPx}px` }}
            >
              <canvas
                ref={canvasRef}
                style={{ width: `${audioDurationPx}px`, height: '76px', display: 'block' }}
              />
            </div>
          )}

          {/* Bar lines (over waveform, aligned with MIDI grid) */}
          {Array.from({ length: bars + 1 }).map((_, i) => (
            <div
              key={`bline-${i}`}
              className="absolute top-0 bottom-0 z-10 pointer-events-none"
              style={{
                left: `${(pickupBeats + i * beatsPerBar) * beatWidth}px`,
                borderLeft: i === 0 ? '2px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.06)'
              }}
            />
          ))}

          {/* Playhead within grid area (ref-based, updated via requestAnimationFrame) */}
          {showPlayhead && (
            <div
              ref={playheadRef}
              className="absolute w-1 bg-red-500 pointer-events-none z-20"
              style={{
                top: 0,
                bottom: 0,
                left: 0,
                boxShadow: '0 0 12px rgba(239, 68, 68, 0.8)',
                opacity: 0.9,
                willChange: 'transform'
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
