#!/usr/bin/env python3
"""
Comprehensive test suite for EarMasterPro harmonic analysis backend.
Tests chord identification, Roman numerals, inversions, enharmonic spelling,
and edge cases across all major and minor keys.

Run with: python3 test_harmony.py
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from main import (
    HarmonyNoteData, parse_user_key, normalize_chord_spelling,
    format_chord, convert_chord_spelling, get_notation_preference, analyze_harmony
)
import music21 as m21

# ─── Helpers ───────────────────────────────────────────────────────────────────

PASS_COUNT = 0
FAIL_COUNT = 0
FAIL_DETAILS = []

def check(test_name, condition, detail=""):
    global PASS_COUNT, FAIL_COUNT, FAIL_DETAILS
    if condition:
        PASS_COUNT += 1
        print(f"  ✅ {test_name}")
    else:
        FAIL_COUNT += 1
        msg = f"  ❌ {test_name}" + (f" — {detail}" if detail else "")
        print(msg)
        FAIL_DETAILS.append(msg)

def make_notes(tuples):
    """Create HarmonyNoteData list from (note, start, duration) tuples."""
    return [HarmonyNoteData(note=n, start=s, duration=d) for n, s, d in tuples]

def get_chord_at(chord_events, start):
    """Find the chord event at a given start time."""
    for e in chord_events:
        if abs(e.start - start) < 0.001:
            return e
    return None

# ─── 1. Key Parsing ────────────────────────────────────────────────────────────

def test_key_parsing():
    print("\n═══ 1. Key Parsing ═══")

    k = parse_user_key("C Major")
    check("C Major parses correctly", k is not None and k.tonic.name == "C" and k.mode == "major")

    k = parse_user_key("A Minor")
    check("A Minor parses correctly", k is not None and k.tonic.name == "A" and k.mode == "minor")

    k = parse_user_key("F# Minor")
    check("F# Minor parses correctly", k is not None and "F" in k.tonic.name and k.mode == "minor")

    k = parse_user_key("Bb Major")
    check("Bb Major parses correctly", k is not None and k.mode == "major")

    k = parse_user_key("Eb Major")
    check("Eb Major parses correctly", k is not None and k.mode == "major")

    k = parse_user_key("")
    check("Empty string returns None", k is None)

    k = parse_user_key("C")
    check("Key without mode defaults to major", k is not None and k.mode == "major")

# ─── 2. Chord Normalization ────────────────────────────────────────────────────

def test_chord_normalization():
    print("\n═══ 2. Chord Normalization ═══")

    c = m21.chord.Chord([m21.pitch.Pitch('C4'), m21.pitch.Pitch('E4'), m21.pitch.Pitch('G4')])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("C major triad → 'C'", label == "C", f"got '{label}'")

    c = m21.chord.Chord([m21.pitch.Pitch('A3'), m21.pitch.Pitch('C4'), m21.pitch.Pitch('E4')])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("A minor triad → 'Am'", label == "Am", f"got '{label}'")

    c = m21.chord.Chord([m21.pitch.Pitch('B3'), m21.pitch.Pitch('D4'), m21.pitch.Pitch('G4')])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("B D G normalizes to G major chord", "G" in label, f"got '{label}'")

    c = m21.chord.Chord([m21.pitch.Pitch('Ab3'), m21.pitch.Pitch('B3'), m21.pitch.Pitch('E4')])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("Ab B E normalized → E major", "E" in label, f"got '{label}'")

# ─── 3. Chord Formatting ──────────────────────────────────────────────────────

def test_chord_formatting():
    print("\n═══ 3. Chord Formatting ═══")

    c = m21.chord.Chord(['C4', 'E4', 'G4', 'B4'])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("C E G B → Cmaj7", "maj7" in label, f"got '{label}'")

    c = m21.chord.Chord(['G3', 'B3', 'D4', 'F4'])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("G B D F → G7", label in ("G7", "Gdom7"), f"got '{label}'")

    c = m21.chord.Chord(['A3', 'C4', 'E4', 'G4'])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("A C E G → Am7", "m7" in label, f"got '{label}'")

    c = m21.chord.Chord(['B3', 'D4', 'F4'])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("B D F → Bdim", "dim" in label.lower() or "o" in label.lower(), f"got '{label}'")

    c = m21.chord.Chord(['C4', 'E4', 'G#4'])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("C E G# → Caug", "aug" in label.lower(), f"got '{label}'")

    c = m21.chord.Chord(['C4', 'F4', 'G4'])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("C F G → Csus4", "sus4" in label, f"got '{label}'")

    c = m21.chord.Chord(['C4', 'D4', 'G4'])
    nc = normalize_chord_spelling(c)
    label = format_chord(nc)
    check("C D G → Csus2", "sus2" in label, f"got '{label}'")

# ─── 4. Chord Spelling Conversion ─────────────────────────────────────────────

def test_chord_spelling_conversion():
    print("\n═══ 4. Chord Spelling Conversion ═══")

    check("C#m → Dbm (flat)", convert_chord_spelling("C#m", "flat") == "Dbm")
    check("Dbm → C#m (sharp)", convert_chord_spelling("Dbm", "sharp") == "C#m")
    check("F# → Gb (flat)", convert_chord_spelling("F#", "flat") == "Gb")
    check("Ab → G# (sharp)", convert_chord_spelling("Ab", "sharp") == "G#")
    check("C stays C (flat)", convert_chord_spelling("C", "flat") == "C")
    check("C stays C (sharp)", convert_chord_spelling("C", "sharp") == "C")
    check("G/B stays G/B (sharp)", convert_chord_spelling("G/B", "sharp") == "G/B")
    r = convert_chord_spelling("Ab/Eb", "sharp")
    check("Ab/Eb → G#/D# (sharp)", r == "G#/D#", f"got '{r}'")

# ─── 5. Notation Preference by Key ────────────────────────────────────────────

def test_notation_preference():
    print("\n═══ 5. Notation Preference by Key ═══")

    sharp_keys = ["C Major", "G Major", "D Major", "A Major", "E Major", "B Major", "F# Major", "C# Major",
                  "A Minor", "E Minor", "B Minor", "F# Minor", "C# Minor", "G# Minor", "D# Minor", "A# Minor"]
    flat_keys  = ["F Major", "Bb Major", "Eb Major", "Ab Major", "Db Major", "Gb Major", "Cb Major",
                  "D Minor", "G Minor", "C Minor", "F Minor", "Bb Minor", "Eb Minor", "Ab Minor"]

    for ks in sharp_keys:
        k = parse_user_key(ks)
        pref = get_notation_preference(k)
        check(f"{ks} → sharp notation", pref == "sharp", f"got '{pref}'")

    for ks in flat_keys:
        k = parse_user_key(ks)
        pref = get_notation_preference(k)
        check(f"{ks} → flat notation", pref == "flat", f"got '{pref}'")

# ─── 6. Roman Numeral Accuracy (C Major diatonic triads) ──────────────────────

def test_roman_numerals_c_major():
    print("\n═══ 6. Roman Numerals — C Major diatonic triads ═══")

    test_cases = [
        (["C4", "E4", "G4"],  "C Major", "I"),
        (["D4", "F4", "A4"],  "C Major", "ii"),
        (["E4", "G4", "B4"],  "C Major", "iii"),
        (["F4", "A4", "C5"],  "C Major", "IV"),
        (["G3", "B3", "D4"],  "C Major", "V"),
        (["A3", "C4", "E4"],  "C Major", "vi"),
        (["B3", "D4", "F4"],  "C Major", "viio"),
    ]

    for pitches, key, expected in test_cases:
        notes = make_notes([(p, 0, 2) for p in pitches])
        events = analyze_harmony(notes, key)
        check(
            f"{' '.join(pitches)} in {key} → '{expected}'",
            len(events) > 0 and events[0].roman_numeral == expected and events[0].is_diatonic,
            f"got {[(e.roman_numeral, e.is_diatonic) for e in events]}"
        )

# ─── 7. Roman Numeral Accuracy (A Minor diatonic triads) ──────────────────────

def test_roman_numerals_a_minor():
    print("\n═══ 7. Roman Numerals — A Minor diatonic triads ═══")

    test_cases = [
        (["A3", "C4", "E4"],  "A Minor", "i"),
        (["B3", "D4", "F4"],  "A Minor", "iio"),
        (["C4", "E4", "G4"],  "A Minor", "bIII"),
        (["D4", "F4", "A4"],  "A Minor", "iv"),
        (["E4", "G4", "B4"],  "A Minor", "v"),
        (["F4", "A4", "C5"],  "A Minor", "bVI"),
        (["G4", "B4", "D5"],  "A Minor", "bVII"),
    ]

    for pitches, key, expected in test_cases:
        notes = make_notes([(p, 0, 2) for p in pitches])
        events = analyze_harmony(notes, key)
        check(
            f"{' '.join(pitches)} in {key} → '{expected}'",
            len(events) > 0 and events[0].roman_numeral == expected and events[0].is_diatonic,
            f"got {[(e.roman_numeral, e.is_diatonic) for e in events]}"
        )

    c_major = analyze_harmony(make_notes([("A3", 0, 2), ("C4", 0, 2), ("E4", 0, 2)]), "C Major")[0]
    a_minor = analyze_harmony(make_notes([("A3", 0, 2), ("C4", 0, 2), ("E4", 0, 2)]), "A Minor")[0]
    a_major = analyze_harmony(make_notes([("A3", 0, 2), ("C4", 0, 2), ("E4", 0, 2)]), "A Major")[0]
    check("Same Am chord re-analyzes as vi in C Major",
          c_major.roman_numeral == "vi" and c_major.is_diatonic,
          f"got {c_major.roman_numeral}, diatonic={c_major.is_diatonic}")
    check("Same Am chord re-analyzes as i in A Minor",
          a_minor.roman_numeral == "i" and a_minor.is_diatonic,
          f"got {a_minor.roman_numeral}, diatonic={a_minor.is_diatonic}")
    check("Same Am chord re-analyzes as non-diatonic i in A Major",
          a_major.roman_numeral == "i" and not a_major.is_diatonic,
          f"got {a_major.roman_numeral}, diatonic={a_major.is_diatonic}")

# ─── 8. Chord Labels in Flat Keys ─────────────────────────────────────────────

def test_chord_labels_flat_keys():
    print("\n═══ 8. Chord Labels in Flat Keys ═══")

    # Bb major: IV chord is Eb
    notes = make_notes([("D#4", 0, 2), ("G4", 0, 2), ("A#4", 0, 2)])
    events = analyze_harmony(notes, "Bb Major")
    chord_labels = [e.chord_label for e in events]
    check("Bb Major IV chord uses flat spelling (Eb)",
          any("Eb" in l for l in chord_labels),
          f"got {chord_labels}")

    # F major: V chord is C
    notes = make_notes([("C4", 0, 2), ("E4", 0, 2), ("G4", 0, 2)])
    events = analyze_harmony(notes, "F Major")
    chord_labels = [e.chord_label for e in events]
    check("F Major V chord is C (no conversion needed)",
          any("C" in l for l in chord_labels),
          f"got {chord_labels}")

    # Ab major: I chord is Ab
    notes = make_notes([("G#3", 0, 2), ("C4", 0, 2), ("D#4", 0, 2)])
    events = analyze_harmony(notes, "Ab Major")
    chord_labels = [e.chord_label for e in events]
    check("Ab Major I chord uses flat spelling (Ab)",
          any("Ab" in l for l in chord_labels),
          f"got {chord_labels}")

# ─── 9. Chord Labels in Sharp Keys ────────────────────────────────────────────

def test_chord_labels_sharp_keys():
    print("\n═══ 9. Chord Labels in Sharp Keys ═══")

    # D major: III chord is F#m
    notes = make_notes([("F#4", 0, 2), ("A4", 0, 2), ("C#5", 0, 2)])
    events = analyze_harmony(notes, "D Major")
    chord_labels = [e.chord_label for e in events]
    check("D Major III chord uses sharp spelling (F#m)",
          any("#" in l for l in chord_labels),
          f"got {chord_labels}")

    # A major: I chord is A
    notes = make_notes([("A3", 0, 2), ("C#4", 0, 2), ("E4", 0, 2)])
    events = analyze_harmony(notes, "A Major")
    chord_labels = [e.chord_label for e in events]
    check("A Major I chord is A (no accidental)",
          any(l.startswith("A") and not l.startswith("Ab") for l in chord_labels),
          f"got {chord_labels}")

# ─── 10. Inversions ───────────────────────────────────────────────────────────

def test_inversions():
    print("\n═══ 10. Chord Inversions ═══")

    # G major first inversion: B-D-G (bass = B)
    notes = make_notes([("B3", 0, 2), ("D4", 0, 2), ("G4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("G/B detected (first inversion)",
          len(events) > 0 and "/B" in events[0].chord_label,
          f"got {[e.chord_label for e in events]}")

    # C major second inversion: G-C-E (bass = G)
    notes = make_notes([("G3", 0, 2), ("C4", 0, 2), ("E4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("C/G detected (second inversion)",
          len(events) > 0 and "/G" in events[0].chord_label,
          f"got {[e.chord_label for e in events]}")

# ─── 11. Seventh Chords ───────────────────────────────────────────────────────

def test_seventh_chords():
    print("\n═══ 11. Seventh Chords ═══")

    # Cmaj7
    notes = make_notes([("C4", 0, 2), ("E4", 0, 2), ("G4", 0, 2), ("B4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("Cmaj7 chord identified",
          len(events) > 0 and "maj7" in events[0].chord_label,
          f"got {[e.chord_label for e in events]}")

    # G7 (dominant)
    notes = make_notes([("G3", 0, 2), ("B3", 0, 2), ("D4", 0, 2), ("F4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("G7 (dominant 7th) identified",
          len(events) > 0 and events[0].chord_label in ("G7", "Gdom7"),
          f"got {[e.chord_label for e in events]}")

    # Am7
    notes = make_notes([("A3", 0, 2), ("C4", 0, 2), ("E4", 0, 2), ("G4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("Am7 identified",
          len(events) > 0 and "m7" in events[0].chord_label,
          f"got {[e.chord_label for e in events]}")

    # V7 roman numeral in C major
    notes = make_notes([("G3", 0, 2), ("B3", 0, 2), ("D4", 0, 2), ("F4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("G7 in C Major → V7",
          len(events) > 0 and "V7" in events[0].roman_numeral,
          f"got {[e.roman_numeral for e in events]}")

    # ii7 in C major (Dm7)
    notes = make_notes([("D4", 0, 2), ("F4", 0, 2), ("A4", 0, 2), ("C5", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("Dm7 in C Major → ii7",
          len(events) > 0 and "ii7" in events[0].roman_numeral,
          f"got {[e.roman_numeral for e in events]}")

# ─── 12. Multiple Chords in Sequence ──────────────────────────────────────────

def test_chord_sequence():
    print("\n═══ 12. Chord Sequence (I–IV–V–I) ═══")

    notes = make_notes([
        ("C4", 0, 2), ("E4", 0, 2), ("G4", 0, 2),
        ("F4", 2, 2), ("A4", 2, 2), ("C5", 2, 2),
        ("G3", 4, 2), ("B3", 4, 2), ("D4", 4, 2),
        ("C4", 6, 2), ("E4", 6, 2), ("G4", 6, 2),
    ])
    events = analyze_harmony(notes, "C Major")

    check("4 chord events detected", len(events) == 4, f"got {len(events)}")
    if len(events) >= 4:
        check("Beat 0 → I",   "I"  in events[0].roman_numeral and events[0].roman_numeral in ("I", "Imaj7"), f"got '{events[0].roman_numeral}'")
        check("Beat 2 → IV",  "IV" in events[1].roman_numeral, f"got '{events[1].roman_numeral}'")
        check("Beat 4 → V",   "V"  in events[2].roman_numeral, f"got '{events[2].roman_numeral}'")
        check("Beat 6 → I",   "I"  in events[3].roman_numeral and events[3].roman_numeral in ("I", "Imaj7"), f"got '{events[3].roman_numeral}'")
        check("All diatonic", all(e.is_diatonic for e in events), f"diatonic flags: {[e.is_diatonic for e in events]}")

# ─── 13. Non-diatonic Chords ──────────────────────────────────────────────────

def test_non_diatonic():
    print("\n═══ 13. Non-Diatonic Chords ═══")

    # Db major in C major context (non-diatonic)
    notes = make_notes([("Db4", 0, 2), ("F4", 0, 2), ("Ab4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("Db in C major is non-diatonic",
          len(events) > 0 and events[0].is_diatonic == False,
          f"diatonic={events[0].is_diatonic if events else 'no events'}")

    # C major in C major (diatonic)
    notes = make_notes([("C4", 0, 2), ("E4", 0, 2), ("G4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("C in C major is diatonic",
          len(events) > 0 and events[0].is_diatonic == True,
          f"diatonic={events[0].is_diatonic if events else 'no events'}")

# ─── 14. Edge Cases ───────────────────────────────────────────────────────────

def test_edge_cases():
    print("\n═══ 14. Edge Cases ═══")

    # Single note — not enough for a chord
    notes = make_notes([("C4", 0, 1)])
    events = analyze_harmony(notes, "C Major")
    check("Single note produces no chord events", len(events) == 0, f"got {len(events)}")

    # Two notes — not enough for a chord
    notes = make_notes([("C4", 0, 1), ("E4", 0, 1)])
    events = analyze_harmony(notes, "C Major")
    check("Two simultaneous notes produce no chord events", len(events) == 0, f"got {len(events)}")

    # Empty notes
    events = analyze_harmony([], "C Major")
    check("Empty note list produces no events", len(events) == 0, f"got {len(events)}")

    # Very high octave notes
    notes = make_notes([("C7", 0, 1), ("E7", 0, 1), ("G7", 0, 1)])
    events = analyze_harmony(notes, "C Major")
    check("High octave notes don't crash", events is not None, "")

    # Multiple keys don't crash
    for key_str in ["C Major", "G Major", "D Major", "F Major", "Bb Major",
                    "Eb Major", "A Minor", "E Minor", "D Minor", "F# Minor", "Ab Major", "Db Major"]:
        notes = make_notes([("C4", 0, 1), ("E4", 0, 1), ("G4", 0, 1)])
        try:
            events = analyze_harmony(notes, key_str)
            check(f"Key '{key_str}' doesn't crash", True)
        except Exception as ex:
            check(f"Key '{key_str}' doesn't crash", False, str(ex))

# ─── 15. Simultaneous Note Changes ───────────────────────────────────────────

def test_sustained_notes():
    print("\n═══ 15. Sustained Notes with Chord Changes ═══")

    # E4 sustained from 0–4, C4 and G4 also start at beat 0 (C major chord)
    # At beat 0: C4, E4, G4 all sounding → C major
    # At beat 2: new D4, F4, A4 start → Am chord (D4 duration 2, F4 duration 2, A4 duration 2)
    # E4 sustains into beat 2 but D,F,A are new → chord at beat 2 should be identified
    notes = make_notes([
        ("C4", 0, 2), ("E4", 0, 2), ("G4", 0, 2),
        ("D4", 2, 2), ("F4", 2, 2), ("A4", 2, 2),
    ])
    events = analyze_harmony(notes, "C Major")
    check("Chord at beat 0 identified (I)",
          any(abs(e.start - 0.0) < 0.001 for e in events),
          f"events at: {[e.start for e in events]}")
    check("Chord at beat 2 identified (ii)",
          any(abs(e.start - 2.0) < 0.001 for e in events),
          f"events at: {[e.start for e in events]}")

    # Test sustained note actually contributes at a new start time
    # C4 sustained 0–4, at beat 2 E4+G4 begin → 3 notes sounding (C4, E4, G4) = C chord
    notes = make_notes([
        ("C4", 0, 4),
        ("E4", 2, 2), ("G4", 2, 2),
    ])
    events = analyze_harmony(notes, "C Major")
    check("Sustained C4 contributes to chord at beat 2",
          any(abs(e.start - 2.0) < 0.001 for e in events),
          f"events at: {[e.start for e in events]}")

# ─── 16. Diminished & Half-Diminished ────────────────────────────────────────

def test_diminished_chords():
    print("\n═══ 16. Diminished & Half-Diminished ═══")

    # Bdim in C major
    notes = make_notes([("B3", 0, 2), ("D4", 0, 2), ("F4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("B D F → Bdim (viiο in C major)",
          len(events) > 0 and ("dim" in events[0].chord_label or "o" in events[0].chord_label),
          f"got {[e.chord_label for e in events]}")
    check("Bdim → viio Roman numeral",
          len(events) > 0 and "vii" in events[0].roman_numeral.lower() and "o" in events[0].roman_numeral,
          f"got {[e.roman_numeral for e in events]}")

    # Bm7b5 (half-diminished)
    notes = make_notes([("B3", 0, 2), ("D4", 0, 2), ("F4", 0, 2), ("A4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("B D F A → Bm7b5 or half-diminished",
          len(events) > 0 and ("m7b5" in events[0].chord_label or "ø" in events[0].chord_label),
          f"got {[e.chord_label for e in events]}")

# ─── 17. Accidental Tonic Diatonic Chords ─────────────────────────────────────

def test_accidental_tonic_diatonic_chords():
    print("\n═══ 17. Accidental Tonic Diatonic Chords ═══")

    explicit_cases = [
        ("A# Minor tonic with MIDI spelling F", "A# Minor", ["A#3", "C#4", "F4"], "i"),
        ("A# Minor v with MIDI spelling F/C", "A# Minor", ["F3", "G#3", "C4"], "v"),
        ("A# Minor bVII", "A# Minor", ["G#3", "C4", "D#4"], "bVII"),
        ("G# Minor tonic", "G# Minor", ["G#3", "B3", "D#4"], "i"),
        ("G# Minor v", "G# Minor", ["D#3", "F#3", "A#3"], "v"),
        ("G# Major tonic with MIDI spelling C", "G# Major", ["G#3", "C4", "D#4"], "I"),
        ("G# Major V with MIDI spelling G", "G# Major", ["D#3", "G3", "A#3"], "V"),
        ("A# Major tonic with MIDI spelling D/F", "A# Major", ["A#3", "D4", "F4"], "I"),
    ]

    for name, key, pitches, expected in explicit_cases:
        notes = make_notes([(p, 0, 2) for p in pitches])
        events = analyze_harmony(notes, key)
        check(name,
              len(events) > 0 and events[0].roman_numeral == expected and events[0].is_diatonic,
              f"got {[(e.chord_label, e.roman_numeral, e.is_diatonic) for e in events]}")

    ui_keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    pc_names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

    def pitch(pc):
        return f"{pc_names[pc % 12]}4"

    for tonic in ui_keys:
        tonic_pc = m21.pitch.Pitch(tonic + '4').pitchClass
        major_tonic = [pitch(tonic_pc), pitch(tonic_pc + 4), pitch(tonic_pc + 7)]
        major_dominant = [pitch(tonic_pc + 7), pitch(tonic_pc + 11), pitch(tonic_pc + 2)]
        minor_tonic = [pitch(tonic_pc), pitch(tonic_pc + 3), pitch(tonic_pc + 7)]
        minor_dominant = [pitch(tonic_pc + 7), pitch(tonic_pc + 10), pitch(tonic_pc + 2)]

        major_i = analyze_harmony(make_notes([(p, 0, 2) for p in major_tonic]), f"{tonic} Major")[0]
        major_v = analyze_harmony(make_notes([(p, 0, 2) for p in major_dominant]), f"{tonic} Major")[0]
        minor_i = analyze_harmony(make_notes([(p, 0, 2) for p in minor_tonic]), f"{tonic} Minor")[0]
        minor_v = analyze_harmony(make_notes([(p, 0, 2) for p in minor_dominant]), f"{tonic} Minor")[0]

        check(f"{tonic} Major I is diatonic with MIDI spelling",
              major_i.roman_numeral == "I" and major_i.is_diatonic,
              f"got {major_i.chord_label}, {major_i.roman_numeral}, diatonic={major_i.is_diatonic}")
        check(f"{tonic} Major V is diatonic with MIDI spelling",
              major_v.roman_numeral == "V" and major_v.is_diatonic,
              f"got {major_v.chord_label}, {major_v.roman_numeral}, diatonic={major_v.is_diatonic}")
        check(f"{tonic} Minor i is diatonic with MIDI spelling",
              minor_i.roman_numeral == "i" and minor_i.is_diatonic,
              f"got {minor_i.chord_label}, {minor_i.roman_numeral}, diatonic={minor_i.is_diatonic}")
        check(f"{tonic} Minor v is diatonic with MIDI spelling",
              minor_v.roman_numeral == "v" and minor_v.is_diatonic,
              f"got {minor_v.chord_label}, {minor_v.roman_numeral}, diatonic={minor_v.is_diatonic}")

# ─── 18. Cross-key Roman Numerals ─────────────────────────────────────────────

def test_chromatic_roman_numerals():
    print("\n═══ 18. Chromatic Roman Numerals ═══")

    # bVII in C major (Bb chord)
    notes = make_notes([("Bb3", 0, 2), ("D4", 0, 2), ("F4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("Bb D F in C Major → bVII",
          len(events) > 0 and "bVII" in events[0].roman_numeral,
          f"got {[e.roman_numeral for e in events]}")

    # bVI in C major (Ab chord)
    notes = make_notes([("Ab3", 0, 2), ("C4", 0, 2), ("Eb4", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("Ab C Eb in C Major → bVI",
          len(events) > 0 and "bVI" in events[0].roman_numeral,
          f"got {[e.roman_numeral for e in events]}")

    # #IV in C major (F# chord — augmented fourth / tritone sub)
    notes = make_notes([("F#4", 0, 2), ("A#4", 0, 2), ("C#5", 0, 2)])
    events = analyze_harmony(notes, "C Major")
    check("F# A# C# in C Major → #IV or bV",
          len(events) > 0 and ("#IV" in events[0].roman_numeral or "bV" in events[0].roman_numeral or "#iv" in events[0].roman_numeral),
          f"got {[e.roman_numeral for e in events]}")

# ─── Run All Tests ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 70)
    print("HARMONY ANALYSIS TEST SUITE — EarMasterPro")
    print("=" * 70)

    test_key_parsing()
    test_chord_normalization()
    test_chord_formatting()
    test_chord_spelling_conversion()
    test_notation_preference()
    test_roman_numerals_c_major()
    test_roman_numerals_a_minor()
    test_chord_labels_flat_keys()
    test_chord_labels_sharp_keys()
    test_inversions()
    test_seventh_chords()
    test_chord_sequence()
    test_non_diatonic()
    test_edge_cases()
    test_sustained_notes()
    test_diminished_chords()
    test_accidental_tonic_diatonic_chords()
    test_chromatic_roman_numerals()

    print("\n" + "=" * 70)
    print(f"RESULTS: {PASS_COUNT} passed, {FAIL_COUNT} failed")
    if FAIL_DETAILS:
        print("\nFailed tests:")
        for detail in FAIL_DETAILS:
            print(detail)
    print("=" * 70)

    sys.exit(0 if FAIL_COUNT == 0 else 1)
