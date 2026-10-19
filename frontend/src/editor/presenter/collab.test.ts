/**
 * Notes and page times travel through the real-time binding like any other page property: there is no code for them
 * in `collab/`, the generic property diff carries them. Two editors on the in-memory server prove it.
 */
import { createBlankDocument } from '@/lib/document'
import type { RealtimeConnection } from '@/types/adapter'
import type { DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from '../engine/editor'
import { type ConnectionPlan, FakeCollabServer, settle } from '../collab/fakeServer'
import { CollabSession } from '../collab/session'
import { installImageStub } from '../test/imageStub'

const owner = (id: string, name: string): ConnectionPlan => ({ user: { id, name }, role: 'owner' })

function twoPageDocument(): DoryDocument {
  const doc = createBlankDocument(800, 600)
  return { ...doc, pages: [{ ...doc.pages[0], id: 'page-1' }, { ...doc.pages[0], id: 'page-2', objects: [] }] }
}

async function open(server: FakeCollabServer, plan: ConnectionPlan, doc: DoryDocument) {
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd1', title: 'Design', mode: 'account' }, ephemeral: true })
  engine.start()
  engine.persistence.start({})
  const host = document.createElement('div')
  document.body.appendChild(host)
  engine.mountPage('page-1', host)
  const view = await engine.whenView('page-1')
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  const realtime: RealtimeConnection = { url: 'ws://test/', setTitle: async () => undefined, requireSignIn: async () => false, flushRef: { current: null }, early: { room: null, start: () => undefined, release: () => undefined } }
  const session = new CollabSession(engine, realtime, { createSocket: server.socketFactory(plan), random: () => 0.5 })
  session.start()
  return { engine, session }
}

async function frames(): Promise<void> {
  await settle(4)
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await settle(4)
}

describe('page notes and times in a live room', () => {
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

  it('shares notes, one page time, all page times and their removal', async () => {
    const doc = twoPageDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()

    a.engine.pages.setNotes('page-2', 'Mention the launch date')
    a.engine.pages.setDuration('page-1', 9)
    await frames()
    expect(b.engine.state.doc.pages[1].notes).toBe('Mention the launch date')
    expect(b.engine.state.doc.pages[0].durationSec).toBe(9)
    expect(b.engine.state.doc.pages[1].durationSec).toBeUndefined()

    b.engine.pages.setDurationAll(4)
    await frames()
    expect(a.engine.state.doc.pages.map((p) => p.durationSec)).toEqual([4, 4])

    a.engine.pages.setNotes('page-2', '')
    b.engine.pages.setDurationAll(null)
    await frames()
    for (const peer of [a, b]) {
      expect('notes' in peer.engine.state.doc.pages[1]).toBe(false)
      expect(peer.engine.state.doc.pages.some((p) => 'durationSec' in p)).toBe(false)
    }
    expect(JSON.stringify(a.engine.state.doc)).toBe(JSON.stringify(b.engine.state.doc))

    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('keeps edits of different properties of one page: A writes notes while B sets the time', async () => {
    const doc = twoPageDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    a.engine.pages.setNotes('page-1', 'Opening remarks')
    b.engine.pages.setDuration('page-1', 20)
    await frames()
    for (const peer of [a, b]) expect(peer.engine.state.doc.pages[0]).toMatchObject({ notes: 'Opening remarks', durationSec: 20 })
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })
})
