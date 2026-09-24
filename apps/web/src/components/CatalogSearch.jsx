import { useMemo, useState } from 'react'
import { ArrowLeft, ChevronRight, Lock, Search, X } from 'lucide-react'

/**
 * Search + faceted-filter view for the catalog sheet.
 *
 * - Typing in the search bar replaces everything with flat section results
 *   (substring match on artist name or song title). Clearing restores the
 *   filter flow (its state is preserved).
 * - Filter flow: pick a property (Artist / Key / Tonality / Time Signature)
 *   → pick one of its distinct values → compact list of matching sections.
 */
function CatalogSearch({ catalog, selectedId, onSelect, isDark }) {
  const [query, setQuery] = useState('')
  const [prop, setProp] = useState(null)      // null | 'artist' | 'key' | 'tonality' | 'meter'
  const [value, setValue] = useState(null)

  // Flatten to a section list once
  const sections = useMemo(() => {
    const out = []
    for (const artist of catalog.artists || [])
      for (const song of artist.songs)
        for (const section of song.sections)
          out.push({ artist: artist.name, song: song.title, section })
    return out
  }, [catalog])

  const PROPS = useMemo(() => ([
    { id: 'artist', label: 'Artist', pick: s => s.artist },
    { id: 'key', label: 'Key', pick: s => `${s.section.key} ${s.section.keyMode}` },
    { id: 'tonality', label: 'Tonality', pick: s => s.section.keyMode },
    { id: 'meter', label: 'Time Signature', pick: s => s.section.timeSignature },
  ]), [])

  // Distinct values + counts for the active property
  const options = useMemo(() => {
    if (!prop) return []
    const pick = PROPS.find(p => p.id === prop).pick
    const counts = new Map()
    for (const s of sections) counts.set(pick(s), (counts.get(pick(s)) || 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [prop, sections, PROPS])

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (q) return sections.filter(s => `${s.artist} ${s.song}`.toLowerCase().includes(q))
    if (prop && value != null) {
      const pick = PROPS.find(p => p.id === prop).pick
      return sections.filter(s => pick(s) === value)
    }
    return null // filter-property browsing, not a result list
  }, [q, prop, value, sections, PROPS])

  const text = isDark ? 'text-white' : 'text-slate-800'
  const sub = isDark ? 'text-slate-400' : 'text-slate-500'
  const rowBase = `flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition active:scale-[0.99]`
  const rowTheme = isDark ? 'border-white/5 bg-white/[0.03] hover:bg-white/[0.08]' : 'border-slate-200 bg-white hover:bg-slate-100'
  const chip = `flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`

  const SectionRow = ({ artist, song, section: s }) => {
    const active = s.id === selectedId
    return (
      <button onClick={() => onSelect(artist, song, s)}
        className={`${rowBase} ${active ? 'border-sky-400/60 bg-sky-400/15' : rowTheme}`}>
        <div className="min-w-0">
          <div className={`truncate text-[13px] font-bold ${active ? 'text-sky-300' : text}`}>
            {song} <span className={sub}>·</span> <span className="font-semibold">{s.label}</span>
          </div>
          <div className={`mt-0.5 truncate text-[10px] ${sub}`}>
            {artist} · {s.key} {s.keyMode} · {s.tempo} BPM · {s.timeSignature}
          </div>
        </div>
        <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-sky-300' : isDark ? 'text-slate-500' : 'text-slate-400'}`} />
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search bar */}
      <div className="px-4 pt-3 pb-2">
        <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${isDark ? 'border-white/10 bg-white/[0.06]' : 'border-slate-300 bg-white'}`}>
          <Search className={`h-4 w-4 shrink-0 ${sub}`} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search artist or song…"
            className={`min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:${sub} ${text}`}
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search"
              className={`shrink-0 rounded-full p-1 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {results ? (
          results.length ? (
            <div className="flex flex-col gap-1">
              {value != null && !q && (
                <button onClick={() => setValue(null)} className={`${chip} mb-1 self-start`}>
                  <ArrowLeft className="h-3 w-3" />{PROPS.find(p => p.id === prop).label} · {value}
                </button>
              )}
              {results.map(s => <SectionRow key={s.section.id} {...s} />)}
            </div>
          ) : (
            <p className={`py-10 text-center text-sm ${sub}`}>No songs match “{query}”.</p>
          )
        ) : prop ? (
          <div className="flex flex-col gap-1">
            <button onClick={() => setProp(null)} className={`${chip} mb-1 self-start`}>
              <ArrowLeft className="h-3 w-3" />{PROPS.find(p => p.id === prop).label}
            </button>
            {options.map(([opt, count]) => (
              <button key={opt} onClick={() => setValue(opt)} className={`${rowBase} ${rowTheme}`}>
                <span className={`truncate text-[13px] font-semibold ${text}`}>{opt}</span>
                <span className={`shrink-0 text-[10px] ${sub}`}>{count}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className={`px-1 pb-1 text-[11px] font-bold uppercase tracking-[0.15em] ${sub}`}>Filter by</p>
            {PROPS.map(p => (
              <button key={p.id} onClick={() => { setProp(p.id); setValue(null) }} className={`${rowBase} ${rowTheme}`}>
                <span className={`text-[13px] font-semibold ${text}`}>{p.label}</span>
                <ChevronRight className={`h-4 w-4 ${sub}`} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default CatalogSearch
