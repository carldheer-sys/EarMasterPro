/**
 * Catalog loading for baked-in Music_Catalog content.
 *
 * /catalog/catalog.json  — manifest built by scripts/build-catalog.mjs:
 *   { artists: [{ name, songs: [{ title, sections: [SectionEntry] }] }] }
 *
 * SectionEntry.assets holds URL paths to the section's session JSON, MIDI
 * files and audio (mp3), plus `capabilities` flags for missing assets.
 */

let catalogPromise = null

/** Load the catalog manifest (cached for the session). */
export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('/catalog/catalog.json')
      .then(res => {
        if (!res.ok) throw new Error(`catalog.json HTTP ${res.status}`)
        return res.json()
      })
      .catch(err => {
        catalogPromise = null // allow retry
        throw err
      })
  }
  return catalogPromise
}

/**
 * Fetch a section's session JSON (notes, chords, annotations, settings).
 * The session embeds all note data — the .mid files are not needed at runtime.
 * `signal` aborts the fetch when the user switches sections quickly.
 */
export async function loadSectionSession(entry, { signal } = {}) {
  const res = await fetch(entry.assets.session, { signal })
  if (!res.ok) throw new Error(`Session HTTP ${res.status}`)
  return res.json()
}

// ── Audio caches ────────────────────────────────────────────────────────────
// Compressed bytes survive AudioContext rebuilds; decoded buffers are bound to
// the context that decoded them. Caching both means a repeat song visit costs
// zero fetches and zero decodes — decodeAudioData of a full-song MP3 used to
// stall the main thread on every section switch on mobile.
const compressedAudioCache = new Map()  // url -> ArrayBuffer (mp3 bytes)
const decodedAudioCache = new Map()     // url -> { ctx, buffer }
const MAX_AUDIO_CACHE = 6

function cacheSet(map, key, value) {
  map.delete(key)            // refresh LRU order
  map.set(key, value)
  while (map.size > MAX_AUDIO_CACHE) map.delete(map.keys().next().value)
}

/** Fetch + decode a section's audio (mp3) into an AudioBuffer. */
export async function loadSectionAudio(entry, audioContext, { signal } = {}) {
  const url = entry.assets.audio
  const hit = decodedAudioCache.get(url)
  if (hit && hit.ctx === audioContext) {
    cacheSet(decodedAudioCache, url, hit)
    return hit.buffer
  }

  let bytes = compressedAudioCache.get(url)
  if (!bytes) {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`Audio HTTP ${res.status}`)
    bytes = await res.arrayBuffer()
    cacheSet(compressedAudioCache, url, bytes)
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const buffer = await audioContext.decodeAudioData(bytes.slice(0))
  cacheSet(decodedAudioCache, url, { ctx: audioContext, buffer })
  return buffer
}
