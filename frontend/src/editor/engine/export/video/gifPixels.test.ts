import { describe, expect, it } from 'vitest'
import { ditherToPalette, framesEqual } from './gifPixels'

const rgba = (pixels: number[][]): Uint8ClampedArray => new Uint8ClampedArray(pixels.flatMap(([r, g, b]) => [r, g, b, 255]))

describe('framesEqual', () => {
  it('tells identical frames from frames that differ in one pixel, and frames of other sizes', () => {
    const a = rgba([[1, 2, 3], [4, 5, 6]])
    expect(framesEqual(a, new Uint8ClampedArray(a))).toBe(true)
    const b = new Uint8ClampedArray(a)
    b[6] = 7
    expect(framesEqual(a, b)).toBe(false)
    expect(framesEqual(a, rgba([[1, 2, 3]]))).toBe(false)
  })

  it('reads a frame that is a view into a larger buffer', () => {
    const big = new Uint8ClampedArray(32)
    big.set([9, 8, 7, 255], 8)
    const view = new Uint8ClampedArray(big.buffer, 8, 4)
    expect(framesEqual(view, new Uint8ClampedArray([9, 8, 7, 255]))).toBe(true)
  })
})

describe('ditherToPalette', () => {
  const blackWhite = [[0, 0, 0], [255, 255, 255]]

  it('maps a colour the palette holds to itself, with no noise in flat areas', () => {
    const flat = rgba(Array.from({ length: 64 }, () => [255, 255, 255]))
    expect([...ditherToPalette(flat, 8, 8, blackWhite)]).toEqual(new Array(64).fill(1))
    const exact = [[225, 29, 72], [28, 21, 23], [255, 225, 230]]
    const art = rgba(Array.from({ length: 100 }, (_, i) => exact[i % 3]))
    const out = ditherToPalette(art, 10, 10, exact)
    expect([...out]).toEqual(Array.from({ length: 100 }, (_, i) => i % 3))
  })

  it('turns a mid grey into a fine mix of black and white that averages to grey', () => {
    const grey = rgba(Array.from({ length: 32 * 32 }, () => [128, 128, 128]))
    const out = ditherToPalette(grey, 32, 32, blackWhite)
    const whites = out.reduce((n, v) => n + v, 0)
    expect(whites / out.length).toBeGreaterThan(0.45)
    expect(whites / out.length).toBeLessThan(0.55)
    // Without error diffusion every pixel would have been the same; with it both colours are everywhere.
    for (let y = 0; y < 32; y += 8) {
      const row = out.subarray(y * 32, y * 32 + 32)
      expect(row.some((v) => v === 0) && row.some((v) => v === 1)).toBe(true)
    }
  })

  it('follows a gradient: darker on one side, lighter on the other', () => {
    const width = 64
    const ramp = rgba(Array.from({ length: width * 8 }, (_, i) => [Math.round(((i % width) / (width - 1)) * 255), Math.round(((i % width) / (width - 1)) * 255), Math.round(((i % width) / (width - 1)) * 255)]))
    const out = ditherToPalette(ramp, width, 8, blackWhite)
    const share = (from: number, to: number): number => {
      let sum = 0
      for (let y = 0; y < 8; y++) for (let x = from; x < to; x++) sum += out[y * width + x]
      return sum / (8 * (to - from))
    }
    expect(share(0, 16)).toBeLessThan(0.2)
    expect(share(48, 64)).toBeGreaterThan(0.8)
  })

  it('only ever picks indices of the palette, and survives an empty frame or palette', () => {
    const noise = rgba(Array.from({ length: 100 }, (_, i) => [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256]))
    const palette = [[10, 10, 10], [200, 50, 50], [30, 200, 90], [240, 240, 20]]
    for (const v of ditherToPalette(noise, 10, 10, palette)) expect(v).toBeLessThan(palette.length)
    expect(ditherToPalette(new Uint8ClampedArray(0), 0, 0, palette)).toHaveLength(0)
    expect(ditherToPalette(noise, 10, 10, [])).toHaveLength(100)
  })
})
