import {
  DEFAULT_METRICS,
  computeCanvasWindow,
  computeStack,
  pageAtViewportCenter,
  visiblePageIds,
  windowContains,
} from './layout'
import { MAX_ZOOM, MIN_ZOOM, clampZoom, fitZoom, nextZoomStep, wheelZoom, zoomLabel } from './zoom'
import { decodeClipboard, encodeClipboard } from './clipboardFormat'

describe('zoom', () => {
  it('clamps to 10%..800%', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM)
    expect(clampZoom(99)).toBe(MAX_ZOOM)
    expect(clampZoom(NaN)).toBe(1)
  })

  it('fits width and page', () => {
    const viewport = { width: 1000, height: 600 }
    const page = { width: 800, height: 800 }
    expect(fitZoom(viewport, page, 'fit-width', 50)).toBeCloseTo(900 / 800, 2)
    expect(fitZoom(viewport, page, 'fit-page', 50)).toBeCloseTo(500 / 800, 2)
  })

  it('never enlarges a page past 100 % when fitting it', () => {
    expect(fitZoom({ width: 3000, height: 2000 }, { width: 559, height: 794 }, 'fit-page')).toBe(1)
    expect(fitZoom({ width: 3000, height: 2000 }, { width: 559, height: 794 }, 'fit-width')).toBeGreaterThan(1)
  })

  it('steps through the preset ladder', () => {
    expect(nextZoomStep(1, 1)).toBe(1.25)
    expect(nextZoomStep(1, -1)).toBe(0.75)
    expect(nextZoomStep(8, 1)).toBe(8)
    expect(nextZoomStep(0.1, -1)).toBe(0.1)
    expect(nextZoomStep(0.9, 1)).toBe(1)
  })

  it('wheel zoom is multiplicative and bounded', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1)
    expect(wheelZoom(1, 100)).toBeLessThan(1)
    expect(wheelZoom(8, -10000)).toBe(8)
    expect(zoomLabel(1.256)).toBe('126%')
  })
})

describe('stack layout', () => {
  const pages = [
    { id: 'a', width: 100, height: 200 },
    { id: 'b', width: 300, height: 100 },
    { id: 'c', width: 100, height: 100 },
  ]
  const layout = computeStack(pages, 2)

  it('stacks pages top to bottom with the configured gaps', () => {
    const { padding, header, gap } = DEFAULT_METRICS
    expect(layout.slots[0].top).toBe(padding)
    expect(layout.slots[0].artboardTop).toBe(padding + header)
    expect(layout.slots[0].height).toBe(400)
    expect(layout.slots[1].top).toBe(layout.slots[0].bottom + gap)
  })

  it('content width follows the widest page', () => {
    expect(layout.contentWidth).toBe(600 + DEFAULT_METRICS.sidePadding * 2)
    expect(layout.contentHeight).toBeGreaterThan(layout.slots[2].bottom)
  })

  it('finds visible pages with overscan', () => {
    expect(visiblePageIds(layout, 0, 100)).toEqual(['a'])
    expect(visiblePageIds(layout, 0, 100, 2000)).toEqual(['a', 'b', 'c'])
    expect(visiblePageIds(layout, layout.slots[2].top, 50)).toEqual(['c'])
  })

  it('tracks the page at the viewport centre', () => {
    expect(pageAtViewportCenter(layout, 0, 200)).toBe('a')
    expect(pageAtViewportCenter(layout, layout.slots[1].top - 100, 200)).toBe('b')
    expect(pageAtViewportCenter({ slots: [], contentHeight: 0, contentWidth: 0 }, 0, 100)).toBeNull()
  })

  it('handles 100 pages quickly', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: String(i), width: 1080, height: 1080 }))
    const l = computeStack(many, 0.5)
    expect(l.slots).toHaveLength(100)
    expect(visiblePageIds(l, 0, 900)).toHaveLength(2)
  })
})

describe('canvas window', () => {
  const artboard = { width: 8640, height: 8640 }

  it('covers the whole page plus bleed when it fits', () => {
    const w = computeCanvasWindow({ width: 500, height: 400 }, { x: -100, y: -100, width: 2000, height: 2000 }, 100, 32)
    expect(w).toEqual({ x: -32, y: -32, width: 564, height: 464 })
  })

  it('stays viewport-sized at high zoom', () => {
    const w = computeCanvasWindow(artboard, { x: 4000, y: 3000, width: 1200, height: 800 }, 200, 32)
    expect(w.width).toBe(1600)
    expect(w.height).toBe(1200)
    expect(w.x).toBe(3800)
  })

  it('detects whether the visible region is still covered', () => {
    const w = computeCanvasWindow(artboard, { x: 4000, y: 3000, width: 1200, height: 800 }, 200, 32)
    expect(windowContains(w, { x: 4000, y: 3000, width: 1200, height: 800 })).toBe(true)
    expect(windowContains(w, { x: 3500, y: 3000, width: 1200, height: 800 })).toBe(false)
  })
})

describe('clipboard format', () => {
  const objs = [{ id: 'a', type: 'rect', left: 1 }]

  it('round-trips', () => {
    const text = encodeClipboard(objs, { width: 100, height: 50 })
    expect(decodeClipboard(text)).toEqual({ kind: 'doory-clipboard/v1', objects: objs, page: { width: 100, height: 50 } })
  })

  it('rejects foreign text and malformed payloads', () => {
    expect(decodeClipboard('hello')).toBeNull()
    expect(decodeClipboard('{"kind":"other"}')).toBeNull()
    expect(decodeClipboard('{"kind":"doory-clipboard/v1","objects":[],"page":{"width":1,"height":1}}')).toBeNull()
    expect(decodeClipboard('{"kind":"doory-clipboard/v1" nope')).toBeNull()
    expect(decodeClipboard('{"kind":"doory-clipboard/v1","objects":[{"type":"rect"}],"page":{}}')).toBeNull()
  })

  it('drops non-object entries', () => {
    const payload = '{"kind":"doory-clipboard/v1","objects":[null,1,{"type":"rect","id":"x"}],"page":{"width":1,"height":1}}'
    expect(decodeClipboard(payload)?.objects).toHaveLength(1)
  })
})
