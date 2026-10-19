// Objective measurements used by the QA script (nobody can listen to 90 files in a review, so the files are
// measured instead): spectrum, tempo, key, loop seam, clipping, silence.

import { SR } from './dsp.mjs'
import { rms, toDb } from './loudness.mjs'

export function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j]
        const ui = im[i + j]
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr
        re[i + j] = ur + vr
        im[i + j] = ui + vi
        re[i + j + len / 2] = ur - vr
        im[i + j + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** Welch-averaged power spectrum of the mono mix: { freqs, power } with `size`/2 bins. */
export function spectrum(channels, size = 4096) {
  const n = channels[0].length
  const power = new Float64Array(size / 2)
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let frames = 0
  const hop = size / 2
  for (let start = 0; start + size <= n; start += hop) {
    for (let i = 0; i < size; i++) {
      let s = 0
      for (const c of channels) s += c[start + i]
      re[i] = (s / channels.length) * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k < size / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k]
    frames++
  }
  if (frames) for (let k = 0; k < power.length; k++) power[k] /= frames
  return { power, binHz: SR / size }
}

/** Share of the power in each band, plus the spectral centroid (Hz). */
export function bands(channels) {
  const { power, binHz } = spectrum(channels)
  const edges = [0, 60, 150, 500, 2000, 6000, 12000, SR / 2]
  const names = ['sub', 'bass', 'low-mid', 'mid', 'high-mid', 'high', 'air']
  const sums = new Array(names.length).fill(0)
  let total = 0
  let weighted = 0
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz
    const band = edges.findIndex((e, i) => f >= e && f < edges[i + 1])
    if (band >= 0) sums[band] += power[k]
    total += power[k]
    weighted += power[k] * f
  }
  const share = Object.fromEntries(names.map((name, i) => [name, total ? sums[i] / total : 0]))
  return { share, centroid: total ? weighted / total : 0 }
}

/** Autocorrelation score of the onset envelope for every tempo from 60 to 200 BPM in half-BPM steps. */
export function tempoScores(channels) {
  const hop = 512
  const size = 1024
  const n = channels[0].length
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let prev = new Float64Array(size / 2)
  const flux = []
  for (let start = 0; start + size <= n; start += hop) {
    for (let i = 0; i < size; i++) {
      let s = 0
      for (const c of channels) s += c[start + i]
      re[i] = (s / channels.length) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size))
      im[i] = 0
    }
    fft(re, im)
    let f = 0
    const mag = new Float64Array(size / 2)
    for (let k = 1; k < size / 2; k++) {
      mag[k] = Math.log1p(40 * Math.hypot(re[k], im[k]))
      f += Math.max(0, mag[k] - prev[k])
    }
    flux.push(f)
    prev = mag
  }
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length
  const x = flux.map((v) => v - mean)
  const scores = new Map()
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = (60 / bpm) * (SR / hop)
    let score = 0
    for (let m = 1; m <= 4; m++) {
      const l = lag * m
      const i0 = Math.floor(l)
      const frac = l - i0
      let acc = 0
      let count = 0
      for (let i = 0; i + i0 + 1 < x.length; i++) {
        acc += x[i] * (x[i + i0] * (1 - frac) + x[i + i0 + 1] * frac)
        count++
      }
      score += acc / Math.max(1, count) / m
    }
    scores.set(bpm, score)
  }
  return scores
}

/** The tempo (BPM) whose period best explains the onsets, searched between 60 and 200. */
export function tempo(channels) {
  let best = { bpm: 0, score: -Infinity }
  for (const [bpm, score] of tempoScores(channels)) if (score > best.score) best = { bpm, score }
  return best.bpm
}

/** Share of the tonal energy (100 Hz - 2 kHz) that falls on the pitch classes of the key's scale. */
export function inKeyShare(channels, scaleClasses) {
  const { power, binHz } = spectrum(channels, 16384)
  const chroma = new Float64Array(12)
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz
    if (f < 100 || f > 2000) continue
    const midi = 69 + 12 * Math.log2(f / 440)
    const nearest = Math.round(midi)
    if (Math.abs(midi - nearest) > 0.3) continue // only energy close to a note counts as tonal
    chroma[((nearest % 12) + 12) % 12] += power[k]
  }
  const total = chroma.reduce((a, b) => a + b, 0)
  if (!total) return 0
  let inKey = 0
  for (const pc of scaleClasses) inKey += chroma[pc]
  return inKey / total
}

/** How abrupt the loop point is: the step across the wrap compared with the steps around it. */
export function seam(channels) {
  const n = channels[0].length
  let worst = 0
  for (const c of channels) {
    const wrap = Math.abs(c[0] - c[n - 1])
    let around = 1e-9
    for (let i = 1; i < 3000; i++) {
      around = Math.max(around, Math.abs(c[i] - c[i - 1]), Math.abs(c[n - i] - c[n - i - 1]))
    }
    worst = Math.max(worst, wrap / around)
  }
  const window = Math.round(0.4 * SR)
  const tail = channels.map((c) => c.subarray(n - window))
  const head = channels.map((c) => c.subarray(0, window))
  return { stepRatio: worst, levelJumpDb: Math.abs(toDb(rms(head)) - toDb(rms(tail))) }
}

export function clippedSamples(channels, threshold = 0.999) {
  let count = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) >= threshold) count++
  return count
}

export function dcOffset(channels) {
  let worst = 0
  for (const c of channels) {
    let sum = 0
    for (let i = 0; i < c.length; i++) sum += c[i]
    worst = Math.max(worst, Math.abs(sum / c.length))
  }
  return worst
}

/** Longest stretch (seconds) below `thresholdDb`. */
export function longestSilence(channels, thresholdDb = -60) {
  const limit = 10 ** (thresholdDb / 20)
  const n = channels[0].length
  let run = 0
  let longest = 0
  for (let i = 0; i < n; i++) {
    let loud = false
    for (const c of channels) if (Math.abs(c[i]) > limit) loud = true
    run = loud ? 0 : run + 1
    longest = Math.max(longest, run)
  }
  return longest / SR
}

/** Stereo correlation (-1..1): 1 is mono, below 0 collapses badly when summed. */
export function correlation(l, r) {
  let lr = 0
  let ll = 0
  let rr = 0
  for (let i = 0; i < l.length; i++) {
    lr += l[i] * r[i]
    ll += l[i] * l[i]
    rr += r[i] * r[i]
  }
  return ll && rr ? lr / Math.sqrt(ll * rr) : 1
}

/** Peaks for a waveform preview: `count` values in 0..100, the loudest sample magnitude in each slice. */
export function peaks(channels, count = 72) {
  const n = channels[0].length
  const out = []
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count)
    const to = Math.floor(((b + 1) * n) / count)
    let p = 0
    for (const c of channels) for (let i = from; i < to; i++) p = Math.max(p, Math.abs(c[i]))
    out.push(p)
  }
  const top = Math.max(...out, 1e-9)
  return out.map((p) => Math.round((p / top) * 100))
}

/** Level (dB) of each octave band around `centres`, from the Welch spectrum of the mono mix. */
export function analyseOctaves(channels, centres) {
  const { power, binHz } = spectrum(channels, 8192)
  return centres.map((c) => {
    let sum = 0
    for (let k = 1; k < power.length; k++) {
      const f = k * binHz
      if (f >= c / Math.SQRT2 && f < c * Math.SQRT2) sum += power[k]
    }
    return 10 * Math.log10(sum + 1e-20)
  })
}

/** How well the onsets support `bpm`: its autocorrelation score relative to the best tempo (0..1). */
export function tempoSupport(channels, bpm) {
  const scores = tempoScores(channels)
  const at = (b) => scores.get(Math.round(b * 2) / 2) ?? 0
  const best = Math.max(...scores.values())
  return Math.max(at(bpm), at(bpm * 2), at(bpm / 2)) / best
}
