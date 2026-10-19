import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { Anim, DocObject, DoryDocument, ObjectAnimation } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from '../engine/editor'
import { inPlaceChange, planPage } from '../engine/remoteSync'
import { PAGE_STYLES } from './pageStyles'

async function setup(options: { mode?: 'guest' | 'shared-view'; doc?: DoryDocument } = {}) {
  const doc = options.doc ?? createBlankDocument(800, 600)
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd1', title: 'Test', mode: options.mode ?? 'guest' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  return { engine, pageId, view }
}

const objects = (engine: EditorEngine): DocObject[] => engine.state.doc.pages[0].objects
const animationOfFirst = (engine: EditorEngine): ObjectAnimation | undefined => objects(engine)[0]?.animation as ObjectAnimation | undefined

const enterFade: Anim = { preset: 'fade', durationMs: 600, delayMs: 0, easing: 'ease-out' }

describe('AnimationApi', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['thumb'], { type: 'image/webp' })))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('puts a preset on the selected object with the preset’s own settings, as one undo step', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    expect(animationOfFirst(engine)).toBeUndefined()
    engine.animation.setPreset('enter', 'rise')
    expect(animationOfFirst(engine)).toEqual({ enter: { preset: 'rise', durationMs: 700, delayMs: 0, easing: 'ease-out' } })
    expect(engine.state.history.undoLabel).toBe('Add enter animation')
    await engine.undo()
    expect(animationOfFirst(engine)).toBeUndefined()
    await engine.redo()
    expect(animationOfFirst(engine)?.enter?.preset).toBe('rise')
    engine.dispose()
  })

  it('keeps the selection and the object when an animation is set (nothing is rebuilt)', async () => {
    const { engine, view } = await setup()
    await engine.insert.shape('rect')
    const live = view.canvas.getObjects()[0]
    const ids = engine.state.selection.ids
    engine.animation.setPreset('enter', 'fade')
    expect(view.canvas.getObjects()[0]).toBe(live)
    expect(engine.state.selection.ids).toEqual(ids)
    expect(engine.state.selection.objects[0].animation).toEqual({ enter: expect.objectContaining({ preset: 'fade' }) })
    engine.dispose()
  })

  it('changing the preset keeps the delay and takes the new preset’s duration and direction', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    engine.animation.setPreset('enter', 'slide')
    engine.animation.patch('enter', { delayMs: 900, direction: 'down' })
    engine.animation.setPreset('enter', 'wipe')
    expect(animationOfFirst(engine)?.enter).toEqual({ preset: 'wipe', durationMs: 700, delayMs: 900, easing: 'ease-in-out', direction: 'down' })
    engine.animation.setPreset('enter', 'fade')
    expect(animationOfFirst(engine)?.enter).not.toHaveProperty('direction')
    expect(engine.state.history.undoLabel).toBe('Change animation')
    engine.dispose()
  })

  it('places an exit so that it ends with the page and an emphasis after the enter', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    engine.animation.setPreset('enter', 'fade')
    engine.animation.setPreset('emphasis', 'pulse')
    engine.animation.setPreset('exit', 'fade')
    const a = animationOfFirst(engine)
    expect(a?.emphasis?.delayMs).toBe(600)
    // The page holds for 5 s once it has built up (600 ms): the exit ends at 5.6 s.
    expect(a?.exit?.delayMs).toBe(600 + 5000 - 600)
    engine.dispose()
  })

  it('limits what is written and coalesces a drag into one undo step', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    engine.animation.setPreset('enter', 'fade')
    const depth = engine.history.depth
    for (const ms of [200, 300, 400, 99_999]) engine.animation.patch('enter', { durationMs: ms }, undefined, 'anim:test')
    expect(animationOfFirst(engine)?.enter?.durationMs).toBe(10_000)
    expect(engine.history.depth).toBe(depth + 1)
    engine.animation.patch('enter', { delayMs: -50, intensity: 7 })
    expect(animationOfFirst(engine)?.enter).toMatchObject({ delayMs: 0, intensity: 1 })
    // Fade has no direction and may step through text units; an enter never loops.
    engine.animation.patch('enter', { direction: 'left', by: 'word', loop: true })
    expect(animationOfFirst(engine)?.enter).not.toHaveProperty('direction')
    expect(animationOfFirst(engine)?.enter).toHaveProperty('by', 'word')
    expect(animationOfFirst(engine)?.enter).not.toHaveProperty('loop')
    // Slide has no text units.
    engine.animation.setPreset('enter', 'slide')
    engine.animation.patch('enter', { by: 'letter', direction: 'up' })
    expect(animationOfFirst(engine)?.enter).not.toHaveProperty('by')
    expect(animationOfFirst(engine)?.enter).toHaveProperty('direction', 'up')
    engine.dispose()
  })

  it('removes a slot, then the whole property when nothing is left', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    engine.animation.setPreset('enter', 'fade')
    engine.animation.setPreset('exit', 'fade')
    engine.animation.remove('enter')
    expect(Object.keys(animationOfFirst(engine) ?? {})).toEqual(['exit'])
    engine.animation.remove('exit')
    expect(objects(engine)[0]).not.toHaveProperty('animation')
    engine.dispose()
  })

  it('animates every selected object', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    await engine.insert.shape('ellipse')
    engine.selectAll()
    engine.animation.setPreset('enter', 'pop')
    expect(objects(engine).map((o) => (o.animation as ObjectAnimation).enter?.preset)).toEqual(['pop', 'pop'])
    engine.animation.removeAll()
    expect(objects(engine).every((o) => !('animation' in o))).toBe(true)
    engine.dispose()
  })

  it('ignores presets that are not registered and numbers that are not numbers', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    engine.animation.setPreset('enter', 'no-such-preset')
    expect(animationOfFirst(engine)).toBeUndefined()
    engine.animation.setPreset('enter', 'fade')
    engine.animation.patch('enter', { durationMs: Number.NaN })
    expect(animationOfFirst(engine)?.enter?.durationMs).toBe(600)
    engine.dispose()
  })

  it('animates the whole page in a style, in reading order, leaving locked objects alone', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    engine.arrange.setPosition(500, 400)
    await engine.insert.shape('ellipse')
    engine.arrange.setPosition(100, 50)
    await engine.insert.shape('triangle')
    engine.arrange.setPosition(100, 300)
    engine.arrange.toggleLock()
    engine.animation.applyPageStyle('rise')
    const [rect, ellipse, triangle] = objects(engine)
    expect(triangle.animation).toBeUndefined()
    const delay = (o: DocObject): number => (o.animation as ObjectAnimation).enter?.delayMs ?? -1
    expect(delay(ellipse)).toBe(0)
    expect(delay(rect)).toBeGreaterThan(0)
    expect((ellipse.animation as ObjectAnimation).enter?.preset).toBe('rise')
    expect(engine.state.history.undoLabel).toBe('Animate page')
    await engine.undo()
    expect(objects(engine).every((o) => !('animation' in o))).toBe(true)
    engine.dispose()
  })

  it.each(PAGE_STYLES.map((s) => s.id))('page style %s only writes valid animations', async (id) => {
    const { engine } = await setup()
    for (const kind of ['rect', 'ellipse'] as const) await engine.insert.shape(kind)
    await engine.insert.text('heading')
    engine.animation.applyPageStyle(id)
    for (const o of objects(engine)) {
      const enter = (o.animation as ObjectAnimation).enter
      expect(enter).toBeDefined()
      expect(enter?.durationMs).toBeGreaterThanOrEqual(100)
      expect(enter?.delayMs).toBeGreaterThanOrEqual(0)
    }
    engine.dispose()
  })

  it('clears the page', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    await engine.insert.shape('ellipse')
    engine.animation.applyPageStyle('fade')
    engine.animation.clearPage()
    expect(objects(engine).every((o) => !('animation' in o))).toBe(true)
    engine.dispose()
  })

  it('does nothing in a view-only editor', async () => {
    const doc = createBlankDocument(800, 600)
    doc.pages[0].objects.push({ id: 'o1', type: 'rect', left: 100, top: 100, width: 50, height: 50, fill: '#ff0000' })
    const { engine, view } = await setup({ mode: 'shared-view', doc })
    view.canvas.setActiveObject(view.canvas.getObjects()[0])
    engine.animation.setPreset('enter', 'fade', ['o1'])
    engine.animation.applyPageStyle('fade')
    expect(objects(engine)[0].animation).toBeUndefined()
    engine.pages.setTransition(engine.state.doc.pages[0].id, { preset: 'fade', durationMs: 700, easing: 'linear' })
    expect(engine.state.doc.pages[0].transition).toBeUndefined()
    engine.dispose()
  })

  it('copies the animation with a duplicate', async () => {
    const { engine } = await setup()
    await engine.insert.shape('rect')
    engine.animation.setPreset('enter', 'pop')
    await engine.arrange.duplicate()
    expect(objects(engine)).toHaveLength(2)
    expect((objects(engine)[1].animation as ObjectAnimation).enter?.preset).toBe('pop')
    expect(objects(engine)[1].id).not.toBe(objects(engine)[0].id)
    engine.dispose()
  })

  it('opens a document with animation and writes it back as it was, unknown presets included', async () => {
    const doc = createBlankDocument(800, 600)
    const odd = { enter: { preset: 'from-the-future', durationMs: 123, delayMs: 45, easing: 'spring', direction: 'up' } }
    doc.pages[0].objects.push(
      { id: 'o1', type: 'rect', left: 100, top: 100, width: 50, height: 50, fill: '#ff0000', animation: { enter: enterFade, emphasis: { preset: 'pulse', durationMs: 800, delayMs: 700, easing: 'ease-in-out', loop: true, intensity: 0.3 } } },
      { id: 'o2', type: 'rect', left: 300, top: 100, width: 50, height: 50, fill: '#00ff00', animation: odd },
    )
    const { engine, view } = await setup({ doc })
    await engine.animation.patch('enter', { delayMs: 100 }, ['o1'])
    expect(objects(engine)[0].animation).toEqual({ enter: { ...enterFade, delayMs: 100 }, emphasis: { preset: 'pulse', durationMs: 800, delayMs: 700, easing: 'ease-in-out', loop: true, intensity: 0.3 } })
    expect(objects(engine)[1].animation).toEqual(odd)
    expect(view.canvas.getObjects()).toHaveLength(2)
    engine.dispose()
  })
})

describe('page transitions', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sets, changes and removes the transition of a page, clamping the duration', async () => {
    const { engine, pageId } = await setup()
    engine.pages.setTransition(pageId, { preset: 'push', durationMs: 50, easing: 'ease-in-out', direction: 'left' })
    expect(engine.state.doc.pages[0].transition).toEqual({ preset: 'push', durationMs: 200, easing: 'ease-in-out', direction: 'left' })
    expect(engine.state.history.undoLabel).toBe('Set page transition')
    engine.pages.setTransition(pageId, { preset: 'push', durationMs: 99_000, easing: 'linear' })
    expect(engine.state.doc.pages[0].transition?.durationMs).toBe(3000)
    engine.pages.setTransition(pageId, null)
    expect(engine.state.doc.pages[0]).not.toHaveProperty('transition')
    await engine.undo()
    expect(engine.state.doc.pages[0].transition?.preset).toBe('push')
    engine.dispose()
  })

  it('says when the transition of a page is set or removed, not when only its duration changes', async () => {
    const { engine, pageId } = await setup()
    engine.pages.setTransition(pageId, { preset: 'push', durationMs: 700, easing: 'ease-in-out', direction: 'left' })
    expect(engine.state.announcement).toBe('Page transition: Push')
    engine.announce('')
    engine.pages.setTransition(pageId, { preset: 'push', durationMs: 900, easing: 'ease-in-out', direction: 'left' })
    expect(engine.state.announcement).toBe('')
    engine.pages.setTransition(pageId, null)
    expect(engine.state.announcement).toBe('Page transition removed')
    engine.dispose()
  })

  it('ignores a transition without a usable preset', async () => {
    const { engine, pageId } = await setup()
    engine.pages.setTransition(pageId, { preset: 'Not Valid!', durationMs: 700, easing: 'linear' })
    expect(engine.state.doc.pages[0].transition).toBeUndefined()
    engine.dispose()
  })

  it('applies one transition to every page in one step, and clears them', async () => {
    const doc = createBlankDocument(800, 600)
    doc.pages.push({ ...doc.pages[0], id: 'second', objects: [] }, { ...doc.pages[0], id: 'third', objects: [] })
    const { engine } = await setup({ doc })
    engine.pages.setTransitionAll({ preset: 'fade', durationMs: 700, easing: 'ease-in-out' })
    expect(engine.state.doc.pages.map((p) => p.transition?.preset)).toEqual(['fade', 'fade', 'fade'])
    await engine.undo()
    expect(engine.state.doc.pages.map((p) => p.transition)).toEqual([undefined, undefined, undefined])
    await engine.redo()
    engine.pages.setTransitionAll(null)
    expect(engine.state.doc.pages.every((p) => !('transition' in p))).toBe(true)
    engine.dispose()
  })

  it('keeps unchanged pages by reference', async () => {
    const { engine, pageId } = await setup()
    const before = engine.state.doc
    engine.pages.setTransition(pageId, null)
    expect(engine.state.doc).toBe(before)
    engine.dispose()
  })
})

describe('changes from elsewhere', () => {
  const base: DocObject = { id: 'a', type: 'rect', left: 1, top: 2, width: 3, height: 4 }
  const withAnimation = { ...base, animation: { enter: enterFade } }

  it('takes an added, changed or removed animation in place, without rebuilding the object', () => {
    expect(inPlaceChange(base, withAnimation)).toEqual(['animation'])
    expect(inPlaceChange(withAnimation, { ...withAnimation, animation: { enter: { ...enterFade, delayMs: 5 } } })).toEqual(['animation'])
    expect(inPlaceChange(withAnimation, base)).toEqual(['animation'])
    expect(inPlaceChange(base, { ...withAnimation, left: 9 })).toEqual(expect.arrayContaining(['animation', 'left']))
    expect(inPlaceChange(base, { ...withAnimation, fill: '#000000' })).toBeNull()
  })

  it('plans such a change as a patch', () => {
    const page = { id: 'p', background: { type: 'solid' as const, color: '#fff' }, objects: [base] }
    const plan = planPage(page, { ...page, objects: [withAnimation] }, new Set(), new Set(['a']))
    expect(plan.patched).toHaveLength(1)
    expect(plan.build).toHaveLength(0)
  })
})
