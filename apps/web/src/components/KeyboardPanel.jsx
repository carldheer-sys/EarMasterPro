import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Waves, X } from 'lucide-react'

/**
 * Compact transcription keyboard — bottom-docked, non-modal.
 * Notes fire via pointer (mouse/touch) and Web MIDI (desktop Chrome).
 * 2-octave window with octave-shift buttons; tonic key is tinted.
 */
const WHITE = [0, 2, 4, 5, 7, 9, 11]
// black semitone -> boundary index it centers on (white-key units)
const BLACK_AT = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 }
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const midiName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1)

function KeyboardPanel({ open, onClose, isDark, tonic, instrument, droneOn, onToggleDrone, onNoteOn, onNoteOff }) {
  const [octave, setOctave] = useState(4)          // base octave (C4 default)
  const [pressed, setPressed] = useState(() => new Set())
  const [midiOk, setMidiOk] = useState(false)

  const noteOn = useCallback((midi, velocity = 96) => {
    setPressed(prev => prev.has(midi) ? prev : new Set(prev).add(midi))
    onNoteOn?.(midiName(midi), velocity)
  }, [onNoteOn])

  const noteOff = useCallback((midi) => {
    setPressed(prev => { if (!prev.has(midi)) return prev; const n = new Set(prev); n.delete(midi); return n })
    onNoteOff?.(midiName(midi))
  }, [onNoteOff])

  // ── Web MIDI (desktop Chrome/Edge; absent on Safari → silently skipped) ──
  useEffect(() => {
    if (!open || typeof navigator === 'undefined' || !navigator.requestMIDIAccess) return
    let access = null
    let mounted = true
    const onMidi = (e) => {
      const [st, note, vel] = e.data
      const cmd = st & 0xF0
      if (cmd === 0x90 && vel > 0) noteOn(note, vel)
      else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) noteOff(note)
    }
    navigator.requestMIDIAccess().then(acc => {
      if (!mounted) return
      access = acc
      setMidiOk(acc.inputs.size > 0)
      const attach = () => {
        for (const input of acc.inputs.values()) input.onmidimessage = onMidi
        setMidiOk(acc.inputs.size > 0)
      }
      attach()
      acc.onstatechange = attach
    }).catch(() => {})
    return () => {
      mounted = false
      if (access) { access.onstatechange = null; for (const i of access.inputs.values()) i.onmidimessage = null }
    }
  }, [open, noteOn, noteOff])

  // Release everything when the panel closes
  useEffect(() => {
    if (!open && pressed.size) setPressed(new Set())
  }, [open, pressed.size])

  if (!open) return null

  const tonicPc = NAMES.indexOf(tonic?.replace(/b/g, '#') ?? 'C')
  const whites = []
  const blacks = []
  for (let oct = octave; oct <= octave + 1; oct++) {
    for (const s of WHITE) {
      const midi = (oct + 1) * 12 + s
      whites.push({ midi, label: s === 0 ? midiName(midi) : '', tonic: s === tonicPc })
    }
    for (const [s, pos] of Object.entries(BLACK_AT)) {
      const midi = (oct + 1) * 12 + Number(s)
      blacks.push({ midi, pos: pos + (oct - octave) * 7, tonic: Number(s) === tonicPc })
    }
  }

  // black key centered on its white boundary: center at pos/14 of the row
  const blackLeft = pos => `calc(${(pos / 14) * 100}% - 2.9%)`

  const keyHandlers = (midi) => ({
    onPointerDown: (e) => { e.preventDefault(); noteOn(midi) },
    onPointerUp: () => noteOff(midi),
    onPointerCancel: () => noteOff(midi),
    onPointerLeave: () => noteOff(midi),
    onContextMenu: (e) => e.preventDefault(),
  })

  const wBase = isDark ? 'bg-slate-50 text-slate-700' : 'bg-white text-slate-700'
  const wEdge = isDark ? 'border-slate-700' : 'border-slate-300'

  return (
    <div className="fixed inset-x-0 bottom-0 z-40" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className={`mx-auto max-w-3xl border-x border-t shadow-2xl backdrop-blur-xl ${isDark ? 'border-white/10 bg-slate-950/95' : 'border-slate-300 bg-white/95'} rounded-t-2xl`}>
        {/* header row: drone | octave | close */}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleDrone}
              title={`Drone on tonic ${tonic}`}
              className={`flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-bold transition active:scale-95 ${droneOn
                ? 'bg-emerald-400 text-slate-950 shadow'
                : isDark ? 'bg-white/10 text-slate-300 hover:bg-white/15' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'}`}>
              <Waves className="h-4 w-4" />
              <span>Drone {tonic}</span>
            </button>
            <span className={`hidden text-[10px] font-medium sm:block ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{instrument}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setOctave(o => Math.max(1, o - 1))} disabled={octave <= 1} aria-label="Octave down"
              className={`rounded-lg p-1.5 transition active:scale-95 disabled:opacity-30 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className={`w-12 text-center text-[11px] font-bold tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>C{octave}–C{octave + 2}</span>
            <button onClick={() => setOctave(o => Math.min(6, o + 1))} disabled={octave >= 6} aria-label="Octave up"
              className={`rounded-lg p-1.5 transition active:scale-95 disabled:opacity-30 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <button onClick={onClose} aria-label="Close keyboard"
            className={`rounded-full p-2 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* keys */}
        <div className="relative mx-2 mb-2 h-24 select-none sm:h-28" style={{ touchAction: 'none' }}>
          <div className="flex h-full gap-px">
            {whites.map(k => (
              <div key={k.midi}
                {...keyHandlers(k.midi)}
                className={`relative flex-1 cursor-pointer rounded-b-md border ${wEdge} ${wBase} transition-colors ${pressed.has(k.midi) ? '!bg-sky-300' : ''} ${k.tonic ? 'shadow-[inset_0_-4px_0_0_rgba(16,185,129,0.7)]' : ''}`}>
                {k.label && <span className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 text-[9px] font-bold opacity-60">{k.label}</span>}
              </div>
            ))}
          </div>
          {blacks.map(k => (
            <div key={k.midi}
              {...keyHandlers(k.midi)}
              className={`absolute top-0 h-[58%] cursor-pointer rounded-b-md border ${isDark ? 'border-slate-900 bg-slate-800' : 'border-slate-800 bg-slate-900'} transition-colors ${pressed.has(k.midi) ? '!bg-sky-500' : ''} ${k.tonic ? 'shadow-[inset_0_-3px_0_0_rgba(16,185,129,0.9)]' : ''}`}
              style={{ left: blackLeft(k.pos), width: '5.8%' }}
            />
          ))}
        </div>
        {midiOk && (
          <p className={`pb-1.5 text-center text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>MIDI keyboard connected</p>
        )}
      </div>
    </div>
  )
}

export default KeyboardPanel
