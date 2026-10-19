#!/usr/bin/env node
// Measures every file of the audio library against the manifest and against the quality rules (nobody can listen to 112
// files in a review, so the rules are numbers): checksums, exact loop length, loudness around -16 LUFS, no clipping,
// a loop seam without a click, the declared tempo and key, a sane spectrum, effects that start and end in silence.
//
//   node qa.mjs                  check everything under backend/data/audio
//   node qa.mjs --dir DIR --manifest FILE --only id,id --verbose
// Exit status 1 when any rule fails.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bands, clippedSamples, correlation, dcOffset, inKeyShare, longestSilence, seam, tempo, tempoSupport } from './analysis.mjs'
import { MUSIC } from './catalog.mjs'
import { SR } from './dsp.mjs'
import { activeLoudness, integratedLoudness, rms, samplePeak, toDb, truePeak } from './loudness.mjs'
import { decode, sha256 } from './media.mjs'
import { NOTE, SCALES } from './theory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const dir = resolve(option('--dir', join(here, '..', '..', 'data', 'audio')))
const manifestPath = resolve(option('--manifest', join(here, '..', '..', 'data', 'audio_library.json')))
const only = option('--only', '') ? new Set(option('--only', '').split(',')) : null
const verbose = args.includes('--verbose')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const failures = []
const rows = []

function check(entry, name, ok, detail) {
  if (!ok) failures.push(`${entry.id}: ${name} (${detail})`)
  return ok
}

function checkMusic(entry, channels, bytes) {
  const spec = MUSIC.find((t) => t.id === entry.id)
  const samples = channels[0].length
  const seconds = samples / SR
  const expected = spec ? Math.round(spec.bars * 4 * ((SR * 60) / spec.bpm)) : null
  const lufs = integratedLoudness(channels.map(doubled))
  const tp = toDb(truePeak(channels))
  const measure = {
    seconds,
    lufs,
    tp,
    clipped: clippedSamples(channels),
    dc: dcOffset(channels),
    silence: longestSilence(channels),
    seam: seam(channels),
    corr: correlation(channels[0], channels[1]),
    spectrum: bands(channels),
    tempo: tempo(channels),
    tempoSupport: spec ? tempoSupport(channels, spec.bpm) : 1,
    inKey: spec ? inKeyShare(channels, SCALES[spec.scale].map((d) => (NOTE[spec.key] + d) % 12)) : 1,
  }
  check(entry, 'length 30-60 s', seconds >= 30 && seconds <= 60, seconds.toFixed(2))
  if (expected) check(entry, 'exactly the bars of the loop', Math.abs(samples - expected) <= 1, `${samples} vs ${expected} samples`)
  check(entry, 'loudness near -16 LUFS', Math.abs(lufs - -16) <= 1, lufs.toFixed(2))
  check(entry, 'true peak below -1 dBTP', tp <= -1, tp.toFixed(2))
  check(entry, 'no clipped samples', measure.clipped === 0, String(measure.clipped))
  check(entry, 'no DC offset', measure.dc < 0.002, measure.dc.toExponential(1))
  check(entry, 'no long silence', measure.silence < 0.5, `${measure.silence.toFixed(2)} s`)
  check(entry, 'loop seam without a click', measure.seam.stepRatio <= 2.5, measure.seam.stepRatio.toFixed(2))
  check(entry, 'level at the seam', measure.seam.levelJumpDb <= 6, `${measure.seam.levelJumpDb.toFixed(1)} dB`)
  check(entry, 'stereo is not out of phase', measure.corr > 0, measure.corr.toFixed(2))
  check(entry, 'spectral centroid 150-4500 Hz', measure.spectrum.centroid >= 150 && measure.spectrum.centroid <= 4500, measure.spectrum.centroid.toFixed(0))
  check(entry, 'sub-bass does not dominate', measure.spectrum.share.sub < 0.4, `${(measure.spectrum.share.sub * 100).toFixed(0)}%`)
  check(entry, 'almost nothing above 12 kHz', measure.spectrum.share.air < 0.03, `${(measure.spectrum.share.air * 100).toFixed(1)}%`)
  if (spec) {
    check(entry, 'stays in key', measure.inKey >= 0.7, measure.inKey.toFixed(2))
    if (!['calm', 'romantic'].includes(spec.mood)) check(entry, 'declared tempo is supported by the onsets', measure.tempoSupport >= 0.55, `${measure.tempoSupport.toFixed(2)} (found ${measure.tempo}, declared ${spec.bpm})`)
  }
  check(entry, 'size matches the manifest', bytes.length === entry.bytes, String(bytes.length))
  return `${seconds.toFixed(1)}s ${lufs.toFixed(1)}LUFS ${tp.toFixed(1)}dBTP seam×${measure.seam.stepRatio.toFixed(2)}/${measure.seam.levelJumpDb.toFixed(1)}dB centroid ${measure.spectrum.centroid.toFixed(0)}Hz key ${measure.inKey.toFixed(2)} bpm ${measure.tempo}`
}

function doubled(channel) {
  const out = new Float32Array(channel.length * 2)
  out.set(channel, 0)
  out.set(channel, channel.length)
  return out
}

function checkEffect(entry, channels, bytes) {
  const seconds = channels[0].length / SR
  const peak = toDb(samplePeak(channels))
  const tp = toDb(truePeak(channels))
  const loud = activeLoudness(channels)
  const level = toDb(rms(channels))
  const first = Math.max(...channels.map((c) => Math.abs(c[0])))
  const last = Math.max(...channels.map((c) => Math.abs(c[c.length - 1])))
  check(entry, 'length 0.02-6 s', seconds >= 0.02 && seconds <= 6, seconds.toFixed(2))
  check(entry, 'peak below -1 dBFS', peak <= -1, peak.toFixed(2))
  check(entry, 'true peak below -0.5 dBTP', tp <= -0.5, tp.toFixed(2))
  check(entry, 'no clipped samples', clippedSamples(channels) === 0, '')
  check(entry, 'loudness -26..-12 LUFS', loud >= -26 && loud <= -12, loud.toFixed(1))
  check(entry, 'not silent', level > -55, level.toFixed(1))
  check(entry, 'starts in silence', first < 0.02, first.toFixed(4))
  check(entry, 'ends in silence', last < 0.005, last.toFixed(4))
  check(entry, 'no DC offset', dcOffset(channels) < 0.005, '')
  check(entry, 'size matches the manifest', bytes.length === entry.bytes, String(bytes.length))
  check(entry, 'finite samples', channels.every((c) => c.every(Number.isFinite)), '')
  return `${seconds.toFixed(2)}s ${loud.toFixed(1)}LUFS ${peak.toFixed(1)}dBFS`
}

let totalBytes = 0
for (const entry of manifest.tracks) {
  if (only && !only.has(entry.id)) continue
  const path = join(dir, entry.file)
  const bytes = readFileSync(path)
  totalBytes += bytes.length
  check(entry, 'checksum matches the manifest', sha256(bytes) === entry.sha256, '')
  const channels = decode(path, entry.channels)
  check(entry, 'duration matches the manifest', Math.abs((channels[0].length / SR) * 1000 - entry.durationMs) <= 1, String(entry.durationMs))
  const line = entry.kind === 'music' ? checkMusic(entry, channels.length === 1 ? [channels[0], channels[0]] : channels, bytes) : checkEffect(entry, channels, bytes)
  rows.push(`${entry.kind.padEnd(5)} ${entry.id.padEnd(24)} ${line}`)
  if (verbose) console.log(rows[rows.length - 1])
}
if (!only) {
  check({ id: 'library' }, 'bundle of at most 15 MB', totalBytes <= 15 * 1024 * 1024, `${(totalBytes / 1e6).toFixed(2)} MB`)
  check({ id: 'library' }, 'at least 24 music loops', manifest.tracks.filter((t) => t.kind === 'music').length >= 24, '')
  check({ id: 'library' }, 'at least 60 sound effects', manifest.tracks.filter((t) => t.kind === 'sfx').length >= 60, '')
  for (const mood of ['upbeat', 'calm', 'cinematic', 'lofi', 'corporate', 'playful', 'romantic', 'dramatic']) {
    check({ id: 'library' }, `three tracks of mood ${mood}`, manifest.tracks.filter((t) => t.mood === mood).length >= 3, '')
  }
}
if (!verbose) for (const row of rows) console.log(row)
console.log(`${rows.length} files, ${(totalBytes / 1e6).toFixed(2)} MB, ${failures.length} problem(s)`)
for (const failure of failures) console.error(`FAIL ${failure}`)
process.exit(failures.length ? 1 : 0)
