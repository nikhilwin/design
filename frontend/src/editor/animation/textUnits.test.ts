import { Textbox } from 'fabric'
import { describe, expect, it } from 'vitest'
import { canSplit, textUnitBoxes } from './textUnits'

function text(content: string, width = 300): Textbox {
  return new Textbox(content, { left: 0, top: 0, width, fontSize: 30, fontFamily: 'sans-serif', textAlign: 'left' })
}

describe('textUnitBoxes', () => {
  it('splits a laid-out text into lines, words and letters that tile its box', () => {
    const t = text('Hello Doory', 120)
    expect(canSplit(t)).toBe(true)
    const lines = textUnitBoxes(t, 'line', 0)!
    const words = textUnitBoxes(t, 'word', 0)!
    const letters = textUnitBoxes(t, 'letter', 0)!
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(words.length).toBe(2)
    expect(letters.length).toBe('HelloDoory'.length)
    for (const list of [lines, words, letters]) {
      const x0 = Math.min(...list.map((b) => b.x0))
      const x1 = Math.max(...list.map((b) => b.x1))
      expect(x0).toBeCloseTo(-t.width / 2, 3)
      expect(x1).toBeCloseTo(t.width / 2, 3)
    }
  })

  it('measures the glyphs itself when the object was laid out without measuring them', () => {
    const t = text('Hello Doory', 400)
    // A size recalculated by hand (what loading a font, or setting a property, does) leaves the glyph measurements to later.
    t.initDimensions()
    expect((t as unknown as { __charBounds: unknown[] }).__charBounds.length).toBe(0)
    const words = textUnitBoxes(t, 'word', 0)
    expect(words).not.toBeNull()
    expect(words!.length).toBe(2)
    expect(words![1].x0).toBeGreaterThan(words![0].x0)
  })

  it('does not split text on a path or right to left', () => {
    const t = text('Hello')
    ;(t as unknown as { direction: string }).direction = 'rtl'
    expect(textUnitBoxes(t, 'word', 0)).toBeNull()
  })
})
