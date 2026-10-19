import { describe, expect, it } from 'vitest'
import { EASINGS, MONOTONE_EASINGS, clamp01, ease, isEasing, mix } from './easing'

describe('easing', () => {
  it.each(EASINGS)('%s starts at 0 and ends at exactly 1', (easing) => {
    expect(ease(easing, 0)).toBe(0)
    expect(ease(easing, 1)).toBe(1)
  })

  it.each(EASINGS)('%s limits progress outside 0..1 and reads a bad number as the start', (easing) => {
    expect(ease(easing, -3)).toBe(0)
    expect(ease(easing, 7)).toBe(1)
    expect(ease(easing, Number.NaN)).toBe(0)
  })

  it.each(MONOTONE_EASINGS)('%s never goes backwards and stays inside 0..1', (easing) => {
    let last = 0
    for (let i = 0; i <= 1000; i++) {
      const v = ease(easing, i / 1000)
      expect(v).toBeGreaterThanOrEqual(last - 1e-12)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      last = v
    }
  })

  it('ease-in starts slowly and ease-out ends slowly', () => {
    expect(ease('ease-in', 0.5)).toBeLessThan(0.5)
    expect(ease('ease-out', 0.5)).toBeGreaterThan(0.5)
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5, 10)
  })

  it('spring overshoots the end by about a tenth and settles on it', () => {
    let peak = 0
    for (let i = 0; i <= 1000; i++) peak = Math.max(peak, ease('spring', i / 1000))
    expect(peak).toBeGreaterThan(1.05)
    expect(peak).toBeLessThan(1.15)
    for (let i = 800; i <= 1000; i++) expect(Math.abs(ease('spring', i / 1000) - 1)).toBeLessThan(0.02)
    for (let i = 0; i <= 1000; i++) expect(ease('spring', i / 1000)).toBeGreaterThanOrEqual(0)
  })

  it('bounce stays inside 0..1 and rebounds off the end', () => {
    let rebounds = 0
    let last = 0
    for (let i = 0; i <= 1000; i++) {
      const v = ease('bounce', i / 1000)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      if (v < last - 1e-9) rebounds++
      last = v
    }
    expect(rebounds).toBeGreaterThan(0)
  })

  it('recognises its names', () => {
    expect(isEasing('spring')).toBe(true)
    expect(isEasing('wobble')).toBe(false)
    expect(isEasing(3)).toBe(false)
  })

  it('mix hits both end points exactly', () => {
    expect(mix(0.3, 1, 1)).toBe(1)
    expect(mix(0.3, 1, 0)).toBe(0.3)
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(2)).toBe(1)
  })
})
