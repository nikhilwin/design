import { computeStack, slotLeft } from './layout'
import { fitZoom, fitZoomForPages } from './zoom'

const pages = [
  { id: 'poster', width: 1080, height: 1920 },
  { id: 'flyer', width: 794, height: 1123 },
  { id: 'card', width: 336, height: 192 },
]

describe('stack layout of pages of different sizes', () => {
  it('stacks each page at its own height with the same gap', () => {
    const layout = computeStack(pages, 0.5)
    const [a, b, c] = layout.slots
    expect([a.width, a.height]).toEqual([540, 960])
    expect([b.width, b.height]).toEqual([397, 561.5])
    expect([c.width, c.height]).toEqual([168, 96])
    expect(b.top - a.bottom).toBe(28)
    expect(c.top - b.bottom).toBe(28)
  })

  it('is as wide as the widest page plus padding', () => {
    expect(computeStack(pages, 1).contentWidth).toBe(1080 + 128)
    expect(computeStack(pages.slice(1), 1).contentWidth).toBe(794 + 128)
  })

  it('centres every artboard on one line, in a narrow and in a wide viewport', () => {
    const layout = computeStack(pages, 1)
    for (const viewport of [600, 1208, 1800]) {
      const centres = layout.slots.map((s) => slotLeft(layout, s, viewport) + s.width / 2)
      expect(new Set(centres).size).toBe(1)
      expect(centres[0]).toBe(Math.max(layout.contentWidth, viewport) / 2)
    }
  })

  it('the widest page sits at the padding when the viewport is narrow', () => {
    const layout = computeStack(pages, 1)
    expect(slotLeft(layout, layout.slots[0], 400)).toBe(64)
  })
})

describe('fitZoomForPages', () => {
  const viewport = { width: 1048, height: 848 }

  it('fit-page fits the given page', () => {
    expect(fitZoomForPages(viewport, { width: 336, height: 192 }, 1080, 'fit-page')).toBe(1)
    expect(fitZoomForPages(viewport, { width: 1080, height: 1920 }, 1080, 'fit-page')).toBe(fitZoom(viewport, { width: 1080, height: 1920 }, 'fit-page'))
  })

  it('fit-width fits the widest page whatever the given page is', () => {
    const z = fitZoomForPages(viewport, { width: 336, height: 192 }, 1080, 'fit-width')
    expect(z).toBeCloseTo(952 / 1080, 2)
    expect(fitZoomForPages(viewport, { width: 1080, height: 1920 }, 1080, 'fit-width')).toBe(z)
  })
})
