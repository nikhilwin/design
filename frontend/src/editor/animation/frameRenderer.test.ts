import { describe, expect, it, vi } from 'vitest'
import type { Anim, DocObject, DocPage, ObjectAnimation } from '@/types/document'
import { renderPageToCanvas } from '../engine/render'
import type { LoadContext } from '../engine/serialization'
import { context2d, createCanvas } from './canvasFx'
import { createFrameRenderer, renderFrame } from './frameRenderer'
import { transitionPresets } from './presets'
import { sampleTransition } from './sampler'
import { drawTransition } from './transitionRenderer'

const ctx: LoadContext = { resolveSrc: async (s) => s, ensureFonts: async () => undefined }
const SIZE = { width: 240, height: 160 }

const anim = (preset: string, over: Partial<Anim> = {}): Anim => ({ preset, durationMs: 1000, delayMs: 0, easing: 'linear', ...over })
const rect = (id: string, fill: string, left: number, top: number, animation?: ObjectAnimation, over: Partial<DocObject> = {}): DocObject => ({
  id,
  type: 'rect',
  left,
  top,
  width: 60,
  height: 40,
  fill,
  stroke: null,
  strokeWidth: 0,
  originX: 'center',
  originY: 'center',
  ...(animation ? { animation } : {}),
  ...over,
})
const page = (objects: DocObject[], color = '#ffffff'): DocPage => ({ id: 'p1', background: { type: 'solid', color }, objects })

function pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data
}

function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const d = context2d(canvas).getImageData(x, y, 1, 1).data
  return [d[0], d[1], d[2], d[3]]
}

function maxDifference(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
  const pa = pixels(a)
  const pb = pixels(b)
  expect(a.width).toBe(b.width)
  expect(a.height).toBe(b.height)
  let max = 0
  for (let i = 0; i < pa.length; i++) max = Math.max(max, Math.abs(pa[i] - pb[i]))
  return max
}

const isColor = (px: number[], r: number, g: number, b: number, tolerance = 6): boolean => Math.abs(px[0] - r) <= tolerance && Math.abs(px[1] - g) <= tolerance && Math.abs(px[2] - b) <= tolerance

const RED = [255, 0, 0] as const
const BLUE = [0, 0, 255] as const
const WHITE = [255, 255, 255] as const

describe('createFrameRenderer', () => {
  it('draws a page without animation exactly like the export does', async () => {
    const p = page([rect('a', '#ff0000', 60, 60), rect('b', '#0000ff', 150, 100)], '#fffbe0')
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    const reference = await renderPageToCanvas(p, SIZE, ctx, { multiplier: 1 })
    expect(maxDifference(renderer.render(0), reference)).toBe(0)
    renderer.dispose()
  })

  it('draws a page at rest the way the export does, with its animated objects in place, at any scale', async () => {
    const p = page([
      rect('under', '#00aa00', 40, 40),
      rect('a', '#ff0000', 60, 60, { enter: anim('fade', { delayMs: 200 }), emphasis: anim('pulse', { delayMs: 3000 }) }),
      rect('over', '#0000ff', 70, 70),
      rect('b', '#222222', 170.5, 100.25, { enter: anim('slide'), exit: anim('fade', { delayMs: 9000 }) }, { angle: 20 }),
    ])
    for (const multiplier of [1, 2, 0.5]) {
      const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier })
      const reference = await renderPageToCanvas(p, SIZE, ctx, { multiplier })
      // Antialiasing at the edges of a rotated shape may differ by a few levels, nothing more.
      expect(maxDifference(renderer.render(5000), reference)).toBeLessThanOrEqual(40)
      const whole = pixels(renderer.render(5000))
      const ref = pixels(reference)
      let off = 0
      for (let i = 0; i < whole.length; i += 4) if (Math.abs(whole[i] - ref[i]) + Math.abs(whole[i + 1] - ref[i + 1]) + Math.abs(whole[i + 2] - ref[i + 2]) > 30) off++
      expect(off / (whole.length / 4)).toBeLessThan(0.002)
      renderer.dispose()
    }
  })

  it('hides an object until its enter starts and shows it when it is over', async () => {
    const p = page([rect('a', '#ff0000', 120, 80, { enter: anim('fade', { delayMs: 500, durationMs: 500 }) })])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    expect(isColor(pixelAt(renderer.render(0), 120, 80), ...WHITE)).toBe(true)
    expect(isColor(pixelAt(renderer.render(499), 120, 80), ...WHITE)).toBe(true)
    const mid = pixelAt(renderer.render(750), 120, 80)
    expect(mid[1]).toBeGreaterThan(80)
    expect(mid[1]).toBeLessThan(180)
    expect(isColor(pixelAt(renderer.render(1000), 120, 80), ...RED)).toBe(true)
    expect(isColor(pixelAt(renderer.render(60_000), 120, 80), ...RED)).toBe(true)
    renderer.dispose()
  })

  it('removes an object once its exit is over', async () => {
    const p = page([rect('a', '#ff0000', 120, 80, { exit: anim('fade', { delayMs: 1000, durationMs: 500 }) })])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    expect(isColor(pixelAt(renderer.render(999), 120, 80), ...RED)).toBe(true)
    expect(isColor(pixelAt(renderer.render(1500), 120, 80), ...WHITE)).toBe(true)
    renderer.dispose()
  })

  it('moves an object the way the sampler says', async () => {
    const p = page([rect('a', '#ff0000', 120, 80, { enter: anim('slide', { direction: 'left' }) })])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    const start = renderer.render(0)
    expect(isColor(pixelAt(start, 120, 80), ...WHITE)).toBe(true)
    const half = renderer.render(500)
    // At half way the object sits left of its place: its right part is empty again, its left part is not.
    expect(isColor(pixelAt(half, 100, 80), ...RED)).toBe(false)
    expect(isColor(pixelAt(half, 30, 80), ...WHITE)).toBe(false)
    renderer.dispose()
  })

  it('keeps the stacking order of animated and still objects', async () => {
    const p = page([
      rect('bottom', '#ff0000', 100, 80, { enter: anim('fade', { durationMs: 100 }) }),
      rect('top', '#0000ff', 110, 80),
    ])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    for (const t of [0, 50, 1000]) {
      const frame = renderer.render(t)
      expect(isColor(pixelAt(frame, 118, 80), ...BLUE)).toBe(true)
    }
    expect(isColor(pixelAt(renderer.render(1000), 75, 80), ...RED)).toBe(true)
    renderer.dispose()
  })

  it('gives the same frame twice, from the same renderer or a new one', async () => {
    const p = page([rect('a', '#ff0000', 80, 60, { enter: anim('spin'), emphasis: anim('wiggle', { delayMs: 1200, loop: true }) }), rect('b', '#0000ff', 160, 100, { enter: anim('blur') })])
    const one = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    const two = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    for (const t of [0, 300, 650, 1500, 2345]) {
      const a = pixels(one.render(t)).slice()
      one.render(t + 777)
      const b = pixels(one.render(t))
      const c = pixels(two.render(t))
      expect(Array.from(b)).toEqual(Array.from(a))
      expect(Array.from(c)).toEqual(Array.from(a))
    }
    one.dispose()
    two.dispose()
  })

  it('draws a frame again only when something changed', async () => {
    const p = page([rect('a', '#ff0000', 80, 60, { enter: anim('fade') })])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    const clear = vi.spyOn(Object.getPrototypeOf(context2d(createCanvas(1, 1))), 'clearRect')
    renderer.render(2000)
    const after = clear.mock.calls.length
    renderer.render(2500)
    renderer.render(9000)
    expect(clear.mock.calls.length).toBe(after)
    renderer.render(100)
    expect(clear.mock.calls.length).toBe(after + 1)
    clear.mockRestore()
    renderer.dispose()
  })

  it('does not change the page it is given', async () => {
    const p = page([rect('a', '#ff0000', 80, 60, { enter: anim('typewriter') }), { id: 't', type: 'textbox', left: 120, top: 100, width: 150, height: 40, text: 'Hello there', fontSize: 24, fontFamily: 'sans-serif', fill: '#000000', animation: { enter: anim('rise', { by: 'word' }) } }])
    const before = JSON.stringify(p)
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    for (const t of [0, 400, 900]) renderer.render(t)
    expect(JSON.stringify(p)).toBe(before)
    renderer.dispose()
  })

  it('leaves the background out when asked for transparency', async () => {
    const p = page([rect('a', '#ff0000', 120, 80)])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1, transparent: true })
    const frame = renderer.render(0)
    expect(pixelAt(frame, 5, 5)[3]).toBe(0)
    expect(pixelAt(frame, 120, 80)[3]).toBe(255)
    renderer.dispose()
  })

  it('draws a blurred entrance without a canvas filter', async () => {
    const p = page([rect('a', '#ff0000', 120, 80, { enter: anim('blur') })])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    const frame = renderer.render(300)
    expect(pixelAt(frame, 120, 80)[3]).toBe(255)
    expect(pixelAt(frame, 120, 80)[1]).toBeGreaterThan(30)
    renderer.dispose()
  })

  it('draws the words of text at the size of the page at any multiplier', async () => {
    const text: DocObject = { id: 't', type: 'textbox', left: 120, top: 80, width: 200, height: 40, text: 'Hello there', fontSize: 28, fontFamily: 'sans-serif', fontWeight: 700, fill: '#000000', textAlign: 'center', originX: 'center', originY: 'center', animation: { enter: anim('rise', { by: 'word', durationMs: 1000 }) } }
    const inkWidth = async (multiplier: number): Promise<number> => {
      const renderer = await createFrameRenderer(page([text]), SIZE, ctx, { multiplier })
      // Part way through: the second word is still on its way, so the units are what is drawn.
      const frame = renderer.render(900)
      const data = pixels(frame)
      let min = frame.width
      let max = -1
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++)
          if (data[(y * frame.width + x) * 4] < 200) {
            min = Math.min(min, x)
            max = Math.max(max, x)
          }
      renderer.dispose()
      return (max - min + 1) / multiplier
    }
    const full = await inkWidth(1)
    const half = await inkWidth(0.5)
    const twice = await inkWidth(2)
    expect(full).toBeGreaterThan(60)
    expect(half / full).toBeGreaterThan(0.9)
    expect(half / full).toBeLessThan(1.1)
    expect(twice / full).toBeGreaterThan(0.9)
    expect(twice / full).toBeLessThan(1.1)
  })

  it('renders one frame in one call', async () => {
    const p = page([rect('a', '#ff0000', 120, 80, { enter: anim('fade', { durationMs: 100 }) })])
    const frame = await renderFrame(p, 1000, SIZE, ctx, { multiplier: 1 })
    expect(isColor(pixelAt(frame, 120, 80), ...RED)).toBe(true)
    expect(frame.width).toBe(SIZE.width)
  })

  it('reports when the page has built up', async () => {
    const p = page([rect('a', '#ff0000', 80, 60, { enter: anim('fade', { delayMs: 300, durationMs: 700 }) })])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    expect(renderer.timing.introMs).toBe(1000)
    renderer.dispose()
  })
})

describe('text that steps through its units', () => {
  const textObject = (by: 'line' | 'word' | 'letter', preset = 'fade'): DocObject => ({
    id: 't',
    type: 'textbox',
    left: 120,
    top: 80,
    width: 200,
    height: 80,
    text: 'Hello big world',
    fontSize: 28,
    fontFamily: 'sans-serif',
    fill: '#000000',
    textAlign: 'left',
    animation: { enter: anim(preset, { by, easing: 'linear' }) },
  })

  function ink(canvas: HTMLCanvasElement): number {
    const d = pixels(canvas)
    let count = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) count++
    return count
  }

  for (const by of ['line', 'word', 'letter'] as const) {
    it(`shows more of the text as time goes by (${by})`, async () => {
      const p = page([textObject(by, 'typewriter')])
      const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
      const amounts = [0, 0.25, 0.5, 0.75, 1].map((f) => ink(renderer.render(f * 1000 - (f === 1 ? 1 : 0))))
      expect(amounts[0]).toBe(0)
      for (let i = 1; i < amounts.length; i++) expect(amounts[i]).toBeGreaterThanOrEqual(amounts[i - 1])
      expect(amounts[amounts.length - 1]).toBeGreaterThan(50)
      expect(ink(renderer.render(5000))).toBeGreaterThanOrEqual(amounts[amounts.length - 1])
      renderer.dispose()
    })

    it(`ends exactly like the text at rest (${by})`, async () => {
      const p = page([textObject(by, 'rise')])
      const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
      const reference = await renderPageToCanvas(page([{ ...textObject(by), animation: undefined }]), SIZE, ctx, { multiplier: 1 })
      expect(maxDifference(renderer.render(5000), reference)).toBeLessThanOrEqual(2)
      renderer.dispose()
    })
  }

  it('draws all the units of a text at rest where the text is, with nothing lost at the seams', async () => {
    const p = page([textObject('letter', 'rise')])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    const reference = await renderPageToCanvas(page([{ ...textObject('letter'), animation: undefined }]), SIZE, ctx, { multiplier: 1 })
    // Just before the end the units are all (almost) in place.
    const near = renderer.render(999.9)
    expect(maxDifference(near, reference)).toBeLessThanOrEqual(60)
    renderer.dispose()
  })

  it('plays curved text as one piece', async () => {
    const p = page([{ ...textObject('word'), curveAmount: 120 }])
    const renderer = await createFrameRenderer(p, SIZE, ctx, { multiplier: 1 })
    expect(() => renderer.render(300)).not.toThrow()
    renderer.dispose()
  })
})

describe('transitions', () => {
  const solid = (r: number, g: number, b: number): HTMLCanvasElement => {
    const c = createCanvas(80, 60)
    const x = context2d(c)
    x.fillStyle = `rgb(${r}, ${g}, ${b})`
    x.fillRect(0, 0, 80, 60)
    return c
  }
  const from = solid(255, 0, 0)
  const to = solid(0, 0, 255)

  function frame(sample: ReturnType<typeof sampleTransition>): HTMLCanvasElement {
    const out = createCanvas(80, 60)
    drawTransition(context2d(out), sample, from, to, 80, 60)
    return out
  }

  for (const preset of transitionPresets.list()) {
    for (const direction of preset.directions ?? [undefined]) {
      it(`${preset.id} (${direction ?? 'no direction'}) starts on the old page, ends on the new one and shows both between`, () => {
        const tr = { preset: preset.id, easing: 'linear' as const, direction }
        const start = frame(sampleTransition(tr, 0))
        const end = frame(sampleTransition(tr, 1))
        for (const [x, y] of [[2, 2], [40, 30], [77, 57]]) {
          expect(isColor(pixelAt(start, x, y), ...RED)).toBe(true)
          expect(isColor(pixelAt(end, x, y), ...BLUE)).toBe(true)
        }
        if (preset.id === 'none') return
        // Somewhere in the middle both pages (or the veil) are on screen.
        const seen = new Set<string>()
        for (let i = 1; i < 20; i++) {
          const mid = frame(sampleTransition(tr, i / 20))
          const d = pixels(mid)
          for (let k = 0; k < d.length; k += 4) {
            if (d[k] > 200 && d[k + 2] < 60) seen.add('red')
            else if (d[k + 2] > 200 && d[k] < 60) seen.add('blue')
            else seen.add('other')
          }
        }
        expect(seen.has('red')).toBe(true)
        expect(seen.has('blue')).toBe(true)
      })
    }
  }

  it('a dissolve shows the new page in separate blocks, more of them as time goes by', () => {
    const tr = { preset: 'dissolve', easing: 'linear' as const }
    const share = (p: number): number => {
      const d = pixels(frame(sampleTransition(tr, p)))
      let blue = 0
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 60) blue++
      return blue / (d.length / 4)
    }
    expect(share(0.25)).toBeGreaterThan(0.1)
    expect(share(0.25)).toBeLessThan(0.45)
    expect(share(0.75)).toBeGreaterThan(share(0.25))
    expect(share(0.5)).toBeGreaterThan(0.3)
    expect(share(0.5)).toBeLessThan(0.7)
  })

  it('a dip to black goes through black', () => {
    const middle = frame(sampleTransition({ preset: 'fade-black', easing: 'linear' }, 0.5))
    expect(isColor(pixelAt(middle, 40, 30), 0, 0, 0)).toBe(true)
  })
})
