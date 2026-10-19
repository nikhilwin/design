import {
  contrastRatio,
  hsvToRgb,
  isHexColor,
  normalizeColor,
  parseColor,
  readableOn,
  rgbToHsv,
  rgbaToCss,
  rgbaToHex,
  withAlpha,
} from './colors'

describe('colors', () => {
  it('parses 3, 4, 6 and 8 digit hex', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('#f008')).toEqual({ r: 255, g: 0, b: 0, a: 0x88 / 255 })
    expect(parseColor('#112233')).toEqual({ r: 17, g: 34, b: 51, a: 1 })
    expect(parseColor('#11223380')?.a).toBeCloseTo(0.502, 2)
  })

  it('parses rgb() and rgba() in comma and percent forms', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseColor('rgba(10,20,30,0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseColor('rgb(10 20 30 / 50%)')?.a).toBe(0.5)
  })

  it('rejects garbage and handles transparent', () => {
    expect(parseColor('not-a-colour')).toBeNull()
    expect(parseColor('#12')).toBeNull()
    expect(parseColor('transparent')?.a).toBe(0)
  })

  it('formats hex with alpha only when not opaque', () => {
    expect(rgbaToHex({ r: 255, g: 0, b: 128, a: 1 })).toBe('#ff0080')
    expect(rgbaToHex({ r: 255, g: 0, b: 128, a: 0.5 })).toBe('#ff008080')
  })

  it('normalises colours and leaves unknown input alone', () => {
    expect(normalizeColor('rgb(255, 0, 0)')).toBe('#ff0000')
    expect(normalizeColor('#ABC')).toBe('#aabbcc')
    expect(normalizeColor('url(#grad)')).toBe('url(#grad)')
  })

  it('round-trips rgb through hsv', () => {
    for (const c of [
      { r: 225, g: 29, b: 72, a: 1 },
      { r: 0, g: 0, b: 0, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
      { r: 12, g: 200, b: 90, a: 1 },
    ]) {
      const back = hsvToRgb(rgbToHsv(c))
      expect(Math.abs(back.r - c.r)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.g - c.g)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.b - c.b)).toBeLessThanOrEqual(1)
    }
  })

  it('computes known hues', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0, a: 1 }).h).toBe(0)
    expect(rgbToHsv({ r: 0, g: 255, b: 0, a: 1 }).h).toBe(120)
    expect(rgbToHsv({ r: 0, g: 0, b: 255, a: 1 }).h).toBe(240)
  })

  it('contrast ratio matches WCAG black/white', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 0)
  })

  it('picks a readable text colour', () => {
    expect(readableOn('#ffffff')).toBe('#000000')
    expect(readableOn('#111111')).toBe('#ffffff')
  })

  it('withAlpha and rgbaToCss', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('#ff000080')
    expect(rgbaToCss({ r: 1, g: 2, b: 3, a: 0.25 })).toBe('rgba(1, 2, 3, 0.25)')
    expect(isHexColor('#fff')).toBe(true)
    expect(isHexColor('fff')).toBe(false)
  })
})
