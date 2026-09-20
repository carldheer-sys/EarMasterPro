import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SlidersHorizontal, X, Loader2 } from 'lucide-react'
import { INSTRUMENT_OPTIONS } from '@common/lib/audioEngine'

// Volume sliders are 0-100% mapped to dB (100% = 0 dB, each % = 0.48 dB)
export function dbFromPercent(value) {
  return Math.round((Number(value) - 100) * 0.48)
}

export function percentFromDb(db) {
  return Math.max(0, Math.min(100, Math.round(100 + Number(db || 0) / 0.48)))
}

const INSTRUMENT_LABELS = {
  'synth': 'Synth',
  'pad': 'Pad',
  'piano': 'Piano',
  'organ': 'Organ',
  'guitar-acoustic': 'Acoustic Guitar',
  'harp': 'Harp',
  'cello': 'Cello',
  'violin': 'Violin',
  'flute': 'Flute',
  'clarinet': 'Clarinet',
  'trumpet': 'Trumpet',
  'bass-electric': 'Electric Bass',
}

const INSTRUMENT_SELECT_OPTIONS = INSTRUMENT_OPTIONS.map(name => ({
  value: name,
  label: INSTRUMENT_LABELS[name] || name,
}))

function SettingCard({ title, children, isDark }) {
  return (
    <section className={`rounded-3xl border p-4 ${isDark ? 'border-white/10 bg-white/[0.06]' : 'border-slate-300 bg-white/80'}`}>
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

function FastSelect({ label, value, options, onChange, isDark }) {
  const [open, setOpen] = useState(false)
  const [menuRect, setMenuRect] = useState(null)
  const rootRef = useRef(null)
  const selected = options.find(opt => opt.value === value)
  const selectedLabel = selected?.label || value

  const updateMenuRect = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuRect({
      left: Math.max(8, rect.left),
      top: rect.bottom + 4,
      width: Math.max(160, rect.width),
      maxHeight: Math.max(160, window.innerHeight - rect.bottom - 16),
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
    <div ref={rootRef} className="relative">
      <div className={`mb-2 text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{label}</div>
      <button type="button" onClick={() => setOpen(v => !v)}
        className={`flex h-12 w-full items-center justify-center rounded-2xl border px-3 text-center text-base font-bold transition active:scale-[0.98] ${isDark ? 'border-white/10 bg-slate-950/80 text-white' : 'border-slate-300 bg-white text-slate-800'}`}>
        <span className="block w-full truncate">{selectedLabel}</span>
      </button>
      {open && menuRect && createPortal(
        <div className={`fixed z-[10000] overflow-y-auto rounded-2xl border p-1 shadow-2xl shadow-black/40 backdrop-blur-xl ${isDark ? 'border-white/10 bg-slate-950/95' : 'border-slate-300 bg-white/95'}`}
          style={{ left: menuRect.left, top: menuRect.top, width: menuRect.width, maxHeight: menuRect.maxHeight }}>
          {options.map(opt => (
            <button key={opt.value} type="button"
              onPointerDown={e => e.stopPropagation()}
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`flex min-h-10 w-full items-center justify-center rounded-xl px-2 text-center text-sm font-semibold transition-colors hover:bg-white/10 active:bg-sky-400/20 ${isDark ? 'text-white' : 'text-slate-800 hover:bg-slate-100'} ${opt.value === value ? 'text-sky-400' : ''}`}>
              {opt.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

/**
 * Settings sheet: instrument + volume for melody, chords, and drone.
 * settings: { melodyInstrument, chordsInstrument, melodyVolume, chordsVolume, droneVolume } (dB)
 * onChange(patch) merges a partial update.
 * loadingInstruments: Set of instrument names currently fetching samples.
 */
function SettingsSheet({ open, onClose, settings, onChange, loadingInstruments, isDark }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  const loading = loadingInstruments && loadingInstruments.size > 0

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative flex max-h-[85vh] w-full flex-col overflow-hidden border shadow-2xl sm:max-h-[80vh] sm:max-w-md sm:rounded-3xl ${isDark ? 'border-white/10 bg-slate-950/95 text-white' : 'border-slate-300 bg-white/95 text-slate-900'} rounded-t-3xl backdrop-blur-xl`}>
        <div className={`flex items-center justify-between border-b px-5 py-4 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className={`h-5 w-5 ${isDark ? 'text-sky-300' : 'text-sky-600'}`} />
            <h2 className="text-lg font-extrabold tracking-tight">Settings</h2>
          </div>
          <button onClick={onClose} className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`} aria-label="Close settings">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
          <SettingCard title="Melody" isDark={isDark}>
            <FastSelect
              label="Sound"
              value={settings.melodyInstrument}
              options={INSTRUMENT_SELECT_OPTIONS}
              onChange={v => onChange({ melodyInstrument: v })}
              isDark={isDark}
            />
            <RangeSetting
              label="Volume"
              value={percentFromDb(settings.melodyVolume)}
              suffix="%"
              onChange={v => onChange({ melodyVolume: dbFromPercent(v) })}
              isDark={isDark}
            />
          </SettingCard>

          <SettingCard title="Chords" isDark={isDark}>
            <FastSelect
              label="Sound"
              value={settings.chordsInstrument}
              options={INSTRUMENT_SELECT_OPTIONS}
              onChange={v => onChange({ chordsInstrument: v })}
              isDark={isDark}
            />
            <RangeSetting
              label="Volume"
              value={percentFromDb(settings.chordsVolume)}
              suffix="%"
              onChange={v => onChange({ chordsVolume: dbFromPercent(v) })}
              isDark={isDark}
            />
          </SettingCard>

          <SettingCard title="Drone" isDark={isDark}>
            <RangeSetting
              label="Volume"
              value={percentFromDb(settings.droneVolume)}
              suffix="%"
              onChange={v => onChange({ droneVolume: dbFromPercent(v) })}
              isDark={isDark}
            />
          </SettingCard>

          {loading && (
            <div className={`flex items-center justify-center gap-2 rounded-2xl border p-3 text-sm ${isDark ? 'border-sky-300/30 bg-sky-400/10 text-sky-100' : 'border-sky-300 bg-sky-50 text-sky-800'}`}>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading instrument samples…
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default SettingsSheet
