import { describe, expect, it } from 'vitest'
import type { Anim, AnimDirection, DocObject, ObjectAnimation, PageTransition } from '@/types/document'
import { type PageLayer, type PageClip, emphasisPresets, inOutPresets, transitionPresets } from './presets'
import { type Box, REST, type Sample, type UnitSample, boxBounds, isRest, isSplittableText, objectBox, sampleObject, sampleTransition, sampleUnit } from './sampler'
import { EASINGS } from './easing'

const PAGE = { width: 800, height: 600 }

const rect = (animation: ObjectAnimation | undefined, over: Partial<DocObject> = {}): DocObject => ({
  id: 'rect-1',
  type: 'rect',
  left: 400,
  top: 300,
  width: 200,
  height: 100,
  ...(animation ? { animation } : {}),
  ...over,
})
const text = (animation: ObjectAnimation | undefined): DocObject => rect(animation, { id: 'text-1', type: 'textbox', width: 300, height: 80 })

const anim = (preset: string, over: Partial<Anim> = {}): Anim => ({ preset, durationMs: 1000, delayMs: 500, easing: 'linear', ...over })

/** A sample shows nothing: it is not drawn, fully transparent, collapsed, cut away or entirely off the page. */
function invisible(s: Readonly<Sample>, object: DocObject): boolean {
  if (!s.visible || s.opacity <= 0.001 || Math.abs(s.scaleX) <= 0.001 || Math.abs(s.scaleY) <= 0.001) return true
  const box = boxBounds(objectBox(object))
  const content = { x0: box.x + s.tx, y0: box.y + s.ty, x1: box.x + box.w + s.tx, y1: box.y + box.h + s.ty }
  if (content.x1 <= 0 || content.y1 <= 0 || content.x0 >= PAGE.width || content.y0 >= PAGE.height) return true
  if (s.clip) {
    const c = s.clip
    const region = c.fixed
      ? { x0: box.x + c.x0 * box.w, y0: box.y + c.y0 * box.h, x1: box.x + c.x1 * box.w, y1: box.y + c.y1 * box.h }
      : { x0: content.x0 + c.x0 * box.w, y0: content.y0 + c.y0 * box.h, x1: content.x0 + c.x1 * box.w, y1: content.y0 + c.y1 * box.h }
    const overlap = Math.min(content.x1, region.x1) > Math.max(content.x0, region.x0) && Math.min(content.y1, region.y1) > Math.max(content.y0, region.y0)
    if (!overlap) return true
  }
  return false
}

function unitInvisible(u: UnitSample, size: { w: number; h: number }): boolean {
  return u.opacity <= 0.001 || Math.abs(u.scaleX) <= 0.001 || Math.abs(u.scaleY) <= 0.001 || (u.clipToUnit && Math.abs(u.ty) >= size.h)
}

function expectSane(s: Readonly<Sample>): void {
  for (const key of ['opacity', 'tx', 'ty', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY', 'blur'] as const) expect(Number.isFinite(s[key])).toBe(true)
  expect(s.opacity).toBeGreaterThanOrEqual(0)
  expect(s.opacity).toBeLessThanOrEqual(1)
  expect(Math.abs(s.tx)).toBeLessThanOrEqual(PAGE.width * 4)
  expect(Math.abs(s.ty)).toBeLessThanOrEqual(PAGE.height * 4)
  expect(Math.abs(s.scaleX)).toBeLessThanOrEqual(6)
  expect(Math.abs(s.scaleY)).toBeLessThanOrEqual(6)
  expect(Math.abs(s.rotate)).toBeLessThanOrEqual(2000)
  expect(Math.abs(s.skewX)).toBeLessThanOrEqual(90)
  expect(Math.abs(s.skewY)).toBeLessThanOrEqual(90)
  expect(s.blur).toBeGreaterThanOrEqual(0)
  expect(s.blur).toBeLessThanOrEqual(300)
  if (s.clip) for (const v of [s.clip.x0, s.clip.y0, s.clip.x1, s.clip.y1]) expect(Number.isFinite(v)).toBe(true)
}

const atRest = (s: Readonly<Sample>): boolean => isRest(s)

describe('every enter / exit preset', () => {
  const presets = inOutPresets.list()

  it('ships at least 22', () => {
    expect(presets.length).toBeGreaterThanOrEqual(22)
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length)
  })

  for (const preset of presets) {
    const directions: (AnimDirection | undefined)[] = preset.directions ? [...preset.directions] : [undefined]
    describe(preset.id, () => {
      for (const direction of directions) {
        for (const easing of EASINGS) {
          it(`enter: hidden at its start, at rest at its end (${direction ?? 'no direction'}, ${easing})`, () => {
            const o = rect({ enter: anim(preset.id, { direction, easing }) })
            expect(invisible(sampleObject(o, 0, PAGE), o)).toBe(true)
            expect(invisible(sampleObject(o, 500, PAGE), o)).toBe(true)
            for (let t = 500; t <= 1500; t += 50) expectSane(sampleObject(o, t, PAGE))
            expect(sampleObject(o, 1500, PAGE)).toBe(REST)
            expect(sampleObject(o, 99999, PAGE)).toBe(REST)
          })
        }

        it(`exit: at rest before it, gone after it (${direction ?? 'no direction'})`, () => {
          const o = rect({ exit: anim(preset.id, { direction, delayMs: 2000 }) })
          expect(sampleObject(o, 0, PAGE)).toBe(REST)
          expect(sampleObject(o, 1999, PAGE)).toBe(REST)
          for (let t = 2000; t <= 3000; t += 50) expectSane(sampleObject(o, t, PAGE))
          expect(sampleObject(o, 3000, PAGE).visible).toBe(false)
          expect(sampleObject(o, 99999, PAGE).visible).toBe(false)
          // The first moment of an exit is the object at rest.
          expect(invisible(sampleObject(o, 2000, PAGE), o)).toBe(false)
        })
      }

      it('is the same twice, for any intensity', () => {
        for (const intensity of [0, 0.25, 0.5, 1]) {
          const o = rect({ enter: anim(preset.id, { intensity }) })
          for (let t = 0; t <= 1600; t += 100) {
            const a = sampleObject(o, t, PAGE)
            const b = sampleObject(o, t, PAGE)
            expect(a).toEqual(b)
            expectSane(a)
          }
        }
      })

      it('does not depend on the order it is asked in', () => {
        const o = rect({ enter: anim(preset.id) })
        const forwards = [500, 700, 900, 1100].map((t) => sampleObject(o, t, PAGE))
        const backwards = [1100, 900, 700, 500].map((t) => sampleObject(o, t, PAGE)).reverse()
        expect(forwards).toEqual(backwards)
      })

      if (preset.textUnits) {
        it('steps through the units of text, all hidden at the start and all at rest at the end', () => {
          for (const by of ['line', 'word', 'letter'] as const) {
            const o = text({ enter: anim(preset.id, { by, easing: 'ease-out' }) })
            const start = sampleObject(o, 500, PAGE)
            expect(start.units).toMatchObject({ by, phase: 'enter', progress: 0 })
            const size = { w: 20, h: 30 }
            for (const [i, n] of [[0, 1], [0, 8], [7, 8]] as const) expect(unitInvisible(sampleUnit(start.units!, i, n, size), size)).toBe(true)
            const mid = sampleObject(o, 1000, PAGE)
            for (let i = 0; i < 6; i++) {
              const u = sampleUnit(mid.units!, i, 6, size)
              for (const v of [u.opacity, u.tx, u.ty, u.scaleX, u.scaleY, u.rotate, u.skewX, u.skewY, u.blur]) expect(Number.isFinite(v)).toBe(true)
              expect(u.opacity).toBeGreaterThanOrEqual(0)
              expect(u.opacity).toBeLessThanOrEqual(1)
            }
            expect(sampleObject(o, 1500, PAGE)).toBe(REST)
            const nearEnd = sampleObject(o, 1499.9, PAGE)
            const last = nearEnd.units!
            const u = sampleUnit({ ...last, progress: 1 }, 5, 6, size)
            expect(u).toMatchObject({ opacity: 1, tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, blur: 0 })
          }
        })

        it('leaves the exit of text units hidden at the end', () => {
          const o = text({ exit: anim(preset.id, { by: 'word', delayMs: 0 }) })
          expect(sampleObject(o, 0, PAGE).units).toMatchObject({ phase: 'exit', progress: 0 })
          expect(sampleObject(o, 1000, PAGE).visible).toBe(false)
        })
      } else {
        it('plays text as one piece', () => {
          const o = text({ enter: anim(preset.id, { by: 'word' }) })
          expect(sampleObject(o, 1000, PAGE).units).toBeUndefined()
        })
      }
    })
  }
})

describe('text units', () => {
  it('only text that is not curved can be split', () => {
    expect(isSplittableText({ type: 'textbox' })).toBe(true)
    expect(isSplittableText({ type: 'itext', curveAmount: 0 })).toBe(true)
    expect(isSplittableText({ type: 'itext', curveAmount: 120 })).toBe(false)
    expect(isSplittableText({ type: 'rect' })).toBe(false)
  })

  it('splits a typewriter into letters by default and an object that is no text into a wipe', () => {
    const t = sampleObject(text({ enter: anim('typewriter') }), 1000, PAGE)
    expect(t.units?.by).toBe('letter')
    const r = sampleObject(rect({ enter: anim('typewriter') }), 1000, PAGE)
    expect(r.units).toBeUndefined()
    expect(r.clip).toBeDefined()
  })

  it('lets the letters of a typewriter appear in turn, none of them twice', () => {
    const plan = sampleObject(text({ enter: anim('typewriter') }), 1000, PAGE).units!
    const size = { w: 10, h: 20 }
    const shown = (progress: number): number => Array.from({ length: 10 }, (_, i) => sampleUnit({ ...plan, progress }, i, 10, size).opacity).filter((o) => o === 1).length
    expect(shown(0)).toBe(0)
    expect(shown(0.05)).toBe(1)
    expect(shown(0.5)).toBe(5)
    expect(shown(0.95)).toBe(10)
  })

  it('starts the first unit first', () => {
    const plan = sampleObject(text({ enter: anim('fade', { by: 'word' }) }), 800, PAGE).units!
    const size = { w: 40, h: 20 }
    const opacities = Array.from({ length: 5 }, (_, i) => sampleUnit(plan, i, 5, size).opacity)
    for (let i = 1; i < opacities.length; i++) expect(opacities[i]).toBeLessThanOrEqual(opacities[i - 1])
    expect(opacities[0]).toBeGreaterThan(opacities[4])
  })
})

describe('combining enter, exit and emphasis', () => {
  const full = rect({
    enter: anim('fade', { delayMs: 0, durationMs: 500 }),
    emphasis: anim('pulse', { delayMs: 1000, durationMs: 1000, easing: 'linear' }),
    exit: anim('fade', { delayMs: 3000, durationMs: 500, easing: 'linear' }),
  })

  it('walks through all of them', () => {
    expect(sampleObject(full, 0, PAGE).opacity).toBe(0)
    expect(sampleObject(full, 250, PAGE).opacity).toBeCloseTo(0.5, 6)
    expect(sampleObject(full, 700, PAGE)).toBe(REST)
    const pulse = sampleObject(full, 1500, PAGE)
    expect(pulse.scaleX).toBeGreaterThan(1.05)
    expect(pulse.opacity).toBe(1)
    expect(sampleObject(full, 2500, PAGE)).toBe(REST)
    expect(sampleObject(full, 3250, PAGE).opacity).toBeCloseTo(0.5, 6)
    expect(sampleObject(full, 3500, PAGE).visible).toBe(false)
  })

  it('treats an object without animation as always at rest', () => {
    expect(sampleObject(rect(undefined), 12345, PAGE)).toBe(REST)
  })

  it('plays a preset it does not know as none', () => {
    const o = rect({ enter: anim('from-the-future'), exit: anim('also-unknown', { delayMs: 100 }), emphasis: anim('nothing-here') })
    expect(sampleObject(o, 0, PAGE)).toBe(REST)
    expect(sampleObject(o, 5000, PAGE)).toBe(REST)
  })

  it('survives a clock that is not a number', () => {
    const o = rect({ enter: anim('fade') })
    expect(sampleObject(o, Number.NaN, PAGE)).toEqual(sampleObject(o, 0, PAGE))
    expect(sampleObject(o, Number.POSITIVE_INFINITY, PAGE)).toEqual(sampleObject(o, 0, PAGE))
    expectSane(sampleObject(o, -500, PAGE))
  })

  it('moves a slide as far as it takes to leave the page', () => {
    const o = rect({ enter: anim('slide', { direction: 'left' }) })
    const start = sampleObject(o, 500, PAGE)
    const box = boxBounds(objectBox(o))
    expect(start.tx).toBeCloseTo(-(box.x + box.w), 6)
    const fromBottom = sampleObject(rect({ enter: anim('slide', { direction: 'down' }) }), 500, PAGE)
    expect(fromBottom.ty).toBeCloseTo(PAGE.height - box.y, 6)
  })

  it('takes the exact box when the renderer passes one', () => {
    const o = rect({ enter: anim('slide', { direction: 'left' }) })
    const box: Box = { cx: 100, cy: 100, w: 50, h: 50, angle: 0 }
    expect(sampleObject(o, 500, PAGE, box).tx).toBeCloseTo(-125, 6)
  })
})

describe('every emphasis preset', () => {
  const presets = emphasisPresets.list()

  it('ships at least 8', () => {
    expect(presets.length).toBeGreaterThanOrEqual(8)
  })

  for (const preset of presets) {
    describe(preset.id, () => {
      it('is at rest at both ends of its cycle and sane inside it', () => {
        for (const intensity of [0, 0.5, 1]) {
          const o = rect({ emphasis: anim(preset.id, { delayMs: 200, durationMs: 800, intensity }) })
          expect(atRest(sampleObject(o, 200, PAGE))).toBe(true)
          expect(atRest(sampleObject(o, 1000, PAGE))).toBe(true)
          expect(sampleObject(o, 0, PAGE)).toBe(REST)
          expect(sampleObject(o, 5000, PAGE)).toBe(REST)
          for (let t = 200; t <= 1000; t += 20) expectSane(sampleObject(o, t, PAGE))
        }
      })

      it('does something in between', () => {
        const o = rect({ emphasis: anim(preset.id, { delayMs: 0, durationMs: 1000, intensity: 1 }) })
        const moved = Array.from({ length: 49 }, (_, i) => sampleObject(o, 20 + i * 20, PAGE)).some((s) => !atRest(s))
        expect(moved).toBe(true)
      })

      it('repeats when it loops, and plays once when it does not', () => {
        const looping = rect({ emphasis: anim(preset.id, { delayMs: 100, durationMs: 800, loop: true, intensity: 1 }) })
        for (const t of [250, 480, 650]) {
          const a = sampleObject(looping, 100 + t, PAGE)
          const b = sampleObject(looping, 100 + t + 800 * 3, PAGE)
          for (const key of ['opacity', 'tx', 'ty', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY'] as const) expect(b[key]).toBeCloseTo(a[key], 6)
        }
        const once = rect({ emphasis: anim(preset.id, { delayMs: 100, durationMs: 800, intensity: 1 }) })
        expect(sampleObject(once, 100 + 800 * 3 + 250, PAGE)).toBe(REST)
      })

      it('is the same twice', () => {
        const o = rect({ emphasis: anim(preset.id, { delayMs: 0, durationMs: 700, loop: true }) })
        for (let t = 0; t < 3000; t += 130) expect(sampleObject(o, t, PAGE)).toEqual(sampleObject(o, t, PAGE))
      })
    })
  }
})

/* ------------------------------------------------------------------------------------------------
 * Transitions
 * ---------------------------------------------------------------------------------------------- */

function clipCoversPage(clip: PageClip | undefined): boolean {
  if (!clip) return true
  switch (clip.kind) {
    case 'rect':
      return clip.x0 <= 0 && clip.y0 <= 0 && clip.x1 >= 1 && clip.y1 >= 1
    case 'circle':
      return clip.r >= Math.SQRT1_2 - 1e-9
    case 'dissolve':
    case 'bars':
      return clip.amount >= 1
  }
}

function clipIsEmpty(clip: PageClip | undefined): boolean {
  if (!clip) return false
  switch (clip.kind) {
    case 'rect':
      return clip.x1 <= clip.x0 || clip.y1 <= clip.y0
    case 'circle':
      return clip.r <= 0
    case 'dissolve':
    case 'bars':
      return clip.amount <= 0
  }
}

const layerRest = (l: PageLayer): boolean =>
  l.opacity === 1 && l.dx === 0 && l.dy === 0 && Math.abs(l.scaleX - 1) < 1e-9 && Math.abs(l.scaleY - 1) < 1e-9 && l.rotate === 0 && l.blur === 0 && clipCoversPage(l.clip)

const layerGone = (l: PageLayer): boolean =>
  l.opacity <= 0.001 || Math.abs(l.scaleX) <= 0.001 || Math.abs(l.scaleY) <= 0.001 || Math.abs(l.dx) >= 1 || Math.abs(l.dy) >= 1 || clipIsEmpty(l.clip)

describe('every page transition', () => {
  const presets = transitionPresets.list()

  it('ships at least 12', () => {
    expect(presets.length).toBeGreaterThanOrEqual(12)
  })

  for (const preset of presets) {
    const directions: (AnimDirection | undefined)[] = preset.directions ? [...preset.directions] : [undefined]
    for (const direction of directions) {
      for (const easing of ['linear', 'ease-in-out', 'spring', 'bounce'] as const) {
        it(`${preset.id} (${direction ?? 'no direction'}, ${easing}) starts on the old page and ends on the new one`, () => {
          const tr: Pick<PageTransition, 'preset' | 'easing' | 'direction'> = { preset: preset.id, easing, direction }
          const start = sampleTransition(tr, 0)
          const end = sampleTransition(tr, 1)
          // At the start the old page alone shows: it is at rest and either the new page is gone or the old one covers it.
          expect(layerRest(start.from)).toBe(true)
          expect(layerGone(start.to) || (!start.toOnTop && start.from.opacity === 1)).toBe(true)
          expect(start.veil).toBe(0)
          // At the end the new page alone shows.
          expect(layerRest(end.to)).toBe(true)
          expect(layerGone(end.from) || end.toOnTop || preset.id === 'none').toBe(true)
          expect(end.veil).toBe(0)
          for (let i = 0; i <= 40; i++) {
            const s = sampleTransition(tr, i / 40)
            for (const layer of [s.from, s.to]) {
              for (const v of [layer.opacity, layer.dx, layer.dy, layer.scaleX, layer.scaleY, layer.rotate, layer.blur]) expect(Number.isFinite(v)).toBe(true)
              expect(layer.opacity).toBeGreaterThanOrEqual(0)
              expect(layer.opacity).toBeLessThanOrEqual(1)
              expect(Math.abs(layer.dx)).toBeLessThanOrEqual(3)
              expect(Math.abs(layer.dy)).toBeLessThanOrEqual(3)
              expect(Math.abs(layer.rotate)).toBeLessThanOrEqual(360)
              expect(layer.blur).toBeLessThanOrEqual(0.2)
            }
            expect(s.veil).toBeGreaterThanOrEqual(0)
            expect(s.veil).toBeLessThanOrEqual(1)
            expect(sampleTransition(tr, i / 40)).toEqual(s)
          }
        })
      }
    }
  }

  it('plays a transition it does not know as none', () => {
    const s = sampleTransition({ preset: 'from-the-future', easing: 'linear' }, 0.5)
    expect(layerRest(s.from)).toBe(true)
  })

  it('a push moves both pages by the same amount and a cover moves only the new one', () => {
    const push = sampleTransition({ preset: 'push', easing: 'linear', direction: 'right' }, 0.25)
    expect(push.to.dx - push.from.dx).toBeCloseTo(1, 9)
    const cover = sampleTransition({ preset: 'cover', easing: 'linear', direction: 'right' }, 0.25)
    expect(cover.from.dx).toBe(0)
    expect(cover.to.dx).toBeCloseTo(0.75, 9)
    const uncover = sampleTransition({ preset: 'uncover', easing: 'linear', direction: 'right' }, 0.25)
    expect(uncover.to.dx).toBe(0)
    expect(uncover.from.dx).toBeCloseTo(-0.25, 9)
    expect(uncover.toOnTop).toBe(false)
  })

  it('goes the other way when the direction is reversed', () => {
    const a = sampleTransition({ preset: 'slide', easing: 'linear', direction: 'left' }, 0.5)
    const b = sampleTransition({ preset: 'slide', easing: 'linear', direction: 'right' }, 0.5)
    expect(a.to.dx).toBeCloseTo(-b.to.dx, 9)
  })

  it('dips to black between the two pages', () => {
    const tr = { preset: 'fade-black', easing: 'linear' as const }
    expect(sampleTransition(tr, 0.5).veil).toBe(1)
    expect(sampleTransition(tr, 0.25).veil).toBeCloseTo(0.5, 9)
    expect(sampleTransition(tr, 0.75).veil).toBeCloseTo(0.5, 9)
  })
})
