#!/usr/bin/env node
/**
 * build-catalog.mjs — Bake the Music_Catalog transcription library into the app.
 *
 * Scans <Music_Catalog>/<Artist - Title>/<section>/ folders, validates assets
 * (melody.mid, chords.mid, audio.wav, session.eartrainer.json), copies them to
 * public/catalog/, and writes public/catalog/catalog.json — a browse-ready
 * manifest organized artist -> song -> section.
 *
 * Folders ending in " - manual" (and the scripts&skills dir) are excluded.
 *
 * Usage: node scripts/build-catalog.mjs [catalogRoot]
 *   catalogRoot defaults to ../Music_Catalog (sibling of this repo) or the
 *   MUSIC_CATALOG_DIR env var.
 */
import midiPkg from '@tonejs/midi'
const { Midi } = midiPkg
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const catalogRoot = path.resolve(
  process.argv[2] || process.env.MUSIC_CATALOG_DIR || path.join(root, '..', 'Music_Catalog')
)
const outDir = path.join(root, 'public', 'catalog')
const manifestPath = path.join(outDir, 'catalog.json')

const SKIP_DIRS = new Set(['scripts&skills'])
const SECTION_ORDER = ['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'bridge', 'outro']

function sectionRank(name) {
  const n = name.toLowerCase()
  const idx = SECTION_ORDER.findIndex(s => n === s || n.startsWith(s))
  return idx === -1 ? SECTION_ORDER.length : idx
}

function sectionLabel(name) {
  return name.split(/[-\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

async function fileExists(p) {
  try { return (await stat(p)).isFile() } catch { return false }
}

async function validateMidi(filePath) {
  /** Returns note count, or throws on unparseable MIDI. */
  const buf = await readFile(filePath)
  const midi = new Midi(buf)
  return midi.tracks.reduce((sum, t) => sum + t.notes.length, 0)
}

function validateWavHeader(buf) {
  return buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
}

const warnings = []
const catalog = { generatedAt: new Date().toISOString(), artists: [] }

console.log(`[catalog] Scanning ${catalogRoot}`)

let songDirs
try {
  songDirs = (await readdir(catalogRoot, { withFileTypes: true }))
    .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort()
} catch (err) {
  console.error(`[catalog] Cannot read catalog root: ${err.message}`)
  process.exit(1)
}

// Clear stale output — sections deleted/renamed upstream must not linger
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

for (const songFolder of songDirs) {
  const songDir = path.join(catalogRoot, songFolder)
  const infoPath = path.join(songDir, 'song-info.json')
  let songInfo = null
  if (await fileExists(infoPath)) {
    try { songInfo = JSON.parse(await readFile(infoPath, 'utf8')) }
    catch (err) { warnings.push(`${songFolder}: invalid song-info.json (${err.message})`) }
  }

  // Artist/title: the "Artist - Title" folder name is the catalog's
  // organizational source of truth; song-info.json is the fallback.
  let artist, title
  const m = songFolder.match(/^(.+?)\s+-\s+(.+)$/)
  if (m) {
    artist = m[1].trim()
    title = m[2].trim()
  } else {
    artist = songInfo?.artist || 'Unknown Artist'
    title = songInfo?.song || songFolder
  }

  const sectionDirs = (await readdir(songDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && !e.name.endsWith('- manual') && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b))

  const sections = []
  for (const sectionFolder of sectionDirs) {
    const dir = path.join(songDir, sectionFolder)
    const meta = songInfo?.sections?.[sectionFolder] || {}

    const files = {
      session: path.join(dir, 'session.eartrainer.json'),
      melody: path.join(dir, 'melody.mid'),
      chords: path.join(dir, 'chords.mid'),
      audio: path.join(dir, 'audio.wav'),
    }
    const present = {}
    for (const [k, p] of Object.entries(files)) present[k] = await fileExists(p)

    // Session JSON is the section's source of truth
    let session = null
    if (present.session) {
      try { session = JSON.parse(await readFile(files.session, 'utf8')) }
      catch (err) { warnings.push(`${songFolder}/${sectionFolder}: invalid session JSON (${err.message})`) }
    }
    if (!session) {
      warnings.push(`${songFolder}/${sectionFolder}: missing/unreadable session.eartrainer.json — section skipped`)
      continue
    }

    // Validate MIDI files actually parse
    let melodyNotes = session.notes?.length || 0
    let chordNotes = session.chordsNotes?.length || 0
    if (present.melody) {
      try {
        const n = await validateMidi(files.melody)
        if (n === 0) { present.melody = false; warnings.push(`${songFolder}/${sectionFolder}: melody.mid contains no notes`) }
        else melodyNotes = Math.max(melodyNotes, n)
      } catch (err) {
        present.melody = false
        warnings.push(`${songFolder}/${sectionFolder}: melody.mid failed to parse (${err.message})`)
      }
    }
    if (present.chords) {
      try {
        const n = await validateMidi(files.chords)
        if (n === 0) { present.chords = false; warnings.push(`${songFolder}/${sectionFolder}: chords.mid contains no notes`) }
        else chordNotes = Math.max(chordNotes, n)
      } catch (err) {
        present.chords = false
        warnings.push(`${songFolder}/${sectionFolder}: chords.mid failed to parse (${err.message})`)
      }
    }
    if (present.audio) {
      const head = await readFile(files.audio)
      if (!validateWavHeader(head)) {
        present.audio = false
        warnings.push(`${songFolder}/${sectionFolder}: audio.wav is not a valid WAV file`)
      }
    }
    if (melodyNotes === 0) present.melody = false
    if (chordNotes === 0) present.chords = false

    if (!present.melody) warnings.push(`${songFolder}/${sectionFolder}: no usable melody MIDI`)
    if (!present.chords) warnings.push(`${songFolder}/${sectionFolder}: no usable chords MIDI`)
    if (!present.audio) warnings.push(`${songFolder}/${sectionFolder}: no usable audio.wav`)
    if (!session.chordAnnotations?.length) {
      warnings.push(`${songFolder}/${sectionFolder}: session has no chordAnnotations (run --annotate-only)`)
    }

    // Copy assets into public/catalog
    const targetDir = path.join(outDir, songFolder, sectionFolder)
    await mkdir(targetDir, { recursive: true })
    const urlBase = `/catalog/${encodeURIComponent(songFolder)}/${encodeURIComponent(sectionFolder)}`
    const assets = {}
    const toCopy = [['session', 'session.eartrainer.json'], ['melody', 'melody.mid'],
                    ['chords', 'chords.mid'], ['audio', 'audio.wav']]
    for (const [key, fname] of toCopy) {
      if (!present[key]) continue
      await copyFile(files[key], path.join(targetDir, fname))
      assets[key] = `${urlBase}/${fname}`
    }

    sections.push({
      id: `${songFolder}/${sectionFolder}`,
      name: sectionFolder,
      label: sectionLabel(sectionFolder),
      key: session.settings?.key || meta.key || 'C',
      keyMode: session.settings?.keyMode || meta.keyMode || 'Major',
      tempo: session.settings?.tempo || meta.tempo || 120,
      internalBpm: meta.internalBpm || null,
      timeSignature: meta.timeSignature ||
        `${session.settings?.timeSignature?.numerator ?? 4}/${session.settings?.timeSignature?.denominator ?? 4}`,
      bars: session.settings?.bars || meta.bars || 0,
      melodyNotes,
      chordNotes,
      assets,
      capabilities: {
        melody: !!present.melody,
        chords: !!present.chords,
        audio: !!present.audio,
        annotations: !!session.chordAnnotations?.length,
      },
    })
  }

  if (!sections.length) continue

  let artistEntry = catalog.artists.find(a => a.name === artist)
  if (!artistEntry) {
    artistEntry = { name: artist, songs: [] }
    catalog.artists.push(artistEntry)
  }
  artistEntry.songs.push({ title, folder: songFolder, sections })
}

catalog.artists.sort((a, b) => a.name.localeCompare(b.name))
for (const a of catalog.artists) a.songs.sort((x, y) => x.title.localeCompare(y.title))

await mkdir(outDir, { recursive: true })
await writeFile(manifestPath, JSON.stringify(catalog, null, 2))

const sectionCount = catalog.artists.reduce((n, a) => n + a.songs.reduce((m, s) => m + s.sections.length, 0), 0)
console.log(`[catalog] Wrote ${catalog.artists.length} artists, ${sectionCount} sections -> ${manifestPath}`)

if (warnings.length) {
  console.log('\n[catalog] WARNINGS — incomplete or incompatible assets:')
  for (const w of warnings) console.log(`  - ${w}`)
}
