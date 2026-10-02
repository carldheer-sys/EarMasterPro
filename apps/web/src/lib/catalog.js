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

/** Integrated RMS + sample peak of a decoded buffer, in dBFS. */
export function measureBufferLevel(buffer) {
  let sumSq = 0, peak = 0, n = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      sumSq += v * v
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
    }
    n += data.length
  }
  const toDb = x => 20 * Math.log10(Math.max(x, 1e-9))
  return { rmsDb: toDb(Math.sqrt(sumSq / Math.max(1, n))), peakDb: toDb(peak) }
}

/** Fetch + decode a section's audio (mp3) into an AudioBuffer + loudness. */
export async function loadSectionAudio(entry, audioContext, { signal } = {}) {
  const url = entry.assets.audio
  const hit = decodedAudioCache.get(url)
  if (hit && hit.ctx === audioContext) {
    cacheSet(decodedAudioCache, url, hit)
    return { buffer: hit.buffer, rmsDb: hit.rmsDb, peakDb: hit.peakDb }
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
  const { rmsDb, peakDb } = measureBufferLevel(buffer)
  cacheSet(decodedAudioCache, url, { ctx: audioContext, buffer, rmsDb, peakDb })
  return { buffer, rmsDb, peakDb }
}
