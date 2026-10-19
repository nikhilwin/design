import { createBlankDocument } from '@/lib/document'
import type { DocObject, DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorEngine } from '../editor'
import { getPageSize } from '../pageSizes'

const rect = (id: string, left: number, top: number): DocObject => ({ id, type: 'rect', left, top, width: 100, height: 50, scaleX: 1, scaleY: 1, originX: 'center', originY: 'center' })

function engineFor(doc: DoryDocument, mode: 'guest' | 'shared-view' = 'guest') {
  const handle = createMemoryAdapter()
  return new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd', title: 'T', mode }, ephemeral: true })
}

function threePages() {
  const engine = engineFor(createBlankDocument(1000, 1000))
  engine.pages.add(1, { width: 500, height: 800 })
  engine.pages.add(2, { width: 336, height: 192 })
  return engine
}

const sizes = (engine: EditorEngine) => engine.state.doc.pages.map((p) => getPageSize(engine.state.doc, p.id))

describe('PagesApi: pages of different sizes', () => {
  it('add(index, size) makes a page of that size and leaves the others alone', () => {
    const engine = threePages()
    expect(sizes(engine)).toEqual([
      { width: 1000, height: 1000 },
      { width: 500, height: 800 },
      { width: 336, height: 192 },
    ])
    expect(engine.state.activePageId).toBe(engine.state.doc.pages[2].id)
    expect(engine.state.doc.pages[0].width).toBeUndefined()
    engine.dispose()
  })

  it('add() without a size copies the size of the page before the new one', () => {
    const engine = threePages()
    engine.pages.add(2)
    expect(sizes(engine)[2]).toEqual({ width: 500, height: 800 })
    engine.pages.add(0)
    expect(sizes(engine)[0]).toEqual({ width: 1000, height: 1000 })
    engine.dispose()
  })

  it('a size out of range is clamped and one that is not a number falls back to the neighbour', () => {
    const engine = engineFor(createBlankDocument(300, 300))
    engine.pages.add(1, { width: 999_999, height: 0 })
    expect(sizes(engine)[1]).toEqual({ width: 20_000, height: 1 })
    engine.pages.add(2, { width: Number.NaN, height: 10 })
    expect(sizes(engine)[2]).toEqual({ width: 20_000, height: 1 })
    engine.dispose()
  })

  it('setSize resizes one page, maps only its content and is one undo step', () => {
    const engine = engineFor(createBlankDocument(1000, 1000))
    const [first] = engine.state.doc.pages
    engine.applyDocument({ ...engine.state.doc, pages: [{ ...first, objects: [rect('a', 500, 500)] }] }, { label: 'seed' })
    engine.pages.add(1)
    const second = engine.state.doc.pages[1]
    engine.applyDocument({ ...engine.state.doc, pages: [engine.state.doc.pages[0], { ...second, objects: [rect('b', 500, 500)] }] }, { label: 'seed' })
    engine.pages.setSize(second.id, 500, 500, 'scale')
    expect(sizes(engine)).toEqual([
      { width: 1000, height: 1000 },
      { width: 500, height: 500 },
    ])
    expect(engine.state.doc.pages[0].objects[0].left).toBe(500)
    expect(engine.state.doc.pages[1].objects[0].left).toBeCloseTo(250)
    expect(engine.state.history.undoLabel).toBe('Resize page')
    return engine.undo().then(() => {
      expect(sizes(engine)[1]).toEqual({ width: 1000, height: 1000 })
      expect(engine.state.doc.pages[1].objects[0].left).toBe(500)
      engine.dispose()
    })
  })

  it('resize(w, h, mode) still resizes every page, and clears the sizes of a mixed design', () => {
    const engine = threePages()
    engine.pages.resize(400, 300, 'keep')
    expect(sizes(engine)).toEqual([1, 2, 3].map(() => ({ width: 400, height: 300 })))
    expect(engine.state.doc.pages.every((p) => p.width === undefined)).toBe(true)
    expect(engine.state.history.undoLabel).toBe('Resize design')
    engine.dispose()
  })

  it('resize with scope page defaults to the active page', () => {
    const engine = threePages()
    engine.pages.resize(600, 600, 'keep', { scope: 'page' })
    expect(sizes(engine).map((s) => s.width)).toEqual([1000, 500, 600])
    engine.dispose()
  })

  it('resizing the first page moves the document size and not the other pages', () => {
    const engine = threePages()
    const first = engine.state.doc.pages[0].id
    engine.pages.setSize(first, 640, 480, 'keep')
    expect(engine.state.doc).toMatchObject({ width: 640, height: 480 })
    expect(sizes(engine)).toEqual([
      { width: 640, height: 480 },
      { width: 500, height: 800 },
      { width: 336, height: 192 },
    ])
    engine.dispose()
  })

  it('a preset is dropped from the document when the first page changes size', () => {
    const engine = engineFor({ ...createBlankDocument(1080, 1080), meta: { presetId: 'instagram-post' } })
    engine.pages.add(1)
    engine.pages.setSize(engine.state.doc.pages[1].id, 300, 300, 'keep')
    expect(engine.state.doc.meta?.presetId).toBe('instagram-post')
    engine.pages.setSize(engine.state.doc.pages[0].id, 900, 900, 'keep')
    expect(engine.state.doc.meta?.presetId).toBeUndefined()
    engine.dispose()
  })

  it('removing or moving pages keeps every page’s size and the document size follows the first page', () => {
    const engine = threePages()
    const ids = engine.state.doc.pages.map((p) => p.id)
    engine.pages.move(ids[2], 0)
    expect(engine.state.doc).toMatchObject({ width: 336, height: 192 })
    expect(sizes(engine)).toEqual([
      { width: 336, height: 192 },
      { width: 1000, height: 1000 },
      { width: 500, height: 800 },
    ])
    engine.pages.remove(ids[2])
    expect(engine.state.doc).toMatchObject({ width: 1000, height: 1000 })
    expect(sizes(engine)).toEqual([
      { width: 1000, height: 1000 },
      { width: 500, height: 800 },
    ])
    engine.dispose()
  })

  it('duplicating a page copies its size', () => {
    const engine = threePages()
    engine.pages.duplicate(engine.state.doc.pages[1].id)
    expect(sizes(engine)[2]).toEqual({ width: 500, height: 800 })
    engine.dispose()
  })

  it('ignores unusable input and read-only editors', () => {
    const engine = threePages()
    const before = engine.state.doc
    engine.pages.resize(Number.NaN, 10, 'keep')
    engine.pages.setSize('nope', 10, 10, 'keep')
    engine.pages.resize(Number.POSITIVE_INFINITY, 10, 'keep', { scope: 'page' })
    expect(engine.state.doc).toBe(before)
    engine.dispose()
    const viewer = engineFor(createBlankDocument(100, 100), 'shared-view')
    const viewerDoc = viewer.state.doc
    viewer.pages.resize(200, 200, 'keep')
    expect(viewer.state.doc).toBe(viewerDoc)
    viewer.dispose()
  })

  it('pageSizeOf answers per page', () => {
    const engine = threePages()
    expect(engine.pageSizeOf(engine.state.doc.pages[1].id)).toEqual({ width: 500, height: 800 })
    expect(engine.pageSizeOf('nope')).toEqual({ width: 1000, height: 1000 })
    engine.dispose()
  })
})

describe('ViewApi: where a page is on screen', () => {
  function withWorkspace(engine: EditorEngine, rects: Record<string, { left: number; top: number; width: number; height: number }>) {
    engine.setViewportController({
      scrollToPage: () => undefined,
      viewportSize: () => ({ width: 1000, height: 800 }),
      relayout: () => undefined,
      artboardRect: (id) => rects[id] ?? null,
    })
  }

  it('gives each page its own rectangle, zoom and size', () => {
    const engine = threePages()
    const [a, b, c] = engine.state.doc.pages.map((p) => p.id)
    engine.store.setState({ zoom: 0.5 })
    withWorkspace(engine, {
      [a]: { left: 100, top: 40, width: 500, height: 500 },
      [b]: { left: 175, top: 600, width: 250, height: 400 },
      [c]: { left: 266, top: 1060, width: 168, height: 96 },
    })
    expect(engine.view.pageRect(b)).toEqual({ pageId: b, left: 175, top: 600, width: 250, height: 400, zoom: 0.5, pageWidth: 500, pageHeight: 800 })
    expect(engine.view.pageRect('nope')).toBeNull()
    // The same client point is a different page point on different pages.
    expect(engine.view.clientToPage(a, 350, 290)).toEqual({ x: 500, y: 500 })
    expect(engine.view.clientToPage(c, 350, 1108)).toEqual({ x: 168, y: 96 })
    expect(engine.view.pageToClient(b, 500, 800)).toEqual({ x: 425, y: 1000 })
    expect(engine.view.pageAt(300, 100)).toBe(a)
    expect(engine.view.pageAt(300, 700)).toBe(b)
    expect(engine.view.pageAt(350, 1100)).toBe(c)
    expect(engine.view.pageAt(5, 5)).toBeNull()
    engine.dispose()
  })

  it('answers null without a workspace', () => {
    const engine = threePages()
    expect(engine.view.pageRect(engine.state.doc.pages[0].id)).toBeNull()
    expect(engine.view.clientToPage(engine.state.doc.pages[0].id, 1, 1)).toBeNull()
    engine.dispose()
  })

  it('fit page fits the active page, fit width the widest page', () => {
    const engine = threePages()
    engine.setViewportController({ scrollToPage: () => undefined, viewportSize: () => ({ width: 1096, height: 2048 }), relayout: () => undefined, artboardRect: () => null })
    engine.view.fit('fit-width')
    expect(engine.state.zoom).toBeCloseTo(1, 2)
    engine.setActivePage(engine.state.doc.pages[2].id)
    engine.setViewportController({ scrollToPage: () => undefined, viewportSize: () => ({ width: 596, height: 248 }), relayout: () => undefined, artboardRect: () => null })
    engine.view.fit('fit-width')
    // The widest page is 1000 px: 500 px of room gives 0.5, whichever page is active.
    expect(engine.state.zoom).toBeCloseTo(0.5, 2)
    engine.view.fit('fit-page')
    // The active page is the 336 x 192 card: 152 px of height gives 0.79, below 100 %.
    expect(engine.state.zoom).toBeCloseTo(152 / 192, 2)
    engine.dispose()
  })
})
