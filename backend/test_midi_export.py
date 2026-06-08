#!/usr/bin/env python3
"""Load MIDI files and export to MusicXML for testing"""

import mido
import json
import os
import requests

def load_midi_notes(midi_path):
    """Load notes from MIDI file"""
    mid = mido.MidiFile(midi_path)
    notes = []
    abs_time = 0
    active_notes = {}
    
    # Use track 1 (track 0 is usually metadata)
    track = mid.tracks[1] if len(mid.tracks) > 1 else mid.tracks[0]
    
    for msg in track:
        abs_time += msg.time
        if msg.type == 'note_on' and msg.velocity > 0:
            active_notes[msg.note] = abs_time / mid.ticks_per_beat
        elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
            if msg.note in active_notes:
                start = active_notes[msg.note]
                end = abs_time / mid.ticks_per_beat
                
                # Convert MIDI note to pitch name
                note_names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
                octave = (msg.note // 12) - 1
                pitch_class = msg.note % 12
                pitch_name = f"{note_names[pitch_class]}{octave}"
                
                notes.append({
                    'pitch': pitch_name,
                    'start': start,
                    'duration': end - start
                })
                del active_notes[msg.note]
    
    return notes

# Load melody notes
print("Loading Vocals MIDI...")
melody_notes = load_midi_notes('/Users/carldheer/Documents/Project_EarMasterPro/EarMasterPro/Test_XML/Vocals - MIDI - noPickup.mid')
print(f"  Found {len(melody_notes)} melody notes")
print(f"  First 5 notes: {melody_notes[:5]}")

# Add scale degrees (simplified - just use '1' for all)
for note in melody_notes:
    note['scale_degree'] = '1'

# Load chord notes
print("\nLoading Chords MIDI...")
chord_notes = load_midi_notes('/Users/carldheer/Documents/Project_EarMasterPro/EarMasterPro/Test_XML/Chords - MIDI - noPickup.mid')
print(f"  Found {len(chord_notes)} chord notes")
print(f"  First 5 notes: {chord_notes[:5]}")

# Create export payload
export_data = {
    'notes': melody_notes,
    'chordNotes': chord_notes,
    'chordAnnotations': [],  # Will be fetched by backend
    'key': 'C Major',
    'tempo': 71,
    'timeSignature': '4/4',
    'pickupBeats': 3,
    'title': 'Twenty One Pilots - The Line - Intro (From MIDI)',
    'composer': 'EarMasterPro'
}

print(f"\nExporting to MusicXML...")
print(f"  Melody notes: {len(melody_notes)}")
print(f"  Chord notes: {len(chord_notes)}")

# Export using requests
response = requests.post(
    f'http://localhost:{os.environ.get("EARMASTER_BACKEND_PORT", "8765")}/export/musicxml',
    headers={'Content-Type': 'application/json'},
    json=export_data
)

if response.status_code == 200:
    output_path = '/Users/carldheer/Documents/Project_EarMasterPro/EarMasterPro/Test_XML/test_from_midi.musicxml'
    with open(output_path, 'wb') as f:
        f.write(response.content)
    print(f"✓ Export successful!")
    print(f"  Output: {output_path}")
else:
    print(f"✗ Export failed with status {response.status_code}")
    print(response.text)
