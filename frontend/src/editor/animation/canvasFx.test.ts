import { afterEach, describe, expect, it } from 'vitest'
import { canFilter, context2d, createCanvas, drawBlurred, resetFilterSupport } from './canvasFx'

function source(): HTMLCanvasElement {
  const c = createCanvas(20, 12)
  const g = context2d(c)
  g.fillStyle = '#e11d48'
  g.fillRect(0, 0, 20, 12)
  g.fillStyle = '#1c1517'
  g.fillRect(4, 3, 8, 5)
  return c
}

function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  return context2d(c).getImageData(0, 0, c.width, c.height).data
}

describe('drawBlurred', () => {
  afterEach(() => resetFilterSupport())

  it('draws a picture that is not blurred as it is', () => {
    const a = createCanvas(60, 40)
    const b = createCanvas(60, 40)
    drawBlurred(context2d(a), source(), 10.5, 8.25, 20, 12, 0.1)
    context2d(b).drawImage(source(), 10.5, 8.25, 20, 12)
    expect(Array.from(pixels(a))).toEqual(Array.from(pixels(b)))
  })

  it('without a canvas filter softens the picture through a smaller copy and keeps its place', () => {
    expect(canFilter()).toBe(false)
    const target = createCanvas(80, 60)
    drawBlurred(context2d(target), source(), 20, 20, 20, 12, 8)
    const d = pixels(target)
    // Something is drawn inside the picture's rectangle and nothing outside it.
    expect(d[(26 * 80 + 30) * 4 + 3]).toBeGreaterThan(0)
    expect(d[(5 * 80 + 5) * 4 + 3]).toBe(0)
    expect(d[(50 * 80 + 70) * 4 + 3]).toBe(0)
  })

  it('with a canvas filter a small picture is blurred on a bitmap of its own and lands exactly where a plain draw would put it', () => {
    // Stand in for a browser that has the filter: the context gets the property; the engine under the test ignores its value.
    const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')) as object
    Object.defineProperty(proto, 'filter', { value: 'none', writable: true, configurable: true })
    try {
      resetFilterSupport()
      expect(canFilter()).toBe(true)
      const draw = (canvas: HTMLCanvasElement, blur: boolean, rotate: number): void => {
        const g = context2d(canvas)
        g.save()
        g.translate(40, 22)
        g.rotate(rotate)
        if (blur) drawBlurred(g, source(), 10.5, 8.25, 20, 12, 6)
        else g.drawImage(source(), 10.5, 8.25, 20, 12)
        g.restore()
      }
      const alpha = (canvas: HTMLCanvasElement): number => {
        const d = pixels(canvas)
        let sum = 0
        for (let i = 3; i < d.length; i += 4) sum += d[i]
        return sum
      }
      // Upright and on whole pixels, it is the same picture as a plain draw, to the pixel (the offset inside the pixel is kept).
      const a = createCanvas(300, 200)
      const b = createCanvas(300, 200)
      draw(a, true, 0)
      draw(b, false, 0)
      let worst = 0
      const da = pixels(a)
      const db = pixels(b)
      for (let i = 0; i < da.length; i++) worst = Math.max(worst, Math.abs(da[i] - db[i]))
      expect(worst).toBeLessThanOrEqual(2)
      // Turned, it covers the same area (the two resamplings differ only at the edges).
      const c = createCanvas(300, 200)
      const d = createCanvas(300, 200)
      draw(c, true, 0.2)
      draw(d, false, 0.2)
      expect(Math.abs(alpha(c) - alpha(d)) / alpha(d)).toBeLessThan(0.05)
      const g = context2d(a)
      // The drawing context is left as it was found.
      expect(g.filter).toBe('none')
    } finally {
      delete (proto as { filter?: unknown }).filter
    }
  })
})
