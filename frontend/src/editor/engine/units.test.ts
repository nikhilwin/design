import { formatUnit, mmToPx, parseUnit, pxToMm, pxToUnit, unitToPx } from './units'

describe('units', () => {
  it('converts px <-> in at 96dpi', () => {
    expect(pxToUnit(96, 'in')).toBe(1)
    expect(unitToPx(2, 'in')).toBe(192)
  })

  it('converts px <-> mm', () => {
    expect(pxToUnit(96, 'mm')).toBeCloseTo(25.4)
    expect(unitToPx(25.4, 'mm')).toBeCloseTo(96)
    expect(mmToPx(pxToMm(300))).toBeCloseTo(300)
  })

  it('formats with unit-appropriate precision', () => {
    expect(formatUnit(100.4, 'px')).toBe('100')
    expect(formatUnit(96, 'in')).toBe('1')
    expect(formatUnit(100, 'mm')).toBe('26.5')
  })

  it('parses user input, accepting decimal commas', () => {
    expect(parseUnit('1,5', 'in')).toBe(144)
    expect(parseUnit('abc', 'px')).toBeNull()
  })
})
