import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import * as Tone from 'tone'
import { ArrowLeft, Bug, ChevronLeft, Headphones, Info, Loader2, Minus, Pause, Play, Plus, RefreshCw, RotateCcw, Settings, Square, Moon, Sun } from 'lucide-react'
import audioEngine from '@common/lib/audioEngine'
import { GranularPlayer } from '@common/lib/granularPlayer'
import { beatsPerBarFromTimeSignature, beatsPerDivisionFromTimeDivision, DEFAULT_TIME_SIGNATURE, importFromMidi, normalizeTimeSignature, timeSignatureToString, getInternalBpm } from '@common/lib/midiUtils'
import { loadSessionCatalog, loadSessionFromUrl, parseSessionTitle } from '@common/lib/sessionManager'
import { solfegePlayer } from '@common/lib/solfegePlayer'
import { Button } from '@/components/ui/button'

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const INSTRUMENT_CONFIGS = {
  synth: { volume: -8 },
  piano: { attack: 0.02, release: 1, volume: -6 },
  violin: { attack: 0.1, release: 1.2, volume: -4 },
  flute: { attack: 0.08, release: 0.8, volume: -2 },
  clarinet: { attack: 0.05, release: 0.5, volume: -4 },
}

const melodyStyles = [
  { value: 'none', label: 'None' },
  { value: 'pitches', label: 'Pitches' },
  { value: 'solfege', label: 'Solfege' },
  { value: 'vocals', label: 'Vocals' },
]

const backgroundStyles = [
  { value: 'none', label: 'None' },
  { value: 'drone', label: 'Drone' },
  { value: 'chords', label: 'Chords' },
  { value: 'instrumentals', label: 'Instrumentals' },
]

const speedOptions = [0.25, 0.5, 0.75, 1]
const MAX_PLAYBACK_RECOVERY_ATTEMPTS = 3
const STALE_AUDIO_REBUILD_MS = 2 * 60 * 1000

function speedLabel(value) {
  return `x${Number(value).toFixed(2).replace(/\.?0+$/, '')}`
}

function dbFromPercent(value) {
  return Math.round((Number(value) - 100) * 0.48)
}

function percentFromDb(db) {
  return Math.max(0, Math.min(100, Math.round(100 + Number(db || 0) / 0.48)))
}

function noteToMidi(note) {
  const names = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const match = String(note || '').match(/^([A-G])(#|b)?(-?\d+)$/)
  if (!match) return 60
  const pc = names[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0)
  return (parseInt(match[3], 10) + 1) * 12 + pc
}

function midiToNoteName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

function isBlackKeyMidi(midi) {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12)
}

function pitchClass(note) {
  return ((noteToMidi(note) % 12) + 12) % 12
}

function scaleDegree(note, tonic) {
  const map = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7']
  const tonicPc = KEYS.indexOf(tonic)
  if (tonicPc < 0) return ''
  return map[(pitchClass(note) - tonicPc + 12) % 12]
}

function splitSessionTitle(displayTitle) {
  const parts = String(displayTitle || '').split(' - ')
  return {
    artist: parts[0] || 'Ear Master',
    song: parts[1] || 'Select a Song',
    section: parts.slice(2).join(' - '),
  }
}

function normalizeKeyMode(value) {
  const text = String(value || '').toLowerCase()
  if (text.includes('minor')) return 'Minor'
  return 'Major'
}

function keyModeLabel(value) {
  return normalizeKeyMode(value) === 'Minor' ? 'Minor' : 'Major'
}

function clearTimerList(timerRef) {
  timerRef.current.forEach(timerId => window.clearTimeout(timerId))
  timerRef.current = []
}

function scheduleMobileNotes(notes, tempo, startBeat, timerRef, activeNotesRef) {
  if (notes.length === 0) return
  const secondsPerBeat = 60 / tempo
  const upcomingNotes = notes.filter(note => note.start + note.duration > startBeat)
  timerRef.current = upcomingNotes.flatMap(note => {
    const noteId = note.id || `${note.note}-${note.start}`
    const noteEnd = note.start + note.duration
    const delayMs = Math.max(0, (note.start - startBeat) * secondsPerBeat * 1000)
    const durationMs = Math.max(50, (noteEnd - Math.max(note.start, startBeat)) * secondsPerBeat * 1000)
    const velocity = Math.min(Math.max((note.velocity ?? 0.8) * Math.pow(10, (note.volume ?? 0) / 20), 0), 1)
    const instrument = note.instrument || 'synth'
    const player = instrument === 'synth' ? audioEngine.synths.synth : audioEngine.samplers[instrument]
    const startTimer = window.setTimeout(() => {
      if (!player) return
      player.triggerAttack(note.note, Tone.now(), velocity)
      activeNotesRef.current.set(noteId, { noteName: note.note, instrument, player })
    }, delayMs)
    const endTimer = window.setTimeout(() => {
      const active = activeNotesRef.current.get(noteId)
      if (active) {
        active.player?.triggerRelease?.(active.noteName, Tone.now())
        activeNotesRef.current.delete(noteId)
      }
    }, delayMs + durationMs)
    return [startTimer, endTimer]
  })
}

function releaseActiveMobileNotes(activeNotesRef) {
  activeNotesRef.current.forEach(active => {
    try { active.player?.triggerRelease?.(active.noteName, Tone.now()) } catch (_) {}
  })
  activeNotesRef.current.clear()
}

function PianoRollMini({ notes, bars, timeDivision, timeSignature, lowestNote, highestNote, cursorPosition, showScaleDegrees, selectedKey, isDark, onNoteClick, onSeek }) {
  const keyboardWidth = 37
  const beatsPerBar = beatsPerBarFromTimeSignature(timeSignature)
  const beatsPerDivision = beatsPerDivisionFromTimeDivision(timeDivision, timeSignature)
  const totalBeats = Math.max(1, bars * beatsPerBar)
  const contentWidth = Math.max(960, totalBeats * 120)
  const [viewportWidth, setViewportWidth] = useState(0)
  const width = contentWidth + Math.max(360, viewportWidth)
  const height = 380
  const visibleNotes = notes || []
  const noteMidis = visibleNotes.map(n => noteToMidi(n.note)).filter(Number.isFinite)
  const rangeLow = noteMidis.length ? Math.max(0, Math.min(...noteMidis) - 2) : (lowestNote ?? 48)
  const rangeHigh = noteMidis.length ? Math.min(127, Math.max(...noteMidis) + 2) : (highestNote ?? 72)
  const pad = 34
  const pitchSpan = Math.max(1, rangeHigh - rangeLow + 1)
  const scrollRef = useRef(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setViewportWidth(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const cursorX = keyboardWidth + cursorPosition * contentWidth
    const visibleContentWidth = Math.max(1, el.clientWidth - keyboardWidth)
    el.scrollLeft = Math.max(0, cursorX - keyboardWidth - visibleContentWidth / 2)
  }, [cursorPosition, contentWidth])

  return (
    <div className={`rounded-3xl border p-3 shadow-2xl ${isDark ? 'border-white/10 bg-slate-900/70 shadow-sky-950/20' : 'border-slate-300 bg-slate-100/80 shadow-sky-200/20'}`}>
      <div ref={scrollRef} className={`overflow-x-auto overflow-y-hidden rounded-2xl ${isDark ? 'bg-slate-950/80' : 'bg-slate-50/80'}`} style={{ WebkitOverflowScrolling: 'touch' }}>
        <div className="flex" style={{ width: keyboardWidth + width, height }}>
          <div className={`sticky left-0 z-20 shrink-0 border-r shadow-[12px_0_24px_rgba(2,6,23,0.45)] ${isDark ? 'border-slate-700 bg-slate-950' : 'border-slate-300 bg-slate-100'}`} style={{ width: keyboardWidth, height }}>
            {Array.from({ length: pitchSpan }).map((_, i) => {
              const midi = rangeHigh - i
              const y = pad + (i / pitchSpan) * (height - pad * 2)
              const rowHeight = Math.max(8, (height - pad * 2) / pitchSpan)
              const black = isBlackKeyMidi(midi)
              return (
                <div key={midi} className={`absolute left-0 flex items-center justify-end px-1.5 text-right font-mono text-[10px] font-semibold leading-none ${black ? (isDark ? 'bg-slate-950 text-slate-100' : 'bg-slate-800 text-slate-100') : (isDark ? 'bg-slate-100 text-slate-950' : 'bg-slate-200 text-slate-800')}`} style={{ top: y, width: keyboardWidth, height: rowHeight }}>
                  {midiToNoteName(midi)}
                </div>
              )
            })}
          </div>
          <svg width={width} height={height} className="block shrink-0" style={{ touchAction: 'manipulation' }}
            onPointerDown={(e) => {
              const svg = e.currentTarget
              const rect = svg.getBoundingClientRect()
              const clickX = e.clientX - rect.left
              if (clickX < 0 || clickX > contentWidth) return
              const clickY = e.clientY - rect.top
              const beat = (clickX / contentWidth) * totalBeats
              let clickedNote = null
              for (const note of visibleNotes) {
                const nx = (note.start / totalBeats) * contentWidth
                const nw = Math.max(8, (note.duration / totalBeats) * contentWidth)
                const midi = noteToMidi(note.note)
                const ny = pad + ((rangeHigh - midi) / pitchSpan) * (height - pad * 2)
                const nh = Math.max(10, (height - pad * 2) / pitchSpan * 0.78)
                if (clickX >= nx && clickX <= nx + nw && clickY >= ny && clickY <= ny + nh) {
                  clickedNote = note
                  break
                }
              }
              if (clickedNote && onNoteClick) onNoteClick(clickedNote)
              else if (onSeek) onSeek(beat)
            }}
          >
            <defs>
              <linearGradient id="noteGradient" x1="0" x2="1">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#818cf8" />
              </linearGradient>
            </defs>
            <rect x={0} y={0} width={contentWidth} height={height} fill={isDark ? '#020617' : '#f8fafc'} />
            <rect x={contentWidth} y={0} width={width - contentWidth} height={height} fill={isDark ? '#06122d' : '#e2e8f0'} />
            {Array.from({ length: pitchSpan }).map((_, i) => {
              const midi = rangeHigh - i
              const y = pad + (i / pitchSpan) * (height - pad * 2)
              const rowHeight = Math.max(8, (height - pad * 2) / pitchSpan)
              const bk = isBlackKeyMidi(midi)
              return <rect key={midi} x={0} y={y} width={contentWidth} height={rowHeight} fill={isDark ? (bk ? '#071022' : '#0d1b33') : (bk ? '#cbd5e1' : '#f1f5f9')} opacity={bk ? '0.95' : '0.72'} />
            })}
            {Array.from({ length: Math.floor(totalBeats / beatsPerDivision) + 1 }).map((_, divIndex) => {
              const beat = divIndex * beatsPerDivision
              const x = (beat / totalBeats) * contentWidth
              return <line key={divIndex} x1={x} y1={0} x2={x} y2={height} stroke={isDark ? '#1e293b' : '#cbd5e1'} strokeWidth={1} />
            })}
            {Array.from({ length: bars + 1 }).map((_, barIndex) => {
              const x = ((barIndex * beatsPerBar) / totalBeats) * contentWidth
              return <line key={`bar-${barIndex}`} x1={x} y1={0} x2={x} y2={height} stroke={isDark ? '#334155' : '#94a3b8'} strokeWidth={2} />
            })}
            {Array.from({ length: pitchSpan }).map((_, i) => {
              const y = pad + (i / pitchSpan) * (height - pad * 2)
              return <line key={i} x1={0} y1={y} x2={contentWidth} y2={y} stroke={isDark ? '#0f172a' : '#e2e8f0'} strokeWidth="1" />
            })}
            {visibleNotes.map((note, idx) => {
              const midi = noteToMidi(note.note)
              const x = (note.start / totalBeats) * contentWidth
              const w = Math.max(8, (note.duration / totalBeats) * contentWidth)
              const y = pad + ((rangeHigh - midi) / pitchSpan) * (height - pad * 2)
              const h = Math.max(10, (height - pad * 2) / pitchSpan * 0.78)
              return (
                <g key={note.id || idx} style={{ cursor: 'pointer' }}>
                  <rect x={x} y={y} width={w} height={h} rx={6} fill="url(#noteGradient)" opacity="0.95" />
                  {showScaleDegrees && w > 24 && (
                    <text x={x + 7} y={Math.max(13, y - 4)} fill={isDark ? '#e0f2fe' : '#0c4a6e'} fontSize="11" fontWeight="800">
                      {scaleDegree(note.note, selectedKey)}
                    </text>
                  )}
                </g>
              )
            })}
            <line x1={cursorPosition * contentWidth} y1="0" x2={cursorPosition * contentWidth} y2={height} stroke="#facc15" strokeWidth={3} />
          </svg>
        </div>
      </div>
    </div>
  )
}

function SettingCard({ title, children, isDark }) {
  return (
    <section className={`rounded-3xl border p-4 shadow-xl ${isDark ? 'border-white/10 bg-white/[0.06] shadow-black/20' : 'border-slate-300 bg-white/80 shadow-slate-200/40'}`}>
      <h2 className={`mb-4 text-sm font-semibold uppercase tracking-[0.22em] ${isDark ? 'text-sky-200/80' : 'text-sky-700/80'}`}>{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function RangeSetting({ label, value, min = 0, max = 100, step = 1, onChange, suffix = '', isDark }) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className={isDark ? 'text-slate-200' : 'text-slate-700'}>{label}</span>
        <span className={`font-medium ${isDark ? 'text-sky-200' : 'text-sky-700'}`}>{value}{suffix}</span>
      </div>
      <input className="w-full accent-sky-400" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
    </label>
  )
}

function FastSelect({ label, value, options, onChange, disabled = false, compact = false, session = false, isDark }) {
  const [open, setOpen] = useState(false)
  const [menuRect, setMenuRect] = useState(null)
  const rootRef = useRef(null)
  const selected = options.find(opt => (opt.value || opt) === value)
  const selectedLabel = selected?.label || selected || value

  const updateMenuRect = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuRect({
      left: Math.max(8, rect.left),
      top: rect.bottom + 4,
      width: Math.max(160, rect.width),
      maxHeight: Math.max(160, window.innerHeight - rect.bottom - 16)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    updateMenuRect()
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', updateMenuRect)
    window.addEventListener('scroll', updateMenuRect, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', updateMenuRect)
      window.removeEventListener('scroll', updateMenuRect, true)
    }
  }, [open, updateMenuRect])

  return (
    <div ref={rootRef} className={`${disabled ? 'pointer-events-none opacity-50' : ''} relative ${compact ? `rounded-[1.4rem] border p-2.5 text-center text-sm shadow-lg shadow-black/10 ${isDark ? 'border-white/10 bg-gradient-to-br from-white/[0.14] to-white/[0.05]' : 'border-slate-300 bg-gradient-to-br from-slate-200/80 to-slate-100/50'}` : 'block'}`}>
      <div className={compact ? `px-1 text-center text-xs font-medium uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}` : `mb-2 text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{label}</div>
      <button type="button" disabled={disabled} onClick={() => setOpen(v => !v)} className={`${session ? 'h-14 text-[0.8rem] leading-tight' : compact ? 'mt-1 h-11 text-[0.8rem]' : 'h-12 text-base'} flex w-full items-center justify-center rounded-2xl border px-3 text-center font-bold ring-sky-400 transition duration-75 active:scale-[0.98] disabled:text-slate-500 ${isDark ? 'border-white/10 bg-slate-950/80 text-white' : 'border-slate-300 bg-white text-slate-800'}`}>
        <span className={`${session ? 'line-clamp-2' : 'truncate'} block w-full overflow-hidden`}>{selectedLabel}</span>
      </button>
      {open && menuRect && createPortal(
        <div className={`fixed z-[9999] overflow-y-auto rounded-2xl border p-1 shadow-2xl shadow-black/40 backdrop-blur-xl ${isDark ? 'border-white/10 bg-slate-950/95' : 'border-slate-300 bg-white/95'}`} style={{ left: menuRect.left, top: menuRect.top, width: menuRect.width, maxHeight: menuRect.maxHeight }}>
          {options.map(opt => {
            const optionValue = opt.value || opt
            const optionLabel = opt.label || opt
            const optionDisabled = Boolean(opt.disabled)
            return (
              <button key={optionValue} type="button" disabled={optionDisabled} onPointerDown={e => e.stopPropagation()} onClick={() => {
                if (optionDisabled) return
                onChange(optionValue)
                setOpen(false)
              }} className={`flex min-h-10 w-full items-center justify-center rounded-xl px-2 text-center text-sm font-semibold transition-colors duration-75 hover:bg-white/10 active:bg-sky-400/20 disabled:text-slate-600 ${isDark ? 'text-white' : 'text-slate-800 hover:bg-slate-100'}`}>
                {optionDisabled ? `${optionLabel} (not available)` : optionLabel}
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

function CompactSelect({ label, value, options, onChange, isDark }) {
  return <FastSelect label={label} value={value} options={options} onChange={onChange} compact isDark={isDark} />
}

function SpeedSelect({ value, onChange, isDark }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const currentIndex = speedOptions.findIndex(speed => Math.abs(speed - value) < 0.001)
  const safeIndex = currentIndex === -1 ? speedOptions.length - 1 : currentIndex
  const canDecrease = safeIndex > 0
  const canIncrease = safeIndex < speedOptions.length - 1

  useEffect(() => {
    if (!open) return
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  return (
    <div ref={rootRef} className={`relative rounded-[1.4rem] border p-2.5 text-center text-sm shadow-lg shadow-black/10 ${isDark ? 'border-white/10 bg-gradient-to-br from-white/[0.14] to-white/[0.05]' : 'border-slate-300 bg-gradient-to-br from-slate-200/80 to-slate-100/50'}`}>
      <div className={`px-1 text-xs font-medium uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Speed</div>
      <div className="mt-1 grid grid-cols-[1rem_minmax(3rem,1fr)_1rem] items-center gap-1">
        <button type="button" onClick={() => canDecrease && onChange(speedOptions[safeIndex - 1])} disabled={!canDecrease} className={`flex h-7 items-center justify-center rounded-full transition-transform duration-75 active:scale-90 disabled:invisible ${isDark ? 'bg-white/10 text-white' : 'bg-slate-200 text-slate-700'}`}>
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setOpen(v => !v)} className={`flex h-11 w-full items-center justify-center rounded-2xl border px-1 text-center text-[0.8rem] font-bold transition duration-75 active:scale-[0.98] ${isDark ? 'border-white/10 bg-slate-950/80 text-white' : 'border-slate-300 bg-white text-slate-800'}`}>
          {speedLabel(value)}
        </button>
        <button type="button" onClick={() => canIncrease && onChange(speedOptions[safeIndex + 1])} disabled={!canIncrease} className={`flex h-7 items-center justify-center rounded-full transition-transform duration-75 active:scale-90 disabled:invisible ${isDark ? 'bg-white/10 text-white' : 'bg-slate-200 text-slate-700'}`}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className={`absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-2xl border p-1 shadow-2xl shadow-black/40 backdrop-blur-xl ${isDark ? 'border-white/10 bg-slate-950/95' : 'border-slate-300 bg-white/95'}`}>
          {speedOptions.map(speed => (
            <button key={speed} type="button" onMouseDown={e => e.preventDefault()} onClick={() => {
              onChange(speed)
              setOpen(false)
            }} className={`flex min-h-10 w-full items-center justify-center rounded-xl px-2 text-sm font-semibold transition-colors duration-75 hover:bg-white/10 active:bg-sky-400/20 ${isDark ? 'text-white' : 'text-slate-800 hover:bg-slate-100'}`}>
              {speedLabel(speed)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MobileSettings({ settings, setSettings, onBack, sessionCapabilities, isDark }) {
  const melodyOptions = melodyStyles.map(opt => ({
    ...opt,
    disabled: opt.value === 'pitches' ? !sessionCapabilities.pitches : opt.value === 'solfege' ? !sessionCapabilities.solfege : opt.value === 'vocals' ? !sessionCapabilities.vocals : false
  }))
  const backgroundOptions = backgroundStyles.map(opt => ({
    ...opt,
    disabled: opt.value === 'chords' ? !sessionCapabilities.chords : opt.value === 'instrumentals' ? !sessionCapabilities.instrumentals : opt.value === 'drone' ? !sessionCapabilities.drone : false
  }))
  const setMelodyMode = value => {
    if (melodyOptions.find(opt => opt.value === value)?.disabled) return
    setSettings(s => ({ ...s, melodyMode: value }))
  }
  const setBackgroundTrack = value => {
    if (backgroundOptions.find(opt => opt.value === value)?.disabled) return
    setSettings(s => ({ ...s, backgroundTrack: value }))
  }
  return (
    <main className={`mobile-safe min-h-full overflow-x-hidden px-4 py-4 ${isDark ? 'bg-[radial-gradient(circle_at_top,#1e3a8a_0,#020617_42%)] text-white' : 'bg-[radial-gradient(circle_at_top,#dbeafe_0,#f8fafc_42%)] text-slate-900'}`}>
      <div className="mx-auto flex min-h-full max-w-md flex-col">
        <div className="mb-5 flex items-center gap-3">
          <button onClick={onBack} className={`rounded-full p-3 active:scale-95 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}><ChevronLeft className="h-5 w-5" /></button>
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Mobile ear training controls</p>
          </div>
        </div>

        <div className="space-y-4 pb-8">
          <SettingCard title="Playback" isDark={isDark}>
            <RangeSetting label="Speed" min={25} max={100} step={25} value={Math.round(settings.playbackSpeed * 100)} suffix="%" onChange={v => setSettings(s => ({ ...s, playbackSpeed: v / 100 }))} isDark={isDark} />
            <label className={`flex items-center justify-between rounded-2xl px-4 py-3 ${isDark ? 'bg-slate-950/60' : 'bg-slate-100'}`}>
              <span>Loop</span>
              <input type="checkbox" className="h-5 w-5 accent-sky-400" checked={settings.isLooping} onChange={e => setSettings(s => ({ ...s, isLooping: e.target.checked }))} />
            </label>
          </SettingCard>

          <SettingCard title="Melody" isDark={isDark}>
            <RangeSetting label="Volume" value={percentFromDb(settings.melodyVolume)} suffix="%" onChange={v => setSettings(s => ({ ...s, melodyVolume: dbFromPercent(v) }))} isDark={isDark} />
            <FastSelect label="Style" value={settings.melodyMode || 'none'} options={melodyOptions} onChange={setMelodyMode} isDark={isDark} />
            <FastSelect label="Sound" value={settings.instrument} options={Object.keys(INSTRUMENT_CONFIGS)} onChange={v => setSettings(s => ({ ...s, instrument: v }))} disabled={settings.melodyMode !== 'pitches'} isDark={isDark} />
            <label className={`flex items-center justify-between rounded-2xl px-4 py-3 ${isDark ? 'bg-slate-950/60' : 'bg-slate-100'}`}>
              <span>Show Scale Degrees</span>
              <input type="checkbox" className="h-5 w-5 accent-sky-400" checked={settings.showScaleDegrees} onChange={e => setSettings(s => ({ ...s, showScaleDegrees: e.target.checked }))} />
            </label>
            {settings.melodyMode === 'vocals' && !sessionCapabilities.vocals && <p className="text-xs text-amber-200">This session has no embedded vocals file.</p>}
          </SettingCard>

          <SettingCard title="Background" isDark={isDark}>
            <RangeSetting label="Volume" value={percentFromDb(settings.backgroundVolume)} suffix="%" onChange={v => setSettings(s => ({ ...s, backgroundVolume: dbFromPercent(v) }))} isDark={isDark} />
            <FastSelect label="Style" value={settings.backgroundTrack || 'none'} options={backgroundOptions} onChange={setBackgroundTrack} isDark={isDark} />
            <FastSelect label="Sound" value={settings.chordsInstrument || 'piano'} options={Object.keys(INSTRUMENT_CONFIGS)} onChange={v => setSettings(s => ({ ...s, chordsInstrument: v }))} disabled={settings.backgroundTrack !== 'chords'} isDark={isDark} />
            {settings.backgroundTrack === 'instrumentals' && !sessionCapabilities.instrumentals && <p className="text-xs text-amber-200">This session has no embedded instrumentals file.</p>}
          </SettingCard>
        </div>
      </div>
    </main>
  )
}

function MobileEarTrainer() {
  const navigate = useNavigate()
  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    document.documentElement.classList.add('dark')
    try { localStorage.setItem('emp-theme', 'dark') } catch (_) {}
  }, [])

  const toggleTheme = useCallback(() => {
    setIsDark(prev => {
      const next = !prev
      if (next) document.documentElement.classList.add('dark')
      else document.documentElement.classList.remove('dark')
      try { localStorage.setItem('emp-theme', next ? 'dark' : 'light') } catch (_) {}
      return next
    })
  }, [])

  const [catalog, setCatalog] = useState([])
  const [selectedUrl, setSelectedUrl] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [notes, setNotes] = useState([])
  const [chordsNotes, setChordsNotes] = useState([])
  const [noteRange, setNoteRange] = useState({ lowestNote: 48, highestNote: 72 })
  const [settings, setSettings] = useState({
    key: 'C', keyMode: 'Major', tempo: 120, bars: 4, timeDivision: '1/8', timeSignature: DEFAULT_TIME_SIGNATURE, playbackSpeed: 1,
    instrument: 'synth', chordsInstrument: 'piano', melodyMode: 'pitches', backgroundTrack: 'drone',
    melodyVolume: 0, backgroundVolume: dbFromPercent(70), regionStart: 0, regionEnd: 1, isLooping: false, showScaleDegrees: true,
  })
  const [isInitialized, setIsInitialized] = useState(false)
  const [playbackState, setPlaybackState] = useState('stopped')
  const [cursorPosition, setCursorPosition] = useState(0)
  const [screen, setScreen] = useState('main')
  const [loading, setLoading] = useState(true)
  const [audioPreparing, setAudioPreparing] = useState(false)
  const [error, setError] = useState('')
  const [showResumeOverlay, setShowResumeOverlay] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [debugEvents, setDebugEvents] = useState([])
  const [capabilities, setCapabilities] = useState({ pitches: false, solfege: false, vocals: false, drone: true, chords: false, instrumentals: false })

  const vocalsPlayerRef = useRef(null)
  const instrumentalsPlayerRef = useRef(null)
  const mobileNoteTimersRef = useRef([])
  const mobileStopTimerRef = useRef(null)
  const activeMobileNotesRef = useRef(new Map())
  const playbackTokenRef = useRef(0)
  const pausedBeatRef = useRef(0)
  const seekBeatRef = useRef(0)
  const playbackStartTimeRef = useRef(0)
  const cursorPositionRef = useRef(0)
  const currentRegionRef = useRef({ startBeat: 0, regionBeats: 0, effectiveTempo: 120 })
  const currentMidiNotesRef = useRef([])
  const solfegeHoldTimerRef = useRef(null)
  const playbackWatchdogTimerRef = useRef(null)
  const playbackRecoveryAttemptRef = useRef(0)
  const playRef = useRef(null)
  const settingsRef = useRef(settings)
  const lastAudioReinitializedAtRef = useRef(Date.now())
  const lastPlaybackVerifiedAtRef = useRef(Date.now())
  const dronePlayingRef = useRef(false)
  const granularInitializedRef = useRef(false)
  const lastRawContextRef = useRef(null)

  const addDebugEvent = useCallback((message, details = {}) => {
    const stamp = new Date().toLocaleTimeString()
    setDebugEvents(prev => [{ stamp, message, details }, ...prev].slice(0, 30))
  }, [])

  useEffect(() => { settingsRef.current = settings }, [settings])

  const title = useMemo(() => parseSessionTitle(sessionName), [sessionName])
  const titleParts = useMemo(() => splitSessionTitle(title), [title])
  const melodyOptions = useMemo(() => melodyStyles.map(opt => ({
    ...opt,
    disabled: opt.value === 'pitches' ? !capabilities.pitches : opt.value === 'solfege' ? !capabilities.solfege : opt.value === 'vocals' ? !capabilities.vocals : false
  })), [capabilities])
  const backgroundOptions = useMemo(() => backgroundStyles.map(opt => ({
    ...opt,
    disabled: opt.value === 'chords' ? !capabilities.chords : opt.value === 'instrumentals' ? !capabilities.instrumentals : opt.value === 'drone' ? !capabilities.drone : false
  })), [capabilities])
  const setMelodyMode = useCallback(value => {
    if (melodyOptions.find(opt => opt.value === value)?.disabled) return
    setSettings(s => ({ ...s, melodyMode: value }))
  }, [melodyOptions])
  const setBackgroundTrack = useCallback(value => {
    if (backgroundOptions.find(opt => opt.value === value)?.disabled) return
    setSettings(s => ({ ...s, backgroundTrack: value }))
  }, [backgroundOptions])
  const sessionOptions = useMemo(() => catalog.map(song => ({
    value: song.url,
    label: song.title
  })), [catalog])
  const isBusy = loading || audioPreparing

  const resetAudioStateAfterContextChange = useCallback(() => {
    audioEngine.dispose()
    setIsInitialized(false)
    granularInitializedRef.current = false
    lastRawContextRef.current = null
    solfegePlayer.stop()
  }, [])

  const ensureFreshAudioContext = useCallback(async ({ force = false, latencyHint = 'playback', label = 'audio', start = true } = {}) => {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback'
    } catch (_) {}
    const rawBefore = Tone.context.rawContext
    const toneState = Tone.context.state
    const rawState = rawBefore?.state
    const isClosed = toneState === 'closed' || rawState === 'closed'
    const shouldReplace = force && isClosed
    if (shouldReplace) {
      addDebugEvent('Fresh audio context requested (context was closed)', { label, toneState, rawState })
      resetAudioStateAfterContextChange()
      Tone.setContext(new Tone.Context({ latencyHint }))
    } else if (force && start) {
      addDebugEvent('Audio resume requested (not closed, just resuming)', { label, toneState, rawState })
    }
    const rawContext = Tone.context.rawContext
    if (start) {
      await Tone.start()
      if (Tone.context.state !== 'running') await Tone.context.resume()
      if (rawContext?.state !== 'running') await rawContext.resume()
      if (Tone.context.state === 'closed' || rawContext?.state === 'closed') {
        throw new Error('Audio context could not be reopened.')
      }
    } else if (Tone.context.state === 'closed' || rawContext?.state === 'closed') {
      Tone.setContext(new Tone.Context({ latencyHint }))
    }
    const contextChanged = Boolean(lastRawContextRef.current && lastRawContextRef.current !== rawContext)
    if (contextChanged) resetAudioStateAfterContextChange()
    lastRawContextRef.current = rawContext
    return { rawContext, contextChanged: contextChanged || shouldReplace }
  }, [addDebugEvent, resetAudioStateAfterContextChange])

  const refreshCatalog = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const bundled = await loadSessionCatalog().catch(() => ({ sessions: [] }))
      setCatalog(bundled.sessions || [])
      setSelectedUrl(prev => (bundled.sessions || []).some(song => song.url === prev) ? prev : (bundled.sessions[0]?.url || ''))
      addDebugEvent('Catalog refreshed', { total: bundled.sessions?.length || 0 })
    } catch (err) {
      console.error(err)
      addDebugEvent('Catalog refresh failed', { message: err.message })
      setError('Could not load sessions.')
    } finally {
      setLoading(false)
    }
  }, [addDebugEvent])

  const stopPlayback = useCallback(({ keepPreparing = false, keepRecovery = false, keepSeek = false } = {}) => {
    playbackTokenRef.current += 1
    clearTimerList(mobileNoteTimersRef)
    if (mobileStopTimerRef.current) {
      window.clearTimeout(mobileStopTimerRef.current)
      mobileStopTimerRef.current = null
    }
    if (playbackWatchdogTimerRef.current) {
      window.clearTimeout(playbackWatchdogTimerRef.current)
      playbackWatchdogTimerRef.current = null
    }
    if (!keepRecovery) playbackRecoveryAttemptRef.current = 0
    audioEngine.stop()
    releaseActiveMobileNotes(activeMobileNotesRef)
    audioEngine.synths.synth?.releaseAll?.()
    if (solfegeHoldTimerRef.current) {
      window.clearInterval(solfegeHoldTimerRef.current)
      solfegeHoldTimerRef.current = null
    }
    solfegePlayer.stop()
    vocalsPlayerRef.current?.stop()
    instrumentalsPlayerRef.current?.stop()
    dronePlayingRef.current = false
    if (!keepPreparing) setAudioPreparing(false)
    if (keepSeek && seekBeatRef.current > 0) {
      pausedBeatRef.current = seekBeatRef.current
      const s = settingsRef.current
      const totalBeats = s.bars * beatsPerBarFromTimeSignature(s.timeSignature)
      const fraction = totalBeats > 0 ? seekBeatRef.current / totalBeats : 0
      cursorPositionRef.current = fraction
      setCursorPosition(fraction)
    } else {
      seekBeatRef.current = 0
      pausedBeatRef.current = 0
      cursorPositionRef.current = 0
      setCursorPosition(0)
    }
    setPlaybackState('stopped')
  }, [])

  useEffect(() => {
    let mounted = true
    const init = async () => {
      try {
        audioEngine.onCursorUpdate = position => {
          cursorPositionRef.current = position
          setCursorPosition(position)
        }
        audioEngine.onPlaybackComplete = () => stopPlayback({ keepSeek: true })
        await audioEngine.initialize({ loadDefaultPiano: false })
        await audioEngine.loadInstrument('synth', INSTRUMENT_CONFIGS.synth)
        await audioEngine.loadInstrument('piano', INSTRUMENT_CONFIGS.piano)
        if (mounted) setIsInitialized(true)
      } catch (err) {
        console.error(err)
        if (mounted) setError(err.message)
      }
    }
    init()
    return () => { mounted = false; stopPlayback() }
  }, [stopPlayback])

  useEffect(() => {
    refreshCatalog()
  }, [refreshCatalog])

  // Foreground recovery: gently resume audio context when tab becomes visible
  // Only rebuild if context is actually closed. iOS usually just suspends.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return
      const toneState = Tone.context.state
      const rawState = Tone.context.rawContext?.state
      addDebugEvent('Foreground visibility check', { toneState, rawState, playbackState })
      // If context is closed, we need a user gesture to rebuild — show overlay
      if (toneState === 'closed' || rawState === 'closed') {
        stopPlayback()
        setShowResumeOverlay(true)
        addDebugEvent('Context closed — showing resume overlay')
        return
      }
      // If context is just suspended, try to resume it directly
      if (toneState === 'suspended' || rawState === 'suspended') {
        try {
          await Tone.context.resume()
          if (Tone.context.rawContext?.state === 'suspended') {
            await Tone.context.rawContext.resume()
          }
          addDebugEvent('Foreground resume succeeded', { toneState: Tone.context.state, rawState: Tone.context.rawContext?.state })
          lastAudioReinitializedAtRef.current = Date.now()
        } catch (err) {
          addDebugEvent('Foreground resume failed, showing overlay', { message: err.message })
          stopPlayback()
          setShowResumeOverlay(true)
        }
      } else {
        // Context is running — just update timestamp
        lastAudioReinitializedAtRef.current = Date.now()
      }
    }
    const handlePageHide = () => {
      if (playbackState === 'playing') {
        addDebugEvent('Page hide — pausing playback')
        stopPlayback()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [addDebugEvent, stopPlayback, playbackState])

  useEffect(() => {
    if (!selectedUrl) return
    let cancelled = false
    const load = async () => {
      stopPlayback()
      setLoading(true)
      setError('')
      try {
        addDebugEvent('Session load started', { selectedUrl })
        const { sessionName: name, sessionData, files } = await loadSessionFromUrl(selectedUrl)
        if (cancelled) return
        const { rawContext: decodeContext } = await ensureFreshAudioContext({ label: 'session-decode', start: false })
        const sd = sessionData.settings || {}
        setSessionName(name)
        setSettings(prev => ({
          ...prev,
          key: sd.key || 'C', keyMode: normalizeKeyMode(sd.keyMode || sd.mode || sd.scale || sd.tonality || sessionData.keyMode || sessionData.mode || sessionData.scale || sessionData.tonality), tempo: sd.tempo || 120, bars: sd.bars || 4, timeDivision: sd.timeDivision || '1/8', timeSignature: normalizeTimeSignature(sd.timeSignature),
          playbackSpeed: sd.playbackSpeed || 1, instrument: 'synth',
          chordsInstrument: sessionData.chordsInstrument || 'piano', melodyMode: 'pitches',
          backgroundTrack: 'drone', melodyVolume: sd.melodyVolume ?? 0,
          backgroundVolume: sd.backgroundVolume || dbFromPercent(70), regionStart: sd.regionStart ?? 0, regionEnd: sd.regionEnd ?? 1,
          isLooping: sd.isLooping ?? false,
        }))
        setNotes(sessionData.notes || [])
        setChordsNotes(sessionData.chordsNotes || [])
        setNoteRange(sessionData.noteRange || { lowestNote: 48, highestNote: 72 })
        setCapabilities({
          pitches: (sessionData.notes || []).length > 0,
          solfege: (sessionData.notes || []).length > 0,
          vocals: Boolean(files.vocals),
          drone: true,
          chords: (sessionData.chordsNotes || []).length > 0 || Boolean(files.chordsMidi),
          instrumentals: Boolean(files.instrumentals)
        })

        if (files.vocals) {
          const buffer = await decodeContext.decodeAudioData(await files.vocals.arrayBuffer())
          vocalsPlayerRef.current = new GranularPlayer()
          vocalsPlayerRef.current.loadBuffer(buffer)
          granularInitializedRef.current = false
        } else {
          vocalsPlayerRef.current?.dispose()
          vocalsPlayerRef.current = null
        }

        if (files.instrumentals) {
          const buffer = await decodeContext.decodeAudioData(await files.instrumentals.arrayBuffer())
          instrumentalsPlayerRef.current = new GranularPlayer()
          instrumentalsPlayerRef.current.loadBuffer(buffer)
          granularInitializedRef.current = false
        } else {
          instrumentalsPlayerRef.current?.dispose()
          instrumentalsPlayerRef.current = null
        }

        if ((!sessionData.chordsNotes || sessionData.chordsNotes.length === 0) && files.chordsMidi) {
          const imported = await importFromMidi(await files.chordsMidi.arrayBuffer(), sd.tempo || 120)
          if (!cancelled) {
            setChordsNotes(imported.notes || [])
            if (sd.timeSignature === undefined && imported.timeSignature) {
              setSettings(prev => ({ ...prev, timeSignature: normalizeTimeSignature(imported.timeSignature) }))
            }
            setCapabilities(prev => ({ ...prev, chords: (imported.notes || []).length > 0 }))
          }
        }
        addDebugEvent('Session load finished', {
          name,
          notes: (sessionData.notes || []).length,
          chords: (sessionData.chordsNotes || []).length,
          vocals: Boolean(files.vocals),
          instrumentals: Boolean(files.instrumentals)
        })
      } catch (err) {
        console.error(err)
        addDebugEvent('Session load failed', { selectedUrl, message: err.message })
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [ensureFreshAudioContext, selectedUrl, stopPlayback])

  useEffect(() => {
    if (!isInitialized) return
    audioEngine.loadInstrument(settings.instrument, INSTRUMENT_CONFIGS[settings.instrument] || {})
  }, [settings.instrument, isInitialized])

  useEffect(() => {
    if (!isInitialized) return
    audioEngine.loadInstrument(settings.chordsInstrument, INSTRUMENT_CONFIGS[settings.chordsInstrument] || {})
  }, [settings.chordsInstrument, isInitialized])

  const unlockAudioForMobile = useCallback(async () => {
    addDebugEvent('Audio unlock started', {
      toneState: Tone.context.state,
      rawState: Tone.context.rawContext?.state
    })
    const { rawContext, contextChanged } = await ensureFreshAudioContext({ label: 'unlock', latencyHint: playbackRecoveryAttemptRef.current >= 2 ? 'interactive' : 'playback' })
    addDebugEvent('Audio unlock finished', {
      toneState: Tone.context.state,
      rawState: rawContext?.state,
      contextChanged
    })
    return rawContext
  }, [addDebugEvent, ensureFreshAudioContext])

  const ensureGranular = useCallback(async (audioContext) => {
    if (!audioContext) return
    const players = [vocalsPlayerRef.current, instrumentalsPlayerRef.current].filter(Boolean)
    const needsInitialization = !granularInitializedRef.current || players.some(player => player.audioContext !== audioContext)
    if (needsInitialization) {
      players.forEach(player => {
        if (player.audioContext && player.audioContext !== audioContext) {
          player.stop()
          if (player.gainNode) {
            try { player.gainNode.disconnect() } catch (_) {}
            player.gainNode = null
          }
          player.audioContext = null
          player.workletReady = false
        }
      })
      await Promise.all([vocalsPlayerRef.current, instrumentalsPlayerRef.current].filter(Boolean).map(player => player.initialize(audioContext)))
      granularInitializedRef.current = true
    }
    if (audioContext.state !== 'running') {
      await audioContext.resume()
    }
  }, [])

  const recoverAudioGraphForRetry = useCallback(async (attempt = 1) => {
    const previousRawContext = Tone.context.rawContext
    addDebugEvent('Playback recovery rebuild started', {
      attempt,
      toneState: Tone.context.state,
      rawState: previousRawContext?.state,
      transportState: Tone.Transport.state,
      transportTicks: Tone.Transport.ticks
    })
    audioEngine.dispose()
    setIsInitialized(false)
    try { Tone.Transport.cancel() } catch (_) {}
    try { Tone.Transport.stop() } catch (_) {}
    granularInitializedRef.current = false
    lastRawContextRef.current = null
    const { rawContext } = await ensureFreshAudioContext({ force: true, label: 'playback-retry', latencyHint: attempt >= 2 ? 'interactive' : 'playback' })
    await new Promise(resolve => window.setTimeout(resolve, 80))
    if (Tone.context.state !== 'running') await Tone.context.resume()
    if (rawContext?.state !== 'running') await rawContext.resume()
    await audioEngine.initialize({ loadDefaultPiano: false })
    await audioEngine.loadInstrument('synth', INSTRUMENT_CONFIGS.synth)
    // Only reload instruments that are actually used by the current session
    const currentSettings = settingsRef.current
    const neededInstruments = new Set(['synth'])
    if (currentSettings.instrument !== 'synth') neededInstruments.add(currentSettings.instrument)
    if (currentSettings.chordsInstrument !== 'synth') neededInstruments.add(currentSettings.chordsInstrument)
    for (const inst of neededInstruments) {
      if (INSTRUMENT_CONFIGS[inst]) {
        try { await audioEngine.loadInstrument(inst, INSTRUMENT_CONFIGS[inst]) } catch (e) {
          console.warn(`Recovery: failed to load ${inst}:`, e)
        }
      }
    }
    lastAudioReinitializedAtRef.current = Date.now()
    setIsInitialized(true)
    addDebugEvent('Playback recovery rebuild finished', {
      attempt,
      toneState: Tone.context.state,
      rawState: rawContext?.state
    })
  }, [addDebugEvent, ensureFreshAudioContext])

  const verifyPlaybackStarted = useCallback((playbackToken, before) => {
    if (playbackWatchdogTimerRef.current) window.clearTimeout(playbackWatchdogTimerRef.current)
    playbackWatchdogTimerRef.current = window.setTimeout(async () => {
      if (playbackToken !== playbackTokenRef.current || document.visibilityState !== 'visible') return
      const rawContext = Tone.context.rawContext
      const rawAdvanced = rawContext ? rawContext.currentTime > before.rawTime + 0.15 : false
      const ticksAdvanced = Tone.Transport.ticks > before.transportTicks + 2
      const cursorAdvanced = cursorPositionRef.current > before.cursorPosition + 0.001
      if (Tone.context.state === 'running' && rawAdvanced && (ticksAdvanced || cursorAdvanced)) {
        playbackRecoveryAttemptRef.current = 0
        lastPlaybackVerifiedAtRef.current = Date.now()
        addDebugEvent('Playback verified', {
          rawAdvanced,
          ticksAdvanced,
          cursorAdvanced,
          transportState: Tone.Transport.state,
          transportTicks: Tone.Transport.ticks
        })
        return
      }
      addDebugEvent('Playback stalled after start', {
        toneState: Tone.context.state,
        rawState: rawContext?.state,
        rawBefore: before.rawTime,
        rawAfter: rawContext?.currentTime,
        ticksBefore: before.transportTicks,
        ticksAfter: Tone.Transport.ticks,
        cursorBefore: before.cursorPosition,
        cursorAfter: cursorPositionRef.current,
        transportState: Tone.Transport.state
      })
      // First attempt: try a simple resume before rebuilding everything
      if (playbackRecoveryAttemptRef.current === 0) {
        playbackRecoveryAttemptRef.current = 1
        addDebugEvent('Watchdog: trying simple resume first')
        try {
          if (Tone.context.state !== 'running') await Tone.context.resume()
          if (rawContext?.state !== 'running') await rawContext.resume()
          // Re-check if playback is now advancing
          await new Promise(r => window.setTimeout(r, 200))
          if (playbackToken !== playbackTokenRef.current) return
          const rawNow = Tone.context.rawContext
          const nowAdvanced = rawNow ? rawNow.currentTime > rawContext.currentTime + 0.1 : false
          const ticksNow = Tone.Transport.ticks
          if (Tone.context.state === 'running' && nowAdvanced && ticksNow > before.transportTicks + 2) {
            addDebugEvent('Watchdog: simple resume succeeded')
            playbackRecoveryAttemptRef.current = 0
            lastPlaybackVerifiedAtRef.current = Date.now()
            return
          }
        } catch (e) {
          addDebugEvent('Watchdog: simple resume failed', { message: e.message })
        }
      }
      const nextAttempt = playbackRecoveryAttemptRef.current + 1
      if (nextAttempt > MAX_PLAYBACK_RECOVERY_ATTEMPTS) {
        stopPlayback()
        setError('Playback did not start after multiple automatic rebuilds. Tap Play again.')
        return
      }
      playbackRecoveryAttemptRef.current = nextAttempt
      setAudioPreparing(true)
      try {
        await recoverAudioGraphForRetry(nextAttempt)
        stopPlayback({ keepPreparing: true, keepRecovery: true })
        setAudioPreparing(false)
        window.setTimeout(() => playRef.current?.(), nextAttempt * 180)
      } catch (err) {
        addDebugEvent('Playback recovery failed', { message: err.message })
        stopPlayback()
        setError(`Playback recovery failed: ${err.message}`)
      }
    }, 900)
  }, [addDebugEvent, recoverAudioGraphForRetry, stopPlayback])

  const pausePlayback = useCallback(() => {
    if (playbackState !== 'playing') return
    const { startBeat, effectiveTempo } = currentRegionRef.current
    const elapsedBeats = Math.max(0, (Tone.now() - playbackStartTimeRef.current) * effectiveTempo / 60)
    pausedBeatRef.current = startBeat + elapsedBeats
    clearTimerList(mobileNoteTimersRef)
    if (mobileStopTimerRef.current) {
      window.clearTimeout(mobileStopTimerRef.current)
      mobileStopTimerRef.current = null
    }
    audioEngine.pause({ releaseActiveNotes: false })
    if (solfegeHoldTimerRef.current) {
      window.clearInterval(solfegeHoldTimerRef.current)
      solfegeHoldTimerRef.current = null
    }
    solfegePlayer.stop()
    const sessionBeat = pausedBeatRef.current
    const heldRegionNote = notes.find(n => n.start <= sessionBeat && n.start + n.duration > sessionBeat)
    if (settings.melodyMode === 'solfege' && heldRegionNote) {
      const playHeld = () => solfegePlayer.playHeldNote?.(heldRegionNote.note, settings.key, 0.22, heldRegionNote.velocity ?? 0.8)
      playHeld()
      solfegeHoldTimerRef.current = window.setInterval(playHeld, 190)
    }
    const internalTempo = getInternalBpm(settings.tempo, settings.timeSignature)
    const normalBps = internalTempo / 60
    const sampleCenter = pausedBeatRef.current / normalBps
    const holdStart = Math.max(0, sampleCenter - 0.055)
    const holdEnd = Math.min(holdStart + 0.035, Math.max(holdStart + 0.02, sampleCenter + 0.025))
    if (settings.melodyMode === 'vocals' && vocalsPlayerRef.current) {
      vocalsPlayerRef.current.volume = settings.melodyVolume
      vocalsPlayerRef.current.start(settings.playbackSpeed, holdStart, true, holdStart, holdEnd)
    }
    if (settings.backgroundTrack === 'instrumentals' && instrumentalsPlayerRef.current) {
      instrumentalsPlayerRef.current.volume = settings.backgroundVolume
      instrumentalsPlayerRef.current.start(settings.playbackSpeed, holdStart, true, holdStart, holdEnd)
    }
    setPlaybackState('paused')
  }, [playbackState, settings, notes])

  const play = useCallback(async () => {
    if (loading || audioPreparing) return
    try {
      setAudioPreparing(true)
      setError('')
      addDebugEvent('Play requested', { playbackState, loading, audioPreparing })
      let audioContext = await unlockAudioForMobile()
      const resumeFromPause = playbackState === 'paused' || (playbackState === 'stopped' && seekBeatRef.current > 0)
      if (!resumeFromPause) stopPlayback({ keepPreparing: true, keepRecovery: playbackRecoveryAttemptRef.current })
      else {
        clearTimerList(mobileNoteTimersRef)
        releaseActiveMobileNotes(activeMobileNotesRef)
        if (solfegeHoldTimerRef.current) {
          window.clearInterval(solfegeHoldTimerRef.current)
          solfegeHoldTimerRef.current = null
        }
        solfegePlayer.stop()
        vocalsPlayerRef.current?.stop()
        instrumentalsPlayerRef.current?.stop()
      }
      if (!resumeFromPause && playbackRecoveryAttemptRef.current === 0 && Date.now() - lastAudioReinitializedAtRef.current > STALE_AUDIO_REBUILD_MS) {
        addDebugEvent('Pre-play context check (stale)', {
          idleMs: Date.now() - lastAudioReinitializedAtRef.current,
          toneState: Tone.context.state,
          rawState: Tone.context.rawContext?.state
        })
        // Just try to resume — don't rebuild unless context is actually closed
        if (Tone.context.state === 'closed' || Tone.context.rawContext?.state === 'closed') {
          addDebugEvent('Pre-play: context closed, rebuilding')
          await recoverAudioGraphForRetry(0)
          audioContext = Tone.context.rawContext
        } else {
          if (Tone.context.state !== 'running') await Tone.context.resume()
          if (Tone.context.rawContext?.state !== 'running') await Tone.context.rawContext.resume()
          lastAudioReinitializedAtRef.current = Date.now()
        }
      }
      const playbackToken = playbackTokenRef.current
      if (!audioEngine.isInitialized) {
        addDebugEvent('Audio engine initialize started')
        await audioEngine.initialize({ loadDefaultPiano: false })
        await audioEngine.loadInstrument('synth', INSTRUMENT_CONFIGS.synth)
        await audioEngine.loadInstrument('piano', INSTRUMENT_CONFIGS.piano)
        setIsInitialized(true)
        addDebugEvent('Audio engine initialize finished')
      }
      await audioEngine.loadInstrument(settings.instrument, INSTRUMENT_CONFIGS[settings.instrument] || {})
      await audioEngine.loadInstrument(settings.chordsInstrument, INSTRUMENT_CONFIGS[settings.chordsInstrument] || {})
      await ensureGranular(audioContext)
      if (playbackToken !== playbackTokenRef.current) return

      const totalBeats = settings.bars * beatsPerBarFromTimeSignature(settings.timeSignature)
      const startBeat = settings.regionStart * totalBeats
      const endBeat = settings.regionEnd * totalBeats
      const resumeBeat = resumeFromPause ? Math.min(Math.max(pausedBeatRef.current, startBeat), endBeat) : startBeat
      const regionBeats = endBeat - startBeat
      const remainingBeats = Math.max(0, endBeat - resumeBeat)
      const internalTempo = getInternalBpm(settings.tempo, settings.timeSignature)
      const effectiveTempo = internalTempo * settings.playbackSpeed
      const regionNotes = notes
        .filter(n => n.start < endBeat && (n.start + n.duration) > startBeat)
        .map(n => ({ ...n, start: Math.max(0, n.start - startBeat), duration: Math.min(n.start + n.duration, endBeat) - Math.max(n.start, startBeat) }))
      const resumeRegionBeat = resumeBeat - startBeat

      audioEngine.clearScheduledNotes()
      audioEngine.setLoopEnabledBeats(false, regionBeats)
      audioEngine.setTempo(settings.tempo * settings.playbackSpeed, settings.timeSignature)
      Tone.Transport.timeSignature = beatsPerBarFromTimeSignature(settings.timeSignature)
      audioEngine.totalTicks = Math.round(regionBeats * Tone.Transport.PPQ)
      Tone.Transport.position = `${Math.round(resumeRegionBeat * Tone.Transport.PPQ)}i`

      let midiNotes = []
      if (settings.melodyMode === 'pitches') {
        const melodyInstrument = settings.instrument === 'synth' || audioEngine.samplers[settings.instrument] ? settings.instrument : 'synth'
        midiNotes = midiNotes.concat(regionNotes.map(n => ({ ...n, instrument: melodyInstrument, volume: settings.melodyVolume })))
      }
      if (settings.backgroundTrack === 'chords' && chordsNotes.length > 0) {
        const chordsInstrument = audioEngine.samplers[settings.chordsInstrument] ? settings.chordsInstrument : 'synth'
        midiNotes = midiNotes.concat(chordsNotes
          .filter(n => n.start < endBeat && (n.start + n.duration) > startBeat)
          .map(n => ({ ...n, start: Math.max(0, n.start - startBeat), duration: Math.min(n.start + n.duration, endBeat) - Math.max(n.start, startBeat), instrument: chordsInstrument, volume: settings.backgroundVolume })))
      }
      if (!settings.isLooping) audioEngine.scheduleStopAtBeats(regionBeats)
      else audioEngine.setLoopEnabledBeats(true, regionBeats)

      if (midiNotes.length > 0) {
        currentMidiNotesRef.current = midiNotes
        scheduleMobileNotes(midiNotes, effectiveTempo, resumeRegionBeat, mobileNoteTimersRef, activeMobileNotesRef)
      }
      audioEngine.totalTicks = Math.round(regionBeats * Tone.Transport.PPQ)
      const playbackStartedFrom = {
        rawTime: Tone.context.rawContext?.currentTime || 0,
        transportTicks: Tone.Transport.ticks,
        cursorPosition: cursorPositionRef.current
      }
      await audioEngine.start(resumeRegionBeat)
      addDebugEvent('Tone playback started', { resumeRegionBeat, effectiveTempo, midiNotes: midiNotes.length })
      playbackStartTimeRef.current = Tone.now() - resumeRegionBeat * 60 / effectiveTempo
      currentRegionRef.current = { startBeat, regionBeats, effectiveTempo }
      if (!settings.isLooping) {
        mobileStopTimerRef.current = window.setTimeout(stopPlayback, Math.max(0, (remainingBeats / effectiveTempo) * 60000 + 250))
      }

      if (settings.melodyMode === 'solfege' && regionNotes.length > 0) {
        const toneRawCtx = Tone.context.rawContext
        if (!solfegePlayer._ctx || solfegePlayer._ctx !== toneRawCtx) await solfegePlayer.initialize(toneRawCtx)
        if (!solfegePlayer.isReady()) await solfegePlayer.loadAll()
        if (!solfegePlayer.isReady()) throw new Error('Solfege samples could not be loaded.')
        solfegePlayer.volume = settings.melodyVolume
        const remainingSolfegeNotes = regionNotes
          .filter(n => n.start + n.duration > resumeRegionBeat)
          .map(n => ({ ...n, start: Math.max(0, n.start - resumeRegionBeat), duration: n.start < resumeRegionBeat ? n.start + n.duration - resumeRegionBeat : n.duration }))
        solfegePlayer.scheduleNotes(remainingSolfegeNotes, settings.key, effectiveTempo, toneRawCtx.currentTime + Tone.context.lookAhead)
      }

      if (settings.backgroundTrack === 'drone' && (!resumeFromPause || !dronePlayingRef.current)) {
        audioEngine.scheduleDroneNotes(settings.key, regionBeats, settings.backgroundVolume)
        dronePlayingRef.current = true
      }

      const normalBps = internalTempo / 60
      const bufferOffsetSeconds = resumeBeat / normalBps
      const regionStartInBuffer = startBeat / normalBps
      const regionEndInBuffer = endBeat / normalBps
      if (settings.melodyMode === 'vocals' && vocalsPlayerRef.current) {
        vocalsPlayerRef.current.volume = settings.melodyVolume
        vocalsPlayerRef.current.start(settings.playbackSpeed, bufferOffsetSeconds, settings.isLooping, regionStartInBuffer, regionEndInBuffer, settings.isLooping ? null : stopPlayback)
      }
      if (settings.backgroundTrack === 'instrumentals' && instrumentalsPlayerRef.current) {
        instrumentalsPlayerRef.current.volume = settings.backgroundVolume
        instrumentalsPlayerRef.current.start(settings.playbackSpeed, bufferOffsetSeconds, settings.isLooping, regionStartInBuffer, regionEndInBuffer, settings.isLooping ? null : stopPlayback)
      }

      setPlaybackState('playing')
      verifyPlaybackStarted(playbackToken, playbackStartedFrom)
      addDebugEvent('Play finished', { melodyMode: settings.melodyMode, backgroundTrack: settings.backgroundTrack })
    } catch (err) {
      console.error('Mobile playback failed:', err)
      addDebugEvent('Play failed', { message: err.message, toneState: Tone.context.state, rawState: Tone.context.rawContext?.state })
      stopPlayback()
      setError(`Playback failed: ${err.message}`)
    } finally {
      setAudioPreparing(false)
    }
  }, [loading, audioPreparing, playbackState, stopPlayback, unlockAudioForMobile, ensureGranular, recoverAudioGraphForRetry, settings, notes, chordsNotes, addDebugEvent, verifyPlaybackStarted])

  useEffect(() => {
    playRef.current = play
  }, [play])

  const playNoteOnClick = useCallback(async (note) => {
    try {
      if (Tone.context.state !== 'running') await unlockAudioForMobile()
      // Stop any held notes from pause state
      if (solfegeHoldTimerRef.current) {
        window.clearInterval(solfegeHoldTimerRef.current)
        solfegeHoldTimerRef.current = null
      }
      solfegePlayer.stop()
      if (vocalsPlayerRef.current) vocalsPlayerRef.current.stop()
      if (instrumentalsPlayerRef.current) instrumentalsPlayerRef.current.stop()
      releaseActiveMobileNotes(activeMobileNotesRef)
      audioEngine.synths.synth?.releaseAll?.()

      const instrument = settings.instrument === 'synth' || audioEngine.samplers[settings.instrument] ? settings.instrument : 'synth'
      const player = instrument === 'synth' ? audioEngine.synths.synth : audioEngine.samplers[instrument]
      if (!player) return
      const velocity = Math.min(Math.max((note.velocity ?? 0.8) * Math.pow(10, settings.melodyVolume / 20), 0), 1)
      player.triggerAttack(note.note, Tone.now(), velocity)
      const durationSec = Math.max(0.3, (note.duration ?? 1) * 60 / (settings.tempo * settings.playbackSpeed))
      window.setTimeout(() => {
        try { player.triggerRelease?.(note.note, Tone.now()) } catch (_) {}
      }, durationSec * 1000)
    } catch (err) {
      addDebugEvent('Note click play failed', { message: err.message })
    }
  }, [settings, unlockAudioForMobile, addDebugEvent])

  const playFromBeat = useCallback((beat) => {
    if (loading || audioPreparing) return
    const totalBeats = settings.bars * beatsPerBarFromTimeSignature(settings.timeSignature)
    const startBeat = settings.regionStart * totalBeats
    const endBeat = settings.regionEnd * totalBeats
    const clampedBeat = Math.min(Math.max(beat, startBeat), endBeat)
    stopPlayback()
    seekBeatRef.current = clampedBeat
    pausedBeatRef.current = clampedBeat
    const fraction = totalBeats > 0 ? clampedBeat / totalBeats : 0
    cursorPositionRef.current = fraction
    setCursorPosition(fraction)
    setPlaybackState('paused')
  }, [loading, audioPreparing, settings, stopPlayback])

  const handleResumeFromOverlay = useCallback(async () => {
    setShowResumeOverlay(false)
    setAudioPreparing(true)
    try {
      addDebugEvent('Resume overlay tapped — rebuilding audio context')
      await recoverAudioGraphForRetry(0)
      lastAudioReinitializedAtRef.current = Date.now()
      addDebugEvent('Resume overlay: audio context rebuilt')
    } catch (err) {
      addDebugEvent('Resume overlay: rebuild failed', { message: err.message })
      setError(`Audio recovery failed: ${err.message}`)
    } finally {
      setAudioPreparing(false)
    }
  }, [recoverAudioGraphForRetry, addDebugEvent])

  if (screen === 'settings') {
    return <MobileSettings settings={settings} setSettings={setSettings} onBack={() => setScreen('main')} sessionCapabilities={capabilities} isDark={isDark} />
  }

  return (
    <main className={`mobile-safe min-h-full overflow-hidden px-4 pb-4 pt-2 ${isDark ? 'bg-[radial-gradient(circle_at_top,#1e3a8a_0,#020617_42%)] text-white' : 'bg-[radial-gradient(circle_at_top,#dbeafe_0,#f8fafc_42%)] text-slate-900'}`}>
      <div className="mx-auto flex h-full max-w-md flex-col gap-4">
        <header className={`rounded-[2rem] border p-4 shadow-2xl backdrop-blur-xl ${isDark ? 'border-white/10 bg-white/[0.08] shadow-black/30' : 'border-slate-300 bg-white/80 shadow-slate-300/30'}`}>
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <button onClick={() => navigate('/')} className={`rounded-full p-2.5 shadow-lg active:scale-95 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}>
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="truncate text-lg font-extrabold tracking-tight">Ear Master Pro</div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button onClick={refreshCatalog} className={`rounded-full p-2.5 shadow-lg active:scale-95 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}><RefreshCw className="h-4 w-4" /></button>
              <button onClick={() => setShowDebug(v => !v)} className={`rounded-full p-2.5 shadow-lg active:scale-95 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}><Bug className="h-4 w-4" /></button>
              <button onClick={() => setScreen('settings')} className={`rounded-full p-2.5 shadow-lg active:scale-95 ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}><Settings className="h-4 w-4" /></button>
            </div>
          </div>

          <div className="mb-4">
            <div className="min-w-0">
              <p className={`text-sm font-bold uppercase tracking-[0.16em] ${isDark ? 'text-sky-100' : 'text-sky-700'}`}>{titleParts.artist}</p>
              <h1 className="mt-1 whitespace-normal break-words text-2xl font-extrabold leading-tight">{titleParts.song}</h1>
              {titleParts.section && <p className={`mt-1 text-sm font-bold uppercase tracking-[0.16em] ${isDark ? 'text-sky-100/90' : 'text-sky-600/90'}`}>{titleParts.section}</p>}
              <p className={`mt-2 text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Key {settings.key} {keyModeLabel(settings.keyMode)} · {settings.tempo} BPM · {timeSignatureToString(settings.timeSignature)}</p>
            </div>
          </div>

          <div className="mb-4">
            <FastSelect
              label="Session"
              value={selectedUrl}
              options={sessionOptions}
              onChange={setSelectedUrl}
              disabled={isBusy}
              session
              isDark={isDark}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={playbackState === 'playing' ? pausePlayback : play} disabled={!selectedUrl || isBusy} className={`${playbackState === 'playing' ? 'bg-amber-300 shadow-amber-500/20' : 'bg-emerald-400 shadow-emerald-500/25'} rounded-3xl px-3 py-4 font-bold text-slate-950 shadow-lg disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none active:scale-95`}>
              {isBusy ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : playbackState === 'playing' ? <Pause className="mx-auto h-5 w-5" /> : <Play className="mx-auto h-5 w-5" />}
              <span className="mt-1 block text-xs">{isBusy ? 'Loading' : playbackState === 'playing' ? 'Pause' : 'Play'}</span>
            </button>
            <button onClick={() => stopPlayback({ keepSeek: true })} disabled={playbackState === 'stopped'} className="rounded-3xl bg-rose-400 px-3 py-4 font-bold text-slate-950 shadow-lg shadow-rose-500/25 disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none active:scale-95">
              <Square className="mx-auto h-5 w-5" />
              <span className="mt-1 block text-xs">Stop</span>
            </button>
          </div>
        </header>

        {error && <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">{error}</div>}
        {showResumeOverlay && (
          <div className={`fixed inset-0 z-[9999] flex items-center justify-center p-6 ${isDark ? 'bg-black/70' : 'bg-slate-900/60'}`}>
            <div className={`rounded-3xl border p-6 text-center shadow-2xl ${isDark ? 'border-white/10 bg-slate-900' : 'border-slate-300 bg-white'}`}>
              <Headphones className={`mx-auto mb-3 h-10 w-10 ${isDark ? 'text-sky-400' : 'text-sky-600'}`} />
              <h2 className="text-lg font-bold">Audio Interrupted</h2>
              <p className={`mt-2 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>The audio context was closed while the app was in the background. Tap below to restore audio.</p>
              <button onClick={handleResumeFromOverlay} className="mt-4 rounded-2xl bg-emerald-400 px-6 py-3 font-bold text-slate-950 shadow-lg shadow-emerald-500/25 active:scale-95">
                Resume Audio
              </button>
            </div>
          </div>
        )}
        {isBusy && <div className="flex items-center justify-center gap-2 rounded-2xl border border-sky-300/30 bg-sky-400/10 p-3 text-sm text-sky-100"><Loader2 className="h-4 w-4 animate-spin" /> Loading playback engine...</div>}
        {showDebug && (
          <div className="max-h-56 overflow-y-auto rounded-2xl border border-fuchsia-300/30 bg-fuchsia-400/10 p-3 text-xs text-fuchsia-50">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-bold">Debug</span>
              <button onClick={() => setDebugEvents([])} className="rounded-full bg-white/10 px-2 py-1 text-[0.7rem]">Clear</button>
            </div>
            <div className="mb-2 text-fuchsia-100/80">Playback: {playbackState} · Tone: {Tone.context.state} · Raw: {Tone.context.rawContext?.state || 'none'} · Engine: {audioEngine.isInitialized ? 'ready' : 'not ready'}</div>
            {debugEvents.length === 0 ? <div className="text-fuchsia-100/70">No events yet.</div> : debugEvents.map((event, index) => (
              <div key={`${event.stamp}-${index}`} className="border-t border-white/10 py-1">
                <div className="font-semibold">{event.stamp} · {event.message}</div>
                {Object.keys(event.details || {}).length > 0 && <pre className="mt-1 whitespace-pre-wrap break-words text-[0.68rem] text-fuchsia-100/75">{JSON.stringify(event.details, null, 2)}</pre>}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 text-center text-sm">
          <CompactSelect label="Melody" value={settings.melodyMode || 'none'} options={melodyOptions} onChange={setMelodyMode} isDark={isDark} />
          <CompactSelect label="Background" value={settings.backgroundTrack || 'none'} options={backgroundOptions} onChange={setBackgroundTrack} isDark={isDark} />
          <SpeedSelect value={settings.playbackSpeed} onChange={value => setSettings(s => ({ ...s, playbackSpeed: value }))} isDark={isDark} />
        </div>

        {cursorPosition > 0 && playbackState === 'stopped' && (
          <div className="flex items-center justify-center pt-1">
            <button onClick={() => stopPlayback()} className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold transition active:scale-95 ${isDark ? 'bg-white/10 text-sky-200' : 'bg-slate-200 text-sky-700'}`} title="Reset to beginning">
              <RotateCcw className="h-3 w-3" />
              Reset to beginning
            </button>
          </div>
        )}
        <PianoRollMini notes={notes} bars={settings.bars} timeDivision={settings.timeDivision} timeSignature={settings.timeSignature} lowestNote={noteRange.lowestNote} highestNote={noteRange.highestNote} cursorPosition={cursorPosition} showScaleDegrees={settings.showScaleDegrees} selectedKey={settings.key} isDark={isDark} onNoteClick={playNoteOnClick} onSeek={playFromBeat} />

        <div className="flex items-center justify-center pt-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className={`h-9 w-9 rounded-full border ${isDark ? 'border-white/10 bg-white/10' : 'border-slate-300 bg-slate-200'}`}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
          </Button>
        </div>
      </div>
    </main>
  )
}

export default MobileEarTrainer
