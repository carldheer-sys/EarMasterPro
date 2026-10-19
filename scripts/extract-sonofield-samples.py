#!/usr/bin/env python3
"""
Extract the real Sonofield SF2 instruments from Sonofield_REA/free.sf2:
  1. Preset "Synth" (16 stereo multisampled zones, keys 42..89 -> G1..E5)
     -> public/samples/sonofield-synth/<note>.mp3
  2. Preset "Drones" (12 chromatic stereo tonic loops, keys 48..59 -> C..B)
     -> public/samples/sonofield-drone/<tonic>.mp3

Each stereo zone in free.sf2 consists of a linked Left (pan=-500) and Right
(pan=+500) 16-bit PCM sample in the SDTA 'smpl' chunk.
"""

import json
import math
import os
import struct
import subprocess
import tempfile
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SF2_PATH = "/Users/carldheer/Documents/MusicProjects/Sonofield_REA/_workdir/assets_copy/sound/soundfonts/free.sf2"
META_PATH = "/Users/carldheer/Documents/MusicProjects/Sonofield_REA/data/soundfont.json"

SYNTH_OUT_DIR = os.path.join(ROOT, "public", "samples", "sonofield-synth")
DRONE_OUT_DIR = os.path.join(ROOT, "public", "samples", "sonofield-drone")

MIDI_NAMES_SHARP = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"]


def midi_to_file_stem(midi):
    octave = (midi // 12) - 1
    return f"{MIDI_NAMES_SHARP[midi % 12]}{octave}"


def find_smpl_offset(data):
    off = 12
    while off + 8 <= len(data):
        cid = data[off : off + 4].decode("latin1")
        sz = struct.unpack_from("<I", data, off + 4)[0]
        if cid == "LIST":
            ltype = data[off + 8 : off + 12].decode("latin1")
            if ltype == "sdta":
                sub_id = data[off + 12 : off + 16].decode("latin1")
                assert sub_id == "smpl", f"Expected smpl chunk, got {sub_id}"
                return off + 20
        off += 8 + sz + (sz & 1)
    raise RuntimeError("Could not find sdta/smpl chunk in SF2")


def read_mono_floats(data, pcm_off, start, end):
    count = end - start
    shorts = struct.unpack_from(f"<{count}h", data, pcm_off + start * 2)
    return [s / 32768.0 for s in shorts]


def unroll_sustain_loop(samples, loop_start_rel, loop_end_rel, sr, target_sec=4.0, fade_out_sec=0.15):
    """
    Unroll an SF2 sustain loop (sampleModes=1) to target_sec so Tone.Sampler
    can sustain long melody/chord notes without cutting off at 1.5s.
    Uses a short crossfade at the loop seam to guarantee zero clicks.
    """
    target_len = int(round(target_sec * sr))
    loop_len = loop_end_rel - loop_start_rel
    if loop_len <= 64 or len(samples) >= target_len:
        out = list(samples[:target_len])
    else:
        xfade = min(256, loop_len // 4)
        out = list(samples[:loop_end_rel])
        while len(out) < target_len:
            # Crossfade the last xfade samples of `out` with the pre-loop_start tail
            for i in range(xfade):
                t = i / xfade
                a = out[len(out) - xfade + i]
                b = samples[loop_start_rel + i]
                out[len(out) - xfade + i] = a * (1.0 - t) + b * t
            take = min(loop_len - xfade, target_len - len(out))
            out.extend(samples[loop_start_rel + xfade : loop_start_rel + xfade + take])

    fade_len = min(int(round(fade_out_sec * sr)), len(out) // 4)
    for i in range(fade_len):
        gain = 0.5 * (1.0 + math.cos(math.pi * i / fade_len))
        out[len(out) - fade_len + i] *= gain
    return out


def build_seamless_drone_loop(left, right, sr, body_sec=14.0, xfade_sec=1.2, guard_sec=0.25):
    """
    Build a seamless stereo drone file of length `body_sec + guard_sec`:
    - First fold `[body_len .. body_len + xfade_len]` into `[0 .. xfade_len]`
      so position 0 continues seamlessly from position `body_len`.
    - Then append `out[0 .. guard_len]` at the end of the file so that
      looping between `loopStart = 0.1s` and `loopEnd = body_sec + 0.1s`
      stays strictly inside the file (avoiding any MP3 encoder start/end padding)
      with identical waveform & phase at loopStart and loopEnd.
    """
    body_len = int(round(body_sec * sr))
    xfade_len = int(round(xfade_sec * sr))
    guard_len = int(round(guard_sec * sr))
    assert body_len + xfade_len <= len(left), "Drone sample shorter than requested loop+xfade"

    def fold_channel(ch):
        out = list(ch[:body_len])
        for i in range(xfade_len):
            t = i / xfade_len
            # Equal-power-ish linear blend of correlated pad texture
            out[i] = ch[i] * t + ch[body_len + i] * (1.0 - t)
        # Append guard prefix so [guard_offset .. body_len + guard_offset] is periodic
        out.extend(out[:guard_len])
        return out

    l_out = fold_channel(left)
    r_out = fold_channel(right)

    # Normalize RMS across all 12 tonics so key changes have uniform loudness
    # Target RMS: ~-15.5 dBFS (linear ~0.168), peak clamped to -1.5 dBFS (0.84)
    sum_sq = 0.0
    peak = 0.0
    for lv, rv in zip(l_out, r_out):
        sum_sq += lv * lv + rv * rv
        a = max(abs(lv), abs(rv))
        if a > peak:
            peak = a
    rms = math.sqrt(sum_sq / (2 * len(l_out)))
    target_rms = 0.168
    gain = min(target_rms / max(rms, 1e-6), 0.84 / max(peak, 1e-6))
    l_out = [x * gain for x in l_out]
    r_out = [x * gain for x in r_out]
    return l_out, r_out


def encode_stereo_mp3(left, right, sr, out_path, bitrate="160k"):
    assert len(left) == len(right)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        pcm = bytearray(len(left) * 4)
        for i, (lv, rv) in enumerate(zip(left, right)):
            li = max(-32768, min(32767, int(round(lv * 32767.0))))
            ri = max(-32768, min(32767, int(round(rv * 32767.0))))
            struct.pack_into("<hh", pcm, i * 4, li, ri)
        with wave.open(wav_path, "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                wav_path,
                "-acodec",
                "libmp3lame",
                "-b:a",
                bitrate,
                "-ar",
                "44100",
                out_path,
            ],
            check=True,
        )
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)


def main():
    with open(META_PATH, "r", encoding="utf-8") as f:
        meta = json.load(f)
    with open(SF2_PATH, "rb") as f:
        data = f.read()

    pcm_off = find_smpl_offset(data)
    samples = meta["samples"]
    instruments = {inst["name"]: inst for inst in meta["instruments"]}

    # 1. Extract Synth (16 stereo zones)
    synth_inst = instruments["Synth"]
    synth_by_key = {}
    for z in synth_inst["zones"]:
        sid = z["sampleID"]
        s = samples[sid]
        orig_key = s["origKey"]
        pan = z.get("pan", 0)
        atten_cb = z.get("initialAttenuation", 0)
        entry = synth_by_key.setdefault(orig_key, {"atten_cb": atten_cb})
        entry["atten_cb"] = max(entry["atten_cb"], atten_cb)
        if pan < 0:
            entry["L"] = s
        else:
            entry["R"] = s

    print(f"Extracting {len(synth_by_key)} Sonofield Synth stereo zones -> {SYNTH_OUT_DIR}")
    for orig_key in sorted(synth_by_key.keys()):
        entry = synth_by_key[orig_key]
        sL, sR = entry["L"], entry["R"]
        sr = sL["sampleRate"]
        # Smooth centibel attenuation across registers so Bb4 (midi 82)
        # transitions seamlessly into Db5/E5 (midi 85/88, raw peak ~0.30).
        atten_db = 0.07 * entry["atten_cb"]
        gain = math.pow(10.0, -atten_db / 20.0) * 0.9

        raw_l = [x * gain for x in read_mono_floats(data, pcm_off, sL["start"], sL["end"])]
        raw_r = [x * gain for x in read_mono_floats(data, pcm_off, sR["start"], sR["end"])]

        l_unrolled = unroll_sustain_loop(
            raw_l,
            sL["loopStart"] - sL["start"],
            sL["loopEnd"] - sL["start"],
            sr,
            target_sec=4.0,
        )
        r_unrolled = unroll_sustain_loop(
            raw_r,
            sR["loopStart"] - sR["start"],
            sR["loopEnd"] - sR["start"],
            sr,
            target_sec=4.0,
        )

        stem = midi_to_file_stem(orig_key)
        out_path = os.path.join(SYNTH_OUT_DIR, f"{stem}.mp3")
        encode_stereo_mp3(l_unrolled, r_unrolled, sr, out_path, bitrate="160k")
        sz_kb = os.path.getsize(out_path) / 1024.0
        print(f"  Synth {stem:4s} (midi {orig_key:2d}, atten -{atten_db:3.1f}dB) -> {sz_kb:5.1f} KB")

    # 2. Extract Drones (12 chromatic stereo tonic loops, keys 48..59)
    drone_inst = instruments["Drones"]
    drone_by_key = {}
    for z in drone_inst["zones"]:
        sid = z["sampleID"]
        s = samples[sid]
        orig_key = s["origKey"]
        pan = z.get("pan", 0)
        entry = drone_by_key.setdefault(orig_key, {})
        if pan < 0:
            entry["L"] = s
        else:
            entry["R"] = s

    print(f"\nExtracting {len(drone_by_key)} Sonofield Drone stereo loops -> {DRONE_OUT_DIR}")
    for orig_key in sorted(drone_by_key.keys()):
        entry = drone_by_key[orig_key]
        sL, sR = entry["L"], entry["R"]
        sr = sL["sampleRate"]
        raw_l = read_mono_floats(data, pcm_off, sL["start"], sL["end"])
        raw_r = read_mono_floats(data, pcm_off, sR["start"], sR["end"])

        l_loop, r_loop = build_seamless_drone_loop(raw_l, raw_r, sr, body_sec=14.0, xfade_sec=1.2, guard_sec=0.25)
        tonic_name = MIDI_NAMES_SHARP[orig_key % 12]
        out_path = os.path.join(DRONE_OUT_DIR, f"{tonic_name}.mp3")
        encode_stereo_mp3(l_loop, r_loop, sr, out_path, bitrate="160k")
        sz_kb = os.path.getsize(out_path) / 1024.0
        print(f"  Drone {tonic_name:2s} (midi {orig_key:2d}) -> {sz_kb:5.1f} KB")


if __name__ == "__main__":
    main()
