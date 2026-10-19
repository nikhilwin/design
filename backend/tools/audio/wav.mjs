// Minimal WAVE reader and writer (IEEE float 32-bit) for the generator's own analysis and for ffmpeg input.

export function floatWav(channels, sampleRate = 48000) {
  const frames = channels[0].length
  const count = channels.length
  const data = Buffer.alloc(frames * count * 4)
  for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) data.writeFloatLE(channels[c][i], (i * count + c) * 4)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(3, 20)
  head.writeUInt16LE(count, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * count * 4, 28)
  head.writeUInt16LE(count * 4, 32)
  head.writeUInt16LE(32, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** Interleaved little-endian float32 samples (what ffmpeg writes with -f f32le) split into channels. */
export function splitFloat32(buffer, channelCount) {
  const frames = Math.floor(buffer.length / 4 / channelCount)
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++) for (let c = 0; c < channelCount; c++) channels[c][i] = buffer.readFloatLE((i * channelCount + c) * 4)
  return channels
}
