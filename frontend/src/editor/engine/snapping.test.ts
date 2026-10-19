import type { Rect } from './geometry'
import { SNAP_THRESHOLD_PX, computeResizeSnap, computeSnap } from './snapping'

const page: Rect = { left: 0, top: 0, width: 400, height: 300 }

describe('computeSnap', () => {
  it('snaps edges to the page edges within the threshold', () => {
    const r = computeSnap({ left: 3, top: 2, width: 50, height: 50 }, [], page)
    expect(r.dx).toBe(-3)
    expect(r.dy).toBe(-2)
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 0)).toBe(true)
  })

  it('snaps the centre to the page centre', () => {
    const r = computeSnap({ left: 177, top: 100, width: 50, height: 50 }, [], page)
    expect(r.dx).toBe(-2)
    expect(r.guides.find((g) => g.axis === 'x')?.kind).toBe('page')
  })

  it('does not snap outside the threshold', () => {
    const r = computeSnap({ left: 20, top: 20, width: 50, height: 50 }, [], page)
    expect(r).toMatchObject({ dx: 0, dy: 0 })
    expect(r.guides).toHaveLength(0)
  })

  it('snaps to other objects edges and centres', () => {
    const other: Rect = { left: 100, top: 100, width: 80, height: 40 }
    const r = computeSnap({ left: 103, top: 200, width: 30, height: 30 }, [other], page)
    expect(r.dx).toBe(-3)
    const c = computeSnap({ left: 130, top: 200, width: 20, height: 20 }, [other], page)
    // centre of moving (140) vs centre of other (140)
    expect(c.dx).toBe(0)
    expect(c.guides.some((g) => g.axis === 'x' && g.kind === 'center')).toBe(true)
  })

  it('prefers the nearest candidate', () => {
    const r = computeSnap({ left: 98, top: 200, width: 30, height: 30 }, [{ left: 100, top: 0, width: 10, height: 10 }, { left: 95, top: 0, width: 10, height: 10 }], page)
    expect(r.dx).toBe(2)
  })

  it('is disabled with enabled:false', () => {
    const r = computeSnap({ left: 1, top: 1, width: 10, height: 10 }, [], page, { enabled: false })
    expect(r).toEqual({ dx: 0, dy: 0, guides: [], spacing: [] })
  })

  it('reports equal spacing between three objects', () => {
    const a: Rect = { left: 0, top: 100, width: 40, height: 40 }
    const b: Rect = { left: 200, top: 100, width: 40, height: 40 }
    // moving 40 wide between: ideal left = 40 + (200-40-40)/2 = 100
    const r = computeSnap({ left: 97, top: 100, width: 40, height: 40 }, [a, b], page, { threshold: SNAP_THRESHOLD_PX })
    expect(r.dx).toBe(3)
    expect(r.spacing[0]?.axis).toBe('x')
    expect(r.spacing[0]?.gap).toBe(60)
  })

  it('matches an existing gap between two other objects', () => {
    const a: Rect = { left: 0, top: 10, width: 30, height: 30 }
    const b: Rect = { left: 50, top: 10, width: 30, height: 30 } // gap 20
    const r = computeSnap({ left: 103, top: 12, width: 30, height: 30 }, [a, b], page)
    // left of moving should be b.right (80) + 20 = 100
    expect(r.dx).toBe(-3)
  })

  it('snaps both axes at once', () => {
    const r = computeSnap({ left: 2, top: 299 - 50 + 3, width: 50, height: 50 }, [], page)
    expect(r.dx).toBe(-2)
    expect(r.dy).toBe(-2)
  })
})

describe('snapping while resizing', () => {
  const page = { left: 0, top: 0, width: 400, height: 400 }
  const box = { left: 50, top: 50, width: 147, height: 100 }

  it('sticks the dragged right edge to the page centre and leaves the other edge alone', () => {
    const r = computeResizeSnap(box, [], page, { x: 'right' })
    expect(r.dx).toBe(3)
    expect(r.dy).toBe(0)
    expect(r.guides).toHaveLength(1)
    expect(r.guides[0]).toMatchObject({ axis: 'x', pos: 200 })
  })

  it('sticks the dragged left edge to another object', () => {
    const r = computeResizeSnap({ left: 103, top: 50, width: 100, height: 40 }, [{ left: 100, top: 200, width: 80, height: 60 }], page, { x: 'left' })
    expect(r.dx).toBe(-3)
    expect(r.guides[0].from).toBeLessThanOrEqual(50)
    expect(r.guides[0].to).toBeGreaterThanOrEqual(260)
  })

  it('snaps both axes of a corner drag independently and ignores edges that are not dragged', () => {
    const r = computeResizeSnap({ left: 50, top: 50, width: 148, height: 148 }, [], page, { x: 'right', y: 'bottom' })
    expect([r.dx, r.dy]).toEqual([2, 2])
    expect(computeResizeSnap({ left: 50, top: 50, width: 148, height: 148 }, [], page, { x: 'left' }).dx).toBe(0)
  })

  it('does nothing outside the threshold', () => {
    expect(computeResizeSnap(box, [], page, { x: 'right' }, 2)).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})
