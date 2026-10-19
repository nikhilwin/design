// The sequencer and mixer of a music loop. A song is `bars` bars long; every note is written into circular
// buses, so a note (or a reverb tail) that runs past the end of the loop continues at its start. The master
// chain runs over two copies of the loop and keeps the second, so the end of the file flows into its start
// exactly as it will when the browser loops it.

import { analyseOctaves } from './analysis.mjs'
import { Biquad, SR, addCircular, clamp, compress, dbToGain, hashSeed, highpass, limit, pan as panGains, pingPong, periodic, reverb, rng, saturate, scale, stereo } from './dsp.mjs'
import { integratedLoudness, rms, samplePeak, toDb, truePeak } from './loudness.mjs'

/**
 * Target level of each octave band (63 Hz ... 8 kHz) relative to the average of the 250 Hz and 500 Hz bands, in dB.
 * The mix is nudged towards its curve so every track has a sane tonal balance (nobody can listen to all of them).
 */
export const TONES = {
  neutral: [-3, -2, 0, 0, -3, -6, -9, -13],
  bright: [-6, -3, 0, 0, -2, -5, -8, -11],
  warm: [-3, -1, 0, 0, -4, -8, -11, -15],
  dark: [-2, -2, 0, 0, -5, -9, -13, -19],
  cinematic: [-2, -2, 0, 0, -4, -7, -11, -15],
}
const BAND_CENTRES = [63, 125, 250, 500, 1000, 2000, 4000, 8000]

/** Matching EQ: peaking filters (shelves at the ends) that move the octave levels of `buf` towards `curve`. */
function matchTone(buf, curve) {
  const levels = analyseOctaves([buf.l, buf.r], BAND_CENTRES)
  const reference = 10 * Math.log10((10 ** (levels[2] / 10) + 10 ** (levels[3] / 10)) / 2)
  const filters = []
  BAND_CENTRES.forEach((centre, i) => {
    const delta = clamp(curve[i] + reference - levels[i], -9, 9) * 0.85
    if (Math.abs(delta) < 0.6) return
    const type = i === 0 ? 'lowshelf' : i === BAND_CENTRES.length - 1 ? 'highshelf' : 'peaking'
    const frequency = i === 0 ? 90 : i === BAND_CENTRES.length - 1 ? 6000 : centre
    filters.push([type, frequency, 0.9, delta])
  })
  return periodic(buf, (b) => {
    for (const [type, frequency, q, gain] of filters) {
      const fl = new Biquad().set(type, frequency, q, gain)
      const fr = new Biquad().set(type, frequency, q, gain)
      for (let i = 0; i < b.length; i++) {
        b.l[i] = fl.process(b.l[i])
        b.r[i] = fr.process(b.r[i])
      }
    }
  })
}

const BUSES = ['drums', 'bass', 'keys', 'pad', 'lead', 'fx']

/** Where each bus sits in the mix before the master chain, as RMS in dBFS; `levels` nudge from there. */
export const BUS_TARGETS = { drums: -20, bass: -21, keys: -24, pad: -25, lead: -24, fx: -32 }

export class Song {
  constructor({ id, bpm, bars, seed, beats = 4, swing = 0, swingGrid = 8 }) {
    this.id = id
    this.bpm = bpm
    this.bars = bars
    this.beats = beats
    this.seed = seed
    this.swing = swing
    this.swingGrid = swingGrid
    this.samplesPerBeat = (SR * 60) / bpm
    this.length = Math.round(bars * beats * this.samplesPerBeat)
    this.bus = Object.fromEntries(BUSES.map((name) => [name, stereo(this.length)]))
    this.revSend = stereo(this.length)
    this.dlySend = stereo(this.length)
    this.kicks = []
    this.busLevels = {}
  }

  get seconds() {
    return this.length / SR
  }

  /** A generator for this event, identical on every render: derived from the song seed and the event's place. */
  rand(...tag) {
    return rng(hashSeed(this.seed, ...tag))
  }

  /** The beat with swing applied: off-beat eighths (or sixteenths) arrive late. */
  swung(beat) {
    if (!this.swing) return beat
    const frac = beat - Math.floor(beat)
    if (this.swingGrid === 8 && Math.abs(frac - 0.5) < 1e-6) return beat + this.swing / 6
    if (this.swingGrid === 16 && (Math.abs(frac - 0.25) < 1e-6 || Math.abs(frac - 0.75) < 1e-6)) return beat + this.swing / 12
    return beat
  }

  /** Sample position of a bar/beat, with swing and an optional human-feel offset in milliseconds. */
  at(bar, beat, humanMs = 0, tag = '') {
    const jitter = humanMs ? (this.rand('human', bar, beat, tag)() * 2 - 1) * humanMs * (SR / 1000) : 0
    return Math.round((bar * this.beats + this.swung(beat)) * this.samplesPerBeat + jitter)
  }

  /**
   * Places a voice. `voice` is a Float32Array (mono) or `{ l, r }`; `pan` -1..1 positions a mono voice;
   * `rev` and `dly` are send levels to the reverb and the stereo delay.
   */
  put(busName, voice, bar, beat, { gain = 1, pan = 0, rev = 0, dly = 0, human = 0, tag = '' } = {}) {
    const bus = this.bus[busName]
    const start = this.at(bar, beat, human, `${busName}${tag}`)
    const [gl, gr] = panGains(pan)
    const place = (target, g) => {
      if (voice.l) {
        addCircular(target, voice.l, start, g, 0)
        addCircular(target, voice.r, start, 0, g)
      } else {
        addCircular(target, voice, start, gl * g * Math.SQRT2, gr * g * Math.SQRT2)
      }
    }
    place(bus, gain)
    if (rev) place(this.revSend, gain * rev)
    if (dly) place(this.dlySend, gain * dly)
  }

  /** Marks a kick drum so the pads and bass can duck under it. */
  markKick(bar, beat, strength = 1) {
    this.kicks.push({ at: this.at(bar, beat), strength })
  }

  /** The gain curve a sidechain compressor would apply: dips at each kick and recovers over `releaseMs`. */
  duckCurve(depth, releaseMs) {
    const curve = new Float32Array(this.length).fill(1)
    const tau = (releaseMs / 1000) * SR
    const span = Math.round(tau * 4)
    for (const kick of this.kicks) {
      for (let k = 0; k < span; k++) {
        const i = (kick.at + k) % this.length
        const g = 1 - depth * kick.strength * Math.exp(-k / tau) * Math.min(1, k / 40)
        if (g < curve[i]) curve[i] = g
      }
    }
    return curve
  }

  /**
   * Mixes the buses and runs the master chain. `levels` are the buses' gains in dB, `duck` an optional
   * `{ pad, bass, keys }` of sidechain depths, `rev`/`dly` the wet levels. Returns the stereo loop and its
   * measurements; the loudness lands on `target` LUFS (peaks held below `ceilingDb`).
   */
  render({ levels = {}, targets = {}, duck = {}, duckRelease = 180, reverbOptions = {}, rev = 0.5, dly = 0.35, delayOptions = {}, target = -16, ceilingDb = -1.2, drive = 0.9, eq = {}, tone = 'neutral' } = {}) {
    const n = this.length
    const dry = stereo(n)
    for (const name of BUSES) {
      const bus = this.bus[name]
      if (duck[name]) {
        const curve = this.duckCurve(duck[name], duckRelease)
        for (let i = 0; i < n; i++) {
          bus.l[i] *= curve[i]
          bus.r[i] *= curve[i]
        }
      }
      const out = name === 'drums' ? periodic(bus, (b) => compress(b, { thresholdDb: -14, ratio: 2.5, attackMs: 18, releaseMs: 120 })) : bus
      const level = toDb(rms([out.l, out.r]))
      const g = level > -90 ? dbToGain((targets[name] ?? BUS_TARGETS[name]) - level + (levels[name] ?? 0)) : 0
      this.busLevels[name] = level > -90 ? (targets[name] ?? BUS_TARGETS[name]) + (levels[name] ?? 0) : null
      for (let i = 0; i < n; i++) {
        dry.l[i] += out.l[i] * g
        dry.r[i] += out.r[i] * g
      }
    }
    // Reverb and delay are linear, so running them over two copies of the loop gives the steady state.
    const wetRev = periodic(this.revSend, (b) => {
      const w = reverb(b.l, b.r, { t60: 2.2, ...reverbOptions })
      b.l.set(w.l)
      b.r.set(w.r)
    })
    const wetDly = periodic(this.dlySend, (b) => {
      const w = pingPong(b.l, b.r, { timeMs: (60000 / this.bpm) * 0.75, ...delayOptions })
      b.l.set(w.l)
      b.r.set(w.r)
    })
    const mix = stereo(n)
    for (let i = 0; i < n; i++) {
      mix.l[i] = dry.l[i] + wetRev.l[i] * rev + wetDly.l[i] * dly
      mix.r[i] = dry.r[i] + wetRev.r[i] * rev + wetDly.r[i] * dly
    }
    let master = periodic(matchTone(mix, TONES[tone] ?? tone), (b) => {
      highpass(b, eq.highpass ?? 30)
      compress(b, { thresholdDb: -17, ratio: 2.2, attackMs: 24, releaseMs: 200 })
      saturate(b, drive)
    })
    let measured = 0
    for (let pass = 0; pass < 4; pass++) {
      const twice = [concat(master.l), concat(master.r)]
      measured = integratedLoudness(twice)
      const delta = target - measured
      if (Math.abs(delta) < 0.15 && pass > 0) break
      scale(master, dbToGain(delta))
      master = periodic(master, (b) => limit(b, { ceilingDb }))
    }
    const channels = [master.l, master.r]
    const loudness = integratedLoudness([concat(master.l), concat(master.r)])
    return { audio: master, lufs: loudness, peakDb: toDb(samplePeak(channels)), truePeakDb: toDb(truePeak(channels)) }
  }
}

function concat(a) {
  const out = new Float32Array(a.length * 2)
  out.set(a, 0)
  out.set(a, a.length)
  return out
}

