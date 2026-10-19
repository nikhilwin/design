import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PRINT_SETTINGS,
  PRINT_PRESETS,
  applyPreset,
  bleedInUnit,
  clampBleedMm,
  customize,
  describeSizes,
  loadPrintSettings,
  sanitizeSettings,
  savePrintSettings,
  sizeLabel,
  summarizeSizes,
} from './printOptions'

describe('print presets', () => {
  it('Screen is no bleed and no marks, Standard print is 3 mm and marks', () => {
    expect(PRINT_PRESETS.screen).toEqual({ bleedMm: 0, cropMarks: false })
    expect(PRINT_PRESETS.standard).toEqual({ bleedMm: 3, cropMarks: true })
    expect(DEFAULT_PRINT_SETTINGS).toEqual({ preset: 'screen', bleedMm: 0, cropMarks: false })
  })

  it('choosing a preset sets its numbers; Custom keeps the current ones', () => {
    const custom = { preset: 'custom' as const, bleedMm: 4.5, cropMarks: true }
    expect(applyPreset('standard', custom)).toEqual({ preset: 'standard', bleedMm: 3, cropMarks: true })
    expect(applyPreset('screen', custom)).toEqual({ preset: 'screen', bleedMm: 0, cropMarks: false })
    expect(applyPreset('custom', { preset: 'standard', ...PRINT_PRESETS.standard })).toEqual({ preset: 'custom', bleedMm: 3, cropMarks: true })
  })

  it('changing a number makes the setup custom', () => {
    const standard = applyPreset('standard', DEFAULT_PRINT_SETTINGS)
    expect(customize(standard, { bleedMm: 5 })).toEqual({ preset: 'custom', bleedMm: 5, cropMarks: true })
    expect(customize(standard, { cropMarks: false })).toEqual({ preset: 'custom', bleedMm: 3, cropMarks: false })
  })
})

describe('bleed values', () => {
  it('stays within what the server accepts', () => {
    expect(clampBleedMm(-2)).toBe(0)
    expect(clampBleedMm(10.01)).toBe(10)
    expect(clampBleedMm(99)).toBe(10)
    expect(clampBleedMm(2.46)).toBe(2.5)
    expect(clampBleedMm(Number.NaN)).toBe(0)
    expect(clampBleedMm(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('is told in the unit of the design', () => {
    expect(bleedInUnit(3, 'px')).toEqual({ value: '11', unit: 'px' })
    expect(bleedInUnit(3, 'in')).toEqual({ value: '0.12', unit: 'in' })
    expect(bleedInUnit(3, 'mm')).toBeNull()
  })
})

describe('what is remembered per design', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('round-trips and keeps designs apart', () => {
    savePrintSettings('a', { preset: 'standard', bleedMm: 3, cropMarks: true })
    savePrintSettings('b', { preset: 'custom', bleedMm: 1.5, cropMarks: false })
    expect(loadPrintSettings('a')).toEqual({ preset: 'standard', bleedMm: 3, cropMarks: true })
    expect(loadPrintSettings('b')).toEqual({ preset: 'custom', bleedMm: 1.5, cropMarks: false })
    expect(loadPrintSettings('c')).toEqual(DEFAULT_PRINT_SETTINGS)
  })

  it('starts from the defaults when storage is empty, broken or blocked', () => {
    localStorage.setItem('doory.editor.print.v1.x', '{not json')
    expect(loadPrintSettings('x')).toEqual(DEFAULT_PRINT_SETTINGS)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(loadPrintSettings('x')).toEqual(DEFAULT_PRINT_SETTINGS)
  })

  it('does not fail when it cannot write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => savePrintSettings('x', DEFAULT_PRINT_SETTINGS)).not.toThrow()
  })

  it('does not trust what it reads', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS)
    expect(sanitizeSettings('x')).toEqual(DEFAULT_PRINT_SETTINGS)
    expect(sanitizeSettings({ preset: 'custom', bleedMm: 999, cropMarks: 'yes' })).toEqual({ preset: 'custom', bleedMm: 10, cropMarks: false })
    expect(sanitizeSettings({ preset: 'custom', bleedMm: -3, cropMarks: true })).toEqual({ preset: 'custom', bleedMm: 0, cropMarks: true })
    expect(sanitizeSettings({ preset: 'bogus', bleedMm: 2, cropMarks: true })).toEqual({ preset: 'custom', bleedMm: 2, cropMarks: true })
    expect(sanitizeSettings({ preset: 'custom', bleedMm: '5' })).toEqual({ preset: 'custom', bleedMm: 0, cropMarks: false })
  })

  it('a preset whose numbers were changed on disk is a custom setup', () => {
    expect(sanitizeSettings({ preset: 'standard', bleedMm: 3, cropMarks: true })).toEqual({ preset: 'standard', bleedMm: 3, cropMarks: true })
    expect(sanitizeSettings({ preset: 'standard', bleedMm: 8, cropMarks: true })).toEqual({ preset: 'custom', bleedMm: 8, cropMarks: true })
    expect(sanitizeSettings({ preset: 'screen', bleedMm: 0, cropMarks: true })).toEqual({ preset: 'custom', bleedMm: 0, cropMarks: true })
  })
})

describe('the sizes of the chosen pages', () => {
  it('names paper sizes whatever their orientation and writes other sizes as numbers', () => {
    expect(sizeLabel({ width: 794, height: 1123 }, 'px')).toBe('A4')
    expect(sizeLabel({ width: 1123, height: 794 }, 'px')).toBe('A4')
    expect(sizeLabel({ width: 816, height: 1056 }, 'px')).toBe('US Letter')
    expect(sizeLabel({ width: 336, height: 192 }, 'px')).toBe('Business Card')
    expect(sizeLabel({ width: 1080, height: 1080 }, 'px')).toBe('1080×1080')
    expect(sizeLabel({ width: 1080, height: 1080 }, 'mm')).toBe('285.8×285.8 mm')
    expect(sizeLabel({ width: 1000, height: 500 }, 'in')).toBe('10.42×5.21 in')
  })

  it('sums them up: pages, distinct sizes in order of appearance', () => {
    const sizes = [
      { width: 1080, height: 1080 },
      { width: 794, height: 1123 },
      { width: 1080, height: 1080 },
    ]
    expect(summarizeSizes(sizes, 'px')).toEqual({ pages: 3, sizes: ['1080×1080', 'A4'], more: 0 })
    expect(describeSizes(sizes, 'px')).toBe('3 pages · 2 sizes: 1080×1080, A4')
  })

  it('uses the singular', () => {
    expect(describeSizes([{ width: 1080, height: 1080 }], 'px')).toBe('1 page · 1 size: 1080×1080')
  })

  it('does not list more than four sizes', () => {
    const sizes = [100, 200, 300, 400, 500, 600].map((width) => ({ width, height: 100 }))
    expect(summarizeSizes(sizes, 'px')).toMatchObject({ pages: 6, more: 2 })
    expect(describeSizes(sizes, 'px')).toBe('6 pages · 6 sizes: 100×100, 200×100, 300×100, 400×100 and 2 more')
  })

  it('says so when no page is chosen', () => {
    expect(describeSizes([], 'px')).toBe('No pages selected')
  })
})
