import type { DocObject, DocPage } from '@/types/document'
import { changedKeys, inPlaceChange, mergeObject, planPage } from './remoteSync'

const obj = (id: string, extra: Record<string, unknown> = {}): DocObject => ({ id, type: 'rect', left: 10, top: 20, width: 30, height: 40, fill: '#e11d48', ...extra })
const page = (objects: DocObject[]): DocPage => ({ id: 'p', background: { type: 'solid', color: '#ffffff' }, objects })

describe('in-place changes', () => {
  it('lists the properties that differ', () => {
    expect(changedKeys(obj('a'), obj('a', { left: 11, extra: { x: 1 } })).sort()).toEqual(['extra', 'left'])
    expect(changedKeys(obj('a'), obj('a'))).toEqual([])
  })

  it('takes position, rotation, scale, flip, skew and opacity in place, nothing else', () => {
    expect(inPlaceChange(obj('a'), obj('a', { left: 99, angle: 15, opacity: 0.4 }))).toEqual(expect.arrayContaining(['left', 'angle', 'opacity']))
    expect(inPlaceChange(obj('a'), obj('a', { fill: '#000000' }))).toBeNull()
    expect(inPlaceChange(obj('a'), obj('a', { left: 5, fill: '#000000' }))).toBeNull()
    expect(inPlaceChange(obj('a'), obj('a', { width: 31 }))).toBeNull()
    expect(inPlaceChange(obj('a'), obj('a', { type: 'ellipse', left: 3 }))).toBeNull()
    expect(inPlaceChange(obj('a'), obj('a'))).toBeNull()
  })

  it('does not set in place a property that was removed', () => {
    const next = obj('a')
    delete next.fill
    expect(inPlaceChange(obj('a', { opacity: 0.5 }), { ...next })).toBeNull()
  })
})

describe('three-way merge', () => {
  const base = obj('a', { text: 'Hi', fontSize: 40 })

  it('keeps what the user changed and takes everything else from elsewhere', () => {
    const local = { ...base, text: 'Hello' }
    const remote = { ...base, fill: '#000000', fontSize: 52 }
    expect(mergeObject(base, local, remote)).toEqual({ ...base, text: 'Hello', fill: '#000000', fontSize: 52 })
  })

  it('lets the user win a property both changed', () => {
    expect(mergeObject(base, { ...base, fontSize: 20 }, { ...base, fontSize: 90 }).fontSize).toBe(20)
  })

  it('follows a property that was removed elsewhere when the user left it alone, and a user removal too', () => {
    const remote = { ...base }
    delete remote.fontSize
    expect(mergeObject(base, base, remote)).not.toHaveProperty('fontSize')
    const local = { ...base }
    delete local.text
    expect(mergeObject(base, local, base)).not.toHaveProperty('text')
  })

  it('returns the remote object itself when nothing of the user is left', () => {
    const remote = { ...base, fill: '#111111' }
    expect(mergeObject(base, base, remote)).toBe(remote)
  })
})

describe('planPage', () => {
  const [a, b, c] = [obj('a'), obj('b'), obj('c')]
  const all = new Set(['a', 'b', 'c'])

  it('has nothing to do for the same page', () => {
    const plan = planPage(page([a, b, c]), page([a, b, c]), new Set(), all)
    expect(plan).toEqual({ removed: [], build: [], patched: [], deferred: [], orderChanged: false })
  })

  it('sorts additions, removals, in-place changes and rebuilds', () => {
    const moved = { ...b, left: 77 }
    const recoloured = { ...c, fill: '#111111' }
    const added = obj('d')
    const plan = planPage(page([a, b, c]), page([moved, recoloured, added]), new Set(), all)
    expect(plan.removed).toEqual(['a'])
    expect(plan.patched).toEqual([{ id: 'b', keys: ['left'], next: moved }])
    expect(plan.build).toEqual([recoloured, added])
    expect(plan.deferred).toEqual([])
  })

  it('holds back changes to what the user is busy with, but never additions', () => {
    const edited = { ...a, text: 'x' }
    const plan = planPage(page([a, b]), page([edited, b, obj('n')]), new Set(['a', 'n']), new Set(['a', 'b']))
    expect(plan.deferred).toEqual([edited])
    expect(plan.build.map((o) => o.id)).toEqual(['n'])
  })

  it('notices a re-ordering and an object the canvas lost', () => {
    expect(planPage(page([a, b, c]), page([c, a, b]), new Set(), all).orderChanged).toBe(true)
    const plan = planPage(page([a, b]), page([a, b]), new Set(), new Set(['a']))
    expect(plan.build).toEqual([b])
  })
})
