import * as Y from 'yjs'
import type { DoryDocument } from '@/types/document'
import { DocBinding } from './binding'
import { withUniqueObjectIds } from './diff'
import { RESTORED_PAGE_ID, readDocument, rootsOf, writeDocument } from './schema'
import { docOf, page, shape } from './testing'

function bound(doc: DoryDocument, canWrite = true) {
  const ydoc = new Y.Doc()
  writeDocument(ydoc, doc)
  let shown = doc
  const invalid = vi.fn()
  const binding = new DocBinding(ydoc, {
    document: () => shown,
    saved: () => doc,
    apply: async (next) => {
      shown = next
    },
    persistInline: async (d) => d,
    onInvalid: invalid,
    onUploadFailed: () => undefined,
    beginUpload: () => undefined,
    canWrite: () => canWrite,
  })
  binding.synchronised()
  return { ydoc, binding, shown: () => shown, show: (d: DoryDocument) => (shown = d), invalid }
}

describe('a shared state that is not a design', () => {
  it('gets its size back from the writer who sees it, instead of leaving every window stuck', async () => {
    const doc = docOf([page([shape()])])
    const { ydoc, binding, shown } = bound(doc)
    ydoc.transact(() => ydoc.getMap('meta').set('width', 'abc'), 'remote')
    expect(readDocument(rootsOf(ydoc), null)).toBeNull()
    await binding.flush()
    expect(ydoc.getMap('meta').get('width')).toBe(doc.width)
    expect(shown().width).toBe(doc.width)
    binding.stop()
  })

  it('puts a blank page back when none is left, and both losses can be repaired in one go', async () => {
    const doc = docOf([page([shape()])])
    const { ydoc, binding, shown } = bound(doc)
    ydoc.transact(() => {
      ydoc.getMap('meta').delete('height')
      ydoc.getMap('pages').delete(doc.pages[0].id)
      ydoc.getArray('pageOrder').delete(0, 1)
    }, 'remote')
    await binding.flush()
    expect(shown().pages.map((p) => p.id)).toEqual([RESTORED_PAGE_ID])
    expect(shown().height).toBe(doc.height)
    binding.stop()
  })

  it('leaves it to a writer: a window that may only look repairs nothing', async () => {
    const doc = docOf([page([shape()])])
    const { ydoc, binding, shown } = bound(doc, false)
    ydoc.transact(() => ydoc.getMap('meta').set('width', 'abc'), 'remote')
    await binding.flush()
    expect(ydoc.getMap('meta').get('width')).toBe('abc')
    expect(shown().width).toBe(doc.width)
    binding.stop()
  })
})

describe('two objects of one page with one id', () => {
  it('is not something the shared state can hold: the later object gets an id of its own, in the shared state and in the editor', async () => {
    const one = shape({ id: 'one' })
    const doc = docOf([page([one, shape({ id: 'two' })])])
    const { ydoc, binding, shown, show } = bound(doc)
    // What ungrouping can do: the group's child is put on the page next to an object with the same id.
    const twin = { ...one, left: 400 }
    const next: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [...doc.pages[0].objects, twin] }] }
    show(next) // the editor takes the design it committed, then the binding corrects it
    binding.writeLocal(doc, next)
    await Promise.resolve()
    const ids = shown().pages[0].objects.map((o) => o.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(ids.slice(0, 2)).toEqual(['one', 'two'])
    expect(shown().pages[0].objects[2].left).toBe(400)
    expect(readDocument(rootsOf(ydoc), null)?.pages[0].objects.map((o) => o.id)).toEqual(ids)
    binding.stop()
  })

  it('leaves a design without such objects alone', () => {
    const doc = docOf([page([shape(), shape()])])
    const next: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: doc.pages[0].objects.slice().reverse() }] }
    expect(withUniqueObjectIds(doc, next)).toBe(next)
  })

  it('does not look at a page that did not change', () => {
    const broken = docOf([page([shape({ id: 'x' }), shape({ id: 'x' })])])
    expect(withUniqueObjectIds(broken, broken)).toBe(broken)
  })
})
