import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import * as Tone from 'tone'
import { ArrowLeft, Bug, ChevronLeft, Info, Loader2, Minus, Pause, Play, Plus, RefreshCw, Settings, Square, Moon, Sun } from 'lucide-react'
import audioEngine from '@common/lib/audioEngine'
import { GranularPlayer } from '@common/lib/granularPlayer'
import { beatsPerBarFromTimeSignature, beatsPerDivisionFromTimeDivision, DEFAULT_TIME_SIGNATURE, importFromMidi, normalizeTimeSignature, timeSignatureToString, getInternalBpm } from '@common/lib/midiUtils'
import { loadSessionCatalog, loadSessionFromUrl, parseSessionTitle } from '@common/lib/sessionManager'
import { solfegePlayer } from '@common/lib/solfegePlayer'
import { useTheme } from '@/hooks/useTheme'
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

function PianoRollMini({ notes, bars, timeDivision, timeSignature, lowestNote, highestNote, cursorPosition, showScaleDegrees, selectedKey }) {
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
    <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-3 shadow-2xl shadow-sky-950/20">
      <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden rounded-2xl bg-slate-950/80" style={{ WebkitOverflowScrolling: 'touch' }}>
        <div className="flex" style={{ width: keyboardWidth + width, height }}>
          <div className="sticky left-0 z-20 shrink-0 border-r border-slate-700 bg-slate-950 shadow-[12px_0_24px_rgba(2,6,23,0.45)]" style={{ width: keyboardWidth, height }}>
            {Array.from({ length: pitchSpan }).map((_, i) => {
              const midi = rangeHigh - i
              const y = pad + (i / pitchSpan) * (height - pad * 2)
              const rowHeight = Math.max(8, (height - pad * 2) / pitchSpan)
              const black = isBlackKeyMidi(midi)
              return (
                <div key={midi} className={`absolute left-0 flex items-center justify-end px-1.5 text-right font-mono text-[10px] font-semibold leading-none ${black ? 'bg-slate-950 text-slate-100' : 'bg-slate-100 text-slate-950'}`} style={{ top: y, width: keyboardWidth, height: rowHeight }}>
                  {midiToNoteName(midi)}
                </div>
              )
            })}
          </div>
          <svg width={width} height={height} className="block shrink-0">
            <defs>
              <linearGradient id="noteGradient" x1="0" x2="1">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#818cf8" />
              </linearGradient>
            </defs>
            <rect x={0} y={0} width={contentWidth} height={height} fill="#020617" />
            <rect x={contentWidth} y={0} width={width - contentWidth} height={height} fill="#06122d" />
            {Array.from({ length: pitchSpan }).map((_, i) => {
              const midi = rangeHigh - i
              const y = pad + (i / pitchSpan) * (height - pad * 2)
              const rowHeight = Math.max(8, (height - pad * 2) / pitchSpan)
              return <rect key={midi} x={0} y={y} width={contentWidth} height={rowHeight} fill={isBlackKeyMidi(midi) ? '#071022' : '#0d1b33'} opacity={isBlackKeyMidi(midi) ? '0.95' : '0.72'} />
            })}
            {Array.from({ length: Math.floor(totalBeats / beatsPerDivision) + 1 }).map((_, divIndex) => {
              const beat = divIndex * beatsPerDivision
              const x = (beat / totalBeats) * contentWidth
              return <line key={divIndex} x1={x} y1={0} x2={x} y2={height} stroke="#1e293b" strokeWidth={1} />
            })}
            {Array.from({ length: bars + 1 }).map((_, barIndex) => {
              const x = ((barIndex * beatsPerBar) / totalBeats) * contentWidth
              return <line key={`bar-${barIndex}`} x1={x} y1={0} x2={x} y2={height} stroke="#334155" strokeWidth={2} />
            })}
            {Array.from({ length: pitchSpan }).map((_, i) => {
              const y = pad + (i / pitchSpan) * (height - pad * 2)
              return <line key={i} x1={0} y1={y} x2={contentWidth} y2={y} stroke="#0f172a" strokeWidth="1" />
            })}
            {visibleNotes.map((note, idx) => {
              const midi = noteToMidi(note.note)
              const x = (note.start / totalBeats) * contentWidth
              const w = Math.max(8, (note.duration / totalBeats) * contentWidth)
              const y = pad + ((rangeHigh - midi) / pitchSpan) * (height - pad * 2)
              const h = Math.max(10, (height - pad * 2) / pitchSpan * 0.78)
              return (
                <g key={note.id || idx}>
                  <rect x={x} y={y} width={w} height={h} rx={6} fill="url(#noteGradient)" opacity="0.95" />
                  {showScaleDegrees && w > 24 && (
                    <text x={x + 7} y={Math.max(13, y - 4)} fill="#e0f2fe" fontSize="11" fontWeight="800">
                      {scaleDegree(note.note, selectedKey)}
                    </text>
                  )}
                </g>
              )
            })}
            <line x1={cursorPosition * contentWidth} y1="0" x2={cursorPosition * contentWidth} y2={height} stroke="#facc15" strokeWidth="3" />
          </svg>
        </div>
      </div>
    </div>
  )
}

function SettingCard({ title, children }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.06] p-4 shadow-xl shadow-black/20">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-sky-200/80">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function RangeSetting({ label, value, min = 0, max = 100, step = 1, onChange, suffix = '' }) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-slate-200">{label}</span>
        <span className="font-medium text-sky-200">{value}{suffix}</span>
      </div>
      <input className="w-full accent-sky-400" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
    </label>
  )
}

function FastSelect({ label, value, options, onChange, disabled = false, compact = false, session = false }) {
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
    <div ref={rootRef} className={`${disabled ? 'pointer-events-none opacity-50' : ''} relative ${compact ? 'rounded-[1.4rem] border border-white/10 bg-gradient-to-br from-white/[0.14] to-white/[0.05] p-2.5 text-center text-sm shadow-lg shadow-black/10' : 'block'}`}>
      <div className={compact ? 'px-1 text-center text-xs font-medium uppercase tracking-wide text-slate-400' : 'mb-2 text-sm text-slate-200'}>{label}</div>
      <button type="button" disabled={disabled} onClick={() => setOpen(v => !v)} className={`${session ? 'h-14 text-[0.8rem] leading-tight' : compact ? 'mt-1 h-11 text-[0.8rem]' : 'h-12 text-base'} flex w-full items-center justify-center rounded-2xl border border-white/10 bg-slate-950/80 px-3 text-center font-bold text-white ring-sky-400 transition duration-75 active:scale-[0.98] disabled:text-slate-500`}>
        <span className={`${session ? 'line-clamp-2' : 'truncate'} block w-full overflow-hidden`}>{selectedLabel}</span>
      </button>
      {open && menuRect && createPortal(
        <div className="fixed z-[9999] overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/95 p-1 shadow-2xl shadow-black/40 backdrop-blur-xl" style={{ left: menuRect.left, top: menuRect.top, width: menuRect.width, maxHeight: menuRect.maxHeight }}>
          {options.map(opt => {
            const optionValue = opt.value || opt
            const optionLabel = opt.label || opt
            const optionDisabled = Boolean(opt.disabled)
            return (
              <button key={optionValue} type="button" disabled={optionDisabled} onPointerDown={e => e.stopPropagation()} onClick={() => {
                if (optionDisabled) return
                onChange(optionValue)
                setOpen(false)
              }} className="flex min-h-10 w-full items-center justify-center rounded-xl px-2 text-center text-sm font-semibold text-white transition-colors duration-75 hover:bg-white/10 active:bg-sky-400/20 disabled:text-slate-600">
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

function CompactSelect({ label, value, options, onChange }) {
  return <FastSelect label={label} value={value} options={options} onChange={onChange} compact />
}

function SpeedSelect({ value, onChange }) {
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
    <div ref={rootRef} className="relative rounded-[1.4rem] border border-white/10 bg-gradient-to-br from-white/[0.14] to-white/[0.05] p-2.5 text-center text-sm shadow-lg shadow-black/10">
      <div className="px-1 text-xs font-medium uppercase tracking-wide text-slate-400">Speed</div>
      <div className="mt-1 grid grid-cols-[1rem_minmax(3rem,1fr)_1rem] items-center gap-1">
        <button type="button" onClick={() => canDecrease && onChange(speedOptions[safeIndex - 1])} disabled={!canDecrease} className="flex h-7 items-center justify-center rounded-full bg-white/10 text-white transition-transform duration-75 active:scale-90 disabled:invisible">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setOpen(v => !v)} className="flex h-11 w-full items-center justify-center rounded-2xl border border-white/10 bg-slate-950/80 px-1 text-center text-[0.8rem] font-bold text-white transition duration-75 active:scale-[0.98]">
          {speedLabel(value)}
        </button>
        <button type="button" onClick={() => canIncrease && onChange(speedOptions[safeIndex + 1])} disabled={!canIncrease} className="flex h-7 items-center justify-center rounded-full bg-white/10 text-white transition-transform duration-75 active:scale-90 disabled:invisible">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 p-1 shadow-2xl shadow-black/40 backdrop-blur-xl">
          {speedOptions.map(speed => (
            <button key={speed} type="button" onMouseDown={e => e.preventDefault()} onClick={() => {
              onChange(speed)
              setOpen(false)
            }} className="flex min-h-10 w-full items-center justify-center rounded-xl px-2 text-sm font-semibold text-white transition-colors duration-75 hover:bg-white/10 active:bg-sky-400/20">
              {speedLabel(speed)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MobileSettings({ settings, setSettings, onBack, sessionCapabilities }) {
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
    <main className="mobile-safe min-h-full overflow-x-hidden bg-[radial-gradient(circle_at_top,#1e3a8a_0,#020617_42%)] px-4 py-4 text-white">
      <div className="mx-auto flex min-h-full max-w-md flex-col">
        <div className="mb-5 flex items-center gap-3">
          <button onClick={onBack} className="rounded-full bg-white/10 p-3 active:scale-95"><ChevronLeft className="h-5 w-5" /></button>
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-sm text-slate-400">Mobile ear training controls</p>
          </div>
        </div>

        <div className="space-y-4 pb-8">
          <SettingCard title="Playback">
            <RangeSetting label="Speed" min={25} max={100} step={25} value={Math.round(settings.playbackSpeed * 100)} suffix="%" onChange={v => setSettings(s => ({ ...s, playbackSpeed: v / 100 }))} />
            <label className="flex items-center justify-between rounded-2xl bg-slate-950/60 px-4 py-3">
              <span>Loop</span>
              <input type="checkbox" className="h-5 w-5 accent-sky-400" checked={settings.isLooping} onChange={e => setSettings(s => ({ ...s, isLooping: e.target.checked }))} />
            </label>
          </SettingCard>

          <SettingCard title="Melody">
            <RangeSetting label="Volume" value={percentFromDb(settings.melodyVolume)} suffix="%" onChange={v => setSettings(s => ({ ...s, melodyVolume: dbFromPercent(v) }))} />
            <FastSelect label="Style" value={settings.melodyMode || 'none'} options={melodyOptions} onChange={setMelodyMode} />
            <FastSelect label="Sound" value={settings.instrument} options={Object.keys(INSTRUMENT_CONFIGS)} onChange={v => setSettings(s => ({ ...s, instrument: v }))} disabled={settings.melodyMode !== 'pitches'} />
            <label className="flex items-center justify-between rounded-2xl bg-slate-950/60 px-4 py-3">
              <span>Show Scale Degrees</span>
              <input type="checkbox" className="h-5 w-5 accent-sky-400" checked={settings.showScaleDegrees} onChange={e => setSettings(s => ({ ...s, showScaleDegrees: e.target.checked }))} />
            </label>
            {settings.melodyMode === 'vocals' && !sessionCapabilities.vocals && <p className="text-xs text-amber-200">This session has no embedded vocals file.</p>}
          </SettingCard>

          <SettingCard title="Background">
            <RangeSetting label="Volume" value={percentFromDb(settings.backgroundVolume)} suffix="%" onChange={v => setSettings(s => ({ ...s, backgroundVolume: dbFromPercent(v) }))} />
            <FastSelect label="Style" value={settings.backgroundTrack || 'none'} options={backgroundOptions} onChange={setBackgroundTrack} />
            <FastSelect label="Sound" value={settings.chordsInstrument || 'piano'} options={Object.keys(INSTRUMENT_CONFIGS)} onChange={v => setSettings(s => ({ ...s, chordsInstrument: v }))} disabled={settings.backgroundTrack !== 'chords'} />
            {settings.backgroundTrack === 'instrumentals' && !sessionCapabilities.instrumentals && <p className="text-xs text-amber-200">This session has no embedded instrumentals file.</p>}
          </SettingCard>
        </div>
      </div>
    </main>
  )
}

function MobileEarTrainer() {
  const navigate = useNavigate()
  const { isDark, toggleTheme } = useTheme()

  const [catalog, setCatalog] = useState([])
  const [selectedUrl, setSelectedUrl] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [notes, setNotes] = useState([])
  const [chordsNotes, setChordsNotes] = useState([])
  const [noteRange, setNoteRange] = useState({ lowestNote: 48, highestNote: 72 })
  const [settings, setSettings] = useState({
    key: 'C', keyMode: 'Major', tempo: 120, bars: 4, timeDivision: '1/8', timeSignature: DEFAULT_TIME_SIGNATURE, playbackSpeed: 1,
    instrument: 'synth', chordsInstrument: 'piano', melodyMode: 'pitches', backgroundTrack: 'drone',
    melodyVolume: 0, backgroundVolume: 0, regionStart: 0, regionEnd: 1, isLooping: false, showScaleDegrees: true,
  })
  const [isInitialized, setIsInitialized] = useState(false)
  const [playbackState, setPlaybackState] = useState('stopped')
  const [cursorPosition, setCursorPosition] = useState(0)
  const [screen, setScreen] = useState('main')
  const [loading, setLoading] = useState(true)
  const [audioPreparing, setAudioPreparing] = useState(false)
  const [error, setError] = useState('')
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
  const playbackStartTimeRef = useRef(0)
  const cursorPositionRef = useRef(0)
  const currentRegionRef = useRef({ startBeat: 0, regionBeats: 0, effectiveTempo: 120 })
  const currentMidiNotesRef = useRef([])
  const solfegeHoldTimerRef = useRef(null)
  const playbackWatchdogTimerRef = useRef(null)
  const playbackRecoveryAttemptRef = useRef(0)
  const playRef = useRef(null)
  const lastAudioReinitializedAtRef = useRef(Date.now())
  const lastPlaybackVerifiedAtRef = useRef(Date.now())
  const dronePlayingRef = useRef(false)
  const granularInitializedRef = useRef(false)
  const lastRawContextRef = useRef(null)

  const addDebugEvent = useCallback((message, details = {}) => {
    const stamp = new Date().toLocaleTimeString()
    setDebugEvents(prev => [{ stamp, message, details }, ...prev].slice(0, 30))
  }, [])

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
    const shouldReplace = force || Tone.context.state === 'closed' || rawBefore?.state === 'closed'
    if (shouldReplace) {
      addDebugEvent('Fresh audio context requested', { label, force, toneState: Tone.context.state, rawState: rawBefore?.state, latencyHint, start })
      resetAudioStateAfterContextChange()
      Tone.setContext(new Tone.Context({ latencyHint }))
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

  const stopPlayback = useCallback(({ keepPreparing = false, keepRecovery = false } = {}) => {
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
    pausedBeatRef.current = 0
    setPlaybackState('stopped')
    cursorPositionRef.current = 0
    setCursorPosition(0)
  }, [])

  useEffect(() => {
    let mounted = true
    const init = async () => {
      try {
        audioEngine.onCursorUpdate = position => {
          cursorPositionRef.current = position
          setCursorPosition(position)
        }
        audioEngine.onPlaybackComplete = () => stopPlayback()
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

  // Foreground recovery: rebuild audio context when tab becomes visible again
  useEffect(() => {
    const refreshOnForeground = async () => {
      if (document.visibilityState !== 'visible') return
      addDebugEvent('Foreground recovery started', {
        toneState: Tone.context.state,
        rawState: Tone.context.rawContext?.state,
        initialized: audioEngine.isInitialized
      })
      setAudioPreparing(true)
      try {
        stopPlayback({ keepPreparing: true })
        await ensureFreshAudioContext({ force: true, label: 'foreground', start: false })
        lastAudioReinitializedAtRef.current = Date.now()
        addDebugEvent('Foreground recovery finished', {
          toneState: Tone.context.state,
          rawState: Tone.context.rawContext?.state
        })
      } catch (err) {
        addDebugEvent('Foreground recovery failed', { message: err.message })
        setError(`Audio recovery failed: ${err.message}`)
      } finally {
        setAudioPreparing(false)
      }
    }
    window.addEventListener('focus', refreshOnForeground)
    document.addEventListener('visibilitychange', refreshOnForeground)
    return () => {
      window.removeEventListener('focus', refreshOnForeground)
      document.removeEventListener('visibilitychange', refreshOnForeground)
    }
  }, [addDebugEvent, ensureFreshAudioContext, stopPlayback])

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
          backgroundVolume: sd.backgroundVolume ?? 0, regionStart: sd.regionStart ?? 0, regionEnd: sd.regionEnd ?? 1,
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
    await audioEngine.loadInstrument('piano', INSTRUMENT_CONFIGS.piano)
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
      const resumeFromPause = playbackState === 'paused'
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
        addDebugEvent('Pre-play stale audio rebuild started', {
          idleMs: Date.now() - lastAudioReinitializedAtRef.current,
          lastVerifiedMs: Date.now() - lastPlaybackVerifiedAtRef.current
        })
        await recoverAudioGraphForRetry(0)
        audioContext = Tone.context.rawContext
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

  if (screen === 'settings') {
    return <MobileSettings settings={settings} setSettings={setSettings} onBack={() => setScreen('main')} sessionCapabilities={capabilities} />
  }

  return (
    <main className="mobile-safe min-h-full overflow-hidden bg-[radial-gradient(circle_at_top,#1e3a8a_0,#020617_42%)] px-4 pb-4 pt-2 text-white">
      <div className="mx-auto flex h-full max-w-md flex-col gap-4">
        <header className="rounded-[2rem] border border-white/10 bg-white/[0.08] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <button onClick={() => navigate('/')} className="rounded-full bg-white/10 p-2.5 shadow-lg active:scale-95">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="truncate text-lg font-extrabold tracking-tight text-white">Ear Master Pro</div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button onClick={refreshCatalog} className="rounded-full bg-white/10 p-2.5 shadow-lg active:scale-95"><RefreshCw className="h-4 w-4" /></button>
              <button onClick={() => setShowDebug(v => !v)} className="rounded-full bg-white/10 p-2.5 shadow-lg active:scale-95"><Bug className="h-4 w-4" /></button>
              <button onClick={() => setScreen('settings')} className="rounded-full bg-white/10 p-2.5 shadow-lg active:scale-95"><Settings className="h-4 w-4" /></button>
            </div>
          </div>

          <div className="mb-4">
            <div className="min-w-0">
              <p className="text-sm font-bold uppercase tracking-[0.16em] text-sky-100">{titleParts.artist}</p>
              <h1 className="mt-1 whitespace-normal break-words text-2xl font-extrabold leading-tight text-white">{titleParts.song}</h1>
              {titleParts.section && <p className="mt-1 text-sm font-bold uppercase tracking-[0.16em] text-sky-100/90">{titleParts.section}</p>}
              <p className="mt-2 text-sm font-medium text-slate-300">Key {settings.key} {keyModeLabel(settings.keyMode)} · {settings.tempo} BPM</p>
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
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={playbackState === 'playing' ? pausePlayback : play} disabled={!selectedUrl || isBusy} className={`${playbackState === 'playing' ? 'bg-amber-300 shadow-amber-500/20' : 'bg-emerald-400 shadow-emerald-500/25'} rounded-3xl px-3 py-4 font-bold text-slate-950 shadow-lg disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none active:scale-95`}>
              {isBusy ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : playbackState === 'playing' ? <Pause className="mx-auto h-5 w-5" /> : <Play className="mx-auto h-5 w-5" />}
              <span className="mt-1 block text-xs">{isBusy ? 'Loading' : playbackState === 'playing' ? 'Pause' : 'Play'}</span>
            </button>
            <button onClick={stopPlayback} disabled={playbackState === 'stopped'} className="rounded-3xl bg-rose-400 px-3 py-4 font-bold text-slate-950 shadow-lg shadow-rose-500/25 disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none active:scale-95">
              <Square className="mx-auto h-5 w-5" />
              <span className="mt-1 block text-xs">Stop</span>
            </button>
          </div>
        </header>

        {error && <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">{error}</div>}
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
          <CompactSelect label="Melody" value={settings.melodyMode || 'none'} options={melodyOptions} onChange={setMelodyMode} />
          <CompactSelect label="Background" value={settings.backgroundTrack || 'none'} options={backgroundOptions} onChange={setBackgroundTrack} />
          <SpeedSelect value={settings.playbackSpeed} onChange={value => setSettings(s => ({ ...s, playbackSpeed: value }))} />
        </div>

        <div className="text-center text-xs font-semibold uppercase tracking-[0.18em] text-sky-100/70">
          {timeSignatureToString(settings.timeSignature)}
        </div>
        <PianoRollMini notes={notes} bars={settings.bars} timeDivision={settings.timeDivision} timeSignature={settings.timeSignature} lowestNote={noteRange.lowestNote} highestNote={noteRange.highestNote} cursorPosition={cursorPosition} showScaleDegrees={settings.showScaleDegrees} selectedKey={settings.key} />

        <div className="flex items-center justify-center pt-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="h-9 w-9 rounded-full border border-white/10 bg-white/10"
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
