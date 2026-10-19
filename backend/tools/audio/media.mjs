// Encoding and decoding through the `ffmpeg` command-line tool. ffmpeg is a build-time tool of this generator only:
// nothing of it is linked into, or shipped with, Doory. The output is Opus in an Ogg container (libopus, BSD-3).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SR } from './dsp.mjs'
import { splitFloat32 } from './wav.mjs'

function run(args, input) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { input, maxBuffer: 1 << 30 })
  if (result.error) throw new Error(`ffmpeg could not be started: ${result.error.message}. Install ffmpeg with libopus to run the generator.`)
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`)
  return result.stdout
}

function interleave(channels) {
  const frames = channels[0].length
  const buffer = Buffer.alloc(frames * channels.length * 4)
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels.length; c++) buffer.writeFloatLE(channels[c][i], (i * channels.length + c) * 4)
  return buffer
}

/** Writes `channels` (Float32Arrays at 48 kHz) as Opus in Ogg; the bytes are reproducible. Returns the file bytes. */
export function encodeOpus(channels, path, { kbps, title, album }) {
  mkdirSync(dirname(path), { recursive: true })
  const args = [
    '-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(channels.length), '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-application', 'audio', '-compression_level', '10', '-frame_duration', '20',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1',
    '-metadata', `title=${title}`, '-metadata', 'artist=Doory', '-metadata', `album=${album}`, '-metadata', 'license=CC0-1.0',
    '-f', 'ogg', path,
  ] // prettier-ignore
  run(args, interleave(channels))
  return readFileSync(path)
}

/** Decodes any audio file ffmpeg understands into 48 kHz float channels. */
export function decode(path, channelCount) {
  const out = run(['-i', path, '-f', 'f32le', '-ar', String(SR), '-ac', String(channelCount), 'pipe:1'])
  return splitFloat32(out, channelCount)
}

/** Channel count, codec and duration as the container declares them. */
export function probe(path) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration,size', '-of', 'json', path])
  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr?.toString()}`)
  const json = JSON.parse(result.stdout.toString())
  const stream = json.streams[0]
  return { codec: stream.codec_name, channels: stream.channels, sampleRate: Number(stream.sample_rate), duration: Number(json.format.duration), size: Number(json.format.size) }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
