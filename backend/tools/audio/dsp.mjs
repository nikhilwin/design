// Signal-processing building blocks for the audio library generator. Plain JavaScript, no dependencies, and
// fully deterministic: every random choice comes from a seeded generator, so the same input renders the same
// samples on every machine. Sample rate is fixed at 48 kHz (the rate Opus works at).

export const SR = 48000
export const TAU = Math.PI * 2

/** Small, fast, seedable generator (mulberry32). Returns numbers in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 32-bit FNV-1a hash of the parts, for deriving seeds ("track seed + note index"). */
export function hashSeed(...parts) {
  let h = 0x811c9dc5
  for (const ch of parts.join('|')) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export const dbToGain = (db) => 10 ** (db / 20)
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12))
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12)
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a, b, t) => a + (b - a) * t

/** A stereo buffer of `length` samples. */
export function stereo(length) {
  return { l: new Float32Array(length), r: new Float32Array(length), length }
}

/* ------------------------------------------------------------------------------------------------ filters */

/** RBJ biquad in transposed direct form II. */
export class Biquad {
  constructor() {
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.z1 = 0
    this.z2 = 0
  }

  set(type, freq, q = 0.7071, gainDb = 0) {
    const f = clamp(freq, 10, SR * 0.49)
    const w0 = (TAU * f) / SR
    const cos = Math.cos(w0)
    const sin = Math.sin(w0)
    const alpha = sin / (2 * Math.max(q, 0.01))
    const A = 10 ** (gainDb / 40)
    let b0, b1, b2, a0, a1, a2
    switch (type) {
      case 'lowpass':
        b0 = (1 - cos) / 2
        b1 = 1 - cos
        b2 = b0
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      case 'highpass':
        b0 = (1 + cos) / 2
        b1 = -(1 + cos)
        b2 = b0
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      case 'bandpass':
        b0 = alpha
        b1 = 0
        b2 = -alpha
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      case 'notch':
        b0 = 1
        b1 = -2 * cos
        b2 = 1
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      case 'peaking':
        b0 = 1 + alpha * A
        b1 = -2 * cos
        b2 = 1 - alpha * A
        a0 = 1 + alpha / A
        a1 = -2 * cos
        a2 = 1 - alpha / A
        break
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha
        b0 = A * (A + 1 - (A - 1) * cos + s)
        b1 = 2 * A * (A - 1 - (A + 1) * cos)
        b2 = A * (A + 1 - (A - 1) * cos - s)
        a0 = A + 1 + (A - 1) * cos + s
        a1 = -2 * (A - 1 + (A + 1) * cos)
        a2 = A + 1 + (A - 1) * cos - s
        break
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha
        b0 = A * (A + 1 + (A - 1) * cos + s)
        b1 = -2 * A * (A - 1 + (A + 1) * cos)
        b2 = A * (A + 1 + (A - 1) * cos - s)
        a0 = A + 1 - (A - 1) * cos + s
        a1 = 2 * (A - 1 - (A + 1) * cos)
        a2 = A + 1 - (A - 1) * cos - s
        break
      }
      case 'allpass':
        b0 = 1 - alpha
        b1 = -2 * cos
        b2 = 1 + alpha
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      default:
        throw new Error(`unknown filter ${type}`)
    }
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
    return this
  }

  process(x) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }

  reset() {
    this.z1 = 0
    this.z2 = 0
  }
}

export function biquadFilter(input, type, freq, q = 0.7071, gainDb = 0) {
  const filter = new Biquad().set(type, freq, q, gainDb)
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = filter.process(input[i])
  return out
}

/** Smooth control signal -> filter cutoff: the filter is re-tuned every `STEP` samples. */
export const CONTROL_STEP = 24

/* ------------------------------------------------------------------------------------------ oscillators */

function polyblep(t, dt) {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

export const sawBL = (phase, dt) => 2 * phase - 1 - polyblep(phase, dt)

export function squareBL(phase, dt, width = 0.5) {
  let v = phase < width ? 1 : -1
  v += polyblep(phase, dt)
  v -= polyblep((phase - width + 1) % 1, dt)
  return v
}

export const triangle = (phase) => 4 * Math.abs(phase - 0.5) - 1

/** White noise generator from a seed. */
export function noiseSource(seed) {
  const next = rng(seed)
  return () => next() * 2 - 1
}

/* ----------------------------------------------------------------------------------------------- envelopes */

/** Attack-release amplitude at sample `i` of a note of `hold` samples with a release tail. */
export function arEnv(i, attack, hold, release) {
  if (i < attack) return i / attack
  if (i < hold) return 1
  const r = (i - hold) / release
  return r >= 1 ? 0 : 1 - r
}

/** Smooth (raised cosine) edges so a sound never starts or stops with a click. */
export function fadeEdges(buf, inSamples, outSamples) {
  const n = buf.length
  for (let i = 0; i < inSamples && i < n; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / inSamples)
  for (let i = 0; i < outSamples && i < n; i++) buf[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / outSamples)
  return buf
}

/* ----------------------------------------------------------------------------------------- delay and reverb */

class DelayLine {
  constructor(length) {
    this.buf = new Float32Array(length)
    this.pos = 0
  }
  read() {
    return this.buf[this.pos]
  }
  write(v) {
    this.buf[this.pos] = v
    this.pos = (this.pos + 1) % this.buf.length
  }
}

function hadamard8(v) {
  // Orthogonal 8x8 Hadamard (fast Walsh transform), scaled by 1/sqrt(8).
  for (let len = 1; len < 8; len <<= 1) {
    for (let i = 0; i < 8; i += len << 1) {
      for (let j = i; j < i + len; j++) {
        const a = v[j]
        const b = v[j + len]
        v[j] = a + b
        v[j + len] = a - b
      }
    }
  }
  const s = 1 / Math.sqrt(8)
  for (let i = 0; i < 8; i++) v[i] *= s
}

/**
 * A feedback-delay-network reverb: input diffusion (4 allpasses), 8 mutually coupled delay lines with
 * frequency-dependent decay, decorrelated stereo taps. Processes whole buffers; returns the wet signal.
 */
export function reverb(inL, inR, { t60 = 2.2, damp = 0.35, preDelayMs = 18, size = 1, spread = 1, highCut = 7000 } = {}) {
  const n = inL.length
  const base = [1031, 1327, 1523, 1777, 2053, 2287, 2579, 2897]
  const lens = base.map((b) => Math.round(b * size))
  const lines = lens.map((len) => new DelayLine(len))
  const gains = lens.map((len) => 10 ** ((-3 * len) / (SR * t60)))
  const lp = new Float32Array(8)
  const pre = Math.max(1, Math.round((preDelayMs / 1000) * SR))
  const preL = new DelayLine(pre)
  const preR = new DelayLine(pre)
  const ap = [142, 107, 379, 277].map((d) => ({ l: new DelayLine(d), r: new DelayLine(Math.round(d * 1.13)) }))
  const outL = new Float32Array(n)
  const outR = new Float32Array(n)
  const v = new Float64Array(8)
  const hc = new Biquad().set('lowpass', highCut, 0.6)
  const hcR = new Biquad().set('lowpass', highCut, 0.6)
  const signsL = [1, -1, 1, 1, -1, 1, -1, -1]
  const signsR = [1, 1, -1, 1, -1, -1, 1, -1]
  const apGain = 0.55
  for (let i = 0; i < n; i++) {
    let xl = preL.read()
    let xr = preR.read()
    preL.write(inL[i])
    preR.write(inR[i])
    for (const stage of ap) {
      const dl = stage.l.read()
      const yl = -apGain * xl + dl
      stage.l.write(xl + apGain * yl)
      xl = yl
      const dr = stage.r.read()
      const yr = -apGain * xr + dr
      stage.r.write(xr + apGain * yr)
      xr = yr
    }
    const mono = (xl + xr) * 0.5
    for (let k = 0; k < 8; k++) v[k] = lines[k].read()
    let sumL = 0
    let sumR = 0
    for (let k = 0; k < 8; k++) {
      sumL += signsL[k] * v[k]
      sumR += signsR[k] * v[k]
    }
    hadamard8(v)
    for (let k = 0; k < 8; k++) {
      let y = v[k] * gains[k]
      lp[k] += (y - lp[k]) * (1 - damp)
      y = lp[k]
      lines[k].write(y + (k % 2 === 0 ? xl : xr) * 0.35 + mono * 0.15)
    }
    outL[i] = hc.process(sumL * 0.35 * spread + sumR * 0.1 * (1 - spread))
    outR[i] = hcR.process(sumR * 0.35 * spread + sumL * 0.1 * (1 - spread))
  }
  return { l: outL, r: outR }
}

/** Ping-pong style stereo delay; wet signal only. */
export function pingPong(inL, inR, { timeMs = 375, feedback = 0.35, tone = 3500 } = {}) {
  const n = inL.length
  const d = Math.max(1, Math.round((timeMs / 1000) * SR))
  const lineL = new DelayLine(d)
  const lineR = new DelayLine(d)
  const lpL = new Biquad().set('lowpass', tone, 0.6)
  const lpR = new Biquad().set('lowpass', tone, 0.6)
  const outL = new Float32Array(n)
  const outR = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const dl = lineL.read()
    const dr = lineR.read()
    outL[i] = dl
    outR[i] = dr
    lineL.write(lpL.process(inL[i] * 0.7 + dr * feedback))
    lineR.write(lpR.process(inR[i] * 0.3 + dl * feedback))
  }
  return { l: outL, r: outR }
}

/** A short modulated delay mix, for width on pads and strings. Returns the processed signal (dry + wet). */
export function chorus(input, { rate = 0.35, depthMs = 5, mix = 0.5, phase = 0 } = {}) {
  const n = input.length
  const maxD = Math.ceil(((depthMs * 2 + 12) / 1000) * SR)
  const line = new Float32Array(maxD)
  const out = new Float32Array(n)
  let w = 0
  for (let i = 0; i < n; i++) {
    line[w] = input[i]
    const t = (i / SR) * rate * TAU + phase
    const delay = ((8 + depthMs * Math.sin(t)) / 1000) * SR
    let rp = w - delay
    while (rp < 0) rp += maxD
    const i0 = Math.floor(rp)
    const frac = rp - i0
    const a = line[i0 % maxD]
    const b = line[(i0 + 1) % maxD]
    out[i] = input[i] * (1 - mix * 0.5) + (a + (b - a) * frac) * mix
    w = (w + 1) % maxD
  }
  return out
}

/* ------------------------------------------------------------------------------------ dynamics and levels */

/** Feed-forward stereo-linked compressor, in place. Returns the buffer. */
export function compress(buf, { thresholdDb = -18, ratio = 3, attackMs = 12, releaseMs = 140, makeupDb = 0 } = {}) {
  const atk = Math.exp(-1 / ((attackMs / 1000) * SR))
  const rel = Math.exp(-1 / ((releaseMs / 1000) * SR))
  const makeup = dbToGain(makeupDb)
  let env = 0
  for (let i = 0; i < buf.length; i++) {
    const level = Math.max(Math.abs(buf.l[i]), Math.abs(buf.r[i]))
    env = level > env ? atk * env + (1 - atk) * level : rel * env + (1 - rel) * level
    const over = gainToDb(env) - thresholdDb
    const gain = over > 0 ? dbToGain(-over * (1 - 1 / ratio)) : 1
    buf.l[i] *= gain * makeup
    buf.r[i] *= gain * makeup
  }
  return buf
}

/** Look-ahead peak limiter, in place: no sample leaves above `ceiling` (linear). */
export function limit(buf, { ceilingDb = -1.2, lookaheadMs = 2.5, releaseMs = 90 } = {}) {
  const ceiling = dbToGain(ceilingDb)
  const n = buf.length
  const look = Math.max(2, Math.round((lookaheadMs / 1000) * SR))
  const need = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(buf.l[i]), Math.abs(buf.r[i]))
    need[i] = p > ceiling ? ceiling / p : 1
  }
  // Smallest gain needed anywhere in [i, i + look - 1] ...
  const smallest = new Float32Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[queue[tail - 1]] >= need[i]) tail--
    queue[tail++] = i
    while (queue[head] > i + look - 1) head++
    smallest[i] = need[queue[head]]
  }
  // ... averaged over the look-ahead so the gain eases in before a peak (the average over [i - look + 1, i]
  // only contains values at or below the peak's need when i is the peak) ...
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + smallest[i]
  const average = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const from = i - look + 1
    average[i] = (prefix[i + 1] - prefix[Math.max(0, from)] + Math.max(0, -from)) / look
  }
  // ... and released slowly afterwards.
  const release = 1 - Math.exp(-1 / ((releaseMs / 1000) * SR))
  let g = 1
  for (let i = 0; i < n; i++) {
    g = average[i] < g ? average[i] : g + (average[i] - g) * release
    buf.l[i] *= g
    buf.r[i] *= g
  }
  // Rounding in the average can leave a hair of overshoot; the clamp makes the ceiling a guarantee.
  for (let i = 0; i < n; i++) {
    buf.l[i] = clamp(buf.l[i], -ceiling, ceiling)
    buf.r[i] = clamp(buf.r[i], -ceiling, ceiling)
  }
  return buf
}

/** Gentle saturation (tanh) with makeup so the knee starts around `drive`. */
export function saturate(buf, drive = 1) {
  const norm = Math.tanh(drive)
  for (let i = 0; i < buf.length; i++) {
    buf.l[i] = Math.tanh(buf.l[i] * drive) / norm
    buf.r[i] = Math.tanh(buf.r[i] * drive) / norm
  }
  return buf
}

export function peakOf(buf) {
  let p = 0
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf.l[i]), Math.abs(buf.r[i]))
  return p
}

export function scale(buf, gain) {
  for (let i = 0; i < buf.length; i++) {
    buf.l[i] *= gain
    buf.r[i] *= gain
  }
  return buf
}

/** Removes DC and rumble. */
export function highpass(buf, freq = 30) {
  const fl = new Biquad().set('highpass', freq, 0.7071)
  const fr = new Biquad().set('highpass', freq, 0.7071)
  for (let i = 0; i < buf.length; i++) {
    buf.l[i] = fl.process(buf.l[i])
    buf.r[i] = fr.process(buf.r[i])
  }
  return buf
}

/** Runs `process` on two copies of the buffer back to back and keeps the second: for a loop, the steady state. */
export function periodic(buf, process) {
  const n = buf.length
  const twice = stereo(n * 2)
  twice.l.set(buf.l, 0)
  twice.l.set(buf.l, n)
  twice.r.set(buf.r, 0)
  twice.r.set(buf.r, n)
  process(twice)
  return { l: twice.l.slice(n), r: twice.r.slice(n), length: n }
}

/** Mixes a mono voice into a circular stereo bus (the voice wraps around the end of the loop). */
export function addCircular(bus, voice, start, gainL, gainR) {
  const n = bus.length
  let pos = ((start % n) + n) % n
  for (let i = 0; i < voice.length; i++) {
    const v = voice[i]
    bus.l[pos] += v * gainL
    bus.r[pos] += v * gainR
    pos++
    if (pos === n) pos = 0
  }
}

/** Mixes a mono voice into a stereo buffer without wrapping (one-shots). */
export function addLinear(bus, voice, start, gainL, gainR) {
  for (let i = 0; i < voice.length; i++) {
    const p = start + i
    if (p < 0 || p >= bus.length) continue
    bus.l[p] += voice[i] * gainL
    bus.r[p] += voice[i] * gainR
  }
}

/** Equal-power pan: -1 is left, +1 is right. */
export function pan(position) {
  const a = ((clamp(position, -1, 1) + 1) * Math.PI) / 4
  return [Math.cos(a), Math.sin(a)]
}
