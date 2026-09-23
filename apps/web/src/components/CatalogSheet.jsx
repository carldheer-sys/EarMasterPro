import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Music, X, Lock, ChevronRight } from 'lucide-react'

/**
 * Catalog browser: artist → song → section.
 * Full-screen sheet on mobile, centered modal on desktop.
 */
function CatalogSheet({ open, onClose, catalog, selectedId, onSelect, isDark }) {
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    // Open with the current song's card at the top of the list (clamped at
    // the scroll end, so the last songs can't overscroll past the bottom).
    panelRef.current?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: 'start' })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  const sectionBadges = (s) => {
    const badges = []
    if (!s.capabilities.chords) badges.push('no chords')
    if (!s.capabilities.audio) badges.push('no audio')
    return badges
  }

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        className={`relative flex max-h-[85vh] w-full flex-col overflow-hidden border shadow-2xl sm:max-h-[80vh] sm:max-w-2xl sm:rounded-3xl ${isDark ? 'border-white/10 bg-slate-950/95 text-white' : 'border-slate-300 bg-white/95 text-slate-900'} rounded-t-3xl backdrop-blur-xl`}
      >
        <div className={`flex items-center justify-between border-b px-5 py-4 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
          <div>
            <h2 className="text-lg font-extrabold tracking-tight">Catalog</h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Pick a song section to practice</p>
          </div>
          <button onClick={onClose} className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`} aria-label="Close catalog">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {catalog.artists.map(artist => (
            <div key={artist.name} className="mb-6">
              <h3 className={`mb-2 px-1 text-xs font-bold uppercase tracking-[0.2em] ${isDark ? 'text-sky-300/80' : 'text-sky-700/80'}`}>{artist.name}</h3>
              {artist.songs.map(song => (
                <div key={song.folder} data-current={song.sections.some(s => s.id === selectedId) || undefined} className={`mb-3 overflow-hidden rounded-2xl border ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-200 bg-slate-50'}`}>
                  <div className={`px-4 py-2.5 text-sm font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>{song.title}</div>
                  <div className={`grid gap-1 px-2 pb-2 ${song.sections.length > 1 ? 'sm:grid-cols-2' : ''}`}>
                    {song.sections.map(section => {
                      const active = section.id === selectedId
                      const badges = sectionBadges(section)
                      return (
                        <button
                          key={section.id}
                          onClick={() => { onSelect(artist.name, song.title, section); onClose() }}
                          className={`group flex items-center justify-between gap-2 rounded-xl border px-3 py-3 text-left transition active:scale-[0.99] ${active
                            ? 'border-sky-400/60 bg-sky-400/15'
                            : isDark ? 'border-white/5 bg-white/[0.03] hover:bg-white/[0.08]' : 'border-slate-200 bg-white hover:bg-slate-100'}`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`truncate text-sm font-bold ${active ? 'text-sky-300' : ''}`}>{section.label}</span>
                              {badges.map(b => (
                                <span key={b} className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${isDark ? 'bg-amber-400/15 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>
                                  <Lock className="h-2.5 w-2.5" />{b}
                                </span>
                              ))}
                            </div>
                            <div className={`mt-0.5 text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              {section.key} {section.keyMode} · {section.tempo} BPM · {section.timeSignature} · {section.bars} bars
                            </div>
                          </div>
                          <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-sky-300' : isDark ? 'text-slate-500 group-hover:text-slate-300' : 'text-slate-400'}`} />
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {catalog.artists.length === 0 && (
            <div className={`flex flex-col items-center gap-2 py-12 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <Music className="h-8 w-8" />
              <p className="text-sm">No sections in the catalog.</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default CatalogSheet
