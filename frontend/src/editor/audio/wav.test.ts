import { describe, expect, it } from 'vitest'
import { encodeWav, wavByteLength } from './wav'

const pcm = (channels: number[][], sampleRate = 8000) => ({ sampleRate, numberOfChannels: channels.length, length: channels[0].length, getChannelData: (c: number) => Float32Array.from(channels[c]) })

describe('encodeWav', () => {
  it('writes a RIFF header that describes the data', () => {
    const bytes = encodeWav(pcm([[0, 0.5, -0.5], [1, -1, 0]], 44_100))
    const view = new DataView(bytes.buffer)
    const text = (at: number, n: number): string => String.fromCharCode(...bytes.slice(at, at + n))
    expect([text(0, 4), text(8, 8), text(36, 4)]).toEqual(['RIFF', 'WAVEfmt ', 'data'])
    expect(view.getUint32(4, true)).toBe(bytes.length - 8)
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)]).toEqual([1, 2, 44_100, 176_400, 4, 16])
    expect(view.getUint32(40, true)).toBe(3 * 2 * 2)
    expect(bytes.length).toBe(wavByteLength({ length: 3, numberOfChannels: 2 }))
  })

  it('interleaves the channels and scales to 16 bits', () => {
    const view = new DataView(encodeWav(pcm([[0, 0.5, -0.5], [1, -1, 0]])).buffer)
    const sample = (i: number): number => view.getInt16(44 + i * 2, true)
    expect([sample(0), sample(1)]).toEqual([0, 32767])
    expect(sample(2)).toBeCloseTo(16384, -1)
    expect(sample(3)).toBe(-32768)
    expect(sample(4)).toBeCloseTo(-16384, -1)
    expect(sample(5)).toBe(0)
  })

  it('clips instead of wrapping', () => {
    const view = new DataView(encodeWav(pcm([[3, -3]])).buffer)
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([32767, -32768])
  })

  it('can keep the exact samples as 32-bit float', () => {
    const bytes = encodeWav(pcm([[0.25, -1.5]]), 'float32')
    const view = new DataView(bytes.buffer)
    expect(view.getUint16(20, true)).toBe(3)
    expect(view.getUint16(34, true)).toBe(32)
    expect([view.getFloat32(44, true), view.getFloat32(48, true)]).toEqual([0.25, -1.5])
  })

  it('writes an empty file for no samples', () => {
    expect(encodeWav(pcm([[]])).length).toBe(44)
  })
})
