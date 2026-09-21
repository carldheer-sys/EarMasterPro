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

/** Fetch + decode a section's audio (mp3) into an AudioBuffer. */
export async function loadSectionAudio(entry, audioContext, { signal } = {}) {
  const res = await fetch(entry.assets.audio, { signal })
  if (!res.ok) throw new Error(`Audio HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  return audioContext.decodeAudioData(buf)
}
