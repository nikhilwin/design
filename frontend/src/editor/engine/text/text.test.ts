import { applyCase, toSentenceCase, toTitleCase, toggleCase } from './case'
import { CURVE_MAX, clampCurve, curveGeometry } from './curve'
import { fontStack, isGenericFamily, primaryFamily } from './fontStack'
import { applyListStyle, continueList, detectListStyle, renumber, stripListMarkers } from './lists'

describe('curve geometry', () => {
  it('returns a straight path for zero', () => {
    const g = curveGeometry(200, 0)
    expect(g.path).toBe('M 0,0 L 200,0')
    expect(g.sagitta).toBe(0)
  })

  it('makes arc length equal the text width (times the safety margin)', () => {
    for (const amount of [-400, -200, -60, 60, 200, 400]) {
      const g = curveGeometry(300, amount)
      expect(g.radius * g.theta).toBeCloseTo(300 * 1.03, 3)
    }
  })

  it('negative bends up (sweep 1), positive bends down (sweep 0)', () => {
    expect(curveGeometry(200, -100).path).toMatch(/0 0,1 /)
    expect(curveGeometry(200, 100).path).toMatch(/0 0,0 /)
  })

  it('caps the bend at a half circle', () => {
    expect(curveGeometry(100, CURVE_MAX).theta).toBeCloseTo(Math.PI)
    expect(curveGeometry(100, CURVE_MAX * 5).theta).toBeCloseTo(Math.PI)
    expect(clampCurve(1e6)).toBe(CURVE_MAX)
  })

  it('a stronger bend has a larger sagitta and smaller chord', () => {
    const a = curveGeometry(300, 100)
    const b = curveGeometry(300, 300)
    expect(b.sagitta).toBeGreaterThan(a.sagitta)
    expect(b.chord).toBeLessThan(a.chord)
  })

  it('survives tiny and non-positive widths', () => {
    expect(Number.isFinite(curveGeometry(0, 120).radius)).toBe(true)
  })
})

describe('text case', () => {
  it('upper, lower and title', () => {
    expect(applyCase('Hello World', 'upper')).toBe('HELLO WORLD')
    expect(applyCase('Hello World', 'lower')).toBe('hello world')
    expect(toTitleCase('the quick brown fox of the north')).toBe('The Quick Brown Fox Of The North')
  })

  it('title case capitalises every word', () => {
    expect(toTitleCase('save the date for a tale of two cities')).toBe('Save The Date For A Tale Of Two Cities')
  })

  it('sentence case capitalises the first letter of every sentence', () => {
    expect(toSentenceCase('HELLO THERE. HOW ARE YOU? FINE! thanks')).toBe('Hello there. How are you? Fine! Thanks')
    expect(applyCase('JOIN US', 'sentence')).toBe('Join us')
  })

  it('handles apostrophes and hyphens', () => {
    expect(toTitleCase("rock-and-roll isn't dead")).toBe("Rock-And-Roll Isn't Dead")
  })

  it('toggle applies, and toggling the active case restores the original', () => {
    const on = toggleCase({ text: 'Some Text', textCase: 'none' }, 'upper')
    expect(on).toEqual({ text: 'SOME TEXT', textCase: 'upper', caseSource: 'Some Text' })
    const off = toggleCase({ text: on.text, textCase: on.textCase, caseSource: on.caseSource }, 'upper')
    expect(off.text).toBe('Some Text')
    expect(off.textCase).toBe('none')
  })

  it('switching case works from the original source', () => {
    const upper = toggleCase({ text: 'Mixed Case', textCase: 'none' }, 'upper')
    const lower = toggleCase({ text: upper.text, textCase: 'upper', caseSource: upper.caseSource }, 'lower')
    expect(lower.text).toBe('mixed case')
    expect(lower.caseSource).toBe('Mixed Case')
  })

  it('does not restore a stale source when the text was edited', () => {
    const r = toggleCase({ text: 'EDITED', textCase: 'upper', caseSource: 'something else' }, 'lower')
    expect(r.text).toBe('edited')
  })
})

describe('lists', () => {
  it('detects styles', () => {
    expect(detectListStyle('• a\n• b')).toBe('bullet')
    expect(detectListStyle('1. a\n2. b')).toBe('number')
    expect(detectListStyle('a\nb')).toBe('none')
    expect(detectListStyle('')).toBe('none')
  })

  it('applies bullets and numbers, skipping blank lines', () => {
    expect(applyListStyle('one\ntwo', 'bullet')).toBe('• one\n• two')
    expect(applyListStyle('one\n\ntwo', 'number')).toBe('1. one\n\n2. two')
  })

  it('toggling the active style removes it', () => {
    expect(applyListStyle('• one\n• two', 'bullet')).toBe('one\ntwo')
  })

  it('switches between bullet and number', () => {
    expect(applyListStyle('• one\n• two', 'number')).toBe('1. one\n2. two')
  })

  it('strips markers and renumbers', () => {
    expect(stripListMarkers('1. a\n• b\nc')).toBe('a\nb\nc')
    expect(renumber('1. a\n5. b\nplain\n9. c')).toBe('1. a\n2. b\nplain\n3. c')
  })

  it('continues a bullet list after Enter', () => {
    const r = continueList('• one\n', 6)
    expect(r).toEqual({ text: '• one\n• ', caret: 8 })
  })

  it('continues a numbered list after Enter', () => {
    const r = continueList('1. one\n', 7)
    expect(r).toEqual({ text: '1. one\n2. ', caret: 10 })
  })

  it('an empty item followed by Enter ends the list', () => {
    const r = continueList('• one\n• \n', 9)
    expect(r?.text).toBe('• one\n')
  })

  it('ignores Enter outside lists', () => {
    expect(continueList('plain\n', 6)).toBeNull()
  })
})

describe('font stacks', () => {
  it('splits and quotes families', () => {
    expect(primaryFamily('"Playfair Display", serif')).toBe('Playfair Display')
    expect(primaryFamily("'Inter', sans-serif")).toBe('Inter')
    expect(primaryFamily('Arial')).toBe('Arial')
  })

  it('builds stacks with a category-based generic family', () => {
    expect(fontStack('Lora', 'serif')).toBe('"Lora", serif')
    expect(fontStack('Pacifico', 'handwriting')).toBe('"Pacifico", cursive')
    expect(fontStack('Mono', 'monospace')).toBe('"Mono", monospace')
    expect(fontStack('Inter', undefined)).toBe('"Inter", sans-serif')
  })

  it('does not double quote and strips quotes inside names', () => {
    expect(fontStack('"Inter", sans-serif', 'sans-serif')).toBe('"Inter", sans-serif')
    expect(fontStack('Bad"Name', 'serif')).toBe('"BadName", serif')
  })

  it('recognises generic families', () => {
    expect(isGenericFamily('Serif')).toBe(true)
    expect(isGenericFamily('Inter')).toBe(false)
  })
})
