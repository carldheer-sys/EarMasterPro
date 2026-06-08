/**
 * Session Manager for Ear Training Page
 * Handles saving and loading complete training sessions with all settings and files
 */

/**
 * Parse session name to display title
 * Example: "TwentyOnePilots_TheLine_Chorus" -> "Twenty One Pilots - The Line - Chorus"
 * Example: "TaylorSwift_the1_Full" -> "Taylor Swift - The 1 - Full"
 */
export const parseSessionTitle = (sessionName) => {
  if (!sessionName || sessionName === 'Untitled Session') {
    return 'Untitled Session'
  }

  const parts = sessionName.split('_')
  
  const formatPart = (part) => {
    // Handle special case like "the1" -> "The 1"
    if (part.match(/^the\d+$/)) {
      return `The ${part.slice(3)}`
    }
    
    // Insert space before capital letters (CamelCase)
    const withSpaces = part.replace(/([a-z])([A-Z])/g, '$1 $2')
    
    // Capitalize first letter of each word
    return withSpaces.split(' ').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ')
  }

  return parts.map(formatPart).join(' - ')
}

/**
 * Create session data object with all settings and file paths
 */
export const createSessionData = ({
  key,
  tempo,
  timeSignature,
  bars,
  timeDivision,
  playbackSpeed,
  instrument,
  melodyMode,
  backgroundTrack,
  melodyVolume,
  backgroundVolume,
  regionStart,
  regionEnd,
  isLooping,
  notes,
  lowestNote,
  highestNote,
  // File paths (relative to session folder)
  midiFilePath = '',
  vocalsFilePath = '',
  droneFilePath = '',
  chordsFilePath = '',
  instrumentalsFilePath = ''
}) => {
  return {
    version: '1.0',
    settings: {
      key,
      tempo,
      timeSignature,
      bars,
      timeDivision,
      playbackSpeed,
      instrument,
      melodyMode,
      backgroundTrack,
      melodyVolume,
      backgroundVolume,
      regionStart,
      regionEnd,
      isLooping
    },
    notes: notes || [],
    noteRange: {
      lowestNote,
      highestNote
    },
    files: {
      midi: midiFilePath,
      vocals: vocalsFilePath,
      drone: droneFilePath,
      chords: chordsFilePath,
      instrumentals: instrumentalsFilePath
    }
  }
}

/**
 * Save session to Saved_Sessions directory with embedded file data
 */
export const saveSession = async (sessionName, sessionData, files) => {
  try {
    // Create a complete session package with embedded files
    const sessionPackage = {
      ...sessionData,
      sessionName,
      embeddedFiles: {}
    }

    // Convert files to base64 for embedding with size information
    if (files.midi) {
      const arrayBuffer = await files.midi.arrayBuffer()
      const base64 = arrayBufferToBase64(arrayBuffer)
      sessionPackage.embeddedFiles.midi = {
        name: files.midi.name,
        type: files.midi.type,
        size: files.midi.size,
        data: base64
      }
    }

    if (files.vocals) {
      const arrayBuffer = await files.vocals.arrayBuffer()
      const base64 = arrayBufferToBase64(arrayBuffer)
      sessionPackage.embeddedFiles.vocals = {
        name: files.vocals.name,
        type: files.vocals.type,
        size: files.vocals.size,
        data: base64
      }
    }

    if (files.drone) {
      const arrayBuffer = await files.drone.arrayBuffer()
      const base64 = arrayBufferToBase64(arrayBuffer)
      sessionPackage.embeddedFiles.drone = {
        name: files.drone.name,
        type: files.drone.type,
        size: files.drone.size,
        data: base64
      }
    }

    if (files.chords) {
      const arrayBuffer = await files.chords.arrayBuffer()
      const base64 = arrayBufferToBase64(arrayBuffer)
      sessionPackage.embeddedFiles.chords = {
        name: files.chords.name,
        type: files.chords.type,
        size: files.chords.size,
        data: base64
      }
    }

    if (files.instrumentals) {
      const arrayBuffer = await files.instrumentals.arrayBuffer()
      const base64 = arrayBufferToBase64(arrayBuffer)
      sessionPackage.embeddedFiles.instrumentals = {
        name: files.instrumentals.name,
        type: files.instrumentals.type,
        size: files.instrumentals.size,
        data: base64
      }
    }

    // Use File System Access API to save to Saved_Sessions directory
    try {
      // Request directory picker starting in documents
      const dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents'
      })

      // Create or get Saved_Sessions folder
      const savedSessionsHandle = await dirHandle.getDirectoryHandle('Saved_Sessions', { create: true })

      // Create the session file
      const fileHandle = await savedSessionsHandle.getFileHandle(`${sessionName}.eartrainer.json`, { create: true })
      const writable = await fileHandle.createWritable()
      const jsonString = JSON.stringify(sessionPackage, null, 2)
      await writable.write(jsonString)
      await writable.close()

      return { success: true, sessionName }
    } catch (fsError) {
      // Fallback to download if File System Access API fails
      console.warn('File System Access API failed, falling back to download:', fsError)
      const jsonString = JSON.stringify(sessionPackage, null, 2)
      const blob = new Blob([jsonString], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      
      const a = document.createElement('a')
      a.href = url
      a.download = `${sessionName}.eartrainer.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      return { success: true, sessionName }
    }
  } catch (error) {
    console.error('Error saving session:', error)
    throw error
  }
}

/**
 * Convert ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convert base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes.buffer
}


/**
 * Load session from Saved_Sessions directory
 */
export const loadSession = async () => {
  try {
    // Try to use File System Access API first
    try {
      // Request directory picker starting in documents
      const dirHandle = await window.showDirectoryPicker({
        mode: 'read',
        startIn: 'documents'
      })

      // Try to get Saved_Sessions folder
      let savedSessionsHandle
      try {
        savedSessionsHandle = await dirHandle.getDirectoryHandle('Saved_Sessions')
      } catch {
        // If Saved_Sessions doesn't exist, let user pick from current directory
        savedSessionsHandle = dirHandle
      }

      // List all .eartrainer.json files
      const files = []
      for await (const entry of savedSessionsHandle.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.eartrainer.json')) {
          files.push(entry.name)
        }
      }

      if (files.length === 0) {
        throw new Error('No session files found in this directory')
      }

      // For now, just pick the first file (in a real app, show a selection dialog)
      const fileName = files[0]
      const fileHandle = await savedSessionsHandle.getFileHandle(fileName)
      const file = await fileHandle.getFile()
      const text = await file.text()
      const sessionPackage = JSON.parse(text)

      return parseSessionPackage(sessionPackage)
    } catch (fsError) {
      // Fallback to file input if File System Access API fails
      console.warn('File System Access API failed, falling back to file input:', fsError)
      return new Promise((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.eartrainer.json,.json'
        
        input.onchange = async (e) => {
          try {
            const file = e.target.files?.[0]
            if (!file) {
              resolve(null)
              return
            }

            const text = await file.text()
            const sessionPackage = JSON.parse(text)
            resolve(parseSessionPackage(sessionPackage))
          } catch (error) {
            reject(error)
          }
        }

        input.oncancel = () => {
          resolve(null)
        }

        input.click()
      })
    }
  } catch (error) {
    console.error('Error loading session:', error)
    throw error
  }
}

export const loadSessionCatalog = async () => {
  const response = await fetch('/Saved_Sessions/catalog.json', { cache: 'no-cache' })
  if (!response.ok) throw new Error(`Could not load session catalog (${response.status})`)
  return response.json()
}

export const loadSessionFromUrl = async (url) => {
  const response = await fetch(url, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`Could not load session (${response.status})`)
  const sessionPackage = await response.json()
  return parseSessionPackage(sessionPackage)
}

/**
 * Parse session package and convert embedded files back to File objects
 */
export function parseSessionPackage(sessionPackage) {
  const sessionName = sessionPackage.sessionName || 'Untitled Session'
  const sessionData = {
    version: sessionPackage.version,
    settings: sessionPackage.settings,
    notes: sessionPackage.notes,
    noteRange: sessionPackage.noteRange,
    files: sessionPackage.files,
    chordsNotes: sessionPackage.chordsNotes || [],
    chordsNoteRange: sessionPackage.chordsNoteRange || null,
    chordsInstrument: sessionPackage.chordsInstrument || null
  }

  // Convert embedded files back to File objects
  const files = {}

  if (sessionPackage.embeddedFiles?.midi) {
    const { name, type, data } = sessionPackage.embeddedFiles.midi
    const arrayBuffer = base64ToArrayBuffer(data)
    files.midi = new File([arrayBuffer], name, { type })
  }

  if (sessionPackage.embeddedFiles?.vocals) {
    const { name, type, data } = sessionPackage.embeddedFiles.vocals
    const arrayBuffer = base64ToArrayBuffer(data)
    files.vocals = new File([arrayBuffer], name, { type })
  }

  if (sessionPackage.embeddedFiles?.drone) {
    const { name, type, data } = sessionPackage.embeddedFiles.drone
    const arrayBuffer = base64ToArrayBuffer(data)
    files.drone = new File([arrayBuffer], name, { type })
  }

  if (sessionPackage.embeddedFiles?.chords) {
    const { name, type, data } = sessionPackage.embeddedFiles.chords
    const arrayBuffer = base64ToArrayBuffer(data)
    files.chords = new File([arrayBuffer], name, { type })
  }

  if (sessionPackage.embeddedFiles?.chordsMidi) {
    const { name, type, data } = sessionPackage.embeddedFiles.chordsMidi
    const arrayBuffer = base64ToArrayBuffer(data)
    files.chordsMidi = new File([arrayBuffer], name, { type })
  }

  if (sessionPackage.embeddedFiles?.instrumentals) {
    const { name, type, data } = sessionPackage.embeddedFiles.instrumentals
    const arrayBuffer = base64ToArrayBuffer(data)
    files.instrumentals = new File([arrayBuffer], name, { type })
  }

  return {
    sessionName,
    sessionData,
    files
  }
}


/**
 * Prompt for session name
 */
export const promptSessionName = async (currentName = '') => {
  const name = prompt(
    'Enter session name (format: Artist_Title_Section)',
    currentName || 'Untitled_Session'
  )
  
  if (!name) return null
  
  // Validate format (no spaces, underscores for separation)
  const cleaned = name.replace(/\s+/g, '_')
  return cleaned
}
