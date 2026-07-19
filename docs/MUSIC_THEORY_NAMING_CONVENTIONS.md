# Music Theory Naming Conventions — Implementation Guide

> **Purpose**: Complete specification for implementing correct scale-degree, chord, and Roman-numeral naming in a music theory study app. Derived from the battle-tested implementation in EarMasterPro.

---

## 1. Core Data Model

All pitch manipulation is done in **MIDI numbers** (integer semitones from C-1=0). Pitch class = `midi % 12`.

```
Pitch Class: 0=C, 1=C#/Db, 2=D, 3=D#/Eb, 4=E, 5=F,
             6=F#/Gb, 7=G, 8=G#/Ab, 9=A, 10=A#/Bb, 11=B
```

Every analysis function takes two inputs:
- **`tonic`**: string like `"C"`, `"F#"`, `"Bb"` — the key root
- **`mode`**: `"Major"` or `"Minor"` (natural minor / Aeolian)

---

## 2. Scale Degrees

### 2.1 Algorithm

```
chromaticDistance = (pitchClass - tonicPitchClass + 12) % 12
```

Then map `chromaticDistance` (0–11) to a label using this **fixed table**:

| Semitones from tonic | Degree Label | Diatonic in Major? | Diatonic in Minor? |
|---------------------:|:-------------|:------------------:|:------------------:|
| 0                    | `1`          | ✅ | ✅ |
| 1                    | `b2`         | ❌ | ❌ |
| 2                    | `2`          | ✅ | ✅ |
| 3                    | `b3`         | ❌ | ✅ |
| 4                    | `3`          | ✅ | ❌ |
| 5                    | `4`          | ✅ | ✅ |
| 6                    | `#4`         | ❌ | ❌ |
| 7                    | `5`          | ✅ | ✅ |
| 8                    | `b6`         | ❌ | ✅ |
| 9                    | `6`          | ✅ | ❌ |
| 10                   | `b7`         | ❌ | ✅ |
| 11                   | `7`          | ✅ | ❌ |

**Diatonic pitch-class sets**:
- Major: `{0, 2, 4, 5, 7, 9, 11}` — the major scale
- Minor: `{0, 2, 3, 5, 7, 8, 10}` — the natural minor scale

### 2.2 Key Rules

1. The degree label is always relative to the **tonic**, never to the scale's notes. A C# in D Major is `b7` (semitone 10 from D), not "7 of the scale."
2. Octave is irrelevant — only pitch class matters. C3, C4, C5 all produce degree `1` in C Major.
3. The `#4` label is used for the tritone (semitone 6), **not** `b5`. This is a convention choice; stick with one consistently.
4. `b2`, `b3`, `b6`, `b7` use flat notation by convention, regardless of key. The degree names are **absolute relative to the tonic** and do not change spelling based on key signature.

### 2.3 Implementation (JavaScript)

```javascript
const degreeMap = {
  0: '1', 1: 'b2', 2: '2', 3: 'b3', 4: '3', 5: '4',
  6: '#4', 7: '5', 8: 'b6', 9: '6', 10: 'b7', 11: '7'
}

const diatonicMajor = new Set([0, 2, 4, 5, 7, 9, 11])
const diatonicMinor = new Set([0, 2, 3, 5, 7, 8, 10])

function getScaleDegree(midiNote, tonicPitchClass, mode) {
  const pc = midiNote % 12
  const chromaticDistance = (pc - tonicPitchClass + 12) % 12
  return {
    scale_degree: degreeMap[chromaticDistance],
    chromatic_distance: chromaticDistance,
    is_diatonic: mode === 'Major'
      ? diatonicMajor.has(chromaticDistance)
      : diatonicMinor.has(chromaticDistance)
  }
}
```

### 2.4 Expected Outputs (Test Cases)

| Key | Mode | Notes | Expected Degrees |
|-----|------|-------|-----------------|
| C   | Major | C D E F G A B C | `1 2 3 4 5 6 7 1` |
| C   | Major | C C# D D# E F F# G G# A A# B | `1 b2 2 b3 3 4 #4 5 b6 6 b7 7` |
| A   | Minor | A B C D E F G A | `1 2 b3 4 5 b6 b7 1` |
| G   | Major | G A B C D E F# G | `1 2 3 4 5 6 7 1` |
| E   | Minor | E F# G A B C D E | `1 2 b3 4 5 b6 b7 1` |
| C#  | Minor | C# D# E F# G# A B C# | `1 2 b3 4 5 b6 b7 1` |

---

## 3. Enharmonic Note Naming (Key-Aware Spelling)

### 3.1 Problem

MIDI pitch class 1 can be spelled as `C#` or `Db`. The correct spelling depends on the key signature. In Db Major, it should be `Db`. In D Major, it should be `C#`.

### 3.2 Key Signature Tables

```javascript
const KEY_SIGNATURES = {
  // Major keys
  'C':  { sharps: [], flats: [] },
  'G':  { sharps: ['F'], flats: [] },
  'D':  { sharps: ['F', 'C'], flats: [] },
  'A':  { sharps: ['F', 'C', 'G'], flats: [] },
  'E':  { sharps: ['F', 'C', 'G', 'D'], flats: [] },
  'B':  { sharps: ['F', 'C', 'G', 'D', 'A'], flats: [] },
  'F#': { sharps: ['F', 'C', 'G', 'D', 'A', 'E'], flats: [] },
  'C#': { sharps: ['F', 'C', 'G', 'D', 'A', 'E', 'B'], flats: [] },
  'F':  { sharps: [], flats: ['B'] },
  'Bb': { sharps: [], flats: ['B', 'E'] },
  'Eb': { sharps: [], flats: ['B', 'E', 'A'] },
  'Ab': { sharps: [], flats: ['B', 'E', 'A', 'D'] },
  'Db': { sharps: [], flats: ['B', 'E', 'A', 'D', 'G'] },
  'Gb': { sharps: [], flats: ['B', 'E', 'A', 'D', 'G', 'C'] },
  'Cb': { sharps: [], flats: ['B', 'E', 'A', 'D', 'G', 'C', 'F'] },
}

const ENHARMONIC_MAP = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
  'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#',
}
```

### 3.3 Minor Key Handling

For minor keys, look up the **relative major's** key signature:

```javascript
const minorToRelativeMajor = {
  'A': 'C', 'E': 'G', 'B': 'D', 'F#': 'A', 'C#': 'E', 'G#': 'B', 'D#': 'F#', 'A#': 'C#',
  'D': 'F', 'G': 'Bb', 'C': 'Eb', 'F': 'Ab', 'Bb': 'Db', 'Eb': 'Gb', 'Ab': 'Cb'
}
```

### 3.4 Algorithm

1. Get the base note name from pitch class using sharps: `['C', 'C#', 'D', ...]`
2. Look up the key signature (via relative major if minor mode).
3. If the note has a `#` and the key uses **flats**, convert to flat spelling via `ENHARMONIC_MAP`.
4. If the note has a `b` and the key uses **sharps**, convert to sharp spelling via `ENHARMONIC_MAP`.
5. Natural notes (C, D, E, F, G, A, B) are never converted.

### 3.5 Notation Preference (Sharp vs Flat by Key)

**Sharp keys**: C, G, D, A, E, B, F#, C# Major + their relative minors (A, E, B, F#, C#, G#, D#, A# Minor)

**Flat keys**: F, Bb, Eb, Ab, Db, Gb, Cb Major + their relative minors (D, G, C, F, Bb, Eb, Ab Minor)

```python
flat_major_keys = {'F', 'B-', 'E-', 'A-', 'D-', 'G-', 'C-'}
flat_minor_keys  = {'D', 'G', 'C', 'F', 'B-', 'E-', 'A-'}  # relative minors of flat majors
# Everything else → sharp
```

---

## 4. Chord Identification

### 4.1 Chord Label Format

Chord labels use **jazz/pop notation** (not classical):

| Chord Type | Label Suffix | Example |
|-----------|:-------------|---------|
| Major triad | *(none)* | `C`, `F`, `G` |
| Minor triad | `m` | `Am`, `Dm` |
| Diminished triad | `dim` | `Bdim` |
| Augmented triad | `aug` | `Caug` |
| Dominant 7th | `7` | `G7`, `F7` |
| Major 7th | `maj7` | `Cmaj7` |
| Minor 7th | `m7` | `Am7` |
| Diminished 7th | `o7` | `Bo7` |
| Half-diminished 7th | `m7b5` | `Bm7b5` |
| Minor-major 7th | `m(maj7)` | `Am(maj7)` |
| Suspended 4th | `sus4` | `Csus4` |
| Suspended 2nd | `sus2` | `Csus2` |
| Dominant 9th | `9` | `G9` |
| Major 9th | `maj9` | `Cmaj9` |
| Minor 9th | `m9` | `Am9` |
| Dominant 11th | `11` | `G11` |
| Major 11th | `maj11` | `Cmaj11` |
| Minor 11th | `m11` | `Am11` |
| Dominant 13th | `13` | `G13` |
| Major 13th | `maj13` | `Cmaj13` |
| Minor 13th | `m13` | `Am13` |
| Added 9th | `add9` | `Cadd9` |
| Minor add 9th | `madd9` | `Amadd9` |
| Augmented 7th | `aug7` | `Caug7` |

### 4.2 Inversions

When the bass note (lowest sounding pitch) differs from the chord root, append `/BassNote`:
- `G/B` = G major in first inversion (B in bass)
- `C/G` = C major in second inversion (G in bass)
- `Am/E` = A minor in first inversion

### 4.3 Chord Normalization (Root Finding)

When multiple pitches are sounding, you must find the **root** before labeling. Algorithm:

1. Collect all unique pitch classes from the sounding notes.
2. For each pitch class as a candidate root, compute the intervals from it to all other pitch classes.
3. Score each candidate:
   - `[0, 4, 7]` (major triad) → 100
   - `[0, 3, 7]` (minor triad) → 100
   - `[0, 3, 6]` (diminished) → 100
   - `[0, 4, 8]` (augmented) → 90
   - Any set starting with `[0, 4, 7]` → 95 (major with extensions)
   - Any set starting with `[0, 3, 7]` → 95 (minor with extensions)
   - `[0, 3, 6, 9]` or `[0, 3, 6, 10]` → 95 (diminished/half-dim 7ths)
   - Has a perfect 5th (7) → 50
   - Otherwise → 0
4. Pick the highest-scoring root. On ties, prefer the lower pitch class number.

### 4.4 Chord Spelling Normalization

Once the root is found, spell all chord tones relative to that root using proper interval names (not just nearest semitone). This ensures a C major chord is spelled C-E-G (not C-Fb-G), and a diminished chord gets proper enharmonic spelling (B-D-F, not B-Eb-F for Bdim).

The mapping from semitone offset to scale degree (relative to root):

| Semitones | Degree | Letter step from root |
|----------:|--------|----------------------|
| 0 | 1 (root) | 0 |
| 1 | b2 | 1 with flat |
| 2 | 2 | 1 |
| 3 | b3 | 2 with flat |
| 4 | 3 | 2 |
| 5 | 4 | 3 |
| 6 | #4 / b5 | 3 with # or 4 with b |
| 7 | 5 | 4 |
| 8 | #5 / b6 | 4 with # or 5 with b |
| 9 | 6 | 5 |
| 10 | b7 | 6 with flat |
| 11 | 7 | 6 |

For diminished chords, semitone 6 should be spelled as `b5` (degree 4 with flat), not `#4`.

### 4.5 Sharp/Flat Conversion for Chord Labels

After identifying a chord, convert its root spelling to match the key's notation preference:

```python
sharp_to_flat = {'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb', 'E#': 'F', 'B#': 'C'}
flat_to_sharp = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#', 'Fb': 'E', 'Cb': 'B'}
```

If the key is a flat key and the chord root is a sharp note, convert it. And vice versa. Also convert the bass note in inversions.

---

## 5. Roman Numerals

### 5.1 Degree Determination

Calculate the semitone distance from the tonic to the chord root:

```python
degree_names = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII']
base_degree = degree_names[semitones_from_tonic % 12]
```

### 5.2 Case and Accidentals

The Roman numeral encodes chord **quality** through case:

| Chord Quality | Numeral Case | Example |
|-------------|:-------------|---------|
| Major | **UPPER** | `I`, `IV`, `V` |
| Minor | **lower** | `ii`, `iii`, `vi` |
| Diminished | **lower + °** | `viio`, `iio` |
| Augmented | **UPPER + +** | `I+`, `III+` |

Accidentals (`b`, `#`) from the degree name are preserved as prefixes:
- `bII` = Neapolitan chord (root on b2)
- `bIII` = submediant in minor (root on b3)
- `bVI` = submediant in minor (root on b6)
- `bVII` = subtonic in minor (root on b7)
- `#IV` = augmented fourth degree

### 5.3 Extensions (7ths, 9ths, etc.)

Append the extension to the Roman numeral:

| Chord Label | Roman Numeral |
|------------|---------------|
| `C` in C Major | `I` |
| `G7` in C Major | `V7` |
| `Dm7` in C Major | `iim7` |
| `Cmaj7` in C Major | `Imaj7` |
| `Bm7b5` in C Major | `viiø7` |
| `Bo7` in C Major | `viio7` |
| `Am(maj7)` in C Major | `vim(maj7)` |

**Rules for extension mapping**:
- If the extension is `m7b5`, use `ø7` for half-diminished (unless the base already has `°`, then just `7`)
- If the extension is `o7` (diminished 7th), append `7` to the `°` numeral: `viio` + `7` → `viio7`
- `m(maj7)` → no extension shown (minor-major 7th is rare; the numeral stays as lowercase)
- `sus`, `add9`, `madd9` chords → no extension appended

### 5.4 Determining Quality from Chord Label

```python
is_minor = ('m' in label and 'maj' not in label) or 'm(maj7)' in label or 'madd9' in label
is_dim = 'dim' in label or 'o7' in label
is_aug = 'aug' in label
```

Apply in order: diminished → minor → augmented → major (default).

### 5.5 Expected Roman Numerals

**C Major diatonic triads**:

| Chord | Pitches | Roman Numeral | Diatonic |
|-------|---------|:-------------|:--------|
| C | C-E-G | `I` | ✅ |
| Dm | D-F-A | `ii` | ✅ |
| Em | E-G-B | `iii` | ✅ |
| F | F-A-C | `IV` | ✅ |
| G | G-B-D | `V` | ✅ |
| Am | A-C-E | `vi` | ✅ |
| Bdim | B-D-F | `viio` | ✅ |

**C Major diatonic 7ths**:

| Chord | Pitches | Roman Numeral |
|-------|---------|:-------------|
| Cmaj7 | C-E-G-B | `Imaj7` |
| Dm7 | D-F-A-C | `ii7` |
| Em7 | E-G-B-D | `iii7` |
| Fmaj7 | F-A-C-E | `IVmaj7` |
| G7 | G-B-D-F | `V7` |
| Am7 | A-C-E-G | `vi7` |
| Bm7b5 | B-D-F-A | `viiø7` |

**A Minor diatonic triads**:

| Chord | Pitches | Roman Numeral | Diatonic |
|-------|---------|:-------------|:--------|
| Am | A-C-E | `i` | ✅ |
| Bdim | B-D-F | `iio` | ✅ |
| C | C-E-G | `bIII` | ✅ |
| Dm | D-F-A | `iv` | ✅ |
| Em | E-G-B | `v` | ✅ |
| F | F-A-C | `bVI` | ✅ |
| G | G-B-D | `bVII` | ✅ |

### 5.6 Same Chord, Different Key Context

The **same chord** gets different Roman numerals depending on the key:

| Chord | In C Major | In A Minor | In A Major |
|-------|:----------|:-----------|:----------|
| Am (A-C-E) | `vi` (diatonic) | `i` (diatonic) | `i` (non-diatonic) |

The `is_diatonic` flag changes based on whether **all chord tones** belong to the key's pitch-class set.

---

## 6. Diatonic Determination

### 6.1 For Single Notes

A note is diatonic if its pitch class is in the key's scale:

```javascript
const diatonicPitches = mode === 'Major'
  ? new Set([0, 2, 4, 5, 7, 9, 11])   // major scale intervals from tonic
  : new Set([0, 2, 3, 5, 7, 8, 10])   // natural minor scale intervals from tonic

const isDiatonic = diatonicPitches.has((pitchClass - tonicPitchClass + 12) % 12)
```

### 6.2 For Chords

A chord is diatonic if **all** of its pitch classes belong to the key's pitch-class set:

```python
key_pitch_classes = {p.pitchClass for p in key.pitches}  # e.g. C Major = {0, 2, 4, 5, 7, 9, 11}
is_diatonic = all(p.pitchClass in key_pitch_classes for p in chord.pitches)
```

### 6.3 Key Pitch-Class Sets (Reference)

| Key | Mode | Pitch Classes |
|-----|------|:-------------|
| C Major / A Minor | Major/Minor | {0,2,4,5,7,9,11} / {9,11,0,2,4,5,7} |
| G Major / E Minor | Major/Minor | {7,9,11,0,2,4,6} / {4,6,7,9,11,0,2} |
| D Major / B Minor | Major/Minor | {2,4,6,7,9,11,1} / {11,1,2,4,6,7,9} |
| A Major / F# Minor | Major/Minor | {9,11,1,2,4,6,8} | {6,8,9,11,1,2,4} |
| E Major / C# Minor | Major/Minor | {4,6,8,9,11,1,3} | {1,3,4,6,8,9,11} |
| B Major / G# Minor | Major/Minor | {11,1,3,4,6,8,10} | {8,10,11,1,3,4,6} |
| F# Major / D# Minor | Major/Minor | {6,8,10,11,1,3,5} | {3,5,6,8,10,11,1} |
| F Major / D Minor | Major/Minor | {5,7,9,10,0,2,4} | {2,4,5,7,9,10,0} |
| Bb Major / G Minor | Major/Minor | {10,0,2,3,5,7,9} | {7,9,10,0,2,3,5} |
| Eb Major / C Minor | Major/Minor | {3,5,7,8,10,0,2} | {0,2,3,5,7,8,10} |
| Ab Major / F Minor | Major/Minor | {8,10,0,1,3,5,7} | {5,7,8,10,0,1,3} |
| Db Major / Bb Minor | Major/Minor | {1,3,5,6,8,10,0} | {10,0,1,3,5,6,8} |

---

## 7. Chord Analysis from MIDI Notes

### 7.1 Grouping Notes into Chords

1. Sort all notes by start time.
2. Find all unique start times.
3. At each start time, collect all **sounding** notes: notes where `note.start <= t < note.start + note.duration`.
4. Extract unique pitch classes (deduplicate enharmonic equivalents).
5. Require **≥3 unique pitch classes** to form a chord. Fewer = no chord event.

### 7.2 Processing Pipeline

```
Raw MIDI notes
  → Group by sounding at each timestamp
  → Deduplicate pitch classes
  → Normalize chord spelling (find root, spell intervals correctly)
  → Format chord label (root + suffix)
  → Detect inversion (compare bass to root)
  → Convert spelling to key notation preference (sharp/flat)
  → Determine diatonic status
  → Calculate Roman numeral
```

---

## 8. Summary of Conventions

1. **Scale degrees**: Always relative to tonic using fixed `b2, 2, b3, 3, #4, b6, b7` notation. Octave-independent.
2. **Diatonic**: Major scale = `{0,2,4,5,7,9,11}`, minor scale = `{0,2,3,5,7,8,10}` (intervals from tonic).
3. **Note spelling**: Sharps in sharp keys, flats in flat keys. Use relative major's key signature for minor keys.
4. **Chord labels**: Jazz notation (`C`, `Am`, `G7`, `Cmaj7`, `Dm7`, `Bdim`, `Bm7b5`, `Csus4`). Inversions as `/BassNote`.
5. **Roman numerals**: Upper case = major, lower case = minor, lower+° = diminished, upper+`+` = augmented. Preserve accidentals from degree. Append extensions (`7`, `m7`, `maj7`, `ø7`, `o7`).
6. **Chord diatonic**: All chord tones must be in the key's pitch-class set.
7. **Root finding**: Score by interval match to known chord templates. Prefer triadic roots, then perfect-fifth-containing candidates.
8. **Same chord in different keys**: Different Roman numeral and potentially different diatonic status.
