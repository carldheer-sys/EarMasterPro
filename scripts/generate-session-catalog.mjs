import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const sessionsDir = path.join(root, 'public', 'Saved_Sessions')
const outputPath = path.join(sessionsDir, 'catalog.json')

function parseSessionTitle(sessionName) {
  if (!sessionName || sessionName === 'Untitled Session') return 'Untitled Session'
  return sessionName.split('_').map(part => {
    if (/^the\d+$/.test(part)) return `The ${part.slice(3)}`
    const withSpaces = part.replace(/([a-z])([A-Z])/g, '$1 $2')
    return withSpaces.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
  }).join(' - ')
}

const entries = await readdir(sessionsDir, { withFileTypes: true })
const sessions = []

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.eartrainer.json')) continue
  const filePath = path.join(sessionsDir, entry.name)
  try {
    const pkg = JSON.parse(await readFile(filePath, 'utf8'))
    const sessionName = pkg.sessionName || entry.name.replace(/\.eartrainer\.json$/, '')
    sessions.push({
      file: entry.name,
      url: `/Saved_Sessions/${encodeURIComponent(entry.name)}`,
      sessionName,
      title: parseSessionTitle(sessionName),
      key: pkg.settings?.key || 'C',
      keyMode: pkg.settings?.keyMode || 'Major',
      tempo: pkg.settings?.tempo || 120,
      bars: pkg.settings?.bars || 4,
      noteRange: pkg.noteRange || null,
      updatedAt: new Date().toISOString()
    })
  } catch (error) {
    console.warn(`[catalog] Skipping invalid session ${entry.name}: ${error.message}`)
  }
}

sessions.sort((a, b) => a.title.localeCompare(b.title))
await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), sessions }, null, 2))
console.log(`[catalog] Wrote ${sessions.length} sessions to ${outputPath}`)
