import { describe, expect, it } from 'vitest'
import { fitContain, frameGeometry, MAX_FRAME_PIXELS, MAX_FRAME_SIDE } from './fit'

describe('fitContain', () => {
  it('pillarboxes a page that is narrower than the screen', () => {
    const r = fitContain({ width: 1920, height: 1080 }, { width: 1000, height: 1000 })
    expect(r).toEqual({ x: 420, y: 0, width: 1080, height: 1080 })
  })

  it('letterboxes a page that is wider than the screen', () => {
    const r = fitContain({ width: 1000, height: 1000 }, { width: 1920, height: 1080 })
    expect(r.width).toBe(1000)
    expect(r.height).toBeCloseTo(562.5)
    expect(r.x).toBe(0)
    expect(r.y).toBeCloseTo(218.75)
  })

  it('fills the screen when the shapes match and scales small pages up', () => {
    expect(fitContain({ width: 1600, height: 900 }, { width: 800, height: 450 })).toEqual({ x: 0, y: 0, width: 1600, height: 900 })
  })

  it('keeps the aspect ratio of tall and extreme pages', () => {
    const tall = fitContain({ width: 1920, height: 1080 }, { width: 600, height: 3000 })
    expect(tall.width / tall.height).toBeCloseTo(0.2)
    expect(tall.height).toBe(1080)
    const banner = fitContain({ width: 1920, height: 1080 }, { width: 728, height: 90 })
    expect(banner.width).toBe(1920)
    expect(banner.width / banner.height).toBeCloseTo(728 / 90)
  })

  it('returns an empty rectangle for degenerate sizes', () => {
    const empty = { x: 0, y: 0, width: 0, height: 0 }
    expect(fitContain({ width: 0, height: 100 }, { width: 10, height: 10 })).toEqual(empty)
    expect(fitContain({ width: 100, height: 100 }, { width: 0, height: 10 })).toEqual(empty)
    expect(fitContain({ width: Number.NaN, height: 100 }, { width: 10, height: 10 })).toEqual(empty)
  })
})

describe('frameGeometry', () => {
  it('sizes the bitmap by the device pixel ratio', () => {
    const g = frameGeometry({ width: 1280, height: 720 }, { width: 1920, height: 1080 }, 2)
    expect(g.css).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(g.pixels).toEqual({ width: 2560, height: 1440 })
  })

  it('centres a differently shaped page with whole-pixel edges', () => {
    const g = frameGeometry({ width: 1280, height: 720 }, { width: 800, height: 800 }, 1)
    expect(g.css).toEqual({ x: 280, y: 0, width: 720, height: 720 })
    expect(g.pixels).toEqual({ width: 720, height: 720 })
  })

  it('never exceeds the side and area limits', () => {
    const g = frameGeometry({ width: 7680, height: 4320 }, { width: 1920, height: 1080 }, 2)
    expect(Math.max(g.pixels.width, g.pixels.height)).toBeLessThanOrEqual(MAX_FRAME_SIDE)
    expect(g.pixels.width * g.pixels.height).toBeLessThanOrEqual(MAX_FRAME_PIXELS)
    expect(g.pixels.width / g.pixels.height).toBeCloseTo(16 / 9, 2)
  })

  it('survives a bad pixel ratio and an empty stage', () => {
    expect(frameGeometry({ width: 100, height: 100 }, { width: 10, height: 10 }, Number.NaN).pixels).toEqual({ width: 100, height: 100 })
    expect(frameGeometry({ width: 0, height: 0 }, { width: 10, height: 10 }, 1).pixels).toEqual({ width: 0, height: 0 })
  })
})
