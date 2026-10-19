import type { DocObject, DoryDocument } from '@/types/document'
import { installImageStub } from '../test/imageStub'
import { frames, open, owner, seedDocument } from './engineTesting'
import { FakeCollabServer } from './fakeServer'

/** A page of 200 shapes, each with every property the editor serialises. */
async function crowdedDocument(): Promise<DoryDocument> {
  const base = await seedDocument()
  const template = base.pages[0].objects[0]
  const objects: DocObject[] = Array.from({ length: 200 }, (_, i) => ({ ...template, id: `crowd-${i}`, left: 40 + (i % 20) * 36, top: 40 + Math.floor(i / 20) * 52, width: 28, height: 40 }))
  return { ...base, pages: [{ ...base.pages[0], objects }] }
}

// Two editors and a server in one test take a moment on a busy machine.
vi.setConfig({ testTimeout: 30_000 })

describe('keeping up with other people', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub()
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['thumb'], { type: 'image/webp' })))
  })
  afterEach(() => {
    restore()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('takes twenty moves a second on a page of 200 objects by patching the one Fabric object', async () => {
    const doc = await crowdedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    const target = b.engine.viewOf(b.pageId)?.canvas.getObjects().find((o) => (o as { id?: string }).id === 'crowd-0')
    const applied = vi.spyOn(b.engine, 'applyRemoteDocument')
    a.engine.select(['crowd-0'])
    for (let i = 0; i < 40; i++) {
      a.engine.arrange.nudge(1, 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    await frames()
    expect(b.engine.state.doc.pages[0].objects[0].left).toBeCloseTo((doc.pages[0].objects[0].left as number) + 40, 5)
    // The same Fabric object, never rebuilt, and the other 199 objects keep their document references.
    expect(b.engine.viewOf(b.pageId)?.canvas.getObjects().find((o) => (o as { id?: string }).id === 'crowd-0')).toBe(target)
    expect(b.engine.state.doc.pages[0].objects.slice(1).every((o, i) => o === a.engine.state.doc.pages[0].objects[i + 1] || JSON.stringify(o) === JSON.stringify(a.engine.state.doc.pages[0].objects[i + 1]))).toBe(true)
    // Changes that follow each other within a frame travel together: at most one per 40 ms, never one per nudge more than twenty a second.
    expect(applied.mock.calls.length).toBeGreaterThan(10)
    expect(applied.mock.calls.length).toBeLessThanOrEqual(45)
    // How long each takes depends on the machine (a garbage collection of this whole test process lands in it): the budget is
    // measured in a real browser by e2e/collab/perf.spec.ts.
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('writes a local move of one object out of 200 as a handful of bytes, not a document', async () => {
    const doc = await crowdedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    await frames()
    const sizes: number[] = []
    a.session.ydoc.on('update', (update: Uint8Array) => sizes.push(update.byteLength))
    a.engine.select(['crowd-7'])
    a.engine.arrange.nudge(10, 0)
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toBeLessThan(200)
    a.session.destroy()
    a.engine.dispose()
  })
})
