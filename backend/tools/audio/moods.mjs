// Composers: one function per mood, each parameterised by a track spec (tempo, key, chords, instrumentation).
// A composer schedules notes on a Song and returns the mixing options for Song.render().

import { hashSeed } from './dsp.mjs'
import * as inst from './instruments.mjs'
import { Song } from './song.mjs'
import { NOTE, Scale, melody, voice } from './theory.mjs'

/* ----------------------------------------------------------------------------------------------- shared */

function setup(spec) {
  const song = new Song({
    id: spec.id,
    bpm: spec.bpm,
    bars: spec.bars,
    seed: hashSeed('doory-audio', spec.id),
    swing: spec.swing ?? 0,
    swingGrid: spec.swingGrid ?? 8,
  })
  const tonic = NOTE[spec.key]
  const scale = new Scale(tonic, spec.scale)
  const chordBars = spec.chordBars ?? 1
  const cycle = spec.prog.length * chordBars
  if (spec.bars % cycle !== 0) throw new Error(`${spec.id}: ${spec.bars} bars is not a whole number of ${cycle}-bar chord cycles`)
  const chordAt = (bar) => {
    const [offset, type] = spec.prog[Math.floor(bar / chordBars) % spec.prog.length]
    return { root: tonic + offset, type, pc: (tonic + offset) % 12 }
  }
  return { song, tonic, scale, chordAt, chordBars }
}

/** The lowest MIDI note at or above `lo` with the pitch class of `pc`. */
function rootAbove(pc, lo) {
  let m = lo
  while (((m % 12) + 12) % 12 !== ((pc % 12) + 12) % 12) m++
  return m
}

const STEP = { '.': 0, o: 0.42, x: 0.78, X: 1 }
const parse = (row) => [...row.replace(/\s/g, '')].map((c) => STEP[c] ?? 0)

/**
 * Plays a drum pattern: one string of 16 steps per instrument ("X" accent, "x" normal, "o" ghost note, "." rest).
 * Bars listed in `fills` use `fill` instead of the pattern for their last beat or two.
 */
function drumTrack(song, { kit, pattern, from = 0, to = song.bars, fills = [], fill = null, gains = {}, pans = {} }) {
  const rows = Object.fromEntries(Object.entries(pattern).map(([name, row]) => [name, parse(row)]))
  const fillRows = fill ? Object.fromEntries(Object.entries(fill).map(([name, row]) => [name, parse(row)])) : null
  for (let bar = from; bar < to; bar++) {
    const useFill = fillRows && fills.includes(bar)
    for (let step = 0; step < 16; step++) {
      for (const name of Object.keys(rows)) {
        const source = useFill && step >= 8 && fillRows[name] ? fillRows[name] : rows[name]
        const vel = source[step]
        if (!vel) continue
        const seed = hashSeed(song.seed, name, bar, step)
        const beat = step / 4
        const g = gains[name] ?? 1
        const human = name === 'kick' ? 2 : 4
        let voiceBuf
        switch (name) {
          case 'kick':
            voiceBuf = inst.kick({ vel, seed, kind: kit.kick ?? 'house' })
            song.markKick(bar, beat, vel)
            break
          case 'snare':
            voiceBuf = inst.snare({ vel, seed, kind: kit.snare ?? 'tight' })
            break
          case 'clap':
            voiceBuf = inst.clap({ vel, seed })
            break
          case 'hat':
            voiceBuf = inst.hat({ vel: vel * 0.9, seed, tone: kit.hat ?? 7500 })
            break
          case 'ohat':
            voiceBuf = inst.hat({ vel, seed, open: true, tone: kit.hat ?? 7500 })
            break
          case 'shaker':
            voiceBuf = inst.shaker({ vel, seed })
            break
          case 'rim':
            voiceBuf = inst.rim({ vel, seed })
            break
          case 'tom':
            voiceBuf = inst.tom({ vel, seed, pitch: 90 + ((step * 7 + bar) % 4) * 22 })
            break
          case 'taiko':
            voiceBuf = inst.taiko({ vel, seed, pitch: kit.taiko ?? 62 })
            break
          case 'crash':
            voiceBuf = inst.crash({ vel, seed })
            break
          default:
            throw new Error(`unknown drum ${name}`)
        }
        song.put('drums', voiceBuf, bar, beat, { gain: g, pan: pans[name] ?? 0, human, rev: kit.rev?.[name] ?? 0.05, tag: name })
      }
    }
  }
}

/** Sustained chord for every chord change in [from, to). */
function padChords(song, chordAt, chordBars, { from = 0, to = song.bars, register = 57, count = 4, gain = 0.5, rev = 0.35, bus = 'pad', ...options } = {}) {
  for (let bar = from; bar < to; bar += chordBars) {
    const chord = chordAt(bar)
    const seconds = (chordBars * song.beats * 60) / song.bpm
    voice(chord.root, chord.type, register, count).forEach((midi, i) => {
      const v = inst.pad({ midi, dur: seconds - 0.05, seed: hashSeed(song.seed, 'pad', bar, i), release: options.release ?? 0.9, ...options })
      song.put(bus, v, bar, 0, { gain: gain / Math.sqrt(count), rev, tag: `pad${i}` })
    })
  }
}

/** Bass line from a pattern of [beat, beats, chordTone] where chordTone 0 root, 1 fifth, 2 octave, 3 third. */
function bassLine(song, chordAt, { pattern, from = 0, to = song.bars, low = 36, kind = 'sub', gain = 0.8, cutoff = 700, velocity = 0.85 }) {
  for (let bar = from; bar < to; bar++) {
    const chord = chordAt(bar)
    const root = rootAbove(chord.pc, low)
    const bar4 = pattern[bar % pattern.length]
    bar4.forEach(([beat, dur, tone, vel], i) => {
      const interval = [0, 7, 12, chord.type.startsWith('min') ? 3 : 4, 10][tone]
      const midi = root + interval
      const seconds = (dur * 60) / song.bpm
      const v = inst.bass({ midi, dur: seconds * 0.92, vel: (vel ?? 1) * velocity, seed: hashSeed(song.seed, 'bass', bar, i), kind, cutoff })
      song.put('bass', v, bar, beat, { gain, human: 3, tag: `b${i}` })
    })
  }
}

/** Plays the notes of `melody()` on a bus with a voice factory. */
function playMelody(song, notes, make, { bus = 'lead', gain = 0.5, rev = 0.25, dly = 0, pan = 0, from = 0, to = song.bars, human = 5 }) {
  notes.forEach((n, i) => {
    if (n.bar < from || n.bar >= to) return
    const seconds = Math.max(0.08, (n.dur * 60) / song.bpm)
    const v = make({ midi: n.midi, dur: seconds * 0.95, vel: n.vel, seed: hashSeed(song.seed, 'mel', n.bar, n.beat, i) })
    song.put(bus, v, n.bar, n.beat, { gain, rev, dly, pan, human, tag: `m${i}` })
  })
}

/** Plucked or struck arpeggio over every chord: `steps` per bar of `stepBeats`, walking `order` through the chord tones. */
function arpLine(song, chordAt, { make, register = 60, count = 4, order, steps = 8, stepBeats = 0.5, from = 0, to = song.bars, gain = 0.4, rev = 0.25, dly = 0, pan = 0, bus = 'keys', accent = [1, 0.7, 0.8, 0.7], human = 4 }) {
  for (let bar = from; bar < to; bar++) {
    const chord = chordAt(bar)
    const notes = voice(chord.root, chord.type, register, count)
    for (let s = 0; s < steps; s++) {
      const k = order[s % order.length]
      const midi = notes[k % notes.length] + (k >= notes.length ? 12 : 0)
      const vel = accent[s % accent.length]
      const v = make({ midi, dur: stepBeats * (60 / song.bpm) * 0.95, vel, seed: hashSeed(song.seed, 'arp', bar, s) })
      song.put(bus, v, bar, s * stepBeats, { gain, rev, dly, pan: pan * (s % 2 ? 1 : -1), human, tag: `a${s}` })
    }
  }
}

function rhythmBank(...patterns) {
  return patterns
}

/* ---------------------------------------------------------------------------------------------- upbeat */

export function upbeat(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  const half = bars / 2
  const kit = { kick: 'house', hat: 8200, rev: { clap: 0.25, snare: 0.2 } }
  drumTrack(song, {
    kit,
    gains: { kick: 0.95, clap: 0.6, hat: 0.34, ohat: 0.3, shaker: 0.26 },
    pattern: { kick: 'X...X...X...X...', clap: '....x.......x...', hat: 'o.x.o.x.o.x.o.xo', ohat: '..x...x...x...x.', shaker: spec.shaker ? 'xoxoxoxoxoxoxoxo' : '................' },
    from: 0,
    to: bars,
    fills: [half - 1, bars - 1],
    fill: { clap: '........x.x.xxxx', kick: '........X.......' },
  })
  padChords(song, chordAt, chordBars, { register: 62, count: 4, gain: 0.52, bright: 0.7, voices: 5, detune: 16, attack: 0.04, release: 0.25, rev: 0.3, from: 0 })
  bassLine(song, chordAt, {
    pattern: [[[0.5, 0.5, 0], [1.5, 0.5, 0], [2.5, 0.5, 2], [3.5, 0.5, 0]]],
    kind: spec.bass ?? 'saw',
    gain: 0.78,
    cutoff: 900,
  })
  const rand = song.rand('melody')
  const notes = melody({
    rand,
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 0.75], [0.75, 0.75], [1.5, 0.5], [2, 1], [3, 1]], [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 1.5], [3, 1]], [[0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1]], [[0, 1], [1, 0.5], [1.5, 0.5], [2, 2]]),
    range: [spec.leadLow ?? 67, spec.leadLow ? spec.leadLow + 14 : 81],
    bars,
    restChance: 0.08,
    leap: 0.2,
  })
  const make = spec.lead === 'saw' ? (o) => inst.lead({ ...o, wave: 'saw', bright: 0.8, vibrato: 0.003 }) : (o) => inst.lead({ ...o, wave: 'square', bright: 0.75, vibrato: 0.004 })
  playMelody(song, notes, make, { gain: 0.34, dly: 0.35, rev: 0.25, from: half })
  const order = spec.arp ?? [0, 2, 1, 3, 2, 1, 3, 2]
  arpLine(song, chordAt, { make: (o) => inst.synthPluck({ ...o, cutoff: 5200, decay: 0.2 }), register: 67, order, steps: 16, stepBeats: 0.25, gain: 0.3, dly: 0.28, rev: 0.18, pan: 0.35, accent: [1, 0.55, 0.75, 0.55], from: 0 })
  return { song, mix: { levels: { drums: 0, bass: 0, pad: -4, keys: -2, lead: 0 }, duck: { pad: 0.5, bass: 0.35, keys: 0.2 }, duckRelease: 190, rev: 0.45, dly: 0.5, drive: 1.0 } }
}

/* ------------------------------------------------------------------------------------------------ calm */

export function calm(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  padChords(song, chordAt, chordBars, { register: 55, count: 4, gain: 0.5, bright: 0.28, voices: 4, detune: 12, attack: 1.4, release: 2.2, rev: 0.5 })
  if (spec.keys === 'harp') {
    arpLine(song, chordAt, { make: (o) => inst.pluckString({ ...o, damp: 0.35, bright: 0.55, sustain: 2.4 }), register: 58, count: 4, order: [0, 1, 2, 3, 2, 1, 3, 2], steps: 8, stepBeats: 0.5, gain: 0.5, rev: 0.45, dly: 0.2, pan: 0.25, accent: [1, 0.55, 0.65, 0.5] })
  } else if (spec.keys === 'epiano') {
    arpLine(song, chordAt, { make: (o) => inst.epiano({ ...o, trem: 3.6, tremDepth: 0.2, dur: 1.6 }), register: 58, count: 4, order: [0, 2, 1, 3, 2, 1], steps: 6, stepBeats: 0.667, gain: 0.5, rev: 0.4, accent: [1, 0.6, 0.7] })
  } else {
    arpLine(song, chordAt, { make: (o) => inst.piano({ ...o, dur: 1.4, bright: 0.35 }), register: 58, count: 4, order: [0, 1, 2, 3, 2, 1, 2, 3], steps: 8, stepBeats: 0.5, gain: 0.55, rev: 0.5, pan: 0.18, accent: [1, 0.55, 0.7, 0.5] })
  }
  const rand = song.rand('melody')
  const notes = melody({
    rand,
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 2], [2, 1], [3, 1]], [[0.5, 1.5], [2, 2]], [[0, 1], [1, 1], [2, 2]], [[1, 1], [2, 1.5], [3.5, 0.5]]),
    range: [72, 84],
    bars,
    restChance: 0.3,
    leap: 0.1,
    velocity: [0.5, 0.75],
  })
  const kind = spec.mallet ?? 'glock'
  playMelody(song, notes, (o) => inst.mallet({ ...o, kind, ring: 1.4 }), { gain: 0.34, rev: 0.6, dly: 0.35, from: bars / 4 })
  bassLine(song, chordAt, { pattern: [[[0, 4, 0, 0.8]]], kind: 'sub', gain: 0.55, low: 31, velocity: 0.7 })
  song.put('fx', inst.wash(song.length, hashSeed(song.seed, 'wash'), { low: 700, high: 2600, level: 0.055 }), 0, 0, { gain: 1, rev: 0.2 })
  return { song, mix: { levels: { pad: 0, keys: 0, lead: 0, bass: -2, fx: 0 }, rev: 0.7, dly: 0.6, drive: 0.7, reverbOptions: { t60: 3.2, damp: 0.45 } } }
}

/* ------------------------------------------------------------------------------------------- cinematic */

export function cinematic(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  const half = bars / 2
  // Low strings: a driving staccato eighth-note ostinato on the chord root and fifth.
  for (let bar = 0; bar < bars; bar++) {
    const chord = chordAt(bar)
    const root = rootAbove(chord.pc, 41)
    const intensity = bar >= half ? 1 : 0.7
    for (let s = 0; s < 8; s++) {
      const midi = root + (s % 4 === 3 ? 7 : s % 2 ? 12 : 0)
      const v = inst.pad({ midi, dur: 0.17, seed: hashSeed(song.seed, 'ost', bar, s), voices: 3, detune: 10, attack: 0.01, release: 0.12, bright: 0.38, vel: 0.9 * intensity })
      song.put('keys', v, bar, s * 0.5, { gain: spec.ostinato ?? 0.42, rev: 0.25, human: 3, tag: `o${s}` })
    }
  }
  padChords(song, chordAt, chordBars, { register: 55, count: 4, gain: 0.5, bright: 0.42, voices: 6, detune: 18, attack: 0.9, release: 1.6, rev: 0.55 })
  padChords(song, chordAt, chordBars, { register: 69, count: 3, gain: 0.3, bright: 0.55, voices: 5, detune: 12, attack: 1.2, release: 2, rev: 0.6, wave: 'tri', vibrato: 0.003, from: half })
  // Taiko hits on the downbeat of every bar, with answers in the second half.
  drumTrack(song, {
    kit: { taiko: spec.taiko ?? 58, rev: { taiko: 0.5, tom: 0.35, crash: 0.5 } },
    gains: { taiko: 0.95, tom: 0.5, crash: 0.5 },
    pattern: { taiko: 'X.......x.......', tom: '................' },
    from: 0,
    to: bars,
    fills: [3, 7, 11, 15].filter((b) => b < bars),
    fill: { tom: '........x.xxxxxx' },
  })
  drumTrack(song, { kit: { taiko: spec.taiko ?? 58, rev: { taiko: 0.5 } }, gains: { taiko: 0.6 }, pattern: { taiko: '..x...x.....x...' }, from: half, to: bars })
  // Brass swells on chord changes in the second half, and a riser into the loop point.
  for (let bar = half; bar < bars; bar += chordBars) {
    const chord = chordAt(bar)
    voice(chord.root, chord.type, 60, 3).forEach((midi, i) => {
      const v = inst.brass({ midi, dur: (chordBars * song.beats * 60) / song.bpm - 0.1, seed: hashSeed(song.seed, 'brass', bar, i), attack: 0.5, open: 3000, release: 0.5 })
      song.put('lead', v, bar, 0, { gain: 0.27, rev: 0.45, tag: `br${i}` })
    })
  }
  song.put('fx', inst.riser({ seconds: (song.beats * 60 * 2) / song.bpm, seed: hashSeed(song.seed, 'riser'), level: 0.5 }), bars - 2, 0, { gain: 0.5, rev: 0.4 })
  song.put('fx', inst.crash({ vel: 0.9, seed: hashSeed(song.seed, 'crash'), len: 3 }), 0, 0, { gain: 0.5, rev: 0.5 })
  const notes = melody({
    rand: song.rand('melody'),
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 2], [2, 1], [3, 1]], [[0, 1.5], [1.5, 0.5], [2, 2]], [[0, 1], [1, 1], [2, 1.5], [3.5, 0.5]]),
    range: [62, 76],
    bars,
    restChance: 0.2,
    leap: 0.2,
  })
  playMelody(song, notes, (o) => (spec.melody === 'bell' ? inst.mallet({ ...o, kind: 'bell', ring: 1.6 }) : inst.lead({ ...o, wave: 'saw', bright: 0.45, vibrato: 0.006, attack: 0.05, release: 0.4 })), { gain: spec.melody === 'bell' ? 0.4 : 0.26, rev: 0.55, dly: 0.2, from: half })
  bassLine(song, chordAt, { pattern: [[[0, 4, 0, 1]]], kind: 'sub', gain: 0.8, low: 29, velocity: 0.9 })
  return { song, mix: { levels: { drums: 0, bass: -1, keys: -1, pad: -1, lead: -1, fx: -2 }, rev: 0.75, dly: 0.35, drive: 1.1, reverbOptions: { t60: 3.8, damp: 0.4 } } }
}

/* -------------------------------------------------------------------------------------------------- lofi */

export function lofi(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  const kit = { kick: 'soft', snare: 'soft', hat: 6000, rev: { snare: 0.2 } }
  drumTrack(song, {
    kit,
    gains: { kick: 0.85, snare: 0.62, hat: 0.3, ohat: 0.2 },
    pattern: spec.drums ?? { kick: 'X.....o...x.o...', snare: '....X.o.....X..o', hat: 'x.xoxoxxx.xoxoxo', ohat: '..............x.' },
    from: 0,
    to: bars,
    fills: [3, 7, 11, 15].filter((b) => b < bars),
    fill: { snare: '........o.o.x.xo', kick: '..............o.' },
  })
  // Chords: electric piano or a nylon-ish guitar, the 7th chords of the progression.
  for (let bar = 0; bar < bars; bar += chordBars) {
    const chord = chordAt(bar)
    const notes = voice(chord.root, chord.type, 58, 4)
    const strum = [0, 0.04, 0.08, 0.12]
    const hits = spec.comp ?? [0, 1.5]
    for (const beat of hits) {
      notes.forEach((midi, i) => {
        const v =
          spec.keys === 'guitar'
            ? inst.pluckString({ midi, dur: 1.4, vel: 0.7, seed: hashSeed(song.seed, 'gtr', bar, beat, i), damp: 0.7, bright: 0.35, sustain: 1.3 })
            : inst.epiano({ midi, dur: 1.5, vel: 0.62, seed: hashSeed(song.seed, 'ep', bar, beat, i), trem: 3.2, tremDepth: 0.18 })
        song.put('keys', v, bar, beat + strum[i] * 0.6, { gain: 0.34, rev: 0.32, pan: (i - 1.5) * 0.12, human: 8, tag: `c${beat}${i}` })
      })
    }
  }
  bassLine(song, chordAt, { pattern: [[[0, 1.5, 0], [1.5, 0.5, 2, 0.7], [2.5, 1.5, 0, 0.8]], [[0, 1, 0], [2, 0.75, 1, 0.8], [3, 1, 0, 0.7]]], kind: 'sub', gain: 0.78, low: 32, velocity: 0.8 })
  const notes = melody({
    rand: song.rand('melody'),
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0.5, 1], [2, 0.5], [3, 1]], [[0, 0.75], [1, 1.25], [3, 0.5], [3.5, 0.5]], [[1, 0.5], [1.5, 1.5], [3, 1]], [[0, 2], [2.5, 1.5]]),
    range: [64, 77],
    bars,
    restChance: 0.25,
    leap: 0.14,
    velocity: [0.45, 0.75],
  })
  const make = spec.lead === 'kalimba' ? (o) => inst.mallet({ ...o, kind: 'kalimba', ring: 1.2 }) : (o) => inst.epiano({ ...o, trem: 4.4, tremDepth: 0.1, dur: o.dur * 1.4 })
  playMelody(song, notes, make, { gain: 0.34, rev: 0.4, dly: 0.45, from: bars / 4, human: 9 })
  song.put('fx', inst.crackle(song.length, hashSeed(song.seed, 'crackle'), { density: spec.crackle ?? 11, level: 0.5 }), 0, 0, { gain: 0.7 })
  song.put('fx', inst.wash(song.length, hashSeed(song.seed, 'tape'), { low: 90, high: 1400, level: 0.02 }), 0, 0, { gain: 1 })
  return { song, mix: { levels: { drums: 0, bass: 0, keys: 0, lead: 0, fx: 0 }, duck: { bass: 0.2 }, rev: 0.5, dly: 0.4, drive: 1.2, eq: { highpass: 40 }, reverbOptions: { t60: 1.6, damp: 0.6, highCut: 4500 } } }
}

/* ---------------------------------------------------------------------------------------------- corporate */

export function corporate(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  const half = bars / 2
  const kit = { kick: 'soft', snare: 'tight', hat: 9000, rev: { clap: 0.3, snare: 0.25 } }
  drumTrack(song, {
    kit,
    gains: { kick: 0.75, clap: 0.5, hat: 0.26, shaker: 0.2, rim: 0.3 },
    pattern: { kick: 'X.......x.x.....', clap: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', shaker: 'xoxoxoxoxoxoxoxo' },
    from: bars / 4,
    to: bars,
    fills: [half - 1, bars - 1],
    fill: { clap: '........x.x.x.xx' },
  })
  padChords(song, chordAt, chordBars, { register: 60, count: 4, gain: 0.46, bright: 0.5, voices: 4, detune: 10, attack: 0.5, release: 0.9, rev: 0.3 })
  if (spec.arp === 'piano') {
    arpLine(song, chordAt, { make: (o) => inst.piano({ ...o, dur: 0.6, bright: 0.65 }), register: 64, order: [0, 1, 2, 3, 2, 1, 3, 2], steps: 8, stepBeats: 0.5, gain: 0.48, rev: 0.28, pan: 0.2, accent: [1, 0.55, 0.7, 0.55] })
  } else {
    arpLine(song, chordAt, { make: (o) => inst.synthPluck({ ...o, cutoff: 4200, decay: 0.22, square: 0.2 }), register: 64, order: [0, 2, 1, 3, 2, 3, 1, 2], steps: 16, stepBeats: 0.25, gain: 0.28, dly: 0.3, rev: 0.2, pan: 0.3, accent: [1, 0.5, 0.7, 0.5] })
  }
  bassLine(song, chordAt, { pattern: [[[0, 1.5, 0], [1.5, 0.5, 2, 0.7], [2, 1.5, 0], [3.5, 0.5, 1, 0.7]]], kind: 'saw', gain: 0.62, cutoff: 600, low: 36, velocity: 0.8 })
  const notes = melody({
    rand: song.rand('melody'),
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1]], [[0.5, 0.5], [1, 1], [2, 1], [3, 0.5], [3.5, 0.5]], [[0, 1.5], [1.5, 0.5], [2, 2]]),
    range: [spec.melodyLow ?? 69, (spec.melodyLow ?? 69) + 13],
    bars,
    restChance: 0.12,
    leap: 0.16,
  })
  playMelody(song, notes, (o) => (spec.lead === 'marimba' ? inst.mallet({ ...o, kind: 'marimba', ring: 0.9 }) : inst.mallet({ ...o, kind: 'vibes', ring: 1.0 })), { gain: 0.42, rev: 0.3, dly: 0.3, from: bars / 4 })
  arpLine(song, chordAt, { make: (o) => inst.mallet({ ...o, kind: 'glock', ring: 0.8 }), register: 84, count: 3, order: [0, 2], steps: 2, stepBeats: 2, gain: 0.22, rev: 0.4, from: half, accent: [0.9, 0.6] })
  return { song, mix: { levels: { drums: 0, bass: 0, keys: 0, pad: -3, lead: 0 }, duck: { pad: 0.25 }, duckRelease: 200, rev: 0.45, dly: 0.4, drive: 0.9 } }
}

/* ------------------------------------------------------------------------------------------------ playful */

export function playful(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  const kit = { kick: 'soft', snare: 'soft', hat: 8500, rev: { clap: 0.2, rim: 0.2 } }
  drumTrack(song, {
    kit,
    gains: { kick: 0.7, rim: 0.5, clap: 0.42, shaker: 0.3, hat: 0.2 },
    pattern: spec.polka
      ? { kick: 'X...x...X...x...', rim: '..x...x...x...x.', shaker: 'xoxoxoxoxoxoxoxo' }
      : { kick: 'X.....x.X.x.....', rim: '....x.......x.o.', clap: '................', shaker: 'xoxoxoxoxoxoxoxo', hat: '..x...x...x...x.' },
    from: 0,
    to: bars,
    fills: [bars / 2 - 1, bars - 1],
    fill: { rim: '........xxxxxxxx' },
  })
  // Bouncy bass: walking pizzicato (or oom-pah for the polka).
  for (let bar = 0; bar < bars; bar++) {
    const chord = chordAt(bar)
    const root = rootAbove(chord.pc, 40)
    const third = chord.type.startsWith('min') ? 3 : 4
    const line = spec.polka ? [[0, 0], [1, 7], [2, 0], [3, 7]] : [[0, 0], [1, third], [2, 7], [3, 9 - (bar % 2) * 2]]
    line.forEach(([beat, interval], i) => {
      const v = inst.pluckString({ midi: root + interval, dur: 0.32, vel: 0.85, seed: hashSeed(song.seed, 'pz', bar, i), damp: 0.8, bright: 0.3, sustain: 0.5 })
      song.put('bass', v, bar, beat, { gain: 0.8, human: 4, tag: `w${i}` })
    })
  }
  // Off-beat chord stabs on a bright electric piano.
  for (let bar = 0; bar < bars; bar += chordBars) {
    const chord = chordAt(bar)
    voice(chord.root, chord.type, 64, 3).forEach((midi, i) => {
      for (const beat of [0.5, 1.5, 2.5, 3.5]) {
        const v = inst.epiano({ midi, dur: 0.16, vel: 0.6, seed: hashSeed(song.seed, 'st', bar, beat, i), trem: 0, tremDepth: 0 })
        song.put('keys', v, bar, beat, { gain: 0.2, rev: 0.2, pan: (i - 1) * 0.3, human: 4, tag: `s${beat}${i}` })
      }
    })
  }
  const notes = melody({
    rand: song.rand('melody'),
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]], [[0, 0.25], [0.5, 0.25], [1, 0.5], [2, 0.5], [2.5, 0.5], [3, 1]], [[0.5, 0.5], [1, 0.5], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]]),
    range: [72, 88],
    bars,
    restChance: 0.1,
    leap: 0.28,
    velocity: [0.7, 0.95],
  })
  playMelody(song, notes, (o) => inst.mallet({ ...o, kind: spec.lead === 'glock' ? 'glock' : 'marimba', ring: 0.6 }), { gain: 0.5, rev: 0.25, dly: 0.2 })
  const whistle = melody({
    rand: song.rand('whistle'),
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 1.5], [1.5, 0.5], [2, 2]], [[0, 1], [1, 1], [2, 2]]),
    range: [79, 91],
    bars,
    restChance: 0.35,
    leap: 0.15,
  })
  playMelody(song, whistle, (o) => inst.lead({ ...o, wave: 'sine', breath: 0.03, vibrato: 0.006, attack: 0.04 }), { gain: 0.3, rev: 0.3, dly: 0.3, from: bars / 2 })
  return { song, mix: { levels: { drums: 0, bass: 0, keys: 0, lead: 0 }, rev: 0.4, dly: 0.35, drive: 0.9 } }
}

/* ---------------------------------------------------------------------------------------------- romantic */

export function romantic(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  const half = bars / 2
  padChords(song, chordAt, chordBars, { register: 57, count: 4, gain: 0.58, bright: 0.34, voices: 5, detune: 13, attack: 1.0, release: 1.6, rev: 0.5, vibrato: 0.002 })
  if (spec.keys === 'harp') {
    arpLine(song, chordAt, { make: (o) => inst.pluckString({ ...o, damp: 0.3, bright: 0.6, sustain: 2.8 }), register: 55, count: 4, order: [0, 1, 2, 3, 4, 3, 2, 1], steps: 8, stepBeats: 0.5, gain: 0.55, rev: 0.5, pan: 0.3, accent: [1, 0.6, 0.7, 0.6] })
  } else if (spec.keys === 'epiano') {
    arpLine(song, chordAt, { make: (o) => inst.epiano({ ...o, trem: 3.4, tremDepth: 0.16, dur: 1.6 }), register: 57, count: 4, order: [0, 2, 3, 2, 1, 2, 3, 2], steps: 8, stepBeats: 0.5, gain: 0.5, rev: 0.45, accent: [1, 0.6, 0.7, 0.6] })
  } else {
    arpLine(song, chordAt, { make: (o) => inst.piano({ ...o, dur: 1.5, bright: 0.4 }), register: 57, count: 4, order: [0, 1, 2, 3, 2, 1, 2, 1], steps: 8, stepBeats: 0.5, gain: 0.56, rev: 0.5, pan: 0.2, accent: [1, 0.55, 0.65, 0.55] })
  }
  const notes = melody({
    rand: song.rand('melody'),
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 3], [3, 1]], [[0, 1.5], [1.5, 0.5], [2, 2]], [[0.5, 1.5], [2, 1], [3, 1]], [[0, 2], [2, 1], [3, 1]]),
    range: [67, 81],
    bars,
    restChance: 0.15,
    leap: 0.1,
    velocity: [0.55, 0.8],
  })
  playMelody(song, notes, (o) => inst.lead({ ...o, wave: spec.lead ?? 'sine', vibrato: 0.007, attack: 0.07, release: 0.5, breath: 0.012, bright: 0.4 }), { gain: 0.42, rev: 0.55, dly: 0.3, from: bars / 4 })
  bassLine(song, chordAt, { pattern: [[[0, 2, 0, 0.9], [2, 2, 1, 0.7]]], kind: 'sub', gain: 0.6, low: 31, velocity: 0.75 })
  for (let bar = half; bar < bars; bar += chordBars) {
    const chord = chordAt(bar)
    voice(chord.root, chord.type, 64, 3).forEach((midi, i) => {
      const v = inst.pad({ midi, dur: (chordBars * song.beats * 60) / song.bpm, seed: hashSeed(song.seed, 'str', bar, i), voices: 6, detune: 9, attack: 0.9, release: 1.4, bright: 0.42, vibrato: 0.004, vel: 0.8 })
      song.put('pad', v, bar, 0, { gain: 0.26, rev: 0.5, tag: `str${i}` })
    })
  }
  song.put('fx', inst.wash(song.length, hashSeed(song.seed, 'air'), { low: 900, high: 3200, level: 0.035 }), 0, 0, { gain: 1, rev: 0.3 })
  return { song, mix: { levels: { pad: 0, keys: 0, lead: 0, bass: -2, fx: 0 }, rev: 0.7, dly: 0.45, drive: 0.7, reverbOptions: { t60: 2.8, damp: 0.42 } } }
}

/* ---------------------------------------------------------------------------------------------- dramatic */

export function dramatic(spec) {
  const { song, scale, chordAt, chordBars } = setup(spec)
  const bars = spec.bars
  const half = bars / 2
  const kit = { kick: 'punch', snare: 'fat', hat: 8000, taiko: 56, rev: { snare: 0.4, taiko: 0.45, crash: 0.5 } }
  drumTrack(song, {
    kit,
    gains: { kick: 0.95, snare: 0.78, hat: 0.28, taiko: 0.7, tom: 0.5 },
    pattern: spec.drums ?? { kick: 'X.....x.X.x...x.', snare: '........X.......', hat: 'x.x.x.x.x.x.x.x.', taiko: 'X...............' },
    from: bars / 4,
    to: bars,
    fills: [3, 7, 11, 15].filter((b) => b >= bars / 4 && b < bars),
    fill: { snare: '........xxxxxxxx', tom: '................' },
  })
  // Pulsing staccato strings on sixteenths.
  for (let bar = 0; bar < bars; bar++) {
    const chord = chordAt(bar)
    const root = rootAbove(chord.pc, 45)
    const intensity = bar < bars / 4 ? 0.65 : 1
    for (let s = 0; s < 16; s++) {
      if (spec.pulse === 'offbeat' && s % 2 === 0) continue
      const midi = root + ([0, 0, 7, 0, 12, 0, 7, 0][s % 8] ?? 0)
      const v = inst.pad({ midi, dur: 0.1, seed: hashSeed(song.seed, 'pulse', bar, s), voices: 3, detune: 8, attack: 0.006, release: 0.07, bright: 0.5, vel: (s % 4 === 0 ? 1 : 0.7) * intensity })
      song.put('keys', v, bar, s * 0.25, { gain: spec.pulseGain ?? 0.4, rev: 0.18, pan: (s % 2 ? 0.2 : -0.2), human: 2, tag: `p${s}` })
    }
  }
  padChords(song, chordAt, chordBars, { register: 52, count: 4, gain: 0.5, bright: 0.38, voices: 6, detune: 16, attack: 0.4, release: 1.0, rev: 0.4 })
  // Brass stabs on the strong beats and a rising tension line into the loop.
  for (let bar = half; bar < bars; bar++) {
    const chord = chordAt(bar)
    for (const beat of [0, 2.5]) {
      voice(chord.root, chord.type, 62, 3).forEach((midi, i) => {
        const v = inst.brass({ midi, dur: 0.35, seed: hashSeed(song.seed, 'stab', bar, beat, i), attack: 0.03, open: 3400, release: 0.2 })
        song.put('lead', v, bar, beat, { gain: 0.24, rev: 0.4, tag: `st${beat}${i}` })
      })
    }
  }
  song.put('fx', inst.riser({ seconds: (song.beats * 60 * 4) / song.bpm, seed: hashSeed(song.seed, 'riser'), level: 0.55 }), bars - 4, 0, { gain: 0.55, rev: 0.4 })
  song.put('fx', inst.crash({ vel: 1, seed: hashSeed(song.seed, 'crash'), len: 3 }), 0, 0, { gain: 0.5, rev: 0.5 })
  song.put('fx', inst.crash({ vel: 0.8, seed: hashSeed(song.seed, 'crash2'), len: 3 }), half, 0, { gain: 0.4, rev: 0.5 })
  const notes = melody({
    rand: song.rand('melody'),
    scale,
    chords: Array.from({ length: bars }, (_, b) => chordAt(b)),
    rhythms: rhythmBank([[0, 1], [1, 0.5], [1.5, 0.5], [2, 2]], [[0, 0.5], [0.5, 0.5], [1, 1], [2, 1], [3, 1]], [[0, 2], [2, 0.5], [2.5, 0.5], [3, 1]]),
    range: [64, 79],
    bars,
    restChance: 0.12,
    leap: 0.25,
    velocity: [0.7, 0.95],
  })
  playMelody(song, notes, (o) => inst.lead({ ...o, wave: 'saw', bright: 0.55, vibrato: 0.005, attack: 0.03, release: 0.3 }), { gain: 0.25, rev: 0.4, dly: 0.25, from: half })
  bassLine(song, chordAt, { pattern: [[[0, 0.5, 0], [0.5, 0.5, 0, 0.7], [1, 0.5, 0], [1.5, 0.5, 2, 0.7], [2, 0.5, 0], [2.5, 0.5, 0, 0.7], [3, 0.5, 1, 0.8], [3.5, 0.5, 0, 0.7]]], kind: 'saw', gain: 0.75, cutoff: 650, low: 31 })
  return { song, mix: { levels: { drums: 0, bass: 0, keys: -1, pad: -2, lead: 0, fx: -2 }, duck: { pad: 0.35, bass: 0.25 }, duckRelease: 150, rev: 0.55, dly: 0.35, drive: 1.2, reverbOptions: { t60: 2.6 } } }
}

const COMPOSERS = { upbeat, calm, cinematic, lofi, corporate, playful, romantic, dramatic }

/** The tonal balance each mood is mixed towards (see TONES in song.mjs). */
const TONE_BY_MOOD = { upbeat: 'bright', calm: 'warm', cinematic: 'cinematic', lofi: 'warm', corporate: 'bright', playful: 'bright', romantic: 'warm', dramatic: 'cinematic' }

/** Composes a track from its catalogue entry: the Song with every note placed, and the options to render it. */
export function compose(spec) {
  const { song, mix } = COMPOSERS[spec.mood](spec)
  return { song, mix: { tone: spec.tone ?? TONE_BY_MOOD[spec.mood], ...mix } }
}
