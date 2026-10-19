// Loudness and level measurement (ITU-R BS.1770-4 / EBU R128 at 48 kHz) for the generator and its QA script.

import { SR } from './dsp.mjs'

// K-weighting at 48 kHz, coefficients from BS.1770-4 table 1 and 2.
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] }
const RLB = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] }

function filter(x, { b, a }) {
  const y = new Float64Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

export const kWeight = (x) => filter(filter(x, SHELF), RLB)

function blockEnergies(weighted, blockSamples, hopSamples) {
  // weighted: array of Float64Array (one per channel). Returns the summed channel mean-squares per block.
  const n = weighted[0].length
  const prefix = weighted.map((w) => {
    const p = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) p[i + 1] = p[i] + w[i] * w[i]
    return p
  })
  const out = []
  for (let start = 0; start + blockSamples <= n; start += hopSamples) {
    let z = 0
    for (const p of prefix) z += (p[start + blockSamples] - p[start]) / blockSamples
    out.push(z)
  }
  return out
}

const toLufs = (z) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity)

/** Integrated loudness (LUFS) with the absolute (-70) and relative (-10 LU) gates. -Infinity if silent. */
export function integratedLoudness(channels) {
  const weighted = channels.map(kWeight)
  const blocks = blockEnergies(weighted, Math.round(0.4 * SR), Math.round(0.1 * SR))
  if (blocks.length === 0) return activeLoudness(channels)
  const above = blocks.filter((z) => toLufs(z) > -70)
  if (above.length === 0) return -Infinity
  const relative = toLufs(above.reduce((a, b) => a + b, 0) / above.length) - 10
  const gated = above.filter((z) => toLufs(z) > relative)
  return toLufs(gated.reduce((a, b) => a + b, 0) / gated.length)
}

/**
 * Loudness of a short sound: the mean energy of the 50 ms blocks that are within 25 dB of the loudest block.
 * (Integrated loudness needs at least 400 ms and counts the silence of a short effect.)
 */
export function activeLoudness(channels) {
  const weighted = channels.map(kWeight)
  const block = Math.round(0.05 * SR)
  const blocks = blockEnergies(weighted, Math.min(block, weighted[0].length), Math.round(0.025 * SR))
  const peak = Math.max(...blocks)
  if (!(peak > 0)) return -Infinity
  const active = blocks.filter((z) => z >= peak * 10 ** -2.5)
  return toLufs(active.reduce((a, b) => a + b, 0) / active.length)
}

/** Loudest 400 ms block (momentary maximum), in LUFS. */
export function momentaryMax(channels) {
  const weighted = channels.map(kWeight)
  const blocks = blockEnergies(weighted, Math.round(0.4 * SR), Math.round(0.1 * SR))
  return blocks.length ? toLufs(Math.max(...blocks)) : activeLoudness(channels)
}

/** Largest sample magnitude. */
export function samplePeak(channels) {
  let p = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]))
  return p
}

// 4x oversampling with a 24-tap windowed sinc, for an estimate of the true (inter-sample) peak.
const TP_TAPS = 12
const TP_PHASES = [0.25, 0.5, 0.75].map((frac) => {
  const k = []
  for (let j = -TP_TAPS + 1; j <= TP_TAPS; j++) {
    const x = j - frac
    const sinc = Math.sin(Math.PI * x) / (Math.PI * x)
    const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TP_TAPS + 0.5))
    k.push(sinc * window)
  }
  return k
})

/** Estimated true peak (linear). */
export function truePeak(channels) {
  let peak = samplePeak(channels)
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      if (Math.abs(c[i]) < peak * 0.6) continue // inter-sample peaks cannot exceed the neighbours' envelope by much
      for (const taps of TP_PHASES) {
        let acc = 0
        for (let j = 0; j < taps.length; j++) {
          const idx = i + j - TP_TAPS + 1
          if (idx >= 0 && idx < c.length) acc += c[idx] * taps[j]
        }
        peak = Math.max(peak, Math.abs(acc))
      }
    }
  }
  return peak
}

export function rms(channels) {
  let sum = 0
  let count = 0
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) sum += c[i] * c[i]
    count += c.length
  }
  return Math.sqrt(sum / Math.max(1, count))
}

export const toDb = (linear) => 20 * Math.log10(Math.max(linear, 1e-12))
