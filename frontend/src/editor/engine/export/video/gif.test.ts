import { describe, expect, it } from 'vitest'
import { GifTooLargeError, createGifWriter } from './gif'
import { inspectGif } from './inspect'
import { bytesOf } from './testing'

const solid = (w: number, h: number, [r, g, b]: number[]): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) out.set([r, g, b, 255], i * 4)
  return out
}


describe('the GIF writer', () => {
  const setup = { width: 8, height: 6, loops: 0, dither: false, maxBytes: 10_000_000 }

  it('writes a valid animated GIF: size, frames, delays and the loop block', async () => {
    const writer = createGifWriter(setup)
    writer.push(solid(8, 6, [255, 0, 0]), 7)
    writer.push(solid(8, 6, [0, 255, 0]), 6)
    writer.push(solid(8, 6, [0, 0, 255]), 7)
    const info = inspectGif(await bytesOf(writer.finish()))
    expect(info).toMatchObject({ version: 'GIF89a', width: 8, height: 6, frames: 3, delaysCs: [7, 6, 7], totalCs: 20, loop: 0, trailer: true })
  })

  it('does not store a frame that equals the one before it: that frame is shown for longer', async () => {
    const writer = createGifWriter(setup)
    writer.push(solid(8, 6, [255, 0, 0]), 10)
    writer.push(solid(8, 6, [255, 0, 0]), 10)
    writer.push(solid(8, 6, [255, 0, 0]), 10)
    writer.push(solid(8, 6, [0, 0, 0]), 5)
    expect(writer.frames).toBe(2)
    const info = inspectGif(await bytesOf(writer.finish()))
    expect(info.frames).toBe(2)
    expect(info.delaysCs).toEqual([30, 5])
  })

  it('lengthens the frame before when the caller knows nothing changed', async () => {
    const writer = createGifWriter(setup)
    writer.push(solid(8, 6, [255, 0, 0]), 10)
    writer.extend(40)
    writer.extend(25)
    const info = inspectGif(await bytesOf(writer.finish()))
    expect(info.delaysCs).toEqual([75])
  })

  it('splits a delay longer than the format can count', async () => {
    const writer = createGifWriter(setup)
    writer.push(solid(8, 6, [1, 2, 3]), 65_535)
    writer.extend(100)
    const info = inspectGif(await bytesOf(writer.finish()))
    expect(info.delaysCs).toEqual([65_535, 100])
  })

  it('plays once (no loop block) or n times as asked', async () => {
    const make = async (loops: number): Promise<number | null> => {
      const writer = createGifWriter({ ...setup, loops })
      writer.push(solid(8, 6, [1, 2, 3]), 10)
      writer.push(solid(8, 6, [3, 2, 1]), 10)
      return inspectGif(await bytesOf(writer.finish())).loop
    }
    expect(await make(0)).toBe(0)
    expect(await make(1)).toBeNull()
    expect(await make(3)).toBe(2)
  })

  it('gives each frame the colours it needs, flat artwork exactly', async () => {
    const writer = createGifWriter({ ...setup, dither: true })
    writer.push(solid(8, 6, [225, 29, 72]), 10)
    writer.push(solid(8, 6, [28, 21, 23]), 10)
    const info = inspectGif(await bytesOf(writer.finish()))
    expect(info.frames).toBe(2)
    expect(info.localPalettes).toBe(1)
  })

  it('refuses to grow past the limit it was given', () => {
    const writer = createGifWriter({ ...setup, maxBytes: 10 })
    writer.push(solid(8, 6, [255, 0, 0]), 10)
    expect(() => writer.push(solid(8, 6, [0, 255, 0]), 10)).toThrow(GifTooLargeError)
  })

  it('reports the bytes written so far', () => {
    const writer = createGifWriter(setup)
    writer.push(solid(8, 6, [255, 0, 0]), 10)
    writer.push(solid(8, 6, [0, 255, 0]), 10)
    expect(writer.bytes).toBeGreaterThan(30)
  })
})
