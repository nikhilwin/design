import { ActiveSelection, Canvas, Rect } from 'fabric'
import { DRAG_CACHE_MIN_OBJECTS, DragLayerCache } from './dragCache'

function build(count: number, zoom = 1, offset = { x: 0, y: 0 }): Canvas {
  const el = document.createElement('canvas')
  const canvas = new Canvas(el, { width: 300, height: 300, renderOnAddRemove: false, preserveObjectStacking: true })
  canvas.setViewportTransform([zoom, 0, 0, zoom, offset.x, offset.y])
  for (let i = 0; i < count; i++) {
    canvas.add(new Rect({ left: (i * 23) % 240, top: (i * 37) % 240, width: 40, height: 30, fill: `hsl(${(i * 47) % 360} 70% 50%)`, objectCaching: false }))
  }
  return canvas
}

function pixels(canvas: Canvas): Uint8ClampedArray {
  const el = canvas.lowerCanvasEl
  const ctx = el.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  return ctx.getImageData(0, 0, el.width, el.height).data
}

function maxDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let max = 0
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
  return max
}

describe('DragLayerCache', () => {
  it('stays out of the way on small pages', () => {
    const canvas = build(DRAG_CACHE_MIN_OBJECTS - 1)
    canvas.setActiveObject(canvas.item(5))
    const cache = new DragLayerCache(canvas)
    cache.ensure()
    expect(cache.active).toBe(false)
    expect(canvas._objectsToRender).toBeUndefined()
    void canvas.dispose()
  })

  it('paints below layer, selection and above layer instead of every object', () => {
    const canvas = build(80)
    const target = canvas.item(40)
    canvas.setActiveObject(target)
    const cache = new DragLayerCache(canvas)
    cache.ensure()
    expect(cache.active).toBe(true)
    expect(canvas._objectsToRender).toHaveLength(3)
    expect(canvas._objectsToRender?.[1]).toBe(target)
    cache.end()
    expect(cache.active).toBe(false)
    expect(canvas._objectsToRender).toBeUndefined()
    void canvas.dispose()
  })

  it.each([
    ['at 100%', 1, { x: 0, y: 0 }],
    ['zoomed and offset like a scrolled window', 0.5, { x: -56, y: -20 }],
  ])('produces the same pixels as normal painting %s', (_name, zoom, offset) => {
    const canvas = build(90, zoom, offset)
    const target = canvas.item(45)
    canvas.setActiveObject(target)
    canvas.renderAll()
    const expected = pixels(canvas)
    const cache = new DragLayerCache(canvas)
    cache.ensure()
    target.set({ left: target.left })
    canvas.renderAll()
    expect(maxDifference(pixels(canvas), expected)).toBeLessThanOrEqual(2)
    // Moving the selection is reflected: the cached layers stay, the selection moves.
    target.set({ left: (target.left ?? 0) + 120, top: (target.top ?? 0) + 60 })
    target.setCoords()
    canvas.renderAll()
    cache.end()
    canvas.discardActiveObject()
    canvas.renderAll()
    const afterMove = pixels(canvas)
    const fresh = build(90, zoom, offset)
    const moved = fresh.item(45)
    moved.set({ left: (moved.left ?? 0) + 120, top: (moved.top ?? 0) + 60 })
    moved.setCoords()
    fresh.renderAll()
    expect(maxDifference(afterMove, pixels(fresh))).toBeLessThanOrEqual(2)
    void canvas.dispose()
    void fresh.dispose()
  })

  it('caches a contiguous multi-selection but not one split by other objects', () => {
    const canvas = build(70)
    const contiguous = new ActiveSelection([canvas.item(30), canvas.item(31), canvas.item(32)], { canvas })
    canvas.setActiveObject(contiguous)
    const cache = new DragLayerCache(canvas)
    cache.ensure()
    expect(canvas._objectsToRender).toHaveLength(5)
    cache.end()
    canvas.discardActiveObject()

    const split = new ActiveSelection([canvas.item(10), canvas.item(50)], { canvas })
    canvas.setActiveObject(split)
    cache.ensure()
    expect(cache.active).toBe(false)
    void canvas.dispose()
  })

  it('falls back to normal painting when an object is added mid-drag and can start again', () => {
    const canvas = build(60)
    canvas.setActiveObject(canvas.item(20))
    const cache = new DragLayerCache(canvas)
    cache.ensure()
    expect(cache.active).toBe(true)
    canvas.add(new Rect({ width: 10, height: 10 }))
    expect(cache.active).toBe(false)
    cache.ensure()
    expect(cache.active).toBe(true)
    expect(canvas._objectsToRender?.at(-1)).toBeDefined()
    void canvas.dispose()
  })
})
