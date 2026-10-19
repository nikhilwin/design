// Sound effects: a handful of synthesis engines, parameterised into the named effects of the library.
// Every builder returns a { l, r } pair (mono effects repeat one channel) of exactly the length it needs;
// the generator then fades the edges and sets the level.

import { Biquad, CONTROL_STEP, SR, TAU, clamp, fadeEdges, midiToHz, noiseSource, pan as panGains, reverb, rng, sawBL, squareBL, stereo, triangle } from './dsp.mjs'
import * as inst from './instruments.mjs'

const n = (seconds) => Math.max(1, Math.round(seconds * SR))
const both = (mono) => ({ l: mono, r: mono })

function mixInto(target, source, at, gain = 1, position = 0) {
  const [gl, gr] = panGains(position)
  const left = source.l ?? source
  const right = source.r ?? source
  for (let i = 0; i < left.length; i++) {
    const p = at + i
    if (p < 0 || p >= target.l.length) continue
    target.l[p] += left[i] * gain * (source.l ? 1 : gl * Math.SQRT2)
    target.r[p] += right[i] * gain * (source.r ? 1 : gr * Math.SQRT2)
  }
}

function waveAt(wave, phase, dt) {
  switch (wave) {
    case 'sine':
      return Math.sin(TAU * phase)
    case 'tri':
      return triangle(phase)
    case 'square':
      return squareBL(phase, dt, 0.5) * 0.6
    case 'saw':
      return sawBL(phase, dt) * 0.6
    default:
      throw new Error(`unknown wave ${wave}`)
  }
}

/* ------------------------------------------------------------------------------------------------ engines */

/** A pitched blip: glides from f0 to f1, quick attack, exponential decay. */
export function blip({ f0, f1 = f0, dur = 0.12, wave = 'sine', attack = 0.003, tau = null, glide = null, vibrato = 0, noise = 0, cutoff = 0, harmonics = 0, seed = 1 }) {
  const out = new Float32Array(n(dur))
  const decay = tau ?? dur / 4
  const g = glide ?? dur * 0.4
  const src = noiseSource(seed)
  const filter = cutoff ? new Biquad().set('lowpass', cutoff, 0.8) : null
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = f1 + (f0 - f1) * Math.exp(-t / Math.max(g, 1e-4))
    const fi = f * (1 + vibrato * Math.sin(TAU * 6 * t))
    const dt = fi / SR
    ph = (ph + dt) % 1
    let v = waveAt(wave, ph, dt)
    if (harmonics) v += harmonics * Math.sin(TAU * ph * 2) + harmonics * 0.5 * Math.sin(TAU * ph * 3)
    if (noise) v += src() * noise
    if (filter) v = filter.process(v)
    out[i] = v * Math.min(1, t / attack) * Math.exp(-t / decay)
  }
  return fadeEdges(out, 8, Math.min(out.length >> 1, 96))
}

/** A short melody of blips (notifications, success, level-up). `notes` are MIDI numbers. */
export function arpeggioFx({ notes, step = 0.08, wave = 'sine', noteDur = 0.18, tau = 0.09, harmonics = 0.15, gainCurve = 1, tail = 0.25, reverbMix = 0, pos = 0 }) {
  const total = step * (notes.length - 1) + noteDur + tail
  const out = stereo(n(total))
  notes.forEach((m, i) => {
    const b = blip({ f0: midiToHz(m), dur: noteDur + tail, wave, tau, harmonics, attack: 0.004 })
    mixInto(out, b, Math.round(i * step * SR), gainCurve ** i, pos)
  })
  return reverbMix ? withReverb(out, reverbMix, { t60: 0.9, preDelayMs: 4 }) : out
}

/** Band-limited noise whose centre frequency sweeps from f0 to f1 (whooshes, swipes, wind). */
export function noiseSweep({ dur = 0.6, f0 = 400, f1 = 3000, q = 1.2, peak = 0.5, sharp = 1.6, level = 1, panFrom = 0, panTo = 0, seed = 1, tone = 0 }) {
  const out = stereo(n(dur))
  const srcL = noiseSource(seed)
  const srcR = noiseSource(seed ^ 0x5bd1)
  const fl = new Biquad()
  const fr = new Biquad()
  for (let i = 0; i < out.l.length; i++) {
    const p = i / out.l.length
    if (i % CONTROL_STEP === 0) {
      const f = f0 * (f1 / f0) ** p
      fl.set('bandpass', f, q)
      fr.set('bandpass', f * 1.03, q)
    }
    const env = p < peak ? (p / peak) ** sharp : ((1 - p) / (1 - peak)) ** (sharp * 1.2)
    const position = panFrom + (panTo - panFrom) * p
    const [gl, gr] = panGains(position)
    const s = tone ? Math.sin(TAU * 140 * (i / SR)) * 0.2 : 0
    out.l[i] = (fl.process(srcL()) * 3 + s) * env * level * gl * Math.SQRT2
    out.r[i] = (fr.process(srcR()) * 3 + s) * env * level * gr * Math.SQRT2
  }
  fadeEdges(out.l, 24, 48)
  fadeEdges(out.r, 24, 48)
  return out
}

/** An impact: a sine that drops in pitch, a burst of noise, and optionally a long tail. */
export function thump({ f0 = 140, f1 = 45, drop = 0.06, dur = 0.5, tau = 0.16, click = 0.5, grit = 0.15, drive = 1.5, seed = 1, body = 0 }) {
  const out = new Float32Array(n(dur))
  const src = noiseSource(seed)
  const lp = new Biquad().set('lowpass', 2500, 0.7)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = f1 + (f0 - f1) * Math.exp(-t / drop)
    ph += (TAU * f) / SR
    let v = Math.sin(ph) * Math.exp(-t / tau)
    if (body) v += Math.sin(ph * 2.01) * body * Math.exp(-t / (tau * 0.5))
    v = Math.tanh(v * drive) / Math.tanh(drive)
    v += lp.process(src()) * (click * Math.exp(-t / 0.006) + grit * Math.exp(-t / (tau * 0.7)))
    out[i] = v
  }
  return fadeEdges(out, 4, 128)
}

/** A resonant, swept saw: lasers, zaps, power-ups and power-downs. */
export function zap({ f0 = 2400, f1 = 200, dur = 0.3, wave = 'saw', q = 6, cutoff0 = 6000, cutoff1 = 300, tau = null, fm = 0, seed = 1 }) {
  const out = new Float32Array(n(dur))
  const decay = tau ?? dur / 2.2
  const filter = new Biquad()
  const src = noiseSource(seed)
  let ph = 0
  let mod = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const p = t / dur
    const f = f1 * (f0 / f1) ** (1 - p) * (1 + fm * Math.sin(mod))
    mod += (TAU * 38) / SR
    const dt = f / SR
    ph = (ph + dt) % 1
    if (i % CONTROL_STEP === 0) filter.set('lowpass', cutoff1 * (cutoff0 / cutoff1) ** (1 - p), q)
    out[i] = filter.process(waveAt(wave, ph, dt) + src() * 0.02) * Math.exp(-t / decay) * Math.min(1, t / 0.002)
  }
  return fadeEdges(out, 6, 192)
}

/** Droplets and bubbles: a sine whose pitch rises quickly while it fades. */
export function bubble({ f0 = 500, f1 = 1500, dur = 0.12, tau = 0.03, wobble = 0 }) {
  const out = new Float32Array(n(dur))
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = f0 + (f1 - f0) * (1 - Math.exp(-t / (dur * 0.35)))
    ph += (TAU * f * (1 + wobble * Math.sin(TAU * 30 * t))) / SR
    out[i] = Math.sin(ph) * Math.exp(-t / tau) * Math.min(1, t / 0.002)
  }
  return fadeEdges(out, 8, 96)
}

/** Slide whistle / cartoon swoop. */
export function slide({ f0 = 400, f1 = 1600, dur = 0.5, vibrato = 0.012, curve = 1, level = 1 }) {
  const out = new Float32Array(n(dur))
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const p = (t / dur) ** curve
    const f = f0 * (f1 / f0) ** p * (1 + vibrato * Math.sin(TAU * 6.5 * t))
    ph += (TAU * f) / SR
    const env = Math.min(1, t / 0.02) * Math.min(1, (dur - t) / 0.06)
    out[i] = (Math.sin(ph) + 0.12 * Math.sin(ph * 2)) * env * level
  }
  return fadeEdges(out, 16, 96)
}

/** A very short transient: clicks, ticks, taps and key presses. */
export function click({ tone = 1800, dur = 0.03, q = 2, noise = 0.8, sine = 0.5, tau = 0.006, seed = 1, gliss = 0 }) {
  const out = new Float32Array(n(dur))
  const src = noiseSource(seed)
  const bp = new Biquad().set('bandpass', tone, q)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (TAU * tone * (1 + gliss * Math.exp(-t / 0.004))) / SR
    out[i] = (bp.process(src()) * 4 * noise + Math.sin(ph) * sine) * Math.exp(-t / tau)
  }
  return fadeEdges(out, 3, 48)
}

/** Random pings in a high register: sparkles, twinkles, glitter and shimmer. */
export function sparkles({ dur = 1.2, count = 14, low = 84, high = 108, seed = 1, tau = 0.25, scatter = 1, decay = 1.6 }) {
  const out = stereo(n(dur + 0.6))
  const r = rng(seed)
  const scale = [0, 2, 4, 7, 9]
  for (let i = 0; i < count; i++) {
    const at = (i / count) ** decay * dur * 0.9 * (0.85 + r() * 0.3)
    const octave = Math.floor(low / 12) + Math.floor(r() * ((high - low) / 12 + 1))
    const midi = clamp(octave * 12 + scale[Math.floor(r() * scale.length)], low, high + 4)
    const ping = inst.mallet({ midi, dur: 0.3, vel: 0.5 + r() * 0.5, seed: seed + i, kind: 'glock', ring: tau })
    mixInto(out, ping, Math.round(at * SR), 0.5 * (1 - at / (dur * 2)), (r() * 2 - 1) * scatter)
  }
  return out
}

/** The effect plus its own reverb tail (`mix` is the wet level); the result is longer by the tail. */
export function withReverb(buf, mix, options = {}) {
  const extra = Math.round(SR * Math.min(2.5, (options.t60 ?? 1.5) * 0.9))
  const padded = stereo(buf.l.length + extra)
  padded.l.set(buf.l)
  padded.r.set(buf.r)
  const tail = reverb(padded.l, padded.r, options)
  for (let i = 0; i < padded.l.length; i++) {
    padded.l[i] += tail.l[i] * mix
    padded.r[i] += tail.r[i] * mix
  }
  return padded
}

/** Applies an exponential fade so a long tail ends in silence. */
function tailFade(buf, from) {
  const len = buf.l.length
  for (let i = from; i < len; i++) {
    const g = Math.max(0, 1 - (i - from) / (len - from)) ** 2
    buf.l[i] *= g
    buf.r[i] *= g
  }
  return buf
}

/* --------------------------------------------------------------------------------------------- the effects */

function repeat(buf, times, gap, decay = 0.7) {
  const unit = buf.l ? buf : both(buf)
  const out = stereo(Math.round(unit.l.length + gap * SR * (times - 1)))
  for (let i = 0; i < times; i++) mixInto(out, unit, Math.round(i * gap * SR), decay ** i)
  return out
}

export const EFFECTS = [
  // ---- ui
  { id: 'click-soft', title: 'Soft Click', category: 'ui', tags: ['click', 'button', 'tap'], make: () => both(click({ tone: 1400, dur: 0.035, noise: 0.5, sine: 0.7, tau: 0.007, seed: 11 })) },
  { id: 'click-sharp', title: 'Sharp Click', category: 'ui', tags: ['click', 'button', 'mouse'], make: () => both(click({ tone: 3600, dur: 0.025, q: 3, noise: 1, sine: 0.2, tau: 0.003, seed: 12 })) },
  { id: 'tap', title: 'Tap', category: 'ui', tags: ['tap', 'touch', 'screen'], make: () => both(click({ tone: 600, dur: 0.05, q: 1.2, noise: 0.35, sine: 0.9, tau: 0.01, seed: 13, gliss: 0.8 })) },
  { id: 'tick', title: 'Tick', category: 'ui', tags: ['tick', 'clock', 'timer'], make: () => both(click({ tone: 4200, dur: 0.02, q: 4, noise: 1, sine: 0.1, tau: 0.002, seed: 14 })) },
  { id: 'tock', title: 'Tock', category: 'ui', tags: ['tock', 'clock', 'timer'], make: () => both(click({ tone: 1700, dur: 0.04, q: 3, noise: 0.8, sine: 0.5, tau: 0.006, seed: 15 })) },
  { id: 'toggle-on', title: 'Toggle On', category: 'ui', tags: ['switch', 'on', 'enable'], make: () => arpeggioFx({ notes: [72, 79], step: 0.06, noteDur: 0.1, tau: 0.04, tail: 0.04, harmonics: 0.1 }) },
  { id: 'toggle-off', title: 'Toggle Off', category: 'ui', tags: ['switch', 'off', 'disable'], make: () => arpeggioFx({ notes: [79, 72], step: 0.06, noteDur: 0.1, tau: 0.04, tail: 0.04, harmonics: 0.1 }) },
  { id: 'pop-small', title: 'Small Pop', category: 'ui', tags: ['pop', 'bubble', 'appear'], make: () => both(bubble({ f0: 300, f1: 900, dur: 0.1, tau: 0.025 })) },
  { id: 'pop-bright', title: 'Bright Pop', category: 'ui', tags: ['pop', 'appear', 'notification'], make: () => both(bubble({ f0: 500, f1: 1800, dur: 0.12, tau: 0.03 })) },
  { id: 'notification-bright', title: 'Notification', category: 'ui', tags: ['notification', 'alert', 'message'], make: () => arpeggioFx({ notes: [79, 86], step: 0.11, noteDur: 0.3, tau: 0.12, tail: 0.3, harmonics: 0.2, reverbMix: 0.25 }) },
  { id: 'notification-soft', title: 'Soft Notification', category: 'ui', tags: ['notification', 'gentle', 'message'], make: () => arpeggioFx({ notes: [74, 81, 78], step: 0.1, noteDur: 0.4, tau: 0.14, tail: 0.3, wave: 'tri', harmonics: 0.05, reverbMix: 0.3 }) },
  { id: 'message-sent', title: 'Message Sent', category: 'ui', tags: ['send', 'message', 'whoosh'], make: () => noiseSweep({ dur: 0.25, f0: 800, f1: 6000, peak: 0.4, level: 0.5, seed: 21, panFrom: -0.3, panTo: 0.6 }) },
  { id: 'message-received', title: 'Message Received', category: 'ui', tags: ['receive', 'message', 'ding'], make: () => arpeggioFx({ notes: [76, 83, 88], step: 0.07, noteDur: 0.25, tau: 0.09, tail: 0.25, harmonics: 0.25, reverbMix: 0.2 }) },
  { id: 'success', title: 'Success', category: 'ui', tags: ['success', 'done', 'complete', 'win'], make: () => arpeggioFx({ notes: [72, 76, 79, 84], step: 0.09, noteDur: 0.3, tau: 0.12, tail: 0.5, harmonics: 0.2, reverbMix: 0.3 }) },
  { id: 'error', title: 'Error', category: 'ui', tags: ['error', 'wrong', 'fail', 'buzz'], make: () => both(repeat(blip({ f0: 196, f1: 185, dur: 0.16, wave: 'square', tau: 0.12, glide: 0.05, cutoff: 1800 }), 2, 0.17, 0.9).l) },
  { id: 'warning', title: 'Warning', category: 'ui', tags: ['warning', 'alert', 'caution'], make: () => arpeggioFx({ notes: [84, 77, 84], step: 0.16, noteDur: 0.18, tau: 0.1, tail: 0.1, wave: 'tri', harmonics: 0.3 }) },
  { id: 'select', title: 'Select', category: 'ui', tags: ['select', 'choose', 'pick'], make: () => arpeggioFx({ notes: [81], noteDur: 0.18, tau: 0.06, tail: 0.1, harmonics: 0.25 }) },
  { id: 'deselect', title: 'Deselect', category: 'ui', tags: ['deselect', 'release', 'drop'], make: () => arpeggioFx({ notes: [69], noteDur: 0.14, tau: 0.04, tail: 0.08, harmonics: 0.15 }) },
  { id: 'drop-in', title: 'Drop In', category: 'ui', tags: ['drop', 'place', 'snap'], make: () => both(thump({ f0: 320, f1: 110, drop: 0.02, dur: 0.18, tau: 0.05, click: 0.3, grit: 0.05, seed: 22 })) },
  { id: 'camera-shutter', title: 'Camera Shutter', category: 'ui', tags: ['camera', 'photo', 'shutter', 'capture'], make: () => {
    const out = stereo(n(0.3))
    mixInto(out, click({ tone: 2600, dur: 0.05, q: 1.5, noise: 1, sine: 0.2, tau: 0.01, seed: 23 }), 0, 1)
    mixInto(out, click({ tone: 1700, dur: 0.07, q: 1.2, noise: 1, sine: 0.3, tau: 0.014, seed: 24 }), Math.round(0.09 * SR), 0.9)
    return out
  } },
  { id: 'key-press', title: 'Key Press', category: 'ui', tags: ['keyboard', 'type', 'key'], make: () => both(click({ tone: 2200, dur: 0.04, q: 2, noise: 0.9, sine: 0.35, tau: 0.008, seed: 25, gliss: 0.3 })) },
  { id: 'typing', title: 'Typing', category: 'ui', tags: ['keyboard', 'typing', 'type', 'writing'], make: () => {
    const out = stereo(n(1.1))
    const r = rng(26)
    let t = 0.02
    for (let i = 0; i < 12; i++) {
      mixInto(out, click({ tone: 1800 + r() * 1400, dur: 0.04, q: 2, noise: 0.9, sine: 0.35, tau: 0.008, seed: 100 + i }), Math.round(t * SR), 0.6 + r() * 0.4, (r() - 0.5) * 0.3)
      t += 0.05 + r() * 0.1
    }
    return out
  } },
  { id: 'crumple', title: 'Paper Crumple', category: 'ui', tags: ['paper', 'delete', 'trash', 'crumple'], make: () => {
    const out = stereo(n(0.7))
    const r = rng(27)
    for (let i = 0; i < 38; i++) {
      const at = Math.round(r() * 0.6 * SR)
      mixInto(out, click({ tone: 2500 + r() * 4500, dur: 0.02 + r() * 0.03, q: 1, noise: 1, sine: 0, tau: 0.004 + r() * 0.006, seed: 200 + i }), at, 0.3 + r() * 0.7, (r() - 0.5) * 0.8)
    }
    return tailFade(out, n(0.45))
  } },
  // ---- whoosh and swipe
  { id: 'whoosh-fast', title: 'Fast Whoosh', category: 'whoosh', tags: ['whoosh', 'fast', 'transition', 'swoosh'], make: () => noiseSweep({ dur: 0.45, f0: 300, f1: 5200, q: 1.1, peak: 0.45, level: 0.9, seed: 31, panFrom: -0.7, panTo: 0.7 }) },
  { id: 'whoosh-soft', title: 'Soft Whoosh', category: 'whoosh', tags: ['whoosh', 'soft', 'air', 'transition'], make: () => noiseSweep({ dur: 0.9, f0: 400, f1: 2400, q: 0.8, peak: 0.5, level: 0.7, seed: 32, sharp: 1.2, panFrom: -0.3, panTo: 0.3 }) },
  { id: 'whoosh-deep', title: 'Deep Whoosh', category: 'whoosh', tags: ['whoosh', 'deep', 'heavy', 'transition'], make: () => noiseSweep({ dur: 1.1, f0: 90, f1: 1400, q: 1.4, peak: 0.55, level: 1, seed: 33, sharp: 1.5, tone: 1 }) },
  { id: 'whoosh-airy', title: 'Airy Whoosh', category: 'whoosh', tags: ['whoosh', 'airy', 'light', 'transition'], make: () => noiseSweep({ dur: 0.8, f0: 2500, f1: 9000, q: 0.9, peak: 0.45, level: 0.7, seed: 34, panFrom: 0.5, panTo: -0.5 }) },
  { id: 'swoosh-up', title: 'Swoosh Up', category: 'whoosh', tags: ['swoosh', 'up', 'rise', 'transition'], make: () => noiseSweep({ dur: 0.55, f0: 250, f1: 7000, q: 1.6, peak: 0.7, level: 0.85, seed: 35, sharp: 1.8 }) },
  { id: 'swoosh-down', title: 'Swoosh Down', category: 'whoosh', tags: ['swoosh', 'down', 'fall', 'transition'], make: () => noiseSweep({ dur: 0.55, f0: 7000, f1: 250, q: 1.6, peak: 0.3, level: 0.85, seed: 36, sharp: 1.8 }) },
  { id: 'swipe-left', title: 'Swipe Left', category: 'whoosh', tags: ['swipe', 'left', 'slide', 'transition'], make: () => noiseSweep({ dur: 0.32, f0: 1200, f1: 4200, q: 1.3, peak: 0.4, level: 0.8, seed: 37, panFrom: 0.9, panTo: -0.9 }) },
  { id: 'swipe-right', title: 'Swipe Right', category: 'whoosh', tags: ['swipe', 'right', 'slide', 'transition'], make: () => noiseSweep({ dur: 0.32, f0: 1200, f1: 4200, q: 1.3, peak: 0.4, level: 0.8, seed: 38, panFrom: -0.9, panTo: 0.9 }) },
  { id: 'swipe-quick', title: 'Quick Swipe', category: 'whoosh', tags: ['swipe', 'quick', 'flick', 'ui'], make: () => noiseSweep({ dur: 0.18, f0: 2000, f1: 6500, q: 1.5, peak: 0.35, level: 0.7, seed: 39, panFrom: -0.4, panTo: 0.4 }) },
  { id: 'air-burst', title: 'Air Burst', category: 'whoosh', tags: ['air', 'burst', 'puff', 'blow'], make: () => noiseSweep({ dur: 0.4, f0: 1500, f1: 800, q: 0.6, peak: 0.12, level: 1, seed: 40, sharp: 1 }) },
  { id: 'transition-sweep', title: 'Transition Sweep', category: 'whoosh', tags: ['transition', 'sweep', 'cut', 'scene'], make: () => withReverb(noiseSweep({ dur: 1.0, f0: 200, f1: 6000, q: 1.2, peak: 0.6, level: 0.8, seed: 41, panFrom: -0.6, panTo: 0.6 }), 0.35, { t60: 1.4 }) },
  { id: 'reverse-swell', title: 'Reverse Swell', category: 'whoosh', tags: ['reverse', 'swell', 'build', 'transition'], make: () => noiseSweep({ dur: 1.4, f0: 600, f1: 5000, q: 1, peak: 0.97, level: 0.8, seed: 42, sharp: 2.4 }) },
  // ---- risers
  { id: 'riser-short', title: 'Short Riser', category: 'riser', tags: ['riser', 'build', 'rise', 'short'], make: () => both(inst.riser({ seconds: 1.5, seed: 51, from: 250, to: 7500, level: 0.6 })) },
  { id: 'riser-long', title: 'Long Riser', category: 'riser', tags: ['riser', 'build', 'rise', 'tension'], make: () => both(inst.riser({ seconds: 3.5, seed: 52, from: 200, to: 9000, level: 0.6, curve: 2.4 })) },
  { id: 'riser-tension', title: 'Tension Riser', category: 'riser', tags: ['riser', 'tension', 'suspense', 'cinematic'], make: () => {
    const len = 3
    const noise = inst.riser({ seconds: len, seed: 53, from: 400, to: 6000, level: 0.45, curve: 2 })
    const tone = zap({ f0: 140, f1: 140 * 4, dur: len, wave: 'saw', q: 2, cutoff0: 2500, cutoff1: 2500, tau: 100 })
    const out = stereo(noise.length)
    for (let i = 0; i < noise.length; i++) {
      const p = i / noise.length
      const v = noise[i] + tone[i] * 0.25 * p ** 2
      out.l[i] = v
      out.r[i] = v
    }
    return out
  } },
  { id: 'downer', title: 'Downer', category: 'riser', tags: ['downer', 'fall', 'drop', 'descend'], make: () => both(zap({ f0: 900, f1: 55, dur: 1.4, wave: 'saw', q: 3, cutoff0: 3500, cutoff1: 120, tau: 0.6 })) },
  // ---- impacts
  { id: 'hit-soft', title: 'Soft Hit', category: 'impact', tags: ['hit', 'soft', 'thud', 'impact'], make: () => both(thump({ f0: 180, f1: 70, drop: 0.04, dur: 0.3, tau: 0.09, click: 0.25, grit: 0.05, seed: 61 })) },
  { id: 'hit-medium', title: 'Hit', category: 'impact', tags: ['hit', 'punch', 'impact'], make: () => both(thump({ f0: 200, f1: 55, drop: 0.05, dur: 0.5, tau: 0.14, click: 0.5, grit: 0.15, seed: 62 })) },
  { id: 'hit-heavy', title: 'Heavy Hit', category: 'impact', tags: ['hit', 'heavy', 'slam', 'impact'], make: () => withReverb(both(thump({ f0: 160, f1: 42, drop: 0.07, dur: 0.9, tau: 0.3, click: 0.6, grit: 0.3, drive: 2.2, seed: 63, body: 0.25 })), 0.25, { t60: 1.1 }) },
  { id: 'hit-cinematic', title: 'Cinematic Hit', category: 'impact', tags: ['hit', 'cinematic', 'trailer', 'boom'], make: () => tailFade(withReverb(both(thump({ f0: 130, f1: 36, drop: 0.09, dur: 1.4, tau: 0.5, click: 0.5, grit: 0.35, drive: 2.4, seed: 64, body: 0.35 })), 0.6, { t60: 2.6, preDelayMs: 12 }), n(1.4)) },
  { id: 'boom', title: 'Boom', category: 'impact', tags: ['boom', 'explosion', 'low', 'bass'], make: () => tailFade(withReverb(both(thump({ f0: 90, f1: 30, drop: 0.12, dur: 2.0, tau: 0.7, click: 0.35, grit: 0.4, drive: 2.2, seed: 65 })), 0.45, { t60: 2.2 }), n(2.0)) },
  { id: 'thud', title: 'Thud', category: 'impact', tags: ['thud', 'drop', 'low', 'impact'], make: () => both(thump({ f0: 110, f1: 55, drop: 0.03, dur: 0.35, tau: 0.08, click: 0.1, grit: 0.02, drive: 1.2, seed: 66 })) },
  { id: 'slam', title: 'Slam', category: 'impact', tags: ['slam', 'door', 'bang', 'impact'], make: () => withReverb(both(thump({ f0: 260, f1: 70, drop: 0.025, dur: 0.6, tau: 0.17, click: 0.9, grit: 0.4, drive: 1.8, seed: 67 })), 0.2, { t60: 0.8 }) },
  { id: 'stomp', title: 'Stomp', category: 'impact', tags: ['stomp', 'foot', 'step', 'impact'], make: () => both(thump({ f0: 150, f1: 60, drop: 0.03, dur: 0.28, tau: 0.07, click: 0.4, grit: 0.12, seed: 68 })) },
  { id: 'cymbal-crash', title: 'Cymbal Crash', category: 'impact', tags: ['crash', 'cymbal', 'accent', 'impact'], make: () => both(inst.crash({ vel: 1, seed: 69, len: 2.6 })) },
  { id: 'stinger-brass', title: 'Brass Stinger', category: 'impact', tags: ['stinger', 'brass', 'dramatic', 'sting'], make: () => {
    const out = stereo(n(1.8))
    ;[50, 57, 62, 66].forEach((m, i) => mixInto(out, inst.brass({ midi: m + 12, dur: 0.5, seed: 70 + i, attack: 0.03, open: 3600, release: 0.5 }), 0, 0.5, (i - 1.5) * 0.3))
    mixInto(out, thump({ f0: 130, f1: 45, drop: 0.06, dur: 0.8, tau: 0.25, seed: 75 }), 0, 0.8)
    return tailFade(withReverb(out, 0.5, { t60: 1.8 }), n(1.4))
  } },
  { id: 'drum-roll', title: 'Drum Roll', category: 'impact', tags: ['drum', 'roll', 'build', 'reveal'], make: () => {
    const len = 2.2
    const out = stereo(n(len + 0.3))
    let t = 0
    let gap = 0.085
    let i = 0
    while (t < len) {
      mixInto(out, inst.snare({ vel: 0.35 + 0.65 * (t / len), seed: 80 + i, kind: 'tight' }), Math.round(t * SR), 0.7, ((i % 2) - 0.5) * 0.3)
      t += gap
      gap = Math.max(0.03, gap * 0.955)
      i++
    }
    mixInto(out, inst.crash({ vel: 0.9, seed: 79, len: 1.6 }), Math.round(len * SR), 0.7)
    return out
  } },
  // ---- magic and musical
  { id: 'sparkle', title: 'Sparkle', category: 'magic', tags: ['sparkle', 'magic', 'shine', 'glitter'], make: () => sparkles({ dur: 1.0, count: 16, seed: 91 }) },
  { id: 'twinkle', title: 'Twinkle', category: 'magic', tags: ['twinkle', 'star', 'magic', 'fairy'], make: () => sparkles({ dur: 0.7, count: 7, low: 88, high: 112, seed: 92, tau: 0.35 }) },
  { id: 'shimmer', title: 'Shimmer', category: 'magic', tags: ['shimmer', 'glow', 'magic', 'dreamy'], make: () => tailFade(withReverb(sparkles({ dur: 1.6, count: 26, low: 79, high: 103, seed: 93, tau: 0.6, decay: 1.1 }), 0.4, { t60: 2 }), n(2)) },
  { id: 'glitter', title: 'Glitter', category: 'magic', tags: ['glitter', 'sparkle', 'confetti', 'celebrate'], make: () => sparkles({ dur: 0.9, count: 30, low: 90, high: 114, seed: 94, tau: 0.18, decay: 1 }) },
  { id: 'chime-high', title: 'High Chime', category: 'magic', tags: ['chime', 'bell', 'ding', 'high'], make: () => withReverb(both(inst.mallet({ midi: 96, dur: 0.4, vel: 0.9, seed: 95, kind: 'bell', ring: 1.1 })), 0.3, { t60: 1.6 }) },
  { id: 'chime-low', title: 'Low Chime', category: 'magic', tags: ['chime', 'bell', 'gong', 'low'], make: () => withReverb(both(inst.mallet({ midi: 74, dur: 0.6, vel: 0.9, seed: 96, kind: 'bell', ring: 1.6 })), 0.35, { t60: 2.2 }) },
  { id: 'ding', title: 'Ding', category: 'magic', tags: ['ding', 'bell', 'ping', 'service'], make: () => both(inst.mallet({ midi: 88, dur: 0.3, vel: 1, seed: 97, kind: 'bell', ring: 0.7 })) },
  { id: 'ding-dong', title: 'Ding Dong', category: 'magic', tags: ['doorbell', 'ding', 'dong', 'bell'], make: () => {
    const out = stereo(n(1.8))
    mixInto(out, inst.mallet({ midi: 80, dur: 0.4, vel: 1, seed: 98, kind: 'bell', ring: 1.0 }), 0, 0.9)
    mixInto(out, inst.mallet({ midi: 72, dur: 0.6, vel: 1, seed: 99, kind: 'bell', ring: 1.4 }), Math.round(0.55 * SR), 0.9)
    return tailFade(out, n(1.0))
  } },
  { id: 'wind-chimes', title: 'Wind Chimes', category: 'magic', tags: ['chimes', 'wind', 'bells', 'calm'], make: () => {
    const out = stereo(n(2.8))
    const r = rng(101)
    const notes = [84, 86, 88, 91, 93, 96]
    for (let i = 0; i < 11; i++) mixInto(out, inst.mallet({ midi: notes[Math.floor(r() * notes.length)], dur: 0.3, vel: 0.5 + r() * 0.5, seed: 300 + i, kind: 'bell', ring: 1.3 }), Math.round(r() * 1.8 * SR), 0.5, (r() - 0.5) * 1.4)
    return tailFade(withReverb(out, 0.3, { t60: 1.8 }), n(1.6))
  } },
  { id: 'harp-gliss', title: 'Harp Glissando', category: 'magic', tags: ['harp', 'gliss', 'magic', 'transition'], make: () => {
    const scale = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88]
    const out = stereo(n(2.6))
    scale.forEach((m, i) => mixInto(out, inst.pluckString({ midi: m, dur: 0.6, vel: 0.8, seed: 400 + i, damp: 0.3, bright: 0.6, sustain: 2 }), Math.round(i * 0.045 * SR), 0.45, -0.5 + i / scale.length))
    return tailFade(withReverb(out, 0.35, { t60: 1.8 }), n(2.2))
  } },
  { id: 'magic-wand', title: 'Magic Wand', category: 'magic', tags: ['magic', 'wand', 'spell', 'fairy'], make: () => {
    const out = sparkles({ dur: 0.9, count: 18, low: 84, high: 110, seed: 102, tau: 0.3, decay: 0.9 })
    const sweep = slide({ f0: 600, f1: 3600, dur: 0.6, vibrato: 0.004, curve: 1.6, level: 0.4 })
    mixInto(out, sweep, 0, 0.5)
    return tailFade(out, n(1.0))
  } },
  { id: 'level-up', title: 'Level Up', category: 'magic', tags: ['level', 'up', 'win', 'game', 'achievement'], make: () => arpeggioFx({ notes: [67, 71, 74, 79, 83, 86], step: 0.075, noteDur: 0.3, tau: 0.13, tail: 0.6, wave: 'tri', harmonics: 0.3, reverbMix: 0.3 }) },
  { id: 'coin', title: 'Coin', category: 'magic', tags: ['coin', 'collect', 'game', 'reward'], make: () => arpeggioFx({ notes: [83, 88], step: 0.07, noteDur: 0.4, tau: 0.17, tail: 0.2, wave: 'square', harmonics: 0, gainCurve: 1 }) },
  // ---- fun
  { id: 'boing', title: 'Boing', category: 'fun', tags: ['boing', 'spring', 'bounce', 'cartoon'], make: () => both(blip({ f0: 700, f1: 160, dur: 0.7, tau: 0.35, glide: 0.35, vibrato: 0.12, wave: 'tri', harmonics: 0.25 })) },
  { id: 'bubble-pop', title: 'Bubble Pop', category: 'fun', tags: ['bubble', 'pop', 'water', 'cute'], make: () => both(bubble({ f0: 900, f1: 2600, dur: 0.09, tau: 0.02 })) },
  { id: 'bloop', title: 'Bloop', category: 'fun', tags: ['bloop', 'bubble', 'water', 'cute'], make: () => both(bubble({ f0: 250, f1: 800, dur: 0.2, tau: 0.07 })) },
  { id: 'slide-whistle-up', title: 'Slide Whistle Up', category: 'fun', tags: ['whistle', 'slide', 'up', 'cartoon'], make: () => both(slide({ f0: 350, f1: 1900, dur: 0.7 })) },
  { id: 'slide-whistle-down', title: 'Slide Whistle Down', category: 'fun', tags: ['whistle', 'slide', 'down', 'cartoon'], make: () => both(slide({ f0: 1900, f1: 300, dur: 0.8 })) },
  { id: 'squeak', title: 'Squeak', category: 'fun', tags: ['squeak', 'toy', 'rubber', 'cute'], make: () => both(slide({ f0: 1100, f1: 2200, dur: 0.14, vibrato: 0.03, curve: 0.6 })) },
  { id: 'balloon-pop', title: 'Balloon Pop', category: 'fun', tags: ['balloon', 'pop', 'burst', 'party'], make: () => both(click({ tone: 1600, dur: 0.12, q: 0.5, noise: 1, sine: 0, tau: 0.018, seed: 111 })) },
  { id: 'party-horn', title: 'Party Horn', category: 'fun', tags: ['party', 'horn', 'celebrate', 'birthday'], make: () => {
    const out = both(blip({ f0: 520, f1: 760, dur: 0.7, tau: 0.5, glide: 0.08, wave: 'saw', cutoff: 2400, attack: 0.02 }))
    return out
  } },
  { id: 'applause-clap', title: 'Hand Clap', category: 'fun', tags: ['clap', 'hands', 'applause', 'cheer'], make: () => both(inst.clap({ vel: 1, seed: 112 })) },
  { id: 'finger-snap', title: 'Finger Snap', category: 'fun', tags: ['snap', 'finger', 'click', 'cool'], make: () => both(click({ tone: 2400, dur: 0.09, q: 6, noise: 1, sine: 0.3, tau: 0.018, seed: 113, gliss: -0.1 })) },
  // ---- tech
  { id: 'zap', title: 'Zap', category: 'tech', tags: ['zap', 'electric', 'spark', 'laser'], make: () => both(zap({ f0: 3600, f1: 180, dur: 0.22, q: 8, tau: 0.08, fm: 0.3, seed: 121 })) },
  { id: 'laser', title: 'Laser', category: 'tech', tags: ['laser', 'sci-fi', 'shoot', 'game'], make: () => both(zap({ f0: 4200, f1: 400, dur: 0.35, wave: 'square', q: 5, tau: 0.15, seed: 122 })) },
  { id: 'beep', title: 'Beep', category: 'tech', tags: ['beep', 'tone', 'computer', 'signal'], make: () => both(blip({ f0: 1000, dur: 0.18, tau: 0.5, wave: 'square', attack: 0.004, cutoff: 3000 })) },
  { id: 'double-beep', title: 'Double Beep', category: 'tech', tags: ['beep', 'confirm', 'computer', 'signal'], make: () => both(repeat(blip({ f0: 1200, dur: 0.09, tau: 0.5, wave: 'square', cutoff: 3200 }), 2, 0.13, 1).l) },
  { id: 'data-burst', title: 'Data Burst', category: 'tech', tags: ['data', 'computer', 'transfer', 'digital'], make: () => {
    const out = stereo(n(0.6))
    const r = rng(123)
    for (let i = 0; i < 18; i++) mixInto(out, blip({ f0: 500 + Math.floor(r() * 12) * 180, dur: 0.035, wave: 'square', tau: 0.5, cutoff: 3500 }), Math.round(i * 0.03 * SR), 0.5, (r() - 0.5) * 0.6)
    return out
  } },
  { id: 'glitch', title: 'Glitch', category: 'tech', tags: ['glitch', 'digital', 'error', 'distort'], make: () => {
    const out = stereo(n(0.5))
    const r = rng(124)
    let t = 0
    while (t < 0.42) {
      const len = 0.01 + r() * 0.05
      const src = r() < 0.5 ? blip({ f0: 200 + r() * 3000, dur: len, wave: 'square', tau: 5, cutoff: 5000 }) : click({ tone: 1000 + r() * 6000, dur: len, noise: 1, sine: 0, tau: len, seed: Math.floor(r() * 1e6) })
      mixInto(out, src, Math.round(t * SR), 0.6, (r() - 0.5) * 1.4)
      t += len + (r() < 0.3 ? 0.04 : 0)
    }
    return out
  } },
  { id: 'power-up', title: 'Power Up', category: 'tech', tags: ['power', 'up', 'charge', 'game'], make: () => both(zap({ f0: 200, f1: 1800, dur: 0.8, wave: 'square', q: 3, cutoff0: 3500, cutoff1: 3500, tau: 0.7, fm: 0.05 })) },
  { id: 'power-down', title: 'Power Down', category: 'tech', tags: ['power', 'down', 'shutdown', 'off'], make: () => both(zap({ f0: 1500, f1: 90, dur: 0.9, wave: 'square', q: 3, cutoff0: 3000, cutoff1: 500, tau: 0.5 })) },
  { id: 'boot', title: 'Boot Up', category: 'tech', tags: ['boot', 'start', 'computer', 'startup'], make: () => arpeggioFx({ notes: [60, 67, 72, 76, 79], step: 0.1, noteDur: 0.3, tau: 0.16, tail: 0.5, wave: 'square', harmonics: 0, reverbMix: 0.2 }) },
  { id: 'scan', title: 'Scan', category: 'tech', tags: ['scan', 'search', 'radar', 'sci-fi'], make: () => both(zap({ f0: 400, f1: 2800, dur: 0.9, wave: 'sine', q: 1, cutoff0: 6000, cutoff1: 6000, tau: 1.5 })) },
  { id: 'radar-ping', title: 'Radar Ping', category: 'tech', tags: ['radar', 'sonar', 'ping', 'detect'], make: () => tailFade(withReverb(both(blip({ f0: 1400, dur: 0.6, tau: 0.25, harmonics: 0.05 })), 0.4, { t60: 1.6 }), n(1.0)) },
  // ---- nature
  { id: 'water-drop', title: 'Water Drop', category: 'nature', tags: ['water', 'drop', 'drip', 'calm'], make: () => withReverb(both(bubble({ f0: 700, f1: 1400, dur: 0.14, tau: 0.035 })), 0.35, { t60: 1.3 }) },
  { id: 'wind-gust', title: 'Wind Gust', category: 'nature', tags: ['wind', 'gust', 'air', 'storm'], make: () => noiseSweep({ dur: 2.4, f0: 300, f1: 900, q: 0.7, peak: 0.5, level: 0.8, seed: 131, sharp: 1.1, panFrom: -0.5, panTo: 0.5 }) },
  { id: 'bird-chirp', title: 'Bird Chirp', category: 'nature', tags: ['bird', 'chirp', 'tweet', 'morning'], make: () => {
    const out = stereo(n(0.7))
    ;[[0, 3200, 4600], [0.13, 3600, 5200], [0.3, 3000, 4400]].forEach(([t, a, b], i) => mixInto(out, blip({ f0: a, f1: b, dur: 0.1, glide: 0.07, tau: 0.04, harmonics: 0.1 }), Math.round(t * SR), 0.6 + i * 0.1, 0.2))
    return out
  } },
  { id: 'heartbeat', title: 'Heartbeat', category: 'nature', tags: ['heartbeat', 'pulse', 'tension', 'life'], make: () => {
    const out = stereo(n(1.1))
    mixInto(out, thump({ f0: 90, f1: 45, drop: 0.04, dur: 0.3, tau: 0.09, click: 0.05, grit: 0, drive: 1.2, seed: 141 }), 0, 1)
    mixInto(out, thump({ f0: 80, f1: 42, drop: 0.04, dur: 0.3, tau: 0.08, click: 0.05, grit: 0, drive: 1.2, seed: 142 }), Math.round(0.28 * SR), 0.7)
    return out
  } },
]
