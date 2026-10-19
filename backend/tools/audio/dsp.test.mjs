// Run with: node --test backend/tools/audio/
import assert from 'node:assert/strict'
import test from 'node:test'
import { Biquad, SR, dbToGain, limit, reverb, rng, stereo } from './dsp.mjs'
import { activeLoudness, integratedLoudness, samplePeak, toDb, truePeak } from './loudness.mjs'

function sine(freq, seconds, amplitude) {
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR)
  return out
}

test('a stereo 997 Hz sine at -23 dBFS measures -23 LUFS (EBU R128 reference)', () => {
  const x = sine(997, 6, dbToGain(-23))
  assert.ok(Math.abs(integratedLoudness([x, x]) - -23) < 0.1)
})

test('loudness follows level in 1 dB steps', () => {
  const quiet = sine(440, 5, dbToGain(-30))
  const loud = sine(440, 5, dbToGain(-24))
  assert.ok(Math.abs(integratedLoudness([loud, loud]) - integratedLoudness([quiet, quiet]) - 6) < 0.05)
})

test('silence is -Infinity and short sounds use the active-part measure', () => {
  assert.equal(integratedLoudness([new Float32Array(SR), new Float32Array(SR)]), -Infinity)
  const burst = new Float32Array(SR)
  burst.set(sine(1000, 0.1, 0.25), 1000)
  const short = activeLoudness([burst, burst])
  assert.ok(short > -22 && short < -12)
})

test('true peak is at least the sample peak and finds inter-sample overshoot', () => {
  const x = sine(11025, 0.2, 0.9)
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] * 1.2))
  assert.ok(truePeak([x]) >= samplePeak([x]))
})

test('the limiter holds the ceiling and leaves quiet audio alone', () => {
  const buf = stereo(SR)
  const loud = sine(220, 1, 2.5)
  buf.l.set(loud)
  buf.r.set(loud)
  limit(buf, { ceilingDb: -1 })
  assert.ok(toDb(samplePeak([buf.l, buf.r])) <= -0.99)
  const quiet = stereo(SR)
  quiet.l.set(sine(220, 1, 0.1))
  const before = quiet.l.slice()
  limit(quiet, { ceilingDb: -1 })
  assert.deepEqual(quiet.l, before)
})

test('the random generator is deterministic', () => {
  const a = rng(42)
  const b = rng(42)
  for (let i = 0; i < 5; i++) assert.equal(a(), b())
})

test('a lowpass filter attenuates what is above its cutoff', () => {
  const f = new Biquad().set('lowpass', 500, 0.7071)
  const high = sine(8000, 0.5, 1)
  let peak = 0
  for (let i = 0; i < high.length; i++) {
    const y = f.process(high[i])
    if (i > 2000) peak = Math.max(peak, Math.abs(y))
  }
  assert.ok(peak < 0.01)
})

test('the reverb decays and stays stable', () => {
  const n = SR * 3
  const l = new Float32Array(n)
  l[0] = 1
  const wet = reverb(l, l, { t60: 1.5 })
  let early = 0
  let late = 0
  for (let i = 0; i < n; i++) {
    const e = wet.l[i] ** 2
    if (i < SR * 0.5) early += e
    if (i > SR * 2.5) late += e
  }
  assert.ok(early > 0 && late < early * 0.01 && Number.isFinite(late))
})
