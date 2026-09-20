import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Loader2, X } from 'lucide-react'

// The bundled Google-Docs HTML is authored for a desktop-width page. Render it
// at a fixed natural width and scale it down to fit the sheet so tables never
// cause horizontal scrolling on phones.
const DOC_WIDTH = 720

/**
 * Transcription sheet: shows the song's bundled Google-Docs HTML transcription
 * (Chords | Melody table per phrase row). Fetches the document lazily on open.
 *
 * url: song-level transcription asset from catalog.json (e.g. /catalog/…/doc.html)
 * sectionAnchor: optional element id to scroll to (e.g. 'chorus-section')
 */
function TranscriptionSheet({ open, onClose, url, title, sectionAnchor, isDark }) {
  const [html, setHtml] = useState(null)
  const [error, setError] = useState('')
  const [docHeight, setDocHeight] = useState(0)
  const [sheetWidth, setSheetWidth] = useState(0)
  const frameRef = useRef(null)
  const bodyRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    setHtml(null)
    setError('')
    setDocHeight(0)
    let cancelled = false
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then(t => { if (!cancelled) setHtml(t) })
      .catch(err => { if (!cancelled) setError(`Could not load transcription: ${err.message}`) })
    return () => {
      cancelled = true
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, url, onClose])

  useEffect(() => {
    if (!open || !bodyRef.current) return
    const ro = new ResizeObserver(() => setSheetWidth(bodyRef.current.clientWidth))
    ro.observe(bodyRef.current)
    setSheetWidth(bodyRef.current.clientWidth)
    return () => ro.disconnect()
  }, [open])

  const scale = Math.min(1, sheetWidth / DOC_WIDTH)

  const onFrameLoad = () => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    const h = Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0)
    setDocHeight(h)
    if (sectionAnchor) {
      const el = doc.getElementById(sectionAnchor)
      if (el && bodyRef.current) {
        bodyRef.current.scrollTop = Math.max(0, el.offsetTop * scale - 8)
      }
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative flex h-[92vh] w-full flex-col overflow-hidden border shadow-2xl sm:h-[85vh] sm:max-w-3xl sm:rounded-3xl ${isDark ? 'border-white/10 bg-slate-950/95 text-white' : 'border-slate-300 bg-white/95 text-slate-900'} rounded-t-3xl backdrop-blur-xl`}>
        <div className={`flex items-center justify-between border-b px-5 py-4 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <FileText className={`h-5 w-5 shrink-0 ${isDark ? 'text-sky-300' : 'text-sky-600'}`} />
            <h2 className="truncate text-lg font-extrabold tracking-tight">{title || 'Transcription'}</h2>
          </div>
          <button onClick={onClose} className={`rounded-full p-2.5 transition active:scale-95 ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-200 hover:bg-slate-300'}`} aria-label="Close transcription">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div ref={bodyRef} className="flex-1 overflow-y-auto overscroll-contain">
          {error && (
            <div className="m-4 rounded-2xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-600 dark:text-amber-100">{error}</div>
          )}
          {!html && !error && (
            <div className={`m-4 flex items-center justify-center gap-2 rounded-2xl border p-3 text-sm ${isDark ? 'border-sky-300/30 bg-sky-400/10 text-sky-100' : 'border-sky-300 bg-sky-50 text-sky-800'}`}>
              <Loader2 className="h-4 w-4 animate-spin" /> Loading transcription…
            </div>
          )}
          {html && (
            <div style={{ height: docHeight ? docHeight * scale : 'auto', overflow: 'hidden' }}>
              <iframe
                ref={frameRef}
                title="Transcription"
                srcDoc={html}
                onLoad={onFrameLoad}
                sandbox="allow-scripts allow-same-origin"
                style={{
                  width: DOC_WIDTH,
                  height: docHeight || 800,
                  border: 0,
                  transform: `scale(${scale})`,
                  transformOrigin: '0 0',
                  display: 'block',
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default TranscriptionSheet
