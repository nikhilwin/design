import { describe, expect, it, vi } from 'vitest'
import type { Anim, DocObject, DocPage, DoryDocument, PageTransition } from '@/types/document'
import type { FrameRenderer } from '../animation/frameRenderer'
import { MotionCache, REDUCED_TRANSITION, motionDurations, planMotion, transitionBetween } from './motion'

const anim = (preset: string, over: Partial<Anim> = {}): Anim => ({ preset, durationMs: 1000, delayMs: 0, easing: 'linear', ...over })
const obj = (id: string, animation?: DocObject['animation']): DocObject => ({ id, type: 'rect', left: 0, top: 0, width: 10, height: 10, ...(animation ? { animation } : {}) })
const page = (id: string, objects: DocObject[] = [], transition?: PageTransition): DocPage => ({ id, background: { type: 'solid', color: '#fff' }, objects, ...(transition ? { transition } : {}) })
const push: PageTransition = { preset: 'push', durationMs: 800, easing: 'linear', direction: 'right' }

const deck = (): DoryDocument => ({
  schemaVersion: 1,
  width: 100,
  height: 100,
  unit: 'px',
  pages: [page('a', [obj('x', { enter: anim('fade', { durationMs: 1500 }) })]), page('b', [obj('y')], push), page('c', [], { preset: 'from-the-future', durationMs: 500, easing: 'linear' })],
})

describe('planMotion', () => {
  it('collects each page, its transition and its timing', () => {
    const plan = planMotion(deck(), false)
    expect(plan.moves).toBe(true)
    expect(plan.pages.map((p) => p.transition?.preset ?? null)).toEqual([null, 'push', null])
    expect(plan.pages[0].timing.introMs).toBe(1500)
    expect(plan.pages[1].timing.spans).toEqual([])
  })

  it('says a design without motion has none, so the plain slideshow is used', () => {
    expect(planMotion({ pages: [page('a', [obj('x')]), page('b')] }, false).moves).toBe(false)
  })

  it('plays a transition it does not know as none', () => {
    expect(planMotion(deck(), false).pages[2].transition).toBeNull()
  })

  it('under reduced motion drops every object animation and fades instead of any transition', () => {
    const plan = planMotion(deck(), true)
    expect(plan.pages[0].page.objects[0]).not.toHaveProperty('animation')
    expect(plan.pages[0].timing.introMs).toBe(0)
    expect(plan.pages[1].transition).toEqual(REDUCED_TRANSITION)
    expect(plan.pages[2].transition).toBeNull()
    expect(plan.moves).toBe(true)
  })

  it('leaves the document alone', () => {
    const doc = deck()
    const before = JSON.stringify(doc)
    planMotion(doc, true)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('keeps pages without animation by reference', () => {
    const doc = deck()
    expect(planMotion(doc, true).pages[1].page).toBe(doc.pages[1])
  })
})

describe('transitionBetween', () => {
  const plan = planMotion(deck(), false)

  it('is the incoming page’s own transition', () => {
    expect(transitionBetween(plan, 0, 1)).toEqual(push)
  })

  it('plays it the other way round when going back', () => {
    expect(transitionBetween(plan, 2, 1)).toEqual({ ...push, direction: 'left' })
    expect(transitionBetween(plan, 2, 1, true)).toEqual(push)
  })

  it('uses the preset’s own direction when the transition has none', () => {
    const p = planMotion({ pages: [page('a'), page('b', [], { preset: 'slide', durationMs: 500, easing: 'linear' })] }, false)
    expect(transitionBetween(p, 2 as never, 1)).toEqual({ preset: 'slide', durationMs: 500, easing: 'linear', direction: 'left' })
  })

  it('has none for the first page shown, for staying, or for a page without one', () => {
    expect(transitionBetween(plan, null, 1)).toBeNull()
    expect(transitionBetween(plan, 1, 1)).toBeNull()
    expect(transitionBetween(plan, 1, 0)).toBeNull()
    expect(transitionBetween(plan, 0, 9)).toBeNull()
  })

  it('never turns the reduced-motion fade around', () => {
    const reduced = planMotion(deck(), true)
    expect(transitionBetween(reduced, 2, 1)).toEqual(REDUCED_TRANSITION)
  })
})

describe('motionDurations', () => {
  it('adds the transition and the build-up to the time of a page', () => {
    const plan = planMotion(deck(), false)
    expect(motionDurations([5, 5, 5], plan)).toEqual([6.5, 5.8, 5])
  })

  it('leaves a page that waits for the presenter waiting', () => {
    expect(motionDurations([null, 5, null], planMotion(deck(), false))).toEqual([null, 5.8, null])
  })

  it('adds nothing but the fade under reduced motion', () => {
    expect(motionDurations([5, 5, 5], planMotion(deck(), true))).toEqual([5, 5.25, 5])
  })

  it('stays inside what a page time may be', () => {
    expect(motionDurations([600], planMotion({ pages: [page('a', [], push)] }, false))).toEqual([600])
  })
})

describe('MotionCache', () => {
  function renderer(): FrameRenderer {
    return { page: { width: 100, height: 100 }, width: 100, height: 100, canvas: document.createElement('canvas'), timing: { spans: [], introMs: 0, endMs: 0, loops: false }, render: vi.fn(), dispose: vi.fn() } as unknown as FrameRenderer
  }
  const make = () => vi.fn(async (): Promise<FrameRenderer> => renderer())
  const size = () => ({ width: 100, height: 100 })

  it('prepares a page once, however often and however concurrently it is asked for', async () => {
    const m = make()
    const cache = new MotionCache(m, size)
    const p = page('a')
    const [one, two] = await Promise.all([cache.get(p, 200), cache.get(p, 200)])
    expect(one).toBe(two)
    expect(await cache.get(p, 200)).toBe(one)
    expect(m).toHaveBeenCalledTimes(1)
    expect(m).toHaveBeenCalledWith(p, 2)
  })

  it('prepares again for another width or an edited page', async () => {
    const m = make()
    const cache = new MotionCache(m, size)
    const p = page('a')
    await cache.get(p, 200)
    await cache.get(p, 300)
    await cache.get({ ...p }, 200)
    expect(m).toHaveBeenCalledTimes(3)
  })

  it('drops the least recently used, but never the page on screen, and frees what it drops', async () => {
    const cache = new MotionCache(make(), size, 2)
    const [a, b, c] = [page('a'), page('b'), page('c')]
    const ra = await cache.get(a, 100)
    cache.keep(a, 100)
    const rb = await cache.get(b, 100)
    await cache.get(c, 100)
    expect(cache.peek(a, 100)).toBe(ra)
    expect(cache.peek(b, 100)).toBeNull()
    expect(rb.dispose).toHaveBeenCalled()
    expect(ra.dispose).not.toHaveBeenCalled()
  })

  it('forgets everything when the stage changes size, freeing it, and does not keep a preparation that was still running', async () => {
    let finish: (r: FrameRenderer) => void = () => undefined
    const slow = vi.fn(() => new Promise<FrameRenderer>((r) => (finish = r)))
    const cache = new MotionCache(slow, size)
    const p = page('a')
    const pending = cache.get(p, 100)
    cache.clear()
    const late = renderer()
    finish(late)
    await pending
    expect(cache.peek(p, 100)).toBeNull()
    expect(late.dispose).toHaveBeenCalled()
  })

  it('passes a failure on to the caller and does not keep it', async () => {
    const failing = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValue(renderer())
    const cache = new MotionCache(failing, size)
    await expect(cache.get(page('a'), 100)).rejects.toThrow('no')
    await expect(cache.get(page('a'), 100)).resolves.toBeDefined()
    cache.prefetch(undefined, 100)
    cache.prefetch(page('z'), 100)
  })
})
