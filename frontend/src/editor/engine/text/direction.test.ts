import { alignmentForDirection, detectDirection, hasComplexScript } from './direction'
import { scriptOf } from './scripts'

describe('text direction', () => {
  it('follows the first letter, like dir="auto"', () => {
    expect(detectDirection('مرحبا Doory')).toBe('rtl')
    expect(detectDirection('Doory مرحبا')).toBe('ltr')
    expect(detectDirection('שלום')).toBe('rtl')
    expect(detectDirection('2027 — مرحبا')).toBe('rtl')
    expect(detectDirection('বাংলা')).toBe('ltr')
    expect(detectDirection('2027 !')).toBeNull()
    expect(detectDirection('')).toBeNull()
  })

  it('keeps a text flush with the start of its lines when the direction flips', () => {
    expect(alignmentForDirection('left', 'ltr', 'rtl')).toBe('right')
    expect(alignmentForDirection('right', 'rtl', 'ltr')).toBe('left')
    expect(alignmentForDirection('center', 'ltr', 'rtl')).toBe('center')
    expect(alignmentForDirection('justify', 'ltr', 'rtl')).toBe('justify')
    expect(alignmentForDirection('right', 'ltr', 'ltr')).toBe('right')
  })

  it('knows the scripts whose letters join or reorder', () => {
    for (const text of ['مرحبا', 'שלום', 'বাংলা', 'हिन्दी', 'ภาษาไทย']) expect(hasComplexScript(text)).toBe(true)
    for (const text of ['Hello', 'Привет', 'Ελληνικά', '中文', '']) expect(hasComplexScript(text)).toBe(false)
  })

  it('finds the first non-Latin script, for the font picker', () => {
    expect(scriptOf('Sale مرحبا')?.id).toBe('arabic')
    expect(scriptOf('আমার সোনার বাংলা')?.id).toBe('bengali')
    expect(scriptOf('नमस्ते')?.id).toBe('devanagari')
    expect(scriptOf('Привет')?.id).toBe('cyrillic')
    expect(scriptOf('Hello, world')).toBeNull()
  })
})
