import { useState, useEffect, useRef, useCallback } from 'react'
import * as Tone from 'tone'
import audioEngine from '@common/lib/audioEngine'

/**
 * Custom hook for handling MIDI keyboard input
 * Sets up MIDI access and routes note on/off messages to the audio engine
 * 
 * @param {Object} options
 * @param {boolean} options.enabled - Whether MIDI input is enabled (default: true)
 * @param {string} options.instrument - Instrument to use for playback (default: 'piano')
 * @param {boolean} options.isPlaying - Whether transport is currently playing (to avoid conflicts)
 * @returns {Object} { activeKeys: Set<string> } - Set of currently active note names
 */
export function useMIDIInput({ enabled = true, instrument = 'piano', isPlaying = false }) {
  const midiAccessRef = useRef(null)
  const instrumentRef = useRef(instrument)
  const enabledRef = useRef(enabled)
  const isPlayingRef = useRef(isPlaying)
  const activeNotesRef = useRef({}) // Track which notes are currently being held with their instruments
  const [activeKeys, setActiveKeys] = useState(new Set()) // For React component re-renders

  // Keep refs in sync with props
  useEffect(() => {
    instrumentRef.current = instrument
  }, [instrument])

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  // Convert MIDI note number to note name
  const midiToNoteName = useCallback((midi) => {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    const octave = Math.floor(midi / 12) - 1
    const noteIndex = midi % 12
    return noteNames[noteIndex] + octave
  }, [])

  // Update active keys state from ref
  const updateActiveKeys = useCallback(() => {
    const newKeys = new Set(Object.keys(activeNotesRef.current))
    setActiveKeys(newKeys)
  }, [])

  // Handle incoming MIDI message
  const handleMIDIMessage = useCallback((message) => {
    if (!enabledRef.current) return

    const command = message.data[0] & 0xF0
    const note = message.data[1]
    const velocity = message.data.length > 2 ? message.data[2] : 0

    const noteName = midiToNoteName(note)
    const currentInstrument = instrumentRef.current

    // Note On (0x90) with velocity > 0
    if (command === 0x90 && velocity > 0) {
      // Start the note immediately
      audioEngine.startNote(noteName, velocity, currentInstrument)
      activeNotesRef.current[noteName] = currentInstrument
      updateActiveKeys()
    }
    // Note Off (0x80) or Note On with velocity 0
    else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      // Stop the note
      audioEngine.stopNote(noteName, currentInstrument)
      delete activeNotesRef.current[noteName]
      updateActiveKeys()
    }
  }, [midiToNoteName, updateActiveKeys])

  // Set up MIDI access
  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      console.log('Web MIDI API not supported in this browser')
      return
    }

    const onMIDISuccess = (midiAccess) => {
      console.log('MIDI ready!')
      midiAccessRef.current = midiAccess

      // Set up message handlers for all inputs
      for (let input of midiAccess.inputs.values()) {
        input.onmidimessage = handleMIDIMessage
        console.log(`MIDI input connected: ${input.name}`)
      }

      // Listen for new connections
      midiAccess.onstatechange = (e) => {
        console.log(`MIDI state change: ${e.port.name} - ${e.port.state}`)
        if (e.port.type === 'input') {
          if (e.port.state === 'connected') {
            e.port.onmidimessage = handleMIDIMessage
          } else {
            e.port.onmidimessage = null
          }
        }
      }
    }

    const onMIDIFailure = () => {
      console.log('Could not access MIDI devices')
    }

    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure)

    // Cleanup
    return () => {
      if (midiAccessRef.current) {
        for (let input of midiAccessRef.current.inputs.values()) {
          input.onmidimessage = null
        }
        midiAccessRef.current.onstatechange = null
      }
      // Stop any active notes
      Object.keys(activeNotesRef.current).forEach(noteName => {
        audioEngine.stopNote(noteName, activeNotesRef.current[noteName])
      })
      activeNotesRef.current = {}
      updateActiveKeys()
    }
  }, [handleMIDIMessage, updateActiveKeys])

  // Stop all live notes when disabled or instrument changes
  useEffect(() => {
    if (!enabled) {
      Object.keys(activeNotesRef.current).forEach(noteName => {
        audioEngine.stopNote(noteName, activeNotesRef.current[noteName])
      })
      activeNotesRef.current = {}
      updateActiveKeys()
    }
  }, [enabled, updateActiveKeys])

  // Handle instrument change - stop notes from old instrument
  useEffect(() => {
    const oldNotes = { ...activeNotesRef.current }
    activeNotesRef.current = {}
    Object.keys(oldNotes).forEach(noteName => {
      audioEngine.stopNote(noteName, oldNotes[noteName])
    })
    updateActiveKeys()
  }, [instrument, updateActiveKeys])

  return { activeKeys }
}

export default useMIDIInput
