import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { parseSessionPackage, parseSessionTitle } from '@common/lib/sessionManager'

const SESSION_DIR = 'Saved_Sessions'
const SESSION_EXTENSIONS = ['.eartrainer.json', '.json']

export function isNativeApp() {
  return Capacitor.isNativePlatform()
}

export async function ensureNativeSessionDirectory() {
  if (!isNativeApp()) return null
  try {
    await Filesystem.mkdir({ path: SESSION_DIR, directory: Directory.Documents, recursive: true })
  } catch (err) {
    if (!String(err?.message || '').toLowerCase().includes('exist')) throw err
  }
  const uri = await Filesystem.getUri({ path: SESSION_DIR, directory: Directory.Documents })
  return uri.uri
}

export async function loadNativeSessionCatalog() {
  if (!isNativeApp()) return { sessions: [], directoryUri: null }
  const directoryUri = await ensureNativeSessionDirectory()
  let entries = []
  try {
    const result = await Filesystem.readdir({ path: SESSION_DIR, directory: Directory.Documents })
    entries = result.files || []
  } catch {
    return { sessions: [], directoryUri }
  }

  const sessions = entries
    .map(entry => typeof entry === 'string' ? entry : entry.name)
    .filter(Boolean)
    .filter(name => SESSION_EXTENSIONS.some(ext => name.endsWith(ext)))
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      const sessionName = name.replace(/\.eartrainer\.json$|\.json$/i, '')
      return {
        title: parseSessionTitle(sessionName),
        url: `native://${encodeURIComponent(name)}`,
        nativeFileName: name,
        source: 'phone'
      }
    })

  return { sessions, directoryUri }
}

export async function loadNativeSessionFromUrl(url) {
  const fileName = decodeURIComponent(String(url).replace('native://', ''))
  const result = await Filesystem.readFile({
    path: `${SESSION_DIR}/${fileName}`,
    directory: Directory.Documents,
    encoding: Encoding.UTF8
  })
  return parseSessionPackage(JSON.parse(result.data))
}

export function isNativeSessionUrl(url) {
  return String(url || '').startsWith('native://')
}
