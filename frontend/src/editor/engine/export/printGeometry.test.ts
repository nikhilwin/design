import { MARK_GAP_MM, MARK_LENGTH_MM, MAX_BLEED_MM, cropMarkSegments, printGeometry } from './printGeometry'
import { mmToPx } from '../units'

describe('print geometry', () => {
  it('is the trim size when there is no bleed and no marks', () => {
    const g = printGeometry({ width: 800, height: 600 }, 0, false)
    expect(g).toMatchObject({ width: 800, height: 600, bleed: 0, slug: 0, sheetWidth: 800, sheetHeight: 600, artWidth: 800, artHeight: 600 })
    expect(cropMarkSegments(g)).toEqual([])
  })

  it('grows by the bleed on every side', () => {
    const g = printGeometry({ width: 800, height: 600 }, 3, false)
    expect(g.bleed).toBeCloseTo(mmToPx(3), 9)
    expect(g.sheetWidth).toBeCloseTo(800 + 2 * mmToPx(3), 9)
    expect(g.artHeight).toBeCloseTo(600 + 2 * mmToPx(3), 9)
    expect(g.slug).toBe(0)
  })

  it('adds a 6 mm slug for the marks, outside the bleed', () => {
    const g = printGeometry({ width: 800, height: 600 }, 3, true)
    expect(g.slug).toBeCloseTo(mmToPx(MARK_GAP_MM + MARK_LENGTH_MM), 9)
    expect(g.sheetWidth).toBeCloseTo(800 + 2 * (mmToPx(3) + mmToPx(6)), 9)
    expect(g.artWidth).toBeCloseTo(800 + 2 * mmToPx(3), 9)
  })

  it('treats a negative or non-finite bleed as none', () => {
    expect(printGeometry({ width: 10, height: 10 }, -4, false).bleed).toBe(0)
  })

  it('draws eight marks that start outside the bleed and stay inside the sheet', () => {
    const g = printGeometry({ width: 500, height: 400 }, 3, true)
    const marks = cropMarkSegments(g)
    expect(marks).toHaveLength(8)
    const artLeft = g.slug
    const artRight = g.slug + g.artWidth
    const artTop = g.slug
    const artBottom = g.slug + g.artHeight
    for (const [x1, y1, x2, y2] of marks) {
      for (const [x, y] of [[x1, y1], [x2, y2]]) {
        expect(x).toBeGreaterThanOrEqual(-1e-9)
        expect(y).toBeGreaterThanOrEqual(-1e-9)
        expect(x).toBeLessThanOrEqual(g.sheetWidth + 1e-9)
        expect(y).toBeLessThanOrEqual(g.sheetHeight + 1e-9)
        expect(x > artLeft && x < artRight && y > artTop && y < artBottom).toBe(false)
      }
      expect(Math.abs(x2 - x1) + Math.abs(y2 - y1)).toBeCloseTo(mmToPx(MARK_LENGTH_MM), 6)
    }
  })

  it('lines the marks up with the trim corners', () => {
    const g = printGeometry({ width: 500, height: 400 }, 0, true)
    const trimLeft = g.slug
    const trimTop = g.slug
    const horizontalAtTop = cropMarkSegments(g).find(([, y1, , y2]) => y1 === y2 && Math.abs(y1 - trimTop) < 1e-9)
    expect(horizontalAtTop).toBeDefined()
    const verticalAtLeft = cropMarkSegments(g).find(([x1, , x2]) => x1 === x2 && Math.abs(x1 - trimLeft) < 1e-9)
    expect(verticalAtLeft).toBeDefined()
  })

  it('draws in the units a schematic asks for', () => {
    const g = printGeometry({ width: 100, height: 100 }, 0, true)
    const [first] = cropMarkSegments(g, 2, 7)
    expect(Math.abs(first[2] - first[0]) + Math.abs(first[3] - first[1])).toBeCloseTo(7, 9)
  })

  it('keeps the largest bleed the server accepts', () => {
    expect(MAX_BLEED_MM).toBe(10)
  })
})
