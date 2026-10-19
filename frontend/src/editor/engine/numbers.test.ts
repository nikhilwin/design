import { clampOrUndefined, isFiniteNumber } from './numbers'
import { sanitizeTextPatch } from './objects/textStyle'

describe('numeric guards', () => {
  it('recognises finite numbers only', () => {
    expect(isFiniteNumber(0)).toBe(true)
    expect(isFiniteNumber(-3.5)).toBe(true)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined, {}]) expect(isFiniteNumber(bad)).toBe(false)
  })

  it('clamps numbers and drops everything else', () => {
    expect(clampOrUndefined(5, 0, 1)).toBe(1)
    expect(clampOrUndefined(-5, 0, 1)).toBe(0)
    expect(clampOrUndefined(0.4, 0, 1)).toBe(0.4)
    expect(clampOrUndefined(Number.NaN, 0, 1)).toBeUndefined()
    expect(clampOrUndefined('2', 0, 10)).toBeUndefined()
  })

  it('cleans a text patch: invalid numbers are dropped, valid ones limited, weights snapped', () => {
    expect(sanitizeTextPatch({ fontSize: Number.NaN, lineHeight: 0, charSpacing: 5000, fontWeight: 650 })).toEqual({ lineHeight: 0.1, charSpacing: 800, fontWeight: 700 })
    expect(sanitizeTextPatch({ fontSize: 12.5, fontWeight: 'bold', fontFamily: '  ' })).toEqual({ fontSize: 12.5, fontWeight: 'bold' })
    expect(sanitizeTextPatch({ fontWeight: 'heavy' as never, curveAmount: Number.POSITIVE_INFINITY })).toEqual({})
    expect(sanitizeTextPatch({ textAlign: 'right', fontStyle: 'italic', underline: true })).toEqual({ textAlign: 'right', fontStyle: 'italic', underline: true })
  })
})
