import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Music, Search, X, Lock, ChevronRight } from 'lucide-react'
import CatalogSearch from './CatalogSearch'

/**
 * Catalog browser: artist → song → section.
 * Full-screen sheet on mobile, centered modal on desktop.
 * A Search icon swaps in the search/filter view (CatalogSearch).
 */
function CatalogSheet({ open, onClose, catalog, selectedId, onSelect, isDark }) {
  const panelRef = useRef(null)
  const [view, setView] = useState('browse') // 'browse' | 'search'

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

  // Open (or return to browse) with the current song's card at the top of the
  // list, clamped at the scroll end so the last songs can't overscroll.
  useEffect(() => {
    if (!open || view !== 'browse') return
    panelRef.current?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: 'start' })
  }, [open, view])

  useEffect(() => { if (!open) setView('browse') }, [open])

  if (!open) return null

  const sectionBadges = (s) => {
    const badges = []
    if (!s.capabilities.chords) badges.push('no chords')
    if (!s.capabilities.audio) badges.push('no audio')
    return badges
  }

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-3" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        className={`relative flex max-h-[82vh] w-full flex-col overflow-hidden rounded-3xl border shadow-2xl sm:max-h-[80vh] sm:max-w-2xl ${isDark ? 'border-white/10 bg-slate-950/95 text-white' : 'border-slate-300 bg-white/95 text-slate-900'} backdrop-blur-xl`}
      >
        <div className={`flex items-center justify-between border-b px-5 py-3 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
          <div className="flex items-center gap-2">
            {view === 'search' && (
              <button onClick={() => setView('browse')} aria-label="Back to catalog"
                className={`rounded-full p-2 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <div>
              <h2 className="text-lg font-extrabold tracking-tight">{view === 'search' ? 'Search catalog' : 'Catalog'}</h2>
              {view === 'browse' && (
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Pick a song section to practice</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {view === 'browse' && (
              <button onClick={() => setView('search')} title="Search & filter" aria-label="Search catalog"
                className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
                <Search className="h-5 w-5" />
              </button>
            )}
            <button onClick={onClose} className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`} aria-label="Close catalog">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {view === 'search' ? (
          <CatalogSearch
            catalog={catalog}
            selectedId={selectedId}
            isDark={isDark}
            onSelect={(artist, title, section) => { onSelect(artist, title, section); onClose() }}
          />
        ) : (
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
            {catalog.artists.map(artist => (
              <div key={artist.name} className="mb-4">
                <h3 className={`sticky top-0 z-10 -mx-4 mb-1.5 px-5 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] backdrop-blur-xl ${isDark ? 'bg-slate-950/90 text-sky-300/80' : 'bg-white/90 text-sky-700/80'}`}>{artist.name}</h3>
                {artist.songs.map(song => (
                  <div key={song.folder} data-current={song.sections.some(s => s.id === selectedId) || undefined} className={`mb-2 overflow-hidden rounded-xl border ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-200 bg-slate-50'}`}>
                    <div className={`px-3 py-1.5 text-[13px] font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>{song.title}</div>
                    <div className={`grid grid-cols-2 gap-1 px-2 pb-2 ${song.sections.length > 2 ? 'sm:grid-cols-3' : ''}`}>
                      {song.sections.map(section => {
                        const active = section.id === selectedId
                        const badges = sectionBadges(section)
                        return (
                          <button
                            key={section.id}
                            onClick={() => { onSelect(artist.name, song.title, section); onClose() }}
                            className={`group flex items-center justify-between gap-1 rounded-lg border px-2 py-2 text-left transition active:scale-[0.99] ${active
                              ? 'border-sky-400/60 bg-sky-400/15'
                              : isDark ? 'border-white/5 bg-white/[0.03] hover:bg-white/[0.08]' : 'border-slate-200 bg-white hover:bg-slate-100'}`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className={`truncate text-[13px] font-bold ${active ? 'text-sky-300' : ''}`}>{section.label}</span>
                                {badges.map(b => (
                                  <span key={b} className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${isDark ? 'bg-amber-400/15 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>
                                    <Lock className="h-2.5 w-2.5" />{b}
                                  </span>
                                ))}
                              </div>
                              <div className={`mt-0.5 whitespace-nowrap text-[10px] leading-tight tracking-tight ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                {section.key} {section.keyMode} · {section.timeSignature} · {section.bars} bars
                              </div>
                            </div>
                            <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-sky-300' : isDark ? 'text-slate-500 group-hover:text-slate-300' : 'text-slate-400'}`} />
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
        )}
      </div>
    </div>,
    document.body
  )
}

export default CatalogSheet
