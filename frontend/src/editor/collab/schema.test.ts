import * as Y from 'yjs'
import type { DocObject, DocPage, DoryDocument } from '@/types/document'
import { writeChanges, syncOrder, hasUnshareableSource } from './diff'
import { jsonEqual, toJson } from '../engine/json'
import { type Dirty, collectPageEvents, emptyDirty, readDocument, rootsOf, writeDocument, orderedIds, ROOT_PAGES } from './schema'
import { Random, docOf, exchange, page, relay, shape } from './testing'

/** What a peer would see after reading the Y state, as JSON (so `undefined` values do not matter). */
const plainDoc = (d: DoryDocument | null) => JSON.parse(JSON.stringify(d)) as unknown

function seeded(doc: DoryDocument): { ydoc: Y.Doc; read: () => DoryDocument | null } {
  const ydoc = new Y.Doc()
  writeDocument(ydoc, doc)
  const roots = rootsOf(ydoc)
  return { ydoc, read: () => readDocument(roots, null) }
}

describe('toJson / jsonEqual', () => {
  it('keeps what JSON keeps and drops the rest', () => {
    expect(toJson({ a: 1, b: undefined, c: [undefined, NaN, Infinity], d: () => 1, e: { f: -0 } })).toEqual({ a: 1, c: [null, null, null], e: { f: 0 } })
    expect(toJson(Number.NaN)).toBeUndefined()
    expect(toJson(undefined)).toBeUndefined()
    expect(toJson(null)).toBeNull()
  })

  it('does not follow cycles forever', () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => toJson(loop)).not.toThrow()
  })

  it('compares structurally and ignores key order and undefined values', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(jsonEqual({ a: null }, {})).toBe(false)
    expect(jsonEqual(0, -0)).toBe(true)
  })
})

describe('Y document schema', () => {
  it('round-trips a document with several pages, groups and unknown properties', () => {
    const group = shape({ type: 'group', objects: [shape({ type: 'circle' }), shape({ type: 'rect', future: { deep: [1, 2, { x: 'y' }] } })] })
    const doc = docOf([page([shape(), group, shape({ type: 'textbox', text: 'Grüße 🎨', styles: [{ start: 0, end: 2, style: { fill: '#000000' } }] })], { name: 'Intro', notes: 'speaker', durationSec: 4, guides: [{ orientation: 'vertical', pos: 12 }], futureProp: { a: [true, null] } }), page([])], {
      meta: { presetId: 'a4', bleedPx: 12 },
      futureDocProp: 'kept',
    })
    const { read } = seeded(doc)
    expect(plainDoc(read())).toEqual(plainDoc(doc))
  })

  it('reads nothing before the server state has arrived', () => {
    expect(readDocument(rootsOf(new Y.Doc()), null)).toBeNull()
  })

  it('refuses a document of another schema or without a usable size', () => {
    const wrongSchema = new Y.Doc()
    writeDocument(wrongSchema, { ...docOf([page()]), schemaVersion: 2 as never })
    expect(readDocument(rootsOf(wrongSchema), null)).toBeNull()
    const noSize = new Y.Doc()
    writeDocument(noSize, { ...docOf([page()]), width: 0 })
    expect(readDocument(rootsOf(noSize), null)).toBeNull()
  })

  it('applies the reading rules of the z-order: first occurrence wins, dangling ids and unlisted entries are ignored', () => {
    const a = shape()
    const b = shape()
    const doc = docOf([page([a, b])])
    const { ydoc } = seeded(doc)
    const roots = rootsOf(ydoc)
    const pageMap = roots.pages.get(doc.pages[0].id) as Y.Map<unknown>
    const order = pageMap.get('objectOrder') as Y.Array<string>
    const objects = pageMap.get('objects') as Y.Map<unknown>
    order.insert(2, [a.id, 'ghost'])
    objects.set('unlisted', new Y.Map())
    const read = readDocument(roots, null) as DoryDocument
    expect(read.pages[0].objects.map((o) => o.id)).toEqual([a.id, b.id])
    expect(orderedIds(order, objects)).toEqual([a.id, b.id])
  })

  it('lets the map key win over a stored id', () => {
    const o = shape()
    const doc = docOf([page([o])])
    const { ydoc } = seeded(doc)
    const roots = rootsOf(ydoc)
    const pageMap = roots.pages.get(doc.pages[0].id) as Y.Map<unknown>
    ;((pageMap.get('objects') as Y.Map<Y.Map<unknown>>).get(o.id) as Y.Map<unknown>).set('id', 'different')
    expect((readDocument(roots, null) as DoryDocument).pages[0].objects[0].id).toBe(o.id)
  })

  it('shares every reference with the previous document when nothing changed', () => {
    const doc = docOf([page([shape(), shape({ shadow: { blur: 4, color: '#000000' } })]), page([shape()])])
    const { ydoc } = seeded(doc)
    const roots = rootsOf(ydoc)
    const first = readDocument(roots, null) as DoryDocument
    const again = readDocument(roots, first, null) as DoryDocument
    expect(again).toBe(first)
    const asRead = JSON.parse(JSON.stringify(doc)) as DoryDocument
    const reused = readDocument(roots, asRead) as DoryDocument
    expect(reused).toBe(asRead)
    expect(reused.pages[0].objects[1]).toBe(asRead.pages[0].objects[1])
  })

  it('reads incrementally: only the objects the events touched are new references', () => {
    const objs = [shape(), shape(), shape()]
    const doc = docOf([page(objs), page([shape()])])
    const { ydoc } = seeded(doc)
    const roots = rootsOf(ydoc)
    const first = readDocument(roots, null) as DoryDocument
    const dirty: Dirty = emptyDirty()
    const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => collectPageEvents(dirty, events, roots.pages)
    roots.pages.observeDeep(handler)
    ydoc.transact(() => {
      const pageMap = roots.pages.get(doc.pages[0].id) as Y.Map<unknown>
      ;((pageMap.get('objects') as Y.Map<Y.Map<unknown>>).get(objs[1].id) as Y.Map<unknown>).set('left', 999)
    }, 'remote')
    const next = readDocument(roots, first, dirty) as DoryDocument
    expect(next).not.toBe(first)
    expect(next.pages[1]).toBe(first.pages[1])
    expect(next.pages[0].objects[0]).toBe(first.pages[0].objects[0])
    expect(next.pages[0].objects[2]).toBe(first.pages[0].objects[2])
    expect(next.pages[0].objects[1].left).toBe(999)
    expect(next.pages[0].background).toBe(first.pages[0].background)
  })
})

describe('writeChanges', () => {
  function edit(from: DoryDocument, to: DoryDocument, ydoc: Y.Doc): void {
    ydoc.transact(() => writeChanges(rootsOf(ydoc), from, to), 'local')
  }

  it('writes only the properties that changed', () => {
    const o = shape()
    const doc = docOf([page([o, shape()])])
    const { ydoc, read } = seeded(doc)
    const updates: Uint8Array[] = []
    ydoc.on('update', (u: Uint8Array) => updates.push(u))
    const next = { ...doc, pages: [{ ...doc.pages[0], objects: [{ ...o, left: 5 }, doc.pages[0].objects[1]] }] }
    edit(doc, next, ydoc)
    expect(updates).toHaveLength(1)
    expect(plainDoc(read())).toEqual(plainDoc(next))
    const after = new Y.Doc()
    Y.applyUpdate(after, updates[0])
    expect(Y.decodeUpdate(updates[0]).structs).toHaveLength(1)
  })

  it('writes nothing for an identical document', () => {
    const doc = docOf([page([shape()])])
    const { ydoc } = seeded(doc)
    let count = 0
    ydoc.on('update', () => (count += 1))
    edit(doc, JSON.parse(JSON.stringify(doc)) as DoryDocument, ydoc)
    expect(count).toBe(0)
  })

  it('adds, removes, re-orders objects and pages, and renames properties', () => {
    const [a, b, c] = [shape(), shape(), shape()]
    const doc = docOf([page([a, b, c]), page([])])
    const { ydoc, read } = seeded(doc)
    const d = shape({ type: 'ellipse' })
    const p0: DocPage = { ...doc.pages[0], name: 'Cover', objects: [c, d, a] }
    const p2 = page([shape()])
    const next: DoryDocument = { ...doc, width: 900, pages: [doc.pages[1], p0, p2] }
    edit(doc, next, ydoc)
    expect(plainDoc(read())).toEqual(plainDoc(next))
    const removed: DoryDocument = { ...next, pages: [p0], meta: { presetId: 'x' } }
    edit(next, removed, ydoc)
    expect(plainDoc(read())).toEqual(plainDoc(removed))
    const stripped: DocObject = { ...c }
    delete stripped.fill
    const unset: DoryDocument = { ...removed, pages: [{ ...p0, objects: [stripped, d, a] }] }
    edit(removed, unset, ydoc)
    expect(plainDoc(read())).toEqual(plainDoc(unset))
  })

  it('does not bring back an object another user deleted, nor revert a property it has not yet seen', () => {
    const [a, b] = [shape(), shape()]
    const doc = docOf([page([a, b])])
    const mine = seeded(doc).ydoc
    const theirs = new Y.Doc()
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine))
    const theirRoots = rootsOf(theirs)
    const pid = doc.pages[0].id
    theirs.transact(() => {
      const pageMap = theirRoots.pages.get(pid) as Y.Map<unknown>
      ;(pageMap.get('objects') as Y.Map<unknown>).delete(a.id)
      const order = pageMap.get('objectOrder') as Y.Array<string>
      order.delete(order.toArray().indexOf(a.id), 1)
      ;((pageMap.get('objects') as Y.Map<Y.Map<unknown>>).get(b.id) as Y.Map<unknown>).set('left', 777)
    })
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs))
    // The editor has not applied their update yet: it edits a (deleted remotely) and b's colour from its old document.
    const local: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [{ ...a, left: 1 }, { ...b, fill: '#000000' }] }] }
    edit(doc, local, mine)
    const read = readDocument(rootsOf(mine), null) as DoryDocument
    expect(read.pages[0].objects.map((o) => o.id)).toEqual([b.id])
    expect(read.pages[0].objects[0].left).toBe(777)
    expect(read.pages[0].objects[0].fill).toBe('#000000')
  })

  it('keeps objects added by others when it re-orders', () => {
    const [a, b] = [shape(), shape()]
    const doc = docOf([page([a, b])])
    const mine = seeded(doc).ydoc
    const roots = rootsOf(mine)
    const pageMap = roots.pages.get(doc.pages[0].id) as Y.Map<unknown>
    const stranger = shape()
    mine.transact(() => {
      ;(pageMap.get('objects') as Y.Map<Y.Map<unknown>>).set(stranger.id, new Y.Map(Object.entries(stranger)))
      ;(pageMap.get('objectOrder') as Y.Array<string>).push([stranger.id])
    })
    edit(doc, { ...doc, pages: [{ ...doc.pages[0], objects: [b, a] }] }, mine)
    const read = readDocument(roots, null) as DoryDocument
    expect(new Set(read.pages[0].objects.map((o) => o.id))).toEqual(new Set([a.id, b.id, stranger.id]))
    expect(read.pages[0].objects.map((o) => o.id).indexOf(b.id)).toBeLessThan(read.pages[0].objects.map((o) => o.id).indexOf(a.id))
  })

  it('holds back objects that still reference local-only images', () => {
    const doc = docOf([page([shape()])])
    const { ydoc, read } = seeded(doc)
    const image = shape({ type: 'image', src: 'blob:http://x/1' })
    const next: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [...doc.pages[0].objects, image] }] }
    const held = new Set<string>()
    ydoc.transact(() => writeChanges(rootsOf(ydoc), doc, next, held))
    expect([...held]).toEqual([image.id])
    expect((read() as DoryDocument).pages[0].objects).toHaveLength(1)
    const durable = { ...image, src: '/media/a.png' }
    const settled: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [...doc.pages[0].objects, durable] }] }
    ydoc.transact(() => writeChanges(rootsOf(ydoc), next, settled, held))
    expect(held.size).toBe(0)
    expect((read() as DoryDocument).pages[0].objects.map((o) => o.src)).toEqual([undefined, '/media/a.png'])
  })

  it('recognises sources the server would refuse', () => {
    expect(hasUnshareableSource({ src: 'blob:x' })).toBe(true)
    expect(hasUnshareableSource({ nested: [{ src: `data:image/png;base64,${'A'.repeat(70_000)}` }] })).toBe(true)
    expect(hasUnshareableSource({ src: 'data:image/png;base64,AAAA' })).toBe(false)
    expect(hasUnshareableSource({ src: '/media/x.png' })).toBe(false)
  })

  it('never stores values JSON cannot express', () => {
    const doc = docOf([page([shape()])])
    const { ydoc, read } = seeded(doc)
    const o = doc.pages[0].objects[0]
    const next = { ...doc, pages: [{ ...doc.pages[0], objects: [{ ...o, left: Number.NaN, top: undefined, extra: { a: undefined, b: Number.POSITIVE_INFINITY } }] }] }
    edit(doc, next, ydoc)
    const read1 = (read() as DoryDocument).pages[0].objects[0]
    expect('left' in read1).toBe(false)
    expect('top' in read1).toBe(false)
    expect(read1.extra).toEqual({ b: null })
  })
})

describe('syncOrder', () => {
  const run = (initial: string[], target: string[], known: string[]): string[] => {
    const ydoc = new Y.Doc()
    const array = ydoc.getArray<string>('o')
    array.insert(0, initial)
    syncOrder(array, target, new Set(known))
    return array.toArray()
  }

  it('produces the target for any permutation, insertion and deletion', () => {
    const random = new Random(7)
    for (let round = 0; round < 200; round++) {
      const universe = Array.from({ length: 12 }, (_, i) => `id${i}`)
      const initial = universe.filter(() => random.bool())
      const target = universe.filter(() => random.bool())
      for (let i = target.length - 1; i > 0; i--) {
        const j = random.int(i + 1)
        ;[target[i], target[j]] = [target[j], target[i]]
      }
      expect(run(initial, target, initial)).toEqual(target)
    }
  })

  it('uses a single move for one re-ordered id', () => {
    const ydoc = new Y.Doc()
    const array = ydoc.getArray<string>('o')
    array.insert(0, ['a', 'b', 'c', 'd', 'e'])
    const updates: Uint8Array[] = []
    ydoc.on('update', (u: Uint8Array) => updates.push(u))
    ydoc.transact(() => syncOrder(array, ['a', 'c', 'd', 'e', 'b'], new Set(['a', 'b', 'c', 'd', 'e'])))
    expect(array.toArray()).toEqual(['a', 'c', 'd', 'e', 'b'])
    expect(updates).toHaveLength(1)
  })

  it('removes duplicates and leaves ids nobody knows', () => {
    expect(run(['a', 'x', 'b', 'a', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'x', 'b', 'c'])
  })
})

describe('arbitrary properties and concurrent editing', () => {
  /** A random edit of a document: touches any property of the document, a page and objects, with random JSON. */
  function mutate(doc: DoryDocument, random: Random): DoryDocument {
    const pages = doc.pages.slice()
    const index = random.int(pages.length)
    const target = pages[index]
    const name = random.pick(['alpha', 'beta', 'left', 'top', 'fill', 'animation', 'notes', 'durationSec', 'x-future'])
    switch (random.int(7)) {
      case 0: {
        const objects = target.objects.slice()
        if (objects.length > 0) {
          const i = random.int(objects.length)
          objects[i] = { ...objects[i], [name]: random.json() }
        }
        pages[index] = { ...target, objects }
        break
      }
      case 1:
        pages[index] = { ...target, objects: [...target.objects, shape({ [name]: random.json(), type: random.pick(['rect', 'textbox', 'future-kind']) })] }
        break
      case 2:
        pages[index] = { ...target, objects: target.objects.filter(() => random.int(4) !== 0) }
        break
      case 3: {
        const objects = target.objects.slice().reverse()
        pages[index] = { ...target, objects }
        break
      }
      case 4:
        pages[index] = { ...target, [name === 'left' || name === 'top' ? 'name' : name]: random.json() } as DocPage
        break
      case 5:
        pages.splice(random.int(pages.length + 1), 0, page([shape({ [name]: random.json() })]))
        break
      default:
        if (pages.length > 1) pages.splice(index, 1)
        return { ...doc, pages, [random.pick(['unit', 'meta', 'futureDoc'])]: random.pick(['px', { presetId: 'a4' }, 'mm', [1, 2]]) } as DoryDocument
    }
    return { ...doc, pages }
  }

  it('syncs any sequence of edits with arbitrary property names and values to a second client', () => {
    const random = new Random(42)
    for (let run = 0; run < 25; run++) {
      let doc = docOf([page([shape(), shape()]), page([shape()])])
      const { ydoc } = seeded(doc)
      const peer = new Y.Doc()
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc))
      const detach = relay(ydoc, peer)
      for (let step = 0; step < 30; step++) {
        const next = mutate(doc, random)
        ydoc.transact(() => writeChanges(rootsOf(ydoc), doc, next), 'local')
        doc = JSON.parse(JSON.stringify(next)) as DoryDocument
        const mine = readDocument(rootsOf(ydoc), null) as DoryDocument
        const theirs = readDocument(rootsOf(peer), null) as DoryDocument
        expect(plainDoc(mine)).toEqual(plainDoc(doc))
        expect(plainDoc(theirs)).toEqual(plainDoc(doc))
      }
      detach()
    }
  })

  it('merges concurrent edits of different properties and agrees on the same property', () => {
    const o = shape()
    const base = docOf([page([o, shape()])])
    const left = seeded(base).ydoc
    const right = new Y.Doc()
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    const withObject = (props: Record<string, unknown>): DoryDocument => ({ ...base, pages: [{ ...base.pages[0], objects: [{ ...o, ...props }, base.pages[0].objects[1]] }] })
    left.transact(() => writeChanges(rootsOf(left), base, withObject({ left: 10, fill: '#111111' })), 'local')
    right.transact(() => writeChanges(rootsOf(right), base, withObject({ top: 20, fill: '#222222' })), 'local')
    exchange(left, right)
    const a = readDocument(rootsOf(left), null) as DoryDocument
    const b = readDocument(rootsOf(right), null) as DoryDocument
    expect(plainDoc(a)).toEqual(plainDoc(b))
    expect(a.pages[0].objects[0]).toMatchObject({ left: 10, top: 20 })
    expect(['#111111', '#222222']).toContain(a.pages[0].objects[0].fill)
  })

  it('converges when one client deletes an object the other edits', () => {
    const [a, b] = [shape(), shape()]
    const base = docOf([page([a, b])])
    const left = seeded(base).ydoc
    const right = new Y.Doc()
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    const without: DoryDocument = { ...base, pages: [{ ...base.pages[0], objects: [b] }] }
    const edited: DoryDocument = { ...base, pages: [{ ...base.pages[0], objects: [{ ...a, left: 3 }, b] }] }
    left.transact(() => writeChanges(rootsOf(left), base, without), 'local')
    right.transact(() => writeChanges(rootsOf(right), base, edited), 'local')
    exchange(left, right)
    const read = (y: Y.Doc) => readDocument(rootsOf(y), null) as DoryDocument
    expect(plainDoc(read(left))).toEqual(plainDoc(read(right)))
    expect(read(left).pages[0].objects.map((o) => o.id)).toEqual([b.id])
  })

  it('observes page events with the keys the binding relies on', () => {
    const doc = docOf([page([shape()])])
    const { ydoc } = seeded(doc)
    const seen: string[] = []
    ydoc.getMap(ROOT_PAGES).observeDeep((events) => events.forEach((e) => seen.push(e.path.join('/'))))
    const o = doc.pages[0].objects[0]
    ydoc.transact(() => writeChanges(rootsOf(ydoc), doc, { ...doc, pages: [{ ...doc.pages[0], name: 'N', objects: [{ ...o, left: 1 }] }] }))
    expect(seen.sort()).toEqual([`${doc.pages[0].id}`, `${doc.pages[0].id}/objects/${o.id}`].sort())
  })
})
