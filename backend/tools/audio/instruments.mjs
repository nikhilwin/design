// Synthesised instruments. Every function returns a mono Float32Array (or a { l, r } pair for the ensembles)
// holding one note, including its release tail, rendered from a seeded generator so it is reproducible.

import { Biquad, CONTROL_STEP, SR, TAU, clamp, fadeEdges, lerp, midiToHz, noiseSource, rng, sawBL, squareBL, triangle } from './dsp.mjs'

const samples = (seconds) => Math.max(1, Math.round(seconds * SR))

/** Adds a decaying sine partial using a recurrence (no per-sample trig): out[i] += amp * exp(-t/tau) * sin. */
function addPartial(out, freq, amp, tau, phase = 0, delay = 0, attack = 0) {
  if (freq >= SR * 0.46 || amp < 1e-5) return
  const w = (TAU * freq) / SR
  const c = 2 * Math.cos(w)
  const decay = Math.exp(-1 / (tau * SR))
  let y1 = Math.sin(phase - w)
  let y0 = Math.sin(phase)
  let a = amp
  const start = Math.round(delay * SR)
  const att = Math.round(attack * SR)
  for (let i = start; i < out.length; i++) {
    const k = i - start
    out[i] += a * y0 * (k < att ? k / att : 1)
    const y = c * y0 - y1
    y1 = y0
    y0 = y
    a *= decay
    if (a < 1e-6) break
  }
}

function lowpassSweep(buf, fromHz, toHz, tau, q = 0.7071) {
  const f = new Biquad()
  for (let i = 0; i < buf.length; i++) {
    if (i % CONTROL_STEP === 0) f.set('lowpass', toHz + (fromHz - toHz) * Math.exp(-i / (tau * SR)), q)
    buf[i] = f.process(buf[i])
  }
  return buf
}

/* ------------------------------------------------------------------------------------------- keys and mallets */

/** Felt-ish piano: inharmonic partials with faster decay up the series, two slightly detuned strings, a soft hammer. */
export function piano({ midi, dur, vel = 0.8, seed = 1, bright = 0.5 }) {
  const f = midiToHz(midi)
  const tail = 1.2
  const out = new Float32Array(samples(dur + tail + 0.5))
  const r = rng(seed)
  const tau0 = clamp(3.8 * (220 / f) ** 0.35, 0.9, 5)
  const b = 0.0003 * (f / 261.6) ** 2
  const partials = Math.min(14, Math.floor((SR * 0.45) / f))
  for (let k = 1; k <= partials; k++) {
    const fk = f * k * Math.sqrt(1 + b * k * k)
    const level = (1 / k ** (1.15 - bright * 0.5)) * (k === 1 ? 1 : 0.55 + 0.45 * vel)
    const tau = tau0 / (1 + 0.55 * (k - 1))
    addPartial(out, fk * 1.00018, level * 0.55, tau, r() * TAU, 0, 0.002)
    addPartial(out, fk * 0.99982, level * 0.55, tau * 0.97, r() * TAU, 0, 0.002)
  }
  const hammer = noiseSource(seed ^ 0x9e37)
  const hp = new Biquad().set('bandpass', 1800 + 3000 * bright, 0.8)
  for (let i = 0; i < samples(0.012); i++) out[i] += hp.process(hammer()) * 0.22 * vel * (1 - i / samples(0.012))
  // Release: a short exponential fade after the key is lifted (the damper).
  const hold = samples(dur)
  const rel = samples(0.35)
  for (let i = hold; i < out.length; i++) out[i] *= Math.max(0, 1 - (i - hold) / rel) ** 2
  for (let i = 0; i < out.length; i++) out[i] *= 0.5 * (0.35 + 0.65 * vel)
  return fadeEdges(out, 12, 32)
}

/** Rhodes-style electric piano: FM tine + bell, with a tremolo. */
export function epiano({ midi, dur, vel = 0.8, seed = 1, trem = 4.2, tremDepth = 0.12, drive = 0 }) {
  const f = midiToHz(midi)
  const len = samples(dur + 0.9)
  const out = new Float32Array(len)
  const r = rng(seed)
  const p0 = r() * TAU
  const index0 = 1.2 + 2.2 * vel
  const tau = clamp(2.2 * (220 / f) ** 0.25, 0.7, 3)
  let phase = 0
  let phase2 = 0
  const hold = samples(dur)
  const rel = samples(0.6)
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = Math.exp(-t / tau) * (i < 90 ? i / 90 : 1)
    const idx = index0 * Math.exp(-t / 0.55) + 0.12
    phase += (TAU * f) / SR
    phase2 += (TAU * f * 14) / SR
    const mod = Math.sin(phase + p0) * idx
    let v = Math.sin(phase + mod) * env
    v += Math.sin(phase2) * 0.04 * vel * Math.exp(-t / 0.08)
    v *= 1 - tremDepth * 0.5 * (1 - Math.sin(TAU * trem * t))
    if (drive > 0) v = Math.tanh(v * (1 + drive)) / Math.tanh(1 + drive)
    const g = i < hold ? 1 : Math.max(0, 1 - (i - hold) / rel) ** 2
    out[i] = v * g * 0.5 * (0.4 + 0.6 * vel)
  }
  return fadeEdges(out, 10, 40)
}

const MALLET_SETS = {
  marimba: { ratios: [1, 3.9, 9.8, 15.7], amps: [1, 0.35, 0.12, 0.04], taus: [0.5, 0.12, 0.05, 0.02] },
  vibes: { ratios: [1, 3.98, 9.9], amps: [1, 0.3, 0.08], taus: [1.8, 0.7, 0.25] },
  glock: { ratios: [1, 2.76, 5.4, 8.9], amps: [1, 0.4, 0.2, 0.08], taus: [1.1, 0.5, 0.25, 0.12] },
  kalimba: { ratios: [1, 5.4, 8.9], amps: [1, 0.25, 0.08], taus: [0.9, 0.12, 0.05] },
  bell: { ratios: [1, 2.0, 2.4, 3.0, 4.07, 5.43, 6.8], amps: [1, 0.55, 0.45, 0.4, 0.28, 0.18, 0.1], taus: [2.8, 2.0, 1.6, 1.2, 0.9, 0.6, 0.4] },
}

export function mallet({ midi, dur, vel = 0.8, seed = 1, kind = 'marimba', ring = 1 }) {
  const set = MALLET_SETS[kind]
  const f = midiToHz(midi)
  const out = new Float32Array(samples(dur * 0.5 + 2.4 * ring + 0.2))
  const r = rng(seed)
  set.ratios.forEach((ratio, i) => addPartial(out, f * ratio, set.amps[i] * (0.4 + 0.6 * vel), set.taus[i] * ring * clamp((261 / f) ** 0.3, 0.5, 1.8), r() * TAU, 0, 0.0008))
  const tick = noiseSource(seed ^ 0x51)
  const hp = new Biquad().set('bandpass', 3500, 1)
  for (let i = 0; i < samples(0.006); i++) out[i] += hp.process(tick()) * 0.12 * vel * (1 - i / samples(0.006))
  for (let i = 0; i < out.length; i++) out[i] *= 0.55
  return fadeEdges(out, 6, 64)
}

/* ---------------------------------------------------------------------------------------------- plucked strings */

/** Karplus-Strong string (guitar, harp, pizzicato): `damp` is how fast the highs die (0 bright .. 1 dull). */
export function pluckString({ midi, dur, vel = 0.8, seed = 1, damp = 0.5, bright = 0.6, sustain = 1 }) {
  const f = midiToHz(midi)
  const len = samples(dur * sustain + 0.6)
  const out = new Float32Array(len)
  const period = SR / f - 0.5
  const n = Math.max(2, Math.floor(period))
  const frac = period - n
  const ap = (1 - frac) / (1 + frac)
  const line = new Float32Array(n + 1)
  const noise = noiseSource(seed)
  const shape = new Biquad().set('lowpass', 1200 + 7000 * bright, 0.7)
  for (let i = 0; i <= n; i++) line[i] = shape.process(noise()) * (0.5 + 0.5 * vel)
  let pos = 0
  let apState = 0
  let prev = 0
  const loss = 0.9985 - 0.012 * damp
  const decayTau = Math.max(0.2, (dur * sustain + 0.4) / 2.2)
  for (let i = 0; i < len; i++) {
    const cur = line[pos]
    const next = line[(pos + 1) % (n + 1)]
    let v = 0.5 * (cur + next) * loss
    const y = ap * (v - apState) + prev
    prev = v
    apState = y
    v = y
    line[pos] = v
    pos = (pos + 1) % (n + 1)
    out[i] = cur * Math.exp(-i / (decayTau * SR))
  }
  const hold = samples(dur)
  const rel = samples(0.25)
  for (let i = hold; i < len; i++) out[i] *= Math.max(0, 1 - (i - hold) / rel)
  return fadeEdges(out, 8, 48)
}

/** Subtractive pluck for electronic music: saw + square through a closing lowpass. */
export function synthPluck({ midi, dur, vel = 0.8, seed = 1, cutoff = 4200, decay = 0.28, square = 0.35, detune = 6 }) {
  const f = midiToHz(midi)
  const len = samples(Math.min(dur, 0.9) + 0.35)
  const out = new Float32Array(len)
  const r = rng(seed)
  let p1 = r()
  let p2 = r()
  let p3 = r()
  const d1 = f / SR
  const d2 = (f * 2 ** (detune / 1200)) / SR
  const d3 = (f * 2 ** (-detune / 1200)) / SR
  const filter = new Biquad()
  for (let i = 0; i < len; i++) {
    if (i % CONTROL_STEP === 0) {
      const t = i / SR
      filter.set('lowpass', 500 + (cutoff * (0.5 + 0.5 * vel) - 500) * Math.exp(-t / decay), 1.2)
    }
    const v = sawBL(p1, d1) * 0.4 + sawBL(p2, d2) * 0.3 + squareBL(p3, d3) * square * 0.4
    p1 = (p1 + d1) % 1
    p2 = (p2 + d2) % 1
    p3 = (p3 + d3) % 1
    const t = i / SR
    out[i] = filter.process(v) * Math.exp(-t / (decay * 1.8)) * (0.35 + 0.65 * vel) * 0.5
  }
  return fadeEdges(out, 6, 64)
}

/* -------------------------------------------------------------------------------------------------- bass */

export function bass({ midi, dur, vel = 0.8, seed = 1, kind = 'sub', cutoff = 700, glideFrom = null }) {
  const f = midiToHz(midi)
  const len = samples(dur + 0.25)
  const out = new Float32Array(len)
  const hold = samples(dur)
  const rel = samples(0.18)
  let ph = 0
  let phSaw = 0
  const filter = new Biquad()
  const gl = glideFrom === null ? 1 : midiToHz(glideFrom) / f
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const fi = f * (gl === 1 ? 1 : 1 + (gl - 1) * Math.exp(-t / 0.05))
    ph += (TAU * fi) / SR
    phSaw = (phSaw + fi / SR) % 1
    const env = i < hold ? Math.min(1, i / 120) * (kind === 'pluck' ? Math.exp(-t / 0.45) * 0.7 + 0.3 : 1) : Math.max(0, 1 - (i - hold) / rel) ** 2 * (kind === 'pluck' ? 0.3 : 1)
    let v
    if (kind === 'sub') {
      v = Math.sin(ph) + 0.25 * Math.sin(2 * ph) * Math.exp(-t / 0.2)
      v = Math.tanh(v * 1.4) * 0.8
    } else if (kind === 'saw') {
      if (i % CONTROL_STEP === 0) filter.set('lowpass', 160 + cutoff * (0.3 + 0.7 * Math.exp(-t / 0.18)) * (0.6 + 0.4 * vel), 1.6)
      v = filter.process(sawBL(phSaw, fi / SR)) * 0.9 + Math.sin(ph) * 0.55
    } else {
      if (i % CONTROL_STEP === 0) filter.set('lowpass', 120 + cutoff * (0.2 + 0.8 * Math.exp(-t / 0.12)), 1.1)
      v = filter.process(triangle(phSaw) * 0.6 + sawBL(phSaw, fi / SR) * 0.5) + Math.sin(ph) * 0.4
    }
    out[i] = v * env * (0.45 + 0.55 * vel) * 0.7
  }
  return fadeEdges(out, 16, 48)
}

/* ------------------------------------------------------------------------------------- sustained ensembles */

/** Detuned saw pad / string ensemble. Returns { l, r } with the unison voices spread across the stereo field. */
export function pad({ midi, dur, vel = 0.7, seed = 1, voices = 5, detune = 14, attack = 0.5, release = 1.0, bright = 0.45, vibrato = 0, wave = 'saw' }) {
  const f = midiToHz(midi)
  const len = samples(dur + release)
  const l = new Float32Array(len)
  const r = new Float32Array(len)
  const rand = rng(seed)
  const hold = samples(dur)
  const att = samples(attack)
  const rel = samples(release)
  const phases = Array.from({ length: voices }, () => rand())
  const offsets = Array.from({ length: voices }, (_, i) => (voices === 1 ? 0 : (i / (voices - 1)) * 2 - 1))
  const filterL = new Biquad()
  const filterR = new Biquad()
  const lfoPhase = rand() * TAU
  const cutoffBase = 350 + 4200 * bright
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = (i < att ? i / att : 1) * (i < hold ? 1 : Math.max(0, 1 - (i - hold) / rel))
    const vib = vibrato ? 1 + vibrato * Math.sin(TAU * 5.2 * t + lfoPhase) * Math.min(1, t / 0.6) : 1
    if (i % CONTROL_STEP === 0) {
      const c = cutoffBase * (0.55 + 0.45 * Math.min(1, t / Math.max(attack, 0.2)) + 0.12 * Math.sin(TAU * 0.17 * t + lfoPhase))
      filterL.set('lowpass', c, 0.8)
      filterR.set('lowpass', c, 0.8)
    }
    let sl = 0
    let sr = 0
    for (let v = 0; v < voices; v++) {
      const fi = f * vib * 2 ** ((offsets[v] * detune) / 1200)
      const dt = fi / SR
      phases[v] = (phases[v] + dt) % 1
      const s = wave === 'square' ? squareBL(phases[v], dt, 0.5) * 0.7 : wave === 'tri' ? triangle(phases[v]) : sawBL(phases[v], dt)
      const w = (offsets[v] + 1) / 2
      sl += s * (1 - w * 0.7)
      sr += s * (0.3 + w * 0.7)
    }
    l[i] = filterL.process(sl / voices) * env * vel * 0.9
    r[i] = filterR.process(sr / voices) * env * vel * 0.9
  }
  fadeEdges(l, 24, 48)
  fadeEdges(r, 24, 48)
  return { l, r }
}

/** A brass-like stab or swell: a pair of saws with an opening filter. */
export function brass({ midi, dur, vel = 0.8, seed = 1, attack = 0.06, open = 3800, release = 0.18 }) {
  const f = midiToHz(midi)
  const len = samples(dur + release)
  const out = new Float32Array(len)
  const r = rng(seed)
  let p1 = r()
  let p2 = r()
  const filter = new Biquad()
  const hold = samples(dur)
  const att = samples(attack)
  const rel = samples(release)
  for (let i = 0; i < len; i++) {
    const t = i / SR
    if (i % CONTROL_STEP === 0) filter.set('lowpass', 300 + open * (0.25 + 0.75 * Math.min(1, t / (attack * 1.6))) * (0.5 + 0.5 * vel), 1.0)
    const d1 = (f * 1.002) / SR
    const d2 = (f * 0.998) / SR
    p1 = (p1 + d1) % 1
    p2 = (p2 + d2) % 1
    const env = (i < att ? i / att : 1) * (i < hold ? 1 : Math.max(0, 1 - (i - hold) / rel))
    out[i] = filter.process(sawBL(p1, d1) * 0.5 + sawBL(p2, d2) * 0.5) * env * vel * 0.6
  }
  return fadeEdges(out, 16, 64)
}

/** A singing lead: sine/triangle/square with delayed vibrato and an optional breath of noise. */
export function lead({ midi, dur, vel = 0.8, seed = 1, wave = 'sine', vibrato = 0.004, attack = 0.02, release = 0.2, breath = 0, bright = 0.5, glideFrom = null }) {
  const f = midiToHz(midi)
  const len = samples(dur + release)
  const out = new Float32Array(len)
  const noise = noiseSource(seed)
  const rand = rng(seed ^ 0x77)
  let ph = rand()
  const hold = samples(dur)
  const att = samples(attack)
  const rel = samples(release)
  const filter = new Biquad().set('lowpass', 1500 + 5500 * bright, 0.7)
  const breathFilter = new Biquad().set('bandpass', f * 2, 1.5)
  const gl = glideFrom === null ? 1 : midiToHz(glideFrom) / f
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const vib = 1 + vibrato * Math.sin(TAU * 5.4 * t) * clamp((t - 0.18) / 0.35, 0, 1)
    const fi = f * vib * (gl === 1 ? 1 : 1 + (gl - 1) * Math.exp(-t / 0.04))
    const dt = fi / SR
    ph = (ph + dt) % 1
    let s
    if (wave === 'sine') s = Math.sin(TAU * ph) + 0.18 * Math.sin(TAU * ph * 2)
    else if (wave === 'tri') s = triangle(ph)
    else if (wave === 'square') s = squareBL(ph, dt, 0.5) * 0.6
    else s = sawBL(ph, dt) * 0.6
    s = filter.process(s)
    if (breath) s += breathFilter.process(noise()) * breath
    const env = (i < att ? i / att : 1) * (i < hold ? 1 : Math.max(0, 1 - (i - hold) / rel) ** 1.5)
    out[i] = s * env * vel * 0.55
  }
  return fadeEdges(out, 12, 64)
}

/* ------------------------------------------------------------------------------------------------- drums */

export function kick({ vel = 1, seed = 1, kind = 'house' }) {
  const o = {
    house: { f0: 52, f1: 130, pitchTau: 0.028, tau: 0.34, click: 0.4, drive: 1.6, len: 0.5 },
    soft: { f0: 48, f1: 105, pitchTau: 0.03, tau: 0.3, click: 0.18, drive: 1.1, len: 0.45 },
    deep: { f0: 41, f1: 100, pitchTau: 0.05, tau: 0.62, click: 0.15, drive: 1.8, len: 0.9 },
    punch: { f0: 56, f1: 170, pitchTau: 0.02, tau: 0.26, click: 0.55, drive: 2.0, len: 0.4 },
  }[kind]
  const out = new Float32Array(samples(o.len))
  const noise = noiseSource(seed)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = o.f0 + (o.f1 - o.f0) * Math.exp(-t / o.pitchTau)
    ph += (TAU * f) / SR
    let v = Math.sin(ph) * Math.exp(-t / o.tau)
    v = Math.tanh(v * o.drive) / Math.tanh(o.drive)
    v += noise() * o.click * Math.exp(-t / 0.004)
    out[i] = v * vel
  }
  return fadeEdges(out, 4, 96)
}

export function snare({ vel = 1, seed = 1, kind = 'tight' }) {
  const o = { tight: { tone: 190, toneTau: 0.06, noiseTau: 0.12, hp: 1400, len: 0.28 }, fat: { tone: 165, toneTau: 0.09, noiseTau: 0.2, hp: 900, len: 0.4 }, soft: { tone: 175, toneTau: 0.05, noiseTau: 0.09, hp: 2000, len: 0.22 } }[kind]
  const out = new Float32Array(samples(o.len))
  const noise = noiseSource(seed)
  const bp = new Biquad().set('highpass', o.hp, 0.7)
  const lp = new Biquad().set('lowpass', 9500, 0.7)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (TAU * (o.tone * (1 + 0.5 * Math.exp(-t / 0.012)))) / SR
    const body = Math.sin(ph) * Math.exp(-t / o.toneTau) * 0.7
    const hiss = lp.process(bp.process(noise())) * Math.exp(-t / o.noiseTau) * 0.9
    out[i] = (body + hiss) * vel
  }
  return fadeEdges(out, 4, 128)
}

export function clap({ vel = 1, seed = 1 }) {
  const out = new Float32Array(samples(0.34))
  const noise = noiseSource(seed)
  const bp = new Biquad().set('bandpass', 1500, 1.1)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const bursts = [0, 0.011, 0.023].reduce((acc, d) => acc + (t >= d ? Math.exp(-(t - d) / 0.004) : 0), 0)
    const tail = t >= 0.034 ? Math.exp(-(t - 0.034) / 0.075) : 0
    out[i] = bp.process(noise()) * (bursts * 0.5 + tail * 0.8) * vel * 1.4
  }
  return fadeEdges(out, 4, 128)
}

export function hat({ vel = 0.7, seed = 1, open = false, tone = 7500 }) {
  const out = new Float32Array(samples(open ? 0.32 : 0.09))
  const noise = noiseSource(seed)
  const hp = new Biquad().set('highpass', tone, 0.8)
  const metal = [1, 1.4471, 1.6170, 1.9265, 2.5028, 2.6637].map((m) => m * 330)
  const ph = metal.map(() => 0)
  const tau = open ? 0.11 : 0.022
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let m = 0
    for (let k = 0; k < metal.length; k++) {
      ph[k] += (TAU * metal[k]) / SR
      m += Math.sign(Math.sin(ph[k]))
    }
    out[i] = hp.process(noise() * 0.7 + (m / metal.length) * 0.3) * Math.exp(-t / tau) * vel * 0.7
  }
  return fadeEdges(out, 3, 96)
}

export function shaker({ vel = 0.5, seed = 1 }) {
  const out = new Float32Array(samples(0.11))
  const noise = noiseSource(seed)
  const bp = new Biquad().set('bandpass', 6200, 1.4)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const env = Math.min(1, t / 0.012) * Math.exp(-t / 0.032)
    out[i] = bp.process(noise()) * env * vel * 1.1
  }
  return fadeEdges(out, 3, 96)
}

export function rim({ vel = 0.7, seed = 1 }) {
  const out = new Float32Array(samples(0.08))
  const noise = noiseSource(seed)
  let a = 0
  let b = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    a += (TAU * 1750) / SR
    b += (TAU * 910) / SR
    out[i] = (Math.sin(a) * 0.5 + Math.sin(b) * 0.4 + noise() * 0.1) * Math.exp(-t / 0.012) * vel
  }
  return fadeEdges(out, 3, 64)
}

export function tom({ vel = 0.8, seed = 1, pitch = 110, tau = 0.22 }) {
  const out = new Float32Array(samples(tau * 4))
  const noise = noiseSource(seed)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (TAU * pitch * (1 + 0.6 * Math.exp(-t / 0.03))) / SR
    out[i] = (Math.sin(ph) * Math.exp(-t / tau) + noise() * 0.1 * Math.exp(-t / 0.01)) * vel
  }
  return fadeEdges(out, 4, 128)
}

export function taiko({ vel = 1, seed = 1, pitch = 62 }) {
  const out = new Float32Array(samples(1.5))
  const noise = noiseSource(seed)
  const body = new Biquad().set('lowpass', 520, 1.2)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (TAU * pitch * (1 + 0.9 * Math.exp(-t / 0.05))) / SR
    const skin = Math.sin(ph) * Math.exp(-t / 0.55) + Math.sin(ph * 1.5) * 0.3 * Math.exp(-t / 0.2)
    out[i] = (skin + body.process(noise()) * 0.55 * Math.exp(-t / 0.018)) * vel * 0.85
  }
  return fadeEdges(out, 4, 256)
}

export function crash({ vel = 0.8, seed = 1, len = 2.4 }) {
  const out = new Float32Array(samples(len))
  const noise = noiseSource(seed)
  const hp = new Biquad().set('highpass', 3200, 0.7)
  const bp = new Biquad().set('bandpass', 7000, 0.5)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = (hp.process(noise()) * 0.6 + bp.process(noise()) * 0.5) * Math.exp(-t / (len / 4.5)) * Math.min(1, t / 0.004) * vel * 0.8
  }
  return fadeEdges(out, 3, 512)
}

/* ------------------------------------------------------------------------------------------- textures */

/** A looping bed of vinyl crackle: sparse clicks and a faint hiss. Periodic by construction (wraps). */
export function crackle(length, seed, { density = 9, level = 0.06 } = {}) {
  const out = new Float32Array(length)
  const r = rng(seed)
  const hiss = noiseSource(seed ^ 0xabc)
  const hp = new Biquad().set('highpass', 4500, 0.7)
  for (let i = 0; i < length; i++) out[i] = hp.process(hiss()) * level * 0.12
  const clicks = Math.round((length / SR) * density)
  for (let c = 0; c < clicks; c++) {
    const at = Math.floor(r() * length)
    const amp = (r() ** 3 * 0.9 + 0.1) * level * (r() < 0.5 ? -1 : 1)
    const tau = 0.0004 + r() * 0.0015
    for (let k = 0; k < 160; k++) out[(at + k) % length] += amp * Math.exp(-k / (tau * SR)) * (k === 0 ? 1 : Math.cos(k * 0.9))
  }
  return out
}

/** A slow wash of band-limited noise that wraps seamlessly (made on two copies, the second one is kept). */
export function wash(length, seed, { low = 500, high = 3000, level = 0.1 } = {}) {
  const src = noiseSource(seed)
  const twice = new Float32Array(length * 2)
  for (let i = 0; i < length; i++) twice[i] = src()
  twice.copyWithin(length, 0, length)
  const hp = new Biquad().set('highpass', low, 0.7)
  const lp = new Biquad().set('lowpass', high, 0.7)
  const out = new Float32Array(length)
  for (let i = 0; i < length * 2; i++) {
    const v = lp.process(hp.process(twice[i]))
    if (i >= length) out[i - length] = v * level
  }
  return out
}

/** Noise that rises in pitch and level over `seconds` and stops at the end (a riser into a downbeat). */
export function riser({ seconds, seed = 1, from = 300, to = 9000, level = 0.5, curve = 2 }) {
  const out = new Float32Array(samples(seconds))
  const noise = noiseSource(seed)
  const f = new Biquad()
  for (let i = 0; i < out.length; i++) {
    const p = i / out.length
    if (i % CONTROL_STEP === 0) f.set('bandpass', from * (to / from) ** (p ** 1.4), 1.8)
    out[i] = f.process(noise()) * p ** curve * level * 2.2
  }
  return fadeEdges(out, 64, 24)
}

export { lerp }
