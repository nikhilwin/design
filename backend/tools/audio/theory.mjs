// Just enough music theory to compose loops that stay in key: chords, scales, and a melody generator whose
// strong beats are chord tones and whose motifs come back in later bars.

export const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 }

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentMajor: [0, 2, 4, 7, 9],
  pentMinor: [0, 3, 5, 7, 10],
}

export const CHORDS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  m7b5: [0, 3, 6, 10],
  add9: [0, 4, 7, 14],
  min9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  six: [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
}

/** The pitch classes (0-11) of a chord. */
export function chordClasses(root, type) {
  return CHORDS[type].map((i) => (((root + i) % 12) + 12) % 12)
}

/** The chord's notes stacked closely around `register` (a MIDI note): good for pads and keys. */
export function voice(root, type, register = 60, count = 4) {
  const base = CHORDS[type].map((i) => root + i)
  const notes = []
  for (const n of base) {
    let m = n
    while (m < register - 7) m += 12
    while (m > register + 5) m -= 12
    notes.push(m)
  }
  notes.sort((a, b) => a - b)
  const unique = [...new Set(notes)]
  return unique.slice(0, count)
}

/** All the MIDI notes of the chord inside [lo, hi]. */
export function chordTones(root, type, lo, hi) {
  const classes = new Set(chordClasses(root, type))
  const out = []
  for (let m = lo; m <= hi; m++) if (classes.has(((m % 12) + 12) % 12)) out.push(m)
  return out
}

/** A scale anchored on a tonic: steps up and down by scale degree, nearest-note lookup. */
export class Scale {
  constructor(tonic, name) {
    this.tonic = tonic
    this.name = name
    this.degrees = SCALES[name]
    this.classes = new Set(this.degrees.map((d) => (tonic + d) % 12))
  }

  has(midi) {
    return this.classes.has(((midi % 12) + 12) % 12)
  }

  /** Index of the scale tone at or just below `midi`, counted from the tonic's octave 0. */
  indexOf(midi) {
    const rel = midi - this.tonic
    const octave = Math.floor(rel / 12)
    const within = rel - octave * 12
    let best = 0
    for (let i = 0; i < this.degrees.length; i++) if (this.degrees[i] <= within) best = i
    return octave * this.degrees.length + best
  }

  /** MIDI note of scale index `index` (may be negative or past one octave). */
  at(index) {
    const n = this.degrees.length
    const octave = Math.floor(index / n)
    return this.tonic + octave * 12 + this.degrees[((index % n) + n) % n]
  }

  /** The note `steps` scale degrees above `midi` (which is first moved onto the scale). */
  step(midi, steps) {
    return this.at(this.indexOf(midi) + steps)
  }

  nearest(midi) {
    let best = midi
    for (let d = 0; d < 12; d++) {
      if (this.has(midi + d)) return midi + d
      if (this.has(midi - d)) return midi - d
    }
    return best
  }
}

/**
 * A melody over a chord progression.
 *
 * `chords[bar]` is `{ root, type }` (one chord per bar; a bar that lasts longer repeats it). A two-bar motif is
 * invented once, from the rhythm bank; later bars answer it by repeating its contour over the new chord, with
 * strong beats snapped to chord tones. Returns `[{ bar, beat, dur, midi, vel }]`.
 */
export function melody({ rand, scale, chords, rhythms, range, bars, restChance = 0.12, leap = 0.18, tonicEnd = true, varyEvery = 4, velocity = [0.62, 0.9] }) {
  const [lo, hi] = range
  const centre = Math.round((lo + hi) / 2)
  const pick = (list) => list[Math.floor(rand() * list.length)]

  // Contour of one bar: for each note, how many scale steps it moves from the previous note.
  const contour = (pattern, startBias) =>
    pattern.map(([beat, dur], i) => {
      if (i === 0) return { beat, dur, steps: startBias, strong: true }
      const roll = rand()
      let steps = roll < leap ? pick([-3, 3, 2, -2, 4]) : pick([-1, 1, 1, -1, 2, -2, 0])
      if (beat % 1 === 0 && dur >= 1) steps = pick([-2, -1, 1, 2, 0])
      return { beat, dur, steps, strong: beat % 2 === 0 || dur >= 1.5 }
    })

  const motifA = [contour(pick(rhythms), 0), contour(pick(rhythms), pick([-1, 1, 2]))]
  const motifB = [contour(pick(rhythms), pick([1, 2, 3])), contour(pick(rhythms), pick([-2, -1, 0]))]
  const out = []
  let prev = centre
  for (let bar = 0; bar < bars; bar++) {
    const chord = chords[bar % chords.length]
    const block = Math.floor(bar / 2)
    const motif = (Math.floor(block / Math.max(1, varyEvery / 2)) % 2 === 0 ? motifA : motifB)[bar % 2]
    const tones = chordTones(chord.root, chord.type, lo, hi)
    const lastBarOfPhrase = bar % varyEvery === varyEvery - 1
    motif.forEach((note, i) => {
      if (i > 0 && rand() < restChance) return
      let midi
      if (i === 0) {
        // First note of a bar: the chord tone nearest the previous note, nudged by the contour.
        const target = prev + note.steps
        midi = tones.reduce((best, m) => (Math.abs(m - target) < Math.abs(best - target) ? m : best), tones[0])
      } else {
        midi = scale.step(prev, note.steps)
        if (note.strong) midi = tones.reduce((best, m) => (Math.abs(m - midi) < Math.abs(best - midi) ? m : best), tones[0])
      }
      if (lastBarOfPhrase && i === motif.length - 1 && tonicEnd) {
        const roots = tones.filter((m) => m % 12 === chord.root % 12)
        if (roots.length) midi = roots.reduce((best, m) => (Math.abs(m - prev) < Math.abs(best - prev) ? m : best), roots[0])
      }
      // Keep the line from drifting out of its register.
      while (midi > hi) midi -= 12
      while (midi < lo) midi += 12
      const vel = velocity[0] + (velocity[1] - velocity[0]) * (note.strong ? 0.8 + rand() * 0.2 : rand() * 0.7)
      out.push({ bar, beat: note.beat, dur: note.dur, midi, vel })
      prev = midi
    })
  }
  return out
}

/** Arpeggio pattern: the chord tones in `order` (indices into the voiced chord), as notes of `step` beats. */
export function arpeggio(notes, order, steps, stepBeats) {
  const out = []
  for (let i = 0; i < steps; i++) out.push({ beat: i * stepBeats, dur: stepBeats, midi: notes[order[i % order.length] % notes.length] + (order[i % order.length] >= notes.length ? 12 : 0) })
  return out
}
