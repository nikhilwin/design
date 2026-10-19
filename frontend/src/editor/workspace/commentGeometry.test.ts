import { describe, expect, it } from 'vitest'
import { PIN_SIZE, clampToPage, isAnchorVisible, isComfortablyInside, layoutPins, placeCard, snapToDevice } from './commentGeometry'

describe('keeping a pin on its page', () => {
  it('keeps a point on its page', () => {
    const size = { width: 800, height: 600 }
    expect(clampToPage(size, { x: -20, y: 9999 })).toEqual({ x: 0, y: 600 })
    expect(clampToPage(size, { x: 400, y: 300 })).toEqual({ x: 400, y: 300 })
    expect(clampToPage(size, { x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({ x: 0, y: 0 })
  })

  it('uses the size of the page itself: the same point is inside one page and outside another', () => {
    const wide = { width: 1920, height: 1080 }
    const tall = { width: 400, height: 900 }
    expect(clampToPage(wide, { x: 1500, y: 1000 })).toEqual({ x: 1500, y: 1000 })
    expect(clampToPage(tall, { x: 1500, y: 1000 })).toEqual({ x: 400, y: 900 })
  })

  it('rounds to whole device pixels', () => {
    expect(snapToDevice(10.3, 1)).toBe(10)
    expect(snapToDevice(10.3, 2)).toBe(10.5)
    expect(snapToDevice(10.26, 2)).toBe(10.5)
    expect(snapToDevice(10.24, 2)).toBe(10)
    expect(snapToDevice(10.3, 0)).toBe(10)
    expect(snapToDevice(10.3, Number.NaN)).toBe(10)
    expect(snapToDevice(1.1, 3)).toBeCloseTo(1, 2)
  })
})

describe('placing a card next to its pin', () => {
  const bounds = { left: 0, top: 54, width: 1000, height: 700 }
  const card = { width: 320, height: 240 }
  const pin = (left: number, top: number) => ({ left, top, width: PIN_SIZE, height: PIN_SIZE })

  it('prefers the right side, level with the pin', () => {
    const p = placeCard(pin(300, 300), card, bounds)
    expect(p.side).toBe('right')
    expect(p.left).toBe(300 + PIN_SIZE + 10)
    expect(p.top).toBeGreaterThan(54)
    expect(p.top).toBeLessThanOrEqual(300)
  })

  it('moves to the left when the right is full', () => {
    const p = placeCard(pin(800, 300), card, bounds)
    expect(p.side).toBe('left')
    expect(p.left).toBe(800 - 10 - card.width)
  })

  it('goes below, then above, when neither side has room', () => {
    const narrow = { left: 0, top: 54, width: 360, height: 700 }
    expect(placeCard(pin(150, 200), card, narrow).side).toBe('below')
    const low = placeCard(pin(150, 600), card, narrow)
    expect(low.side).toBe('above')
    expect(low.top).toBe(600 - 10 - card.height)
  })

  it('stays inside the bounds, whatever the pin does', () => {
    for (const [x, y] of [[0, 54], [990, 740], [500, 54], [500, 740], [-40, 300], [1200, 300]]) {
      const p = placeCard(pin(x, y), card, bounds)
      expect(p.left).toBeGreaterThanOrEqual(8)
      expect(p.left + card.width).toBeLessThanOrEqual(1000 - 8)
      expect(p.top).toBeGreaterThanOrEqual(54 + 8)
      expect(p.top + card.height).toBeLessThanOrEqual(754 - 8)
    }
  })

  it('does its best when the card is bigger than the room', () => {
    const tiny = { left: 0, top: 0, width: 200, height: 150 }
    const p = placeCard(pin(50, 50), card, tiny)
    expect(p.left).toBe(8)
    expect(p.top).toBe(8)
  })

  it('tells when the pin is out of view', () => {
    expect(isAnchorVisible(pin(100, 100), bounds)).toBe(true)
    expect(isAnchorVisible(pin(100, 10), bounds)).toBe(false)
    expect(isAnchorVisible(pin(100, 760), bounds)).toBe(false)
  })
})

describe('knowing when nothing needs scrolling', () => {
  const area = { left: 0, top: 100, width: 800, height: 600 }
  it('is true for a pin well inside the area and false for one near or past an edge', () => {
    const pin = (left: number, top: number) => ({ left, top, width: PIN_SIZE, height: PIN_SIZE })
    expect(isComfortablyInside(pin(300, 300), area, 48)).toBe(true)
    expect(isComfortablyInside(pin(20, 300), area, 48)).toBe(false)
    expect(isComfortablyInside(pin(300, 110), area, 48)).toBe(false)
    expect(isComfortablyInside(pin(780, 300), area, 48)).toBe(false)
    expect(isComfortablyInside(pin(300, 690), area, 48)).toBe(false)
    expect(isComfortablyInside(pin(300, 5000), area, 48)).toBe(false)
    expect(isComfortablyInside(pin(48, 148), area, 48)).toBe(true)
  })
})

describe('fanning out pins that cover each other', () => {
  it('leaves pins that do not touch where they are', () => {
    expect(layoutPins([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }, { id: 'c', x: 0, y: 100 }], 1).size).toBe(0)
  })

  it('moves later pins off the older one when they sit on the same spot', () => {
    const offsets = layoutPins([{ id: 'a', x: 50, y: 50 }, { id: 'b', x: 50, y: 50 }, { id: 'c', x: 50, y: 50 }], 1)
    expect(offsets.has('a')).toBe(false)
    const b = offsets.get('b')
    const c = offsets.get('c')
    expect(b).toBeDefined()
    expect(c).toBeDefined()
    expect(b).not.toEqual(c)
    for (const o of [b, c]) {
      expect(Math.max(Math.abs(o?.dx ?? 0), Math.abs(o?.dy ?? 0))).toBeGreaterThanOrEqual(PIN_SIZE - 2)
    }
  })

  it('separates pins that overlap only partly', () => {
    const offsets = layoutPins([{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 110, y: 105 }], 1)
    expect(offsets.has('a')).toBe(false)
    expect(offsets.has('b')).toBe(true)
  })

  it('depends on what is drawn: the same pins part when the page is zoomed in, and bunch up when it is zoomed out', () => {
    const pins = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 112, y: 100 }]
    expect(layoutPins(pins, 1).has('b')).toBe(true)
    expect(layoutPins(pins, 4).size).toBe(0)
    expect(layoutPins(pins, 0.2).has('b')).toBe(true)
  })

  it('is deterministic', () => {
    const pins = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, x: 40 + (i % 3), y: 40 }))
    expect([...layoutPins(pins, 1)]).toEqual([...layoutPins(pins, 1)])
  })

  it('gives every pin of a crowd its own place (no two overlap) up to what fits in three rings', () => {
    const pins = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, x: 300, y: 300 }))
    const offsets = layoutPins(pins, 1)
    const placed = pins.map((p) => ({ x: 300 + (offsets.get(p.id)?.dx ?? 0), y: 300 + (offsets.get(p.id)?.dy ?? 0) }))
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const apart = Math.abs(placed[i].x - placed[j].x) >= PIN_SIZE - 2 || Math.abs(placed[i].y - placed[j].y) >= PIN_SIZE - 2
        expect(apart).toBe(true)
      }
    }
  })

  it('handles 500 pins in a blink', () => {
    const pins = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, x: (i % 25) * 9, y: Math.floor(i / 25) * 9 }))
    const started = performance.now()
    const offsets = layoutPins(pins, 1)
    expect(performance.now() - started).toBeLessThan(150)
    expect(offsets.size).toBeGreaterThan(0)
  })

  it('ignores a nonsense scale', () => {
    expect(layoutPins([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 0 }], 0).size).toBe(0)
    expect(layoutPins([{ id: 'a', x: 0, y: 0 }], 1).size).toBe(0)
  })
})
