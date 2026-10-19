import { describe, expect, it } from 'vitest'
import { PAIRINGS, faceOptions } from './pairings'

describe('font pairings', () => {
  it('has unique ids and a heading and body face each', () => {
    expect(new Set(PAIRINGS.map((p) => p.id)).size).toBe(PAIRINGS.length)
    for (const p of PAIRINGS) {
      expect(p.heading.family).not.toBe('')
      expect(p.body.family).not.toBe('')
    }
  })

  it('keeps every colour a plain hex value (tokens do not apply inside the design)', () => {
    for (const p of PAIRINGS) for (const face of [p.heading, p.body]) expect(face.color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('builds text options with a CSS stack that falls back to the generic family', () => {
    const classic = PAIRINGS.find((p) => p.id === 'classic')!
    expect(faceOptions(classic.heading, 'heading', 'Hi')).toMatchObject({ text: 'Hi', preset: 'heading', fontFamily: '"Playfair Display", serif', fontWeight: 700 })
    expect(faceOptions(classic.body, 'body', 'Body')).toMatchObject({ preset: 'body', fontFamily: '"DM Sans", sans-serif' })
    const playful = PAIRINGS.find((p) => p.id === 'playful')!
    expect(faceOptions(playful.heading, 'heading', 'x').fontFamily).toBe('"Pacifico", cursive')
  })
})
