import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { useScaleDegreeAnalysis } from '@/hooks/useScaleDegreeAnalysis'
import { beatsPerBarFromTimeSignature, beatsPerDivisionFromTimeDivision, DEFAULT_TIME_SIGNATURE, normalizeKeyName, keyAtBeat } from '@common/lib/midiUtils'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BAR_LABEL_HEIGHT = 22
const BEAT_WIDTH_BASE = 40

// ── Device-pixel alignment ─────────────────────────────────────
// The piano roll blurs whenever anything lands on a fractional DEVICE
// pixel: a fractional scroll offset resamples the whole scroll layer
// (DOM + canvas), a fractional canvas transform resamples the bitmap,
// and fill/stroke coordinates between device pixels produce soft edges.
// CSS-pixel rounding is not enough — at fractional DPR (125%/150% OS
// scaling, some Androids) an integer CSS px is still a fractional device
// px, so everything below quantizes to the device-pixel grid.
const dprNow = () => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
// Nearest device-pixel boundary — for fills, element positions, widths.
const snapDev = (v, dpr = dprNow()) => Math.round(v * dpr) / dpr
// Nearest device-pixel CENTER — for hairline strokes: a 1-device-px line
// centered on a boundary straddles two pixels at 50% alpha each.
const hairDev = (v, dpr) => (Math.round(v * dpr - 0.5) + 0.5) / dpr

// Diatonic pitch-class sets (semitones from tonic)
const DIATONIC = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
}

const noteToMidi = (note) => {
  if (!note || typeof note !== 'string') return -Infinity
  const match = note.match(/^([A-Ga-g])(#{0,2}|b{0,2})(-?\d+)$/)
  if (!match) return -Infinity
  let [, letter, accidental, octaveStr] = match
  letter = letter.toUpperCase()
  let pc = NOTE_NAMES.indexOf(letter)
  if (pc < 0) return -Infinity
  for (const ch of accidental) pc += ch === '#' ? 1 : -1
  return (parseInt(octaveStr, 10) + 1) * 12 + pc
}

const midiToNoteName = (midi) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
const isBlackKey = (midi) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12)

function isNoteDiatonic(midi, tonicPc, mode) {
  const scale = DIATONIC[mode] || DIATONIC.Major
  return scale.includes(((midi - tonicPc) % 12 + 12) % 12)
}

// ═══════════════════════════════════════════════════════════════
// CANVAS RENDERING
// ═══════════════════════════════════════════════════════════════

function renderGrid(ctx, { width, height, beatWidth, barStarts, totalBeats, lowestNote, highestNote, dpr, beatsPerDivision, isDark }) {
  const totalNotes = highestNote - lowestNote + 1
  const cellH = ctx._cellH
  const q = v => snapDev(v, dpr)
  const hair = v => hairDev(v, dpr)
  ctx.clearRect(0, 0, width, height)

  const blackKeyBg = isDark ? 'rgba(15, 23, 42, 0.4)' : 'rgba(180, 190, 210, 0.35)'
  const whiteKeyBg = isDark ? 'rgba(30, 41, 59, 0.3)' : 'rgba(220, 230, 245, 0.25)'
  const rowLine = isDark ? 'rgba(100, 116, 139, 0.2)' : 'rgba(100, 116, 139, 0.25)'
  const cMarker = 'rgba(59, 130, 246, 0.3)'
  const barLine = isDark ? 'rgba(255, 255, 255, 0.65)' : 'rgba(30, 41, 59, 0.55)'
  const divLine = isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(30, 41, 59, 0.15)'

  for (let i = 0; i < totalNotes; i++) {
    const midiNum = highestNote - i
    const y = i * cellH
    ctx.fillStyle = isBlackKey(midiNum) ? blackKeyBg : whiteKeyBg
    ctx.fillRect(0, y, width, cellH)
    const yh = hair(y + cellH)
    ctx.strokeStyle = rowLine
    ctx.lineWidth = 1 / dpr
    ctx.beginPath()
    ctx.moveTo(0, yh)
    ctx.lineTo(width, yh)
    ctx.stroke()
    if (midiNum % 12 === 0) {
      ctx.strokeStyle = cMarker
      ctx.lineWidth = 2 / dpr
      ctx.beginPath()
      ctx.moveTo(0, q(y))
      ctx.lineTo(0, q(y + cellH))
      ctx.stroke()
    }
  }

  ctx.strokeStyle = barLine
  ctx.lineWidth = 2 / dpr
  ctx.beginPath()
  for (const bar of barStarts) {
    const x = q(bar.start * beatWidth)
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
  }
  const endX = q(totalBeats * beatWidth)
  ctx.moveTo(endX, 0)
  ctx.lineTo(endX, height)
  ctx.stroke()

  ctx.strokeStyle = divLine
  ctx.lineWidth = 1 / dpr
  ctx.beginPath()
  const totalDivisions = Math.floor(totalBeats / beatsPerDivision)
  for (let divIndex = 0; divIndex <= totalDivisions; divIndex++) {
    const beat = divIndex * beatsPerDivision
    if (beat > totalBeats + 0.0001) continue
    if (barStarts.some(b => Math.abs(b.start - beat) < 0.0001)) continue
    const x = hair(beat * beatWidth)
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
  }
  ctx.stroke()
}

function renderNotes(ctx, { notes, beatWidth, cellH, lowestNote, highestNote, viewportStartBeat, viewportEndBeat, dpr, showAnswers, notation, isDark }) {
  const buffer = 2
  const visible = notes.filter(n => n.start + n.duration >= viewportStartBeat - buffer && n.start <= viewportEndBeat + buffer)
  const cornerRadius = Math.min(3, cellH / 4)
  const q = v => snapDev(v, dpr)
  const inset = q(1.5)          // dev-px-aligned ~1.5 CSS-px note inset
  const half = 0.5 / dpr        // stroke centers on dev-px centers → crisp rim

  for (const note of visible) {
    const midi = noteToMidi(note.note)
    if (midi < lowestNote || midi > highestNote) continue
    const y = (highestNote - midi) * cellH
    // Snap both edges to the device grid — a fractional edge ramps over ~1
    // extra device px and reads as blur on every note.
    const x0 = q(note.start * beatWidth)
    const x1 = q(note.start * beatWidth + Math.max(4, note.duration * beatWidth))
    const y0 = q(y + inset)
    const y1 = q(y + inset + cellH - 3)
    const w = x1 - x0

    const nonDiatonic = note.isNonDiatonic === true
    const rr = (l, t, rgt, b) => {
      ctx.beginPath()
      ctx.moveTo(l + cornerRadius, t)
      ctx.lineTo(rgt - cornerRadius, t)
      ctx.quadraticCurveTo(rgt, t, rgt, t + cornerRadius)
      ctx.lineTo(rgt, b - cornerRadius)
      ctx.quadraticCurveTo(rgt, b, rgt - cornerRadius, b)
      ctx.lineTo(l + cornerRadius, b)
      ctx.quadraticCurveTo(l, b, l, b - cornerRadius)
      ctx.lineTo(l, t + cornerRadius)
      ctx.quadraticCurveTo(l, t, l + cornerRadius, t)
      ctx.closePath()
    }

    if (nonDiatonic) {
      // Subtle red for non-diatonic notes
      ctx.fillStyle = isDark ? 'rgba(248, 113, 113, 0.85)' : 'rgba(220, 38, 38, 0.8)'
      ctx.strokeStyle = isDark ? 'rgba(248, 113, 113, 0.5)' : 'rgba(220, 38, 38, 0.5)'
    } else {
      ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.9)' : 'rgba(30, 64, 175, 0.85)'
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(30, 64, 175, 0.4)'
    }
    rr(x0, y0, x1, y1)
    ctx.fill()
    // Stroke path inset by half a device px so the 1-dev-px rim sits inside
    // the fill instead of straddling its edge.
    rr(x0 + half, y0 + half, x1 - half, y1 - half)
    ctx.lineWidth = 1 / dpr
    ctx.stroke()

    // Analysis label
    if (showAnswers) {
      let label = null
      let labelNonDiatonic = false
      if (note.degree_info?.scale_degree) {
        // theory: scale degree ('b7'); names: pitch class without octave ('F')
        label = notation === 'names' ? note.note.replace(/-?\d+$/, '') : note.degree_info.scale_degree
        labelNonDiatonic = note.degree_info.is_diatonic === false
      } else if (note.chord_info && note.is_top_note) {
        // theory: Roman numeral ('bVII11'); names: spelled chord ('Bb11')
        label = notation === 'names'
          ? (note.chord_info.chord_label || note.chord_info.roman_numeral)
          : note.chord_info.roman_numeral
        labelNonDiatonic = !note.chord_info.is_diatonic
      }
      if (label) {
        ctx.font = `bold ${note.is_top_note !== undefined ? 12 : 11}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = labelNonDiatonic ? 'rgb(239, 68, 68)' : (isDark ? 'rgb(255, 255, 255)' : 'rgb(30, 41, 59)')
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
        ctx.shadowBlur = 3
        ctx.shadowOffsetY = 1
        ctx.fillText(label, q(x0 + w / 2), q(y - 6))
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetY = 0
      }
    }
  }
}

function renderRegionOverlay(ctx, { width, height, regionStartPx, regionEndPx, dpr }) {
  const q = v => snapDev(v, dpr)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.38)'
  if (regionStartPx > 0) ctx.fillRect(0, 0, q(regionStartPx), height)
  if (regionEndPx < width) ctx.fillRect(q(regionEndPx), 0, width - q(regionEndPx), height)
}

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════

/**
 * Read-only piano roll with region selection.
 *
 * mode 'melody'  → scale-degree labels (degree_info from useScaleDegreeAnalysis)
 * mode 'harmony' → Roman numeral labels from session `annotations`
 * notation 'names' swaps those for pitch names / spelled chord labels.
 * Non-diatonic notes are tinted red in both modes.
 */
function PianoRoll({
  notes = [],
  annotations = [],
  mode = 'melody',
  tonic = 'C',
  keyMode = 'Major',
  bars = 4,
  barStarts = null,     // [{start, numerator, denominator}] from meterEvents
  totalBeats: totalBeatsProp = null, // section length in quarter-beats
  keyEvents = null,     // [{beat, key, keyMode}] for key changes
  timeDivision = '1/8',
  timeSignature = DEFAULT_TIME_SIGNATURE,
  lowestNote = 36,
  highestNote = 84,
  regionStart = 0,
  regionEnd = 1,
  onRegionChange,
  onZoom,               // (deltaY) — ctrl/cmd + wheel
  cursorRef,          // ref holding playhead fraction 0..1 of the whole section
  isPlaying = false,
  playbackState = 'stopped', // 'playing' | 'paused' | 'stopped'
  zoom = 1,
  isDark = true,
  showAnswers = true,
  notation = 'theory',  // 'theory' = degrees/roman numerals, 'names' = notes/chords
  onNoteClick,
  onSeek,
}) {
  const scrollRef = useRef(null)
  const canvasRef = useRef(null)
  const gridRef = useRef(null)
  const playheadRef = useRef(null)
  // Raw scroll position, kept current in the scroll listener — the zoom
  // re-anchor can't read el.scrollLeft lazily because the browser clamps it
  // the moment the grid shrinks, before the beatWidth effect runs.
  const scrollLeftPxRef = useRef(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(1000)
  // devicePixelRatio as state: browser zoom / moving the window to another
  // display changes it, and every snap/quantization must track it.
  const [dprRaw, setDprRaw] = useState(() => dprNow())
  // Canvas landing correction: the viewport-anchored canvas composites at a
  // constant page position; if that position isn't on the device-pixel grid
  // (fractional DPR, fractional page padding) the GPU resamples the bitmap.
  // Measured lazily in the RAF tick — never a forced layout per frame.
  const landAdjRef = useRef(0)
  const landAdjStaleRef = useRef(true)
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dprRaw}dppx)`)
    const onChange = () => { landAdjStaleRef.current = true; setDprRaw(dprNow()) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [dprRaw])

  const beatsPerBar = beatsPerBarFromTimeSignature(timeSignature)
  const beatsPerDivision = beatsPerDivisionFromTimeDivision(timeDivision, timeSignature)
  const beatWidth = BEAT_WIDTH_BASE * zoom
  const totalBeats = Math.max(1, totalBeatsProp ?? bars * beatsPerBar)
  const gridWidth = totalBeats * beatWidth

  // Bar layout: meter-event map when available, uniform bars otherwise
  const effectiveBarStarts = useMemo(() => {
    if (barStarts && barStarts.length) return barStarts
    return Array.from({ length: bars }, (_, i) => ({
      start: i * beatsPerBar,
      numerator: timeSignature.numerator,
      denominator: timeSignature.denominator,
    }))
  }, [barStarts, bars, beatsPerBar, timeSignature])

  // Responsive row height: smaller on narrow screens
  const cellH = viewportWidth < 560 ? 14 : 19
  const gridHeight = (highestNote - lowestNote + 1) * cellH

  // Per-beat key resolution (initial key when no key changes)
  const activeKeyAt = useCallback((beat) => {
    if (keyEvents && keyEvents.length > 1) return keyAtBeat(keyEvents, beat, tonic, keyMode)
    return { key: tonic, keyMode }
  }, [keyEvents, tonic, keyMode])

  // ── Analysis data ────────────────────────────────────────────
  const notesWithDegrees = useScaleDegreeAnalysis(notes, tonic, keyMode, keyEvents)

  const displayNotes = useMemo(() => {
    const base = mode === 'melody' ? notesWithDegrees : notes
    // Attach non-diatonic flag + (harmony) chord annotations + top-note marks
    let annoGroups = null
    if (mode === 'harmony') {
      annoGroups = new Map() // annotation index -> top note id
      const byAnno = new Map()
      notes.forEach(n => {
        const idx = annotations.findIndex(a => n.start >= a.start - 1e-3 && n.start < a.start + a.duration - 1e-3)
        if (idx >= 0) {
          const midi = noteToMidi(n.note)
          const cur = byAnno.get(idx)
          if (!cur || midi > cur.midi) byAnno.set(idx, { id: n.id, midi })
        }
      })
      byAnno.forEach((v, k) => annoGroups.set(v.id, k))
    }
    return base.map(note => {
      const midi = noteToMidi(note.note)
      const k = activeKeyAt(note.start)
      const kpc = NOTE_NAMES.indexOf(normalizeKeyName(k.key))
      const out = { ...note, isNonDiatonic: kpc >= 0 ? !isNoteDiatonic(midi, kpc, k.keyMode) : false }
      if (mode === 'harmony') {
        const annoIdx = annoGroups.get(note.id)
        if (annoIdx !== undefined) {
          const ann = annotations[annoIdx]
          out.chord_info = { roman_numeral: ann.roman, chord_label: ann.label, is_diatonic: ann.isDiatonic }
          out.is_top_note = true
        }
      }
      return out
    })
  }, [mode, notesWithDegrees, notes, annotations, activeKeyAt])

  // ── Scroll tracking / viewport ───────────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let snapTimer = 0
    const onScroll = () => {
      const sl = el.scrollLeft
      scrollLeftPxRef.current = sl
      // Clamp the state so during a rubber-band overscroll the canvas draw
      // slice stays consistent with the DOM grid instead of detaching.
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      setScrollLeft(Math.min(Math.max(0, sl), max))
      // Once scrolling settles, snap to a whole DEVICE pixel: a fractional
      // scroll offset composites the ENTIRE scroll layer (DOM labels and
      // canvas alike) at a sub-pixel position → everything blurs. CSS-px
      // rounding is insufficient at fractional DPR (125%/150% desktop
      // scaling, non-integer Android DPRs) where integer CSS px land
      // between device pixels — the blur then persists forever.
      window.clearTimeout(snapTimer)
      snapTimer = window.setTimeout(() => {
        const snapped = snapDev(el.scrollLeft)
        if (Math.abs(el.scrollLeft - snapped) > 0.01 / dprNow()) el.scrollLeft = snapped
      }, 120)
    }
    const onResize = () => { setViewportWidth(el.getBoundingClientRect().width); landAdjStaleRef.current = true }
    onResize()
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { ro.disconnect(); el.removeEventListener('scroll', onScroll); window.clearTimeout(snapTimer) }
  }, [])

  // ── Ctrl/Cmd + wheel zoom ────────────────────────────────────
  // Non-passive listener so we can preventDefault the browser/page zoom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !onZoom) return
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      onZoom(e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoom])

  // Keep the leftmost visible beat pinned across every zoom change (wheel,
  // +/- buttons — any beatWidth change), clamped at both ends. useLayoutEffect
  // so the re-anchor lands before paint — a useEffect would let the browser
  // paint one frame at the clamped position first (visible jump).
  const prevBeatWidthRef = useRef(beatWidth)
  useLayoutEffect(() => {
    const prev = prevBeatWidthRef.current
    prevBeatWidthRef.current = beatWidth
    const el = scrollRef.current
    if (!el || prev === beatWidth) return
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    const snapped = Math.min(Math.max(0, snapDev((scrollLeftPxRef.current / prev) * beatWidth)), max)
    el.scrollLeft = snapped
    scrollLeftPxRef.current = snapped
  }, [beatWidth])

  // Snap back to the section start when playback stops; pause keeps the view.
  useLayoutEffect(() => {
    if (playbackState !== 'stopped') return
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = 0
    scrollLeftPxRef.current = 0
  }, [playbackState])

  // ── Playhead + canvas anchoring + auto-scroll (RAF — no re-render) ──
  useEffect(() => {
    let raf
    let last = -1
    let lastSl = -1
    const tick = () => {
      const el = scrollRef.current
      // Clamp so the canvas rides with the DOM grid through any residual
      // rubber-band overscroll instead of pinning to the scrollport.
      const sl = el ? Math.min(Math.max(0, el.scrollLeft), Math.max(0, el.scrollWidth - el.clientWidth)) : 0
      if (canvasRef.current) {
        // Measure the resting landing error once per layout — the element
        // is glued to the scrollport so its visual left is a page-layout
        // constant; snap that onto the device-pixel grid and keep the
        // correction in the transform. Skipped while rubber-banding (sl
        // clamped away from real scrollLeft) so a transient can't poison it.
        if (landAdjStaleRef.current && el && Math.abs(el.scrollLeft - sl) < 0.5) {
          const rect = canvasRef.current.getBoundingClientRect()
          const dpr = dprNow()
          landAdjRef.current = Math.round(rect.left * dpr) / dpr - rect.left
          landAdjStaleRef.current = false
        }
        const tx = sl + landAdjRef.current
        if (tx !== lastSl) {
          canvasRef.current.style.transform = `translateX(${tx}px)`
          lastSl = tx
        }
      }
      const frac = cursorRef?.current ?? 0
      const px = snapDev(frac * gridWidth)
      if (playheadRef.current && px !== last) {
        playheadRef.current.style.transform = `translateX(${px}px)`
        playheadRef.current.style.opacity = px > 0 ? 0.95 : 0
        last = px
      }
      if (isPlaying && el) {
        const rel = px - el.scrollLeft
        const target = el.clientWidth * 0.35
        if (rel > target || rel < 0) {
          // Dev-px-snap the write so the DOM layer doesn't sit at a
          // fractional offset for the entire playback (which would also
          // keep the scroll-settle snap from ever firing).
          el.scrollLeft = Math.max(0, snapDev(px - target))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, gridWidth, cursorRef])

  // ── Canvas render — viewport slice only ─────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx._cellH = cellH
    // Cap 3: the viewport-sized canvas stays small (~1–2 Mpx) even at dpr 3 —
    // the old cap of 2 dated from the full-width canvas that hit iOS limits.
    const dpr = Math.min(dprRaw, 3)
    const cssW = Math.min(Math.max(0, viewportWidth - 44), gridWidth)
    if (cssW <= 0) return
    const bw = Math.round(cssW * dpr)
    const bh = Math.round(gridHeight * dpr)
    // Assigning width/height clears the canvas — only touch it when it changed
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
    // Size the element to exact multiples of 1/dpr so the bitmap composites
    // 1:1 — a fractional CSS size forces a GPU stretch and softens everything.
    canvas.style.width = `${bw / dpr}px`
    canvas.style.height = `${bh / dpr}px`
    // Snap the slice offset to whole device pixels (matching the canvas
    // element's snapped translateX in the RAF tick) so integer grid coords
    // land on exact device pixels — fractional offsets blur everything.
    const slDraw = Math.round(scrollLeft * dpr)
    // setTransform: dpr scale + viewport offset in one atomic reset
    ctx.setTransform(dpr, 0, 0, dpr, -slDraw, 0)

    const vpStart = (slDraw / dpr) / beatWidth
    const vpEnd = ((slDraw / dpr) + cssW) / beatWidth

    renderGrid(ctx, { width: gridWidth, height: gridHeight, beatWidth, barStarts: effectiveBarStarts, totalBeats, lowestNote, highestNote, dpr, beatsPerDivision, isDark })
    renderNotes(ctx, { notes: displayNotes, beatWidth, cellH, lowestNote, highestNote, viewportStartBeat: vpStart, viewportEndBeat: vpEnd, dpr, showAnswers, notation, isDark })
    renderRegionOverlay(ctx, { width: gridWidth, height: gridHeight, regionStartPx: regionStart * gridWidth, regionEndPx: regionEnd * gridWidth, dpr })
  }, [displayNotes, beatWidth, gridWidth, gridHeight, cellH, effectiveBarStarts, totalBeats, beatsPerDivision, lowestNote, highestNote, scrollLeft, viewportWidth, regionStart, regionEnd, showAnswers, notation, isDark, dprRaw])

  // ── Region handle dragging (mouse + touch via pointer events) ──
  const regionDragCleanup = useRef(null)
  const startRegionDrag = useCallback((e, which) => {
    if (!onRegionChange || !gridRef.current) return
    e.preventDefault()
    e.stopPropagation()
    regionDragCleanup.current?.()
    const snap = (beatsPerDivision * beatWidth) / gridWidth
    const minGap = snap
    const curStart = () => regionStartRef.current
    const curEnd = () => regionEndRef.current

    const onMove = (ev) => {
      const rect = gridRef.current?.getBoundingClientRect()
      if (!rect) return
      const raw = (ev.clientX - rect.left) / gridWidth
      const snapped = Math.round(raw / snap) * snap
      if (which === 'start') {
        onRegionChange(Math.max(0, Math.min(curEnd() - minGap, snapped)), curEnd())
      } else {
        onRegionChange(curStart(), Math.min(1, Math.max(curStart() + minGap, snapped)))
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      regionDragCleanup.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    regionDragCleanup.current = onUp
  }, [onRegionChange, gridWidth, beatWidth, beatsPerDivision])

  const regionStartRef = useRef(regionStart)
  const regionEndRef = useRef(regionEnd)
  regionStartRef.current = regionStart
  regionEndRef.current = regionEnd
  useEffect(() => () => regionDragCleanup.current?.(), [])

  // ── Tap to seek / audition note ──────────────────────────────
  const tapInfo = useRef(null)
  const handleCanvasPointerDown = useCallback((e) => {
    tapInfo.current = { x: e.clientX, y: e.clientY, t: performance.now() }
  }, [])
  const handleCanvasPointerUp = useCallback((e) => {
    const info = tapInfo.current
    tapInfo.current = null
    if (!info || performance.now() - info.t > 350) return
    if (Math.hypot(e.clientX - info.x, e.clientY - info.y) > 8) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    // Canvas is viewport-anchored: local x + scrollLeft → grid-space x
    const x = e.clientX - rect.left + scrollLeft
    const y = e.clientY - rect.top
    const beat = (x / gridWidth) * totalBeats
    // Note hit-test first
    for (const note of notes) {
      const midi = noteToMidi(note.note)
      const nx = note.start * beatWidth
      const nw = Math.max(4, note.duration * beatWidth)
      const ny = (highestNote - midi) * cellH
      if (x >= nx && x <= nx + nw && y >= ny && y <= ny + cellH) {
        onNoteClick?.(note)
        return
      }
    }
    onSeek?.(Math.max(0, Math.min(totalBeats, beat)))
  }, [gridWidth, totalBeats, notes, beatWidth, highestNote, cellH, scrollLeft, onNoteClick, onSeek])

  const regionStartPx = snapDev(regionStart * gridWidth)
  const regionEndPx = snapDev(regionEnd * gridWidth)

  const noteRange = useMemo(() => {
    const r = []
    for (let i = highestNote; i >= lowestNote; i--) r.push(midiToNoteName(i))
    return r
  }, [highestNote, lowestNote])

  return (
    <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden" style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
      <div className="flex" style={{ width: 44 + gridWidth, height: gridHeight + BAR_LABEL_HEIGHT }}>
        {/* Sticky pitch labels */}
        <div className={`sticky left-0 z-20 shrink-0 border-r ${isDark ? 'border-slate-700 bg-slate-950' : 'border-slate-300 bg-slate-100'}`} style={{ width: 44, marginTop: BAR_LABEL_HEIGHT }}>
          {noteRange.map(name => (
            <div key={name} className={`flex items-center justify-end pr-1 font-mono text-[9px] font-semibold leading-none ${isBlackKey(noteToMidi(name)) ? (isDark ? 'bg-slate-900 text-slate-300' : 'bg-slate-300 text-slate-700') : (isDark ? 'bg-slate-950 text-slate-400' : 'bg-slate-100 text-slate-600')}`} style={{ height: cellH }}>
              {name}
            </div>
          ))}
        </div>

        {/* Grid area */}
        <div ref={gridRef} className="relative" style={{ width: gridWidth, height: gridHeight + BAR_LABEL_HEIGHT }}>
          {/* Ruler: bar numbers + region handles */}
          <div className="absolute left-0 right-0 top-0 z-40 select-none" style={{ height: BAR_LABEL_HEIGHT }}>
            <div className="absolute pointer-events-none" style={{ left: regionStartPx, width: regionEndPx - regionStartPx, height: '100%', background: 'rgba(56,189,248,0.10)', borderBottom: '1px solid rgba(56,189,248,0.35)' }} />
            {effectiveBarStarts.map((bar, i) => {
              const next = effectiveBarStarts[i + 1]?.start ?? totalBeats
              return (
                <div key={i} className={`absolute flex items-center pl-1 text-[10px] font-semibold pointer-events-none ${isDark ? 'text-slate-400' : 'text-slate-500'}`} style={{ left: snapDev(bar.start * beatWidth), width: Math.max(10, (next - bar.start) * beatWidth), height: '100%' }}>
                  {i + 1}
                </div>
              )
            })}
            {/* Key-change markers */}
            {(keyEvents || []).slice(1).map((ke, i) => (
              <div key={`key-${i}`} className="absolute pointer-events-none" style={{ left: snapDev(ke.beat * beatWidth), top: 0, height: '100%' }}>
                <div className="absolute top-0 bottom-0 w-px" style={{ background: 'rgba(168, 85, 247, 0.7)' }} />
                <div className={`absolute top-0 whitespace-nowrap rounded px-1 text-[9px] font-bold ${isDark ? 'bg-purple-500/30 text-purple-200' : 'bg-purple-200 text-purple-800'}`} style={{ left: 14 }}>
                  → {ke.key} {ke.keyMode || ''}
                </div>
              </div>
            ))}
            {/* Region handles — wide hit zones for touch */}
            {['start', 'end'].map(which => (
              <div key={which}
                className="absolute top-0 z-50 cursor-ew-resize"
                style={{ left: (which === 'start' ? regionStartPx : regionEndPx), width: 0, height: '100%', touchAction: 'none' }}
                onPointerDown={(e) => startRegionDrag(e, which)}
              >
                <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: -snapDev(1.5), width: 3, background: 'rgba(56,189,248,0.9)', boxShadow: '0 0 5px rgba(56,189,248,0.6)' }} />
                <div className="absolute pointer-events-none" style={{ top: 0, left: -6, width: 12, height: 12, background: 'rgba(56,189,248,0.95)', borderRadius: '3px 3px 0 0' }} />
                <div className="absolute top-0 bottom-0" style={{ left: -14, width: 28, touchAction: 'none' }} />
              </div>
            ))}
          </div>

          {/* Canvas — viewport-sized layer, glued to the scrollport by a
              transform updated in the RAF loop (see below). Rendering only
              the visible slice keeps every repaint small: a full-width
              canvas (~18k px at DPR 3 on long sections) both exceeds iOS
              canvas limits and turns every scroll tick into a huge repaint. */}
          <canvas
            ref={canvasRef}
            className="absolute"
            style={{ left: 0, top: BAR_LABEL_HEIGHT, touchAction: 'pan-x pan-y', willChange: 'transform' }}
            onPointerDown={handleCanvasPointerDown}
            onPointerUp={handleCanvasPointerUp}
          />

          {/* Region guide lines */}
          <div className="absolute pointer-events-none z-20" style={{ top: BAR_LABEL_HEIGHT, bottom: 0, left: regionStartPx - 1, width: 2, background: 'rgba(56,189,248,0.4)' }} />
          <div className="absolute pointer-events-none z-20" style={{ top: BAR_LABEL_HEIGHT, bottom: 0, left: regionEndPx - 1, width: 2, background: 'rgba(56,189,248,0.4)' }} />

          {/* Playhead */}
          <div ref={playheadRef} className="absolute bottom-0 w-[3px] bg-amber-400 z-30 pointer-events-none" style={{ top: BAR_LABEL_HEIGHT, left: 0, opacity: 0, boxShadow: '0 0 10px rgba(250,190,36,0.8)', willChange: 'transform' }} />
        </div>
      </div>
    </div>
  )
}

export default PianoRoll
