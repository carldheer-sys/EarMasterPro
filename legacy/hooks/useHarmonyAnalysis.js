import { useState, useEffect, useRef, useMemo } from 'react'
import { BACKEND_URL } from '@/lib/backend'

/**
 * Hook that calls the backend /analyze/harmony endpoint and returns
 * a map of startTime → { chord_label, roman_numeral, is_diatonic }
 *
 * The result is debounced so it doesn't fire on every keystroke while editing.
 */
export function useHarmonyAnalysis(notes, tonic, keyMode, enabled = true) {
  const [chordMap, setChordMap] = useState({}) // { startTime: ChordEvent }
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const debounceRef = useRef(null)
  const abortRef = useRef(null)

  // Stable hash so the effect only fires when note content actually changes
  const notesHash = useMemo(() => {
    if (!notes || notes.length === 0) return ''
    return notes.map(n => `${n.note}:${n.start}:${n.duration}`).join('|')
  }, [notes])
  const keyStr = useMemo(() => `${tonic} ${keyMode}`, [tonic, keyMode])

  useEffect(() => {
    if (!enabled || !notesHash) {
      setChordMap({})
      return
    }

    setChordMap({})
    if (abortRef.current) abortRef.current.abort()

    // Debounce: wait 400ms after last change before calling backend
    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(async () => {
      // Abort any in-flight request
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsLoading(true)
      setError(null)

      try {
        const currentNotes = notesHash.split('|').map(s => {
          const [note, start, duration] = s.split(':')
          return { note, start: parseFloat(start), duration: parseFloat(duration) }
        })
        const body = {
          notes: currentNotes,
          key: keyStr,
        }

        const res = await fetch(`${BACKEND_URL}/analyze/harmony`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!res.ok) throw new Error(`Backend error: ${res.status}`)

        const data = await res.json()
        const map = {}
        for (const event of data.chord_events || []) {
          // Round start to avoid float key collisions
          const key = Math.round(event.start * 1000) / 1000
          map[key] = event
        }
        setChordMap(map)
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Harmony analysis failed:', err)
          setError(err.message)
          setChordMap({})
        }
      } finally {
        setIsLoading(false)
      }
    }, 400)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [notesHash, keyStr, enabled])

  return { chordMap, isLoading, error }
}
