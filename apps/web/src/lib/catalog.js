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

/**
 * A catalog URL that returns HTML means the in-memory manifest is stale:
 * the dev/preview SPA fallback answers missing /catalog/* paths with
 * index.html and HTTP 200, so JSON endpoints must check Content-Type.
 */
export class StaleCatalogError extends Error {
  constructor(url) {
    super(`catalog asset returned HTML, not JSON: ${url}`)
    this.name = 'StaleCatalogError'
    this.url = url
  }
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  if ((res.headers.get('content-type') || '').includes('text/html'))
    throw new StaleCatalogError(url)
  return res.json()
}

/** Load the catalog manifest (cached for the session). */
export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchJson('/catalog/catalog.json')
      .catch(err => {
        catalogPromise = null // allow retry
        throw err
      })
  }
  return catalogPromise
}

/** Drop the cached manifest — paths change when songs are renamed/re-exported. */
export function invalidateCatalog() {
  catalogPromise = null
}

/**
 * Fetch a section's session JSON (notes, chords, annotations, settings).
 * The session embeds all note data — the .mid files are not needed at runtime.
 * `signal` aborts the fetch when the user switches sections quickly.
 */
export async function loadSectionSession(entry, { signal } = {}) {
  return fetchJson(entry.assets.session, signal)
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
