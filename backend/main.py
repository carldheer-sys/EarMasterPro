"""
EarMasterPro Backend - MusicXML Export + Harmonic Analysis Service
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import music21 as m21
import tempfile
import os
import uuid
import re

app = FastAPI(title="EarMasterPro Backend", version="1.0.0")

# Allow CORS for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class NoteData(BaseModel):
    """Single melody note with pitch, timing, and scale-degree annotation"""
    pitch: str
    start: float
    duration: float
    scale_degree: Optional[str] = None
    is_diatonic: Optional[bool] = True


class ChordNoteData(BaseModel):
    """Single chord note with pitch and timing"""
    pitch: str
    start: float
    duration: float


class ChordAnnotation(BaseModel):
    """Chord symbol + Roman numeral for a single chord moment"""
    start: float
    chord_label: str          # e.g. 'Am', 'G7', 'C/E'
    roman_numeral: str        # e.g. 'vi', 'V7', 'I'
    is_diatonic: bool = True


class MusicXMLExportRequest(BaseModel):
    """Request to export a Grand Staff (melody + harmony) to MusicXML"""
    notes: List[NoteData]                          # Melody notes
    chord_notes: List[ChordNoteData] = Field(default_factory=list, alias="chordNotes")
    chord_annotations: List[ChordAnnotation] = Field(default_factory=list, alias="chordAnnotations")
    key: str = Field(..., description="Key signature (e.g., 'C Major', 'A minor')")
    tempo: int = Field(default=120, ge=20, le=300)
    time_signature: str = Field(default="4/4", alias="timeSignature")
    pickup_beats: float = Field(default=0, ge=0, le=4, alias="pickupBeats")
    title: Optional[str] = "Exported Melody"
    composer: Optional[str] = "EarMasterPro"

    class Config:
        populate_by_name = True


def parse_user_key(selected_key: str) -> Optional[m21.key.Key]:
    """Parse the user-selected key into a music21 Key, normalizing case and spacing."""
    if not selected_key:
        return None
    selected_key_str = selected_key.strip()
    tonic_part = selected_key_str
    mode_part = "major"
    if " " in selected_key_str:
        tonic_part, mode_part = selected_key_str.split(" ", 1)

    tonic_part = tonic_part.strip().capitalize()
    # Preserve accidentals (#/b) after capitalize()
    if len(tonic_part) > 1 and tonic_part[1] in ['#', 'b']:
        tonic_part = tonic_part[0].upper() + tonic_part[1:]
    mode_part = mode_part.strip().lower()
    if mode_part not in ["major", "minor"]:
        mode_part = "major" if "maj" in mode_part else "minor" if "min" in mode_part else mode_part
    try:
        return m21.key.Key(tonic_part, mode_part)
    except Exception as e:
        print(f"Failed to build music21 Key from '{selected_key}': {e}")
        return None


# ─── Harmonic Analysis Models ─────────────────────────────────────────────────

class HarmonyNoteData(BaseModel):
    note: str
    start: float
    duration: float

class ChordEvent(BaseModel):
    start: float
    chord_label: str
    roman_numeral: str
    is_diatonic: bool
    inversion: Optional[str] = None  # e.g. "/E" for first inversion

class HarmonyAnalysisRequest(BaseModel):
    notes: List[HarmonyNoteData]
    key: str = Field(..., description="Key signature e.g. 'C Major', 'A Minor'")

class HarmonyAnalysisResponse(BaseModel):
    chord_events: List[ChordEvent]


# ─── Harmonic Analysis Core Functions ─────────────────────────────────────────

def normalize_chord_spelling(chord_obj: m21.chord.Chord) -> m21.chord.Chord:
    """
    Normalize enharmonic spelling of chord pitches for consistent analysis.
    Converts pitch spellings to be theoretically consistent with the chord's root and quality.
    """
    try:
        pitch_classes = sorted(set(p.pitchClass for p in chord_obj.pitches))

        if len(pitch_classes) < 3:
            return chord_obj

        def score_root_candidate(root_pc_candidate):
            intervals = sorted([(pc - root_pc_candidate) % 12 for pc in pitch_classes])
            if intervals == [0, 4, 7]: return 100
            elif intervals == [0, 3, 7]: return 100
            elif intervals == [0, 4, 8]: return 90
            elif intervals == [0, 3, 6]: return 100
            elif intervals[:3] == [0, 4, 7]: return 95
            elif intervals[:3] == [0, 3, 7]: return 95
            elif intervals[:4] == [0, 3, 6, 9]: return 95
            elif intervals[:4] == [0, 3, 6, 10]: return 95
            else:
                return 50 if 7 in intervals else 0

        best_root_pc = None
        best_score = -1
        for pc in pitch_classes:
            score = score_root_candidate(pc)
            if score > best_score or (score == best_score and best_score > 0 and (best_root_pc is None or pc < best_root_pc)):
                best_score = score
                best_root_pc = pc

        if best_root_pc is None:
            best_root_pc = pitch_classes[0]

        root_pc = best_root_pc
        pc_to_note = {
            0: 'C', 1: 'C#', 2: 'D', 3: 'Eb', 4: 'E', 5: 'F',
            6: 'F#', 7: 'G', 8: 'Ab', 9: 'A', 10: 'Bb', 11: 'B'
        }
        root_name = pc_to_note[root_pc]
        root_letter = root_name[0]
        root_accidental = root_name[1:] if len(root_name) > 1 else ''
        use_sharps = root_name in ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']

        normalized_pitches = []
        reordered_pcs = [root_pc] + [pc for pc in pitch_classes if pc != root_pc]

        all_intervals = sorted([(pc - root_pc) % 12 for pc in pitch_classes])
        is_diminished = (len(all_intervals) >= 3 and all_intervals[:3] == [0, 3, 6])

        current_octave = 4
        for i, pc in enumerate(reordered_pcs):
            target_semitones = (pc - root_pc) % 12
            if target_semitones == 0:
                normalized_pitches.append(m21.pitch.Pitch(root_name + str(current_octave)))
            else:
                if target_semitones == 6 and is_diminished:
                    degree_offset, accidental_hint = 4, 'b'
                elif target_semitones == 1:
                    degree_offset, accidental_hint = 1, 'b'
                elif target_semitones == 2:
                    degree_offset, accidental_hint = 1, ''
                elif target_semitones == 3:
                    degree_offset, accidental_hint = 2, 'b'
                elif target_semitones == 4:
                    degree_offset, accidental_hint = 2, ''
                elif target_semitones == 5:
                    degree_offset, accidental_hint = 3, ''
                elif target_semitones == 6:
                    degree_offset, accidental_hint = 3, '#'
                elif target_semitones == 7:
                    degree_offset, accidental_hint = 4, ''
                elif target_semitones == 8:
                    degree_offset, accidental_hint = 4, '#'
                elif target_semitones == 9:
                    degree_offset, accidental_hint = 5, ''
                elif target_semitones == 10:
                    degree_offset, accidental_hint = 6, 'b'
                elif target_semitones == 11:
                    degree_offset, accidental_hint = 6, ''
                else:
                    degree_offset, accidental_hint = 0, ''

                steps = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
                root_idx = steps.index(root_letter)
                target_letter = steps[(root_idx + degree_offset) % 7]

                letter_semitones = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
                root_base_semitones = letter_semitones[root_letter]
                if root_accidental == 'b':
                    root_base_semitones = (root_base_semitones - 1) % 12
                elif root_accidental == '#':
                    root_base_semitones = (root_base_semitones + 1) % 12

                target_base_semitones = letter_semitones[target_letter]
                natural_interval = (target_base_semitones - root_base_semitones) % 12
                semitone_diff = target_semitones - natural_interval

                if semitone_diff == 0:
                    final_accidental = ''
                elif semitone_diff == 1:
                    final_accidental = '#'
                elif semitone_diff == -1:
                    final_accidental = 'b'
                elif semitone_diff == 2:
                    final_accidental = '##' if use_sharps else 'b'
                elif semitone_diff == -2:
                    final_accidental = 'bb' if not use_sharps else '#'
                else:
                    final_accidental = ''

                pitch_obj = m21.pitch.Pitch(target_letter + final_accidental + str(current_octave))
                if i > 0 and pitch_obj.midi < normalized_pitches[0].midi:
                    pitch_obj.octave += 1
                normalized_pitches.append(pitch_obj)

        normalized_chord = m21.chord.Chord(normalized_pitches)
        return normalized_chord

    except Exception as ex:
        print(f"Chord spelling normalization failed: {ex}")
        return chord_obj


def format_chord(chord_obj: m21.chord.Chord) -> str:
    """
    Format a chord object into a standardized chord label using music21 + custom rules.
    """
    try:
        try:
            fig = m21.harmony.chordSymbolFigureFromChord(chord_obj)
            if fig and 'Chord Symbol Cannot Be Identified' not in fig:
                root_name = chord_obj.root().name
                if '-' in root_name:
                    fig = fig.replace(root_name, root_name.replace('-', 'b'))
                fig = re.sub(r'^([A-G][b#]?)-', r'\1m', fig)
                fig = fig.replace('ø7', 'm7b5')
                fig = fig.replace('ø', 'm7b5')
                if 'dim7' in fig:
                    fig = fig.replace('dim7', 'o7')
                fig = fig.replace('+', 'aug')
                fig = re.sub(r'sus(?!\d)', 'sus4', fig)
                fig = re.sub(r'add([A-G][b#]?)', 'add9', fig)
                fig = re.sub(r'([A-G][b#]?)mM7', r'\1m(maj7)', fig)
                if any(x in fig.lower() for x in ['power', 'alt']):
                    return '?'
                if len(fig) > 12:
                    return '?'
                return fig
        except Exception:
            pass

        root = chord_obj.root().name
        quality = getattr(chord_obj, 'quality', '') or ''
        common = (chord_obj.commonName or '').lower()

        if any(x in common for x in ['cluster', 'tetrachord', 'pentachord', 'hexachord', 'heptachord', 'tritone']):
            return '?'

        if 'major thirteenth' in common: suffix = 'maj13'
        elif 'dominant thirteenth' in common: suffix = '13'
        elif 'major eleventh' in common: suffix = 'maj11'
        elif 'dominant eleventh' in common: suffix = '11'
        elif 'major ninth' in common: suffix = 'maj9'
        elif 'minor ninth' in common: suffix = 'm9'
        elif 'dominant ninth' in common or 'dominant-ninth' in common: suffix = '9'
        elif 'minor eleventh' in common: suffix = 'm11'
        elif 'minor thirteenth' in common: suffix = 'm13'
        elif 'major seventh' in common: suffix = 'maj7'
        elif 'minor seventh' in common: suffix = 'm7'
        elif 'dominant seventh' in common or 'major-minor seventh' in common: suffix = '7'
        elif 'half-diminished seventh' in common: suffix = 'm7b5'
        elif 'diminished seventh' in common: suffix = 'o7'
        elif 'minor-major seventh' in common or 'minor major seventh' in common: suffix = 'm(maj7)'
        elif 'augmented seventh' in common: suffix = 'aug7'
        elif 'suspended fourth' in common or 'sus4' in common: suffix = 'sus4'
        elif 'suspended second' in common or 'sus2' in common: suffix = 'sus2'
        else:
            quality_map = {
                'major': '', 'minor': 'm', 'diminished': 'dim',
                'augmented': 'aug', 'half-diminished': 'm7b5', 'dominant': '7'
            }
            suffix = quality_map.get(quality, '')

        if chord_obj.pitches and len(chord_obj.pitches) == 4:
            root_pc = chord_obj.root().pitchClass
            intervals = sorted(set((p.pitchClass - root_pc) % 12 for p in chord_obj.pitches))
            if 2 in intervals:
                if intervals == [0, 2, 4, 7]: suffix = 'add9'
                elif intervals == [0, 2, 3, 7]: suffix = 'madd9'

        label = f"{root}{suffix}" if suffix is not None else root
        if len(label) > 10:
            return '?'
        return label
    except Exception:
        return '?'


def convert_chord_spelling(chord_label: str, target_spelling: str) -> str:
    """Convert chord label from sharps to flats or vice versa."""
    if target_spelling not in ['sharp', 'flat']:
        return chord_label

    sharp_to_flat = {'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb', 'E#': 'F', 'B#': 'C'}
    flat_to_sharp = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#', 'Fb': 'E', 'Cb': 'B'}

    if '/' in chord_label:
        root_part, bass_part = chord_label.split('/', 1)
    else:
        root_part = chord_label
        bass_part = None

    root_match = re.match(r'^([A-G][#b]?)', root_part)
    if not root_match:
        return chord_label

    root_note = root_match.group(1)
    suffix = root_part[len(root_note):]

    if target_spelling == 'flat' and root_note in sharp_to_flat:
        new_root = sharp_to_flat[root_note]
    elif target_spelling == 'sharp' and root_note in flat_to_sharp:
        new_root = flat_to_sharp[root_note]
    else:
        new_root = root_note

    new_label = new_root + suffix

    if bass_part:
        bass_match = re.match(r'^([A-G][#b]?)', bass_part)
        if bass_match:
            bass_note = bass_match.group(1)
            if target_spelling == 'flat' and bass_note in sharp_to_flat:
                new_bass = sharp_to_flat[bass_note]
            elif target_spelling == 'sharp' and bass_note in flat_to_sharp:
                new_bass = flat_to_sharp[bass_note]
            else:
                new_bass = bass_note
            new_label += '/' + new_bass
        else:
            new_label += '/' + bass_part

    return new_label


def get_notation_preference(key_obj: m21.key.Key) -> str:
    """Determine whether to use sharps or flats based on key signature."""
    if key_obj is None:
        return 'sharp'
    # Flat keys: F, Bb, Eb, Ab, Db, Gb, Cb + their relative minors
    flat_major_keys = {'F', 'B-', 'E-', 'A-', 'D-', 'G-', 'C-'}
    tonic_name = key_obj.tonic.name
    if tonic_name in flat_major_keys:
        return 'flat'
    if key_obj.mode == 'minor':
        # Relative minor of flat keys
        flat_minor_keys = {'D', 'G', 'C', 'F', 'B-', 'E-', 'A-'}
        if tonic_name in flat_minor_keys:
            return 'flat'
    return 'sharp'


def get_roman_degree_name(semitones: int, mode: str) -> str:
    degree_names = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII']
    return degree_names[semitones % 12]


def is_chord_diatonic(chord_obj: m21.chord.Chord, key_obj: m21.key.Key) -> bool:
    key_pitch_classes = {p.pitchClass for p in key_obj.pitches}
    return all(p.pitchClass in key_pitch_classes for p in chord_obj.pitches)


def analyze_harmony(notes: List[HarmonyNoteData], key_str: str) -> List[ChordEvent]:
    """
    Analyze chords and Roman numerals from a list of notes using music21.
    Groups simultaneous notes into chords at each unique start time.
    """
    key_obj = parse_user_key(key_str)
    notation_pref = get_notation_preference(key_obj) if key_obj else 'sharp'

    # Sort notes and find all unique start times
    sorted_notes = sorted(notes, key=lambda n: (n.start, n.note))
    start_times = sorted(set(n.start for n in sorted_notes))

    chord_events: List[ChordEvent] = []

    for t in start_times:
        # All notes sounding at this moment (started at or before t, end after t)
        sounding = [n for n in sorted_notes if n.start <= t < round(n.start + n.duration, 5)]
        if not sounding:
            continue

        # Collect unique pitch classes
        pitches = []
        for n in sorted(sounding, key=lambda x: m21.pitch.Pitch(x.note).midi):
            p = m21.pitch.Pitch(n.note)
            if p.pitchClass not in [x.pitchClass for x in pitches]:
                pitches.append(p)

        if len(pitches) < 3:
            continue

        original_bass = pitches[0]  # lowest sounding pitch

        # Build and normalize chord
        c = m21.chord.Chord(pitches)
        c = normalize_chord_spelling(c)
        label = format_chord(c)

        if label == '?':
            continue

        # Detect inversion
        normalized_root = c.root()
        inversion_str = None
        if original_bass.pitchClass != normalized_root.pitchClass:
            bass_name = original_bass.name.replace('-', 'b')
            # Apply enharmonic conversion to bass note
            bass_name = convert_chord_spelling(bass_name, notation_pref)
            inversion_str = f"/{bass_name}"
            label = f"{label}{inversion_str}"

        # Apply notation preference to chord label
        label = convert_chord_spelling(label, notation_pref)

        # Determine if diatonic
        is_diatonic = True
        if key_obj:
            is_diatonic = is_chord_diatonic(c, key_obj)

        # Calculate Roman numeral
        roman_numeral = '?'
        if key_obj:
            try:
                root = c.root()
                tonic_pitch = m21.pitch.Pitch(key_obj.tonic.name + '4')
                root_pitch = m21.pitch.Pitch(root.name + '4')
                if root_pitch < tonic_pitch:
                    root_pitch.octave += 1

                interval = m21.interval.Interval(tonic_pitch, root_pitch)
                semitones = interval.semitones % 12
                base_degree = get_roman_degree_name(semitones, key_obj.mode)

                degree_match = re.match(r'^([b#]*)([IViv]+)$', base_degree)
                if degree_match:
                    accidental = degree_match.group(1)
                    numeral = degree_match.group(2)
                else:
                    accidental = ''
                    numeral = base_degree

                is_minor = ('m' in label and 'maj' not in label) or 'm(maj7)' in label or 'madd9' in label
                is_dim = 'dim' in label or 'o7' in label
                is_aug = 'aug' in label

                if is_dim:
                    rn_base = accidental + numeral.lower() + 'o'
                elif is_minor:
                    rn_base = accidental + numeral.lower()
                elif is_aug:
                    rn_base = accidental + numeral.upper() + '+'
                else:
                    rn_base = accidental + numeral.upper()

                ext = ""
                if 'sus' not in label and 'add9' not in label and 'madd9' not in label:
                    m_ext = re.search(r'(m\(maj7\)|maj13|maj11|maj9|maj7|m7b5|m13|m11|m9|m7|o7|13|11|9|7)$', label)
                    if m_ext:
                        ext_match = m_ext.group(1)
                        if ext_match == 'm7b5':
                            ext = 'ø7' if 'o' not in rn_base else '7'
                        elif ext_match == 'o7':
                            ext = '7'
                        elif ext_match == 'm(maj7)':
                            ext = ""
                        elif rn_base and rn_base[-1].islower() and ext_match.startswith('m') and ext_match not in ['maj7', 'maj9', 'maj11', 'maj13', 'm7b5', 'm(maj7)']:
                            ext = ext_match[1:]
                        else:
                            ext = ext_match

                roman_numeral = rn_base + ext
            except Exception as ex:
                print(f"Roman numeral calc failed at t={t}: {ex}")
                roman_numeral = '?'

        chord_events.append(ChordEvent(
            start=t,
            chord_label=label,
            roman_numeral=roman_numeral,
            is_diatonic=is_diatonic,
            inversion=inversion_str,
        ))

    return chord_events


# ─── Harmonic Analysis Endpoint ───────────────────────────────────────────────

@app.post("/analyze/harmony", response_model=HarmonyAnalysisResponse)
async def analyze_harmony_endpoint(request: HarmonyAnalysisRequest):
    """
    Analyze chords and Roman numerals from MIDI notes.
    Groups notes by start time, identifies chords with inversions,
    and returns chord label + Roman numeral for each unique chord moment.
    """
    try:
        chord_events = analyze_harmony(request.notes, request.key)
        return HarmonyAnalysisResponse(chord_events=chord_events)
    except Exception as e:
        print(f"Harmony analysis error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


# ─── MusicXML Export Helpers ──────────────────────────────────────────────────

QUANTIZE_GRID = 0.25  # 1/16 note = 0.25 quarter-beats


def quantize_value(value: float, grid: float = QUANTIZE_GRID) -> float:
    """Round value to nearest grid unit."""
    return round(round(value / grid) * grid, 6)


def build_measures(
    sorted_items,          # list of items with .start (absolute beat)
    beats_per_measure: float,
    total_beats: float,
    main_ts: m21.meter.TimeSignature,
    make_element,          # callable(item) -> m21 element with .quarterLength set
    extra_inserts=None,    # list of (measure_num, offset, element) to insert
) -> list:
    """
    Build a list of m21.stream.Measure objects for one part.
    All measures are the same time signature.
    Notes crossing measure boundaries are split with ties.
    """
    epsilon = 1e-6
    measures = []
    
    # Start from measure 1 (no pickup)
    measure_num = 1
    measure_start = 0.0
    current_m = m21.stream.Measure(number=measure_num)
    # Only show time signature in first measure
    current_m.timeSignature = main_ts
    cursor = 0.0

    def close_measure_and_start_new():
        nonlocal current_m, measure_num, measure_start, cursor
        # Fill any remaining space with rest
        measure_end = measure_start + beats_per_measure
        tail = round(measure_end - cursor, 6)
        if tail > epsilon:
            offset_in_m = round(cursor - measure_start, 6)
            current_m.insert(offset_in_m, m21.note.Rest(quarterLength=tail))
        measures.append(current_m)
        measure_start = measure_end
        measure_num += 1
        current_m = m21.stream.Measure(number=measure_num)
        cursor = measure_start

    for item in sorted_items:
        abs_start = item.start
        el = make_element(item)
        note_end = round(abs_start + el.quarterLength, 6)

        # Advance to measure containing this note's start
        while abs_start >= round(measure_start + beats_per_measure, 6) - epsilon:
            close_measure_and_start_new()

        # Fill gap before note
        gap = round(abs_start - cursor, 6)
        if gap > epsilon:
            rest_offset = round(cursor - measure_start, 6)
            current_m.insert(rest_offset, m21.note.Rest(quarterLength=gap))
            cursor = abs_start

        # Check if note crosses measure boundary
        measure_end = measure_start + beats_per_measure
        if note_end > measure_end + epsilon:
            # Note crosses boundary - split with ties
            duration_in_current = round(measure_end - abs_start, 6)
            el_first = make_element(item)
            el_first.quarterLength = duration_in_current
            el_first.tie = m21.tie.Tie('start')  # Start tie
            offset_in_m = round(abs_start - measure_start, 6)
            current_m.insert(offset_in_m, el_first)
            cursor = measure_end
            close_measure_and_start_new()
            
            # Insert continuation(s) in next measure(s)
            remaining_duration = round(note_end - measure_end, 6)
            remaining_start = measure_end
            is_first_continuation = True
            
            while remaining_duration > epsilon:
                measure_end_next = measure_start + beats_per_measure
                duration_in_next = min(remaining_duration, round(measure_end_next - remaining_start, 6))
                
                el_next = make_element(item)
                el_next.quarterLength = duration_in_next
                
                # Set tie type
                if remaining_duration > duration_in_next + epsilon:
                    # More segments to come
                    el_next.tie = m21.tie.Tie('continue')
                else:
                    # Last segment
                    el_next.tie = m21.tie.Tie('stop')
                
                offset_in_next = round(remaining_start - measure_start, 6)
                current_m.insert(offset_in_next, el_next)
                
                cursor = round(remaining_start + duration_in_next, 6)
                remaining_duration = round(remaining_duration - duration_in_next, 6)
                remaining_start = cursor
                is_first_continuation = False
                
                if remaining_duration > epsilon:
                    close_measure_and_start_new()
        else:
            # Note fits in current measure
            offset_in_m = round(abs_start - measure_start, 6)
            current_m.insert(offset_in_m, el)
            cursor = note_end

            # Close measure if note ends exactly at boundary
            if abs(cursor - (measure_start + beats_per_measure)) < epsilon:
                close_measure_and_start_new()

    # Close final measure
    if cursor < round(total_beats, 6) - epsilon:
        while cursor < round(total_beats, 6) - epsilon:
            measure_end = measure_start + beats_per_measure
            fill_end = min(measure_end, total_beats)
            fill = round(fill_end - cursor, 6)
            if fill > epsilon:
                current_m.insert(round(cursor - measure_start, 6), m21.note.Rest(quarterLength=fill))
            cursor = fill_end
            if abs(cursor - measure_end) < epsilon:
                measures.append(current_m)
                measure_start = measure_end
                measure_num += 1
                if cursor < round(total_beats, 6) - epsilon:
                    current_m = m21.stream.Measure(number=measure_num)
                    cursor = measure_start
                else:
                    break
    else:
        tail = round((measure_start + beats_per_measure) - cursor, 6)
        if tail > epsilon:
            current_m.insert(round(cursor - measure_start, 6), m21.note.Rest(quarterLength=tail))
        measures.append(current_m)

    # Extra inserts (tempo, clef, key)
    if extra_inserts:
        m_by_num = {m.number: m for m in measures}
        for m_num, offset, element in extra_inserts:
            if m_num in m_by_num:
                m_by_num[m_num].insert(offset, element)

    return measures


@app.post("/export/musicxml")
async def export_musicxml(request: MusicXMLExportRequest):
    """
    Export a Grand Staff (Lead Sheet) to MusicXML:
    - Part 1 (Melody): treble clef, melody notes with scale-degree lyrics
    - Part 2 (Harmony): bass clef, chord notes with ChordSymbol + RN annotations
    Both parts share the same measure structure.
    Quantized to 1/16 note grid.
    """
    try:
        print("="*80)
        print("[MusicXML Export] Starting Grand Staff export...")
        print(f"[MusicXML Export] key={request.key}, tempo={request.tempo}, "
              f"pickup={request.pickup_beats}, title={request.title}")
        print(f"[MusicXML Export] Melody notes: {len(request.notes)}, "
              f"Chord notes: {len(request.chord_notes)}, "
              f"Annotations: {len(request.chord_annotations)}")

        # ── Parse key ────────────────────────────────────────────────────────
        key_obj = parse_user_key(request.key)
        if not key_obj:
            raise HTTPException(status_code=400, detail=f"Invalid key: {request.key}")

        # ── Parse time signature ─────────────────────────────────────────────
        try:
            main_ts = m21.meter.TimeSignature(request.time_signature)
        except Exception:
            main_ts = m21.meter.TimeSignature('4/4')
        beats_per_measure = main_ts.numerator * (4.0 / main_ts.denominator)

        pickup_beats = float(request.pickup_beats or 0)

        # ── Quantize helper (1/16 = 0.25 ql) ────────────────────────────────
        def q(val):
            return quantize_value(val, QUANTIZE_GRID)

        def quantize_notes(raw_notes):
            out = []
            for nd in sorted(raw_notes, key=lambda n: n.start):
                nd2 = nd.copy()
                nd2.start = q(nd.start)
                nd2.duration = max(QUANTIZE_GRID, q(nd.duration))
                out.append(nd2)
            return out

        melody_notes = quantize_notes(request.notes)
        chord_notes  = quantize_notes(request.chord_notes)

        # Build annotation lookup: start_time → ChordAnnotation
        ann_map = {}
        for ann in request.chord_annotations:
            key_t = q(ann.start)
            ann_map[key_t] = ann

        # ── Determine total score length (beats) ─────────────────────────────
        all_ends = []
        for n in melody_notes:
            all_ends.append(n.start + n.duration)
        for n in chord_notes:
            all_ends.append(n.start + n.duration)
        if not all_ends:
            all_ends = [beats_per_measure]

        # Round up to next full measure boundary
        raw_end = max(all_ends)
        full_measures_needed = max(1, int((raw_end + beats_per_measure - 1e-6) // beats_per_measure))
        total_beats = full_measures_needed * beats_per_measure
        print(f"[MusicXML Export] total_beats={total_beats}, full_measures={full_measures_needed}")

        # ── Score & metadata ─────────────────────────────────────────────────
        score = m21.stream.Score()
        score.insert(0, m21.metadata.Metadata())
        score.metadata.title    = request.title    or "Exported Melody"
        score.metadata.composer = request.composer or "EarMasterPro"
        score.metadata.lyricist = request.key

        tempo_mark = m21.tempo.MetronomeMark(number=request.tempo)
        # Insert tempo into first measure
        tempo_target_measure = 1

        # ── PART 1: Melody (treble clef) ─────────────────────────────────────
        melody_part = m21.stream.Part()
        melody_part.id = "Melody"
        melody_part.partName = "Melody"

        def make_melody_element(nd):
            el = m21.note.Note(nd.pitch)
            el.quarterLength = nd.duration
            if nd.scale_degree:
                el.lyrics.append(m21.note.Lyric(str(nd.scale_degree)))
            return el

        # Only create melody part if there are melody notes
        if melody_notes:
            melody_measures = build_measures(
                melody_notes, beats_per_measure, total_beats,
                main_ts, make_melody_element,
                extra_inserts=[
                    (tempo_target_measure, 0, tempo_mark),
                    (tempo_target_measure, 0, m21.clef.TrebleClef()),
                    (tempo_target_measure, 0, key_obj),
                ]
            )
            for m_obj in melody_measures:
                melody_part.append(m_obj)
            score.insert(0, melody_part)

        # ── PART 2: Harmony (bass clef) ──────────────────────────────────────
        harmony_part = m21.stream.Part()
        harmony_part.id = "Harmony"
        harmony_part.partName = "Chords"

        # Group chord notes by start time to create vertical chords
        from collections import defaultdict
        chord_groups = defaultdict(list)
        for cn in chord_notes:
            chord_groups[cn.start].append(cn)
        
        # Create chord objects (each group = one chord with multiple pitches)
        class ChordGroup:
            def __init__(self, start, duration, pitches):
                self.start = start
                self.duration = duration
                self.pitches = pitches
        
        chord_objects = []
        for start_time in sorted(chord_groups.keys()):
            notes_at_time = chord_groups[start_time]
            # All notes at same start time should have same duration
            # Use the first note's duration (they should all match)
            duration = notes_at_time[0].duration
            pitches = [n.pitch for n in notes_at_time]
            chord_objects.append(ChordGroup(start_time, duration, pitches))
        
        def make_chord_element(cg):
            """Create a m21.chord.Chord from a ChordGroup."""
            if len(cg.pitches) == 1:
                # Single note
                el = m21.note.Note(cg.pitches[0])
            else:
                # Multiple notes = chord
                el = m21.chord.Chord(cg.pitches)
            el.quarterLength = cg.duration
            return el

        # Build chord symbol + RN extra inserts (measure-level)
        # We need to map annotation start times → measure number + offset
        def beat_to_measure_offset(abs_beat):
            """Return (measure_number, offset_within_measure) for an absolute beat."""
            # Measures start at 1, each measure is beats_per_measure beats
            m_num = int(abs_beat // beats_per_measure) + 1
            offset = abs_beat - ((m_num - 1) * beats_per_measure)
            return (m_num, round(offset, 6))

        harmony_extra = []
        # Add clef and key to harmony part
        harmony_extra.append((tempo_target_measure, 0, m21.clef.BassClef()))
        harmony_extra.append((tempo_target_measure, 0, key_obj))

        for ann in request.chord_annotations:
            start_q = q(ann.start)
            m_num, offset = beat_to_measure_offset(start_q)

            # ChordSymbol above staff
            try:
                cs = m21.harmony.ChordSymbol(ann.chord_label)
                harmony_extra.append((m_num, offset, cs))
            except Exception as e:
                print(f"[MusicXML Export] ChordSymbol failed for '{ann.chord_label}': {e}")
                # Fall back to TextExpression
                te = m21.expressions.TextExpression(ann.chord_label)
                te.style.absoluteY = 40
                harmony_extra.append((m_num, offset, te))

            # Roman numeral as lyric on the nearest chord note in that measure
            # We use a TextExpression placed below the staff
            rn_te = m21.expressions.TextExpression(ann.roman_numeral)
            rn_te.style.absoluteY = -60   # below the staff
            rn_te.style.fontSize  = 10
            harmony_extra.append((m_num, offset, rn_te))

        # Only create harmony part if there are chord notes
        if chord_notes:
            harmony_measures = build_measures(
                chord_objects, beats_per_measure, total_beats,
                main_ts, make_chord_element,
                extra_inserts=harmony_extra
            )
            for m_obj in harmony_measures:
                harmony_part.append(m_obj)
            score.insert(0, harmony_part)

        # ── Write to temp file ───────────────────────────────────────────────
        temp_dir = tempfile.gettempdir()
        output_filename = f"earmaster_export_{uuid.uuid4().hex[:8]}.musicxml"
        output_path = os.path.join(temp_dir, output_filename)

        print(f"[MusicXML Export] Writing to: {output_path}")
        score.write('musicxml', fp=output_path, makeNotation=True)
        print("[MusicXML Export] Export complete!")
        print("="*80)

        title_safe = (request.title or "melody").replace(' ', '_')
        return FileResponse(
            path=output_path,
            filename=f"{title_safe}.musicxml",
            media_type="application/vnd.recordare.musicxml+xml"
        )

    except Exception as e:
        print(f"MusicXML export error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "EarMasterPro Backend"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("EARMASTER_BACKEND_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port)
