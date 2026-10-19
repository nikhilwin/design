import { alignItems, distributeItems, selectionBounds, tidyItems } from './align'
import type { Rect } from './geometry'

const items = [
  { id: 'a', rect: { left: 10, top: 10, width: 40, height: 20 } },
  { id: 'b', rect: { left: 100, top: 50, width: 60, height: 30 } },
  { id: 'c', rect: { left: 300, top: 20, width: 20, height: 60 } },
]
const page: Rect = { left: 0, top: 0, width: 400, height: 300 }

describe('alignItems', () => {
  it('aligns to the left of a target', () => {
    const d = alignItems(items, 'left', page)
    expect(d.get('a')).toEqual({ dx: -10, dy: 0 })
    expect(d.get('b')).toEqual({ dx: -100, dy: 0 })
  })

  it('aligns to right and bottom', () => {
    const d = alignItems(items, 'right', page)
    expect(d.get('c')).toEqual({ dx: 80, dy: 0 })
    const b = alignItems(items, 'bottom', page)
    expect(b.get('a')).toEqual({ dx: 0, dy: 270 })
  })

  it('centres horizontally and vertically', () => {
    const d = alignItems(items, 'center', page)
    expect(d.get('a')?.dx).toBe(200 - 30)
    const m = alignItems(items, 'middle', page)
    expect(m.get('b')?.dy).toBe(150 - 65)
  })

  it('aligns to the selection bounds', () => {
    const bounds = selectionBounds(items)
    expect(bounds).toEqual({ left: 10, top: 10, width: 310, height: 70 })
    const d = alignItems(items, 'top', bounds)
    expect(d.get('b')?.dy).toBe(-40)
  })
})

describe('distributeItems', () => {
  it('equalises horizontal gaps keeping the outer items', () => {
    const d = distributeItems(items, 'horizontal')
    // total span 10..320 = 310, sizes 40+60+20 = 120, gap = 95
    expect(d.get('a')).toEqual({ dx: 0, dy: 0 })
    expect(d.get('c')).toEqual({ dx: 0, dy: 0 })
    expect(d.get('b')?.dx).toBeCloseTo(10 + 40 + 95 - 100)
  })

  it('distributes vertically', () => {
    const v = [
      { id: 'a', rect: { left: 0, top: 0, width: 10, height: 10 } },
      { id: 'b', rect: { left: 0, top: 15, width: 10, height: 10 } },
      { id: 'c', rect: { left: 0, top: 100, width: 10, height: 10 } },
    ]
    const d = distributeItems(v, 'vertical')
    expect(d.get('b')?.dy).toBeCloseTo(35)
  })

  it('does nothing with fewer than three items', () => {
    const d = distributeItems(items.slice(0, 2), 'horizontal')
    expect([...d.values()].every((x) => x.dx === 0 && x.dy === 0)).toBe(true)
  })

  it('is order independent', () => {
    const shuffled = [items[2], items[0], items[1]]
    expect(distributeItems(shuffled, 'horizontal').get('b')?.dx).toBeCloseTo(distributeItems(items, 'horizontal').get('b')?.dx ?? NaN)
  })
})

describe('tidyItems', () => {
  it('makes spacing even along the dominant axis', () => {
    const d = tidyItems(items)
    const moved = items.map((i) => ({ ...i.rect, left: i.rect.left + (d.get(i.id)?.dx ?? 0) }))
    const sorted = moved.sort((a, b) => a.left - b.left)
    const gap1 = sorted[1].left - (sorted[0].left + sorted[0].width)
    const gap2 = sorted[2].left - (sorted[1].left + sorted[1].width)
    expect(gap1).toBeCloseTo(gap2)
  })

  it('honours a minimum gap', () => {
    const tight = [
      { id: 'a', rect: { left: 0, top: 0, width: 50, height: 10 } },
      { id: 'b', rect: { left: 50, top: 0, width: 50, height: 10 } },
    ]
    const d = tidyItems(tight, 8)
    expect(d.get('b')?.dx).toBe(8)
  })

  it('leaves a single item alone', () => {
    expect(tidyItems([items[0]]).get('a')).toEqual({ dx: 0, dy: 0 })
  })
})
