// sectionBounce.js — render a section's MIDI/drone performance to an
// AudioBuffer via OfflineAudioContext ("bounce"). The rendered WAV plays
// through HTMLAudioElement — the OS media pipeline that stays smooth over
// Bluetooth, where the live AudioContext output path underruns on iOS.
//
// The graph mirrors audioEngine's live chain verbatim (midiGain → compressor
// → limiter → destination, −14dB reverb send, per-synth chorus, drone loop
// buffers) so the bounce sounds identical to live playback — with one upgrade
// borrowed from Sonofield's SF2 envelopes: drone segments crossfade (~1s
// attack, 2s release tail) instead of hard-switching at key changes.

import * as Tone from 'tone'
import SampleLibrary from './Tonejs-Instruments'
import { audioEngine, SYNTH_TYPES, INSTRUMENT_CONFIGS, tonicToMidi } from './audioEngine'
import { droneBandIndex, droneBandRef, droneLoopPromise } from './droneBaker'

const TAIL_SEC = 1.5          // rendered release tail after the region end
const DRONE_ATTACK_S = 1.0    // per-segment fade-in (Sonofield ~1s envelope)
const DRONE_RELEASE_S = 2.0   // fade-out tail — overlaps the next key change

// keyEvents → [{start,end,key}] in region beats — mirrors
// scheduleDroneSegments' seg math exactly.
function droneSegments(keyEvents, startBeat, regionBeats) {
  const events = keyEvents?.length ? keyEvents : [{ beat: 0, key: 'C' }]
  const segs = []
  for (let i = 0; i < events.length; i++) {
    const s = Math.max(0, (i === 0 ? 0 : events[i].beat) - startBeat)
    const e = Math.min(regionBeats, (events[i + 1]?.beat ?? Infinity) - startBeat)
    if (e > s) segs.push({ start: s, end: e, key: events[i].key })
  }
  if (!segs.length) segs.push({ start: 0, end: regionBeats, key: events[0].key })
  return segs
}

// Fold the rendered tail back into the head so a loop wraps seamlessly —
// out[i<tail] = head·rampUp + tail·rampDown, so position 0 continues what
// followed the last sample (same fold droneBaker uses on its loops).
function foldTail(buf, tailSamples) {
  const nCh = Math.min(2, buf.numberOfChannels || 1)
  const bodyLen = buf.length - tailSamples
  const channels = []
  for (let c = 0; c < nCh; c++) {
    const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))
    const out = new Float32Array(bodyLen)
    for (let i = 0; i < bodyLen; i++) out[i] = src[i]
    for (let i = 0; i < tailSamples; i++) {
      const t = i / tailSamples
      out[i] = src[i] * t + src[bodyLen + i] * (1 - t)
    }
    channels.push(out)
  }
  return {
    numberOfChannels: nCh,
    length: bodyLen,
    sampleRate: buf.sampleRate,
    getChannelData: (i) => channels[i],
  }
}

async function buildInstrument(name, config, midiGain, rawCtx) {
  const def = SYNTH_TYPES[name]
  if (def) {
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: def.oscillator,
      envelope: def.envelope,
    })
    const chorus = new Tone.Chorus(1.2, 4, 0.5).start()
    chorus.wet.value = 0.2
    chorus.connect(midiGain)
    if (def.filter) {
      synth.connect(new Tone.Filter(def.filter, 'lowpass').connect(chorus))
    } else {
      synth.connect(chorus)
    }
    synth.volume.value = config.volume !== undefined ? config.volume : def.volume
    return synth
  }
  const noteMap = SampleLibrary[name]
  if (!noteMap) return null
  const cache = await audioEngine.ensureInstrumentBytes(name)
  const urls = {}
  for (const note of Object.keys(noteMap)) {
    const bytes = cache.get(note)
    if (!bytes) continue
    try {
      urls[note] = await rawCtx.decodeAudioData(bytes.slice(0))
    } catch (_) {}
  }
  const sampler = new Tone.Sampler({ urls })
  sampler.connect(midiGain)
  if (config.volume !== undefined) sampler.volume.value = config.volume
  if (config.attack !== undefined) sampler.attack = config.attack
  if (config.release !== undefined) sampler.release = config.release
  return sampler
}

/**
 * Render a section's scheduled playback to a duck-typed buffer
 * ({numberOfChannels, length, sampleRate, getChannelData}) — feed to
 * encodeWavPcm16.
 *
 * @param notes         region-relative beats, already sliced + instrumented
 * @param keyEvents     key-change events (drone schedule)
 * @param droneDb       drone level in dB; null/undefined → no drone
 * @param regionBeats   region length in beats
 * @param tempo         EFFECTIVE tempo (base × speed) — render is 1.0× for the
 *                      element, so every playback speed works
 * @param looping       fold the tail into the head for a seamless file loop
 * @param instrumentConfigs  map instrument name → {volume,attack,release}
 * @param startBeat     section-relative offset of the region (drone segs)
 */
export async function bounceSection({
  notes = [], keyEvents = [], droneDb = null, regionBeats = 0,
  tempo = 120, looping = false, instrumentConfigs = {}, startBeat = 0,
}) {
  if (regionBeats <= 0) return null
  const OfflineCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext
  if (!OfflineCtor) return null
  const spb = 60 / tempo
  const regionSec = regionBeats * spb
  const renderSec = regionSec + TAIL_SEC
  const sr = Tone.getContext()?.rawContext?.sampleRate || 44100

  // Drone loop buffers render in their own OfflineAudioContext — fetch them
  // (module-cached) before the main render begins.
  const segs = droneDb != null ? droneSegments(keyEvents, startBeat, regionBeats) : []
  const droneLoops = []
  for (const seg of segs) {
    const midi = tonicToMidi(seg.key, 2)
    const freq = 440 * Math.pow(2, (midi - 69) / 12)
    const band = droneBandIndex(freq)
    droneLoops.push({ seg, freq, band, buffer: await droneLoopPromise(band, sr) })
  }

  const instrumentNames = [...new Set(notes.map(n => n.instrument).filter(Boolean))]

  const toneBuffer = await Tone.Offline(async (ctx) => {
    const rawCtx = ctx.rawContext
    // Mastering chain — verbatim copy of audioEngine.initialize:
    const midiGain = new Tone.Volume(-3)
    const compressor = new Tone.Compressor({ threshold: -18, ratio: 2.5, attack: 0.01, release: 0.2 })
    const limiter = new Tone.Limiter(-1.5)
    midiGain.connect(compressor)
    compressor.connect(limiter)
    limiter.toDestination()
    const reverbSend = new Tone.Gain(Math.pow(10, -14 / 20))
    const reverb = new Tone.Reverb({ decay: 1.6, preDelay: 0.01, wet: 1 })
    midiGain.connect(reverbSend)
    reverbSend.connect(reverb)
    reverb.toDestination()
    try { await reverb.ready } catch (_) {}

    // Players — same name→synth/sampler→default resolution as getPlayer.
    const players = {}
    for (const name of instrumentNames) {
      const config = instrumentConfigs[name] || INSTRUMENT_CONFIGS[name] || {}
      players[name] = await buildInstrument(name, config, midiGain, rawCtx)
    }
    const fallback = players['synth'] || (instrumentNames.length ? null : null)
      || (await buildInstrument('synth', instrumentConfigs['synth'] || INSTRUMENT_CONFIGS['synth'] || {}, midiGain, rawCtx))
    const playerFor = (n) => players[n.instrument] || fallback

    // Notes — velocity math identical to scheduleNotesAudioClock.fire.
    for (const n of notes) {
      const player = playerFor(n)
      if (!player) continue
      const t = n.start * spb
      const durSec = Math.max(0.05, Math.min(n.duration, regionBeats - n.start) * spb)
      const velocity = Math.min(Math.max((n.velocity ?? 0.8) * Math.pow(10, (n.volume ?? 0) / 20), 0), 1)
      try { player.triggerAttackRelease(n.note, durSec, t, velocity) } catch (_) {}
    }

    // Drone segments — baked loops (same voicing as _startDroneLoop) with a
    // Sonofield-style envelope: ~1s attack per segment, 2s release tail that
    // overlaps the next key change into a true crossfade.
    // Same level as the live _startDroneLoop: ~1dB under the voice bus.
    const droneLevel = Math.pow(10, (droneDb - 1) / 20)
    for (const { seg, freq, band, buffer } of droneLoops) {
      if (!buffer) continue
      const t0 = seg.start * spb
      const tEnd = Math.min(seg.end, regionBeats) * spb
      const src = new Tone.ToneBufferSource(buffer)
      src.loop = true
      src.playbackRate.value = freq / droneBandRef(band)
      const g = new Tone.Gain(0).connect(midiGain)
      const attackEnd = Math.min(t0 + DRONE_ATTACK_S, tEnd)
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(droneLevel, attackEnd)
      const releaseStart = Math.max(tEnd, attackEnd)
      const stopAt = tEnd + DRONE_RELEASE_S
      g.gain.setValueAtTime(droneLevel, releaseStart)
      g.gain.linearRampToValueAtTime(0, stopAt)
      src.connect(g)
      src.start(t0)
      src.stop(stopAt + 0.05)
    }
  }, renderSec, 2, sr)

  const rendered = toneBuffer.get?.() ?? toneBuffer._buffer ?? toneBuffer
  if (looping) {
    return { buf: foldTail(rendered, Math.round(TAIL_SEC * rendered.sampleRate)), seconds: regionSec }
  }
  return { buf: rendered, seconds: renderSec }
}
