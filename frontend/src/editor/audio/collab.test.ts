/**
 * The audio tracks of a design travel through the real-time binding like any other document-level list: `audioTracks`
 * is one JSON property of the document, so the generic binding carries it as a whole and `collab/` has no code for it.
 * Two editors on the in-memory server prove that an added track, a change, a removal and an undo reach the other
 * editor, and document what the whole-list model means for two people who change tracks at the same moment (the last
 * writer's list wins; nothing is merged inside the list).
 */
import { createBlankDocument } from '@/lib/document'
import type { RealtimeConnection } from '@/types/adapter'
import type { DoryDocument } from '@/types/document'
import { type ConnectionPlan, FakeCollabServer, settle } from '../collab/fakeServer'
import { CollabSession } from '../collab/session'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from '../engine/editor'
import { installImageStub } from '../test/imageStub'

const owner = (id: string, name: string): ConnectionPlan => ({ user: { id, name }, role: 'owner' })

function document1(): DoryDocument {
  const doc = createBlankDocument(800, 600)
  return { ...doc, pages: [{ ...doc.pages[0], id: 'page-1', objects: [] }, { ...doc.pages[0], id: 'page-2', objects: [] }] }
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

const input = (name: string) => ({ kind: 'music' as const, name, src: '/media/audio/music/a-aaaaaaaaaaaa.ogg', durationMs: 30_000 })

describe('audio in a live room', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub()
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['thumb'], { type: 'image/webp' })))
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:http://localhost/audio' }))
  })
  afterEach(() => {
    restore()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('shares a track, a change to it, its removal, and the undo of that', async () => {
    const doc = document1()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()

    const track = a.engine.audio.add(input('Theme'))
    await frames()
    expect(b.engine.audio.tracks().map((t) => t.name)).toEqual(['Theme'])
    expect(b.engine.audio.tracks()[0]).toEqual(track)

    b.engine.audio.update(track!.id, { volume: 0.25, trimEndMs: 20_000 })
    await frames()
    a.engine.audio.setScope(track!.id, { type: 'page', pageId: 'page-2' })
    await frames()
    expect(a.engine.audio.get(track!.id)).toMatchObject({ volume: 0.25, trimEndMs: 20_000, scope: { type: 'page', pageId: 'page-2' } })
    expect(b.engine.audio.get(track!.id)).toEqual(a.engine.audio.get(track!.id))

    b.engine.audio.remove(track!.id)
    await frames()
    expect(a.engine.audio.tracks()).toEqual([])
    await b.engine.undo()
    await frames()
    expect(a.engine.audio.get(track!.id)).toMatchObject({ name: 'Theme' })
  })

  it('shares several tracks, in order', async () => {
    const doc = document1()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    a.engine.audio.add(input('One'))
    a.engine.audio.add(input('Two'))
    await frames()
    expect(b.engine.state.doc.audioTracks?.map((t) => t.name)).toEqual(['One', 'Two'])
  })

  it('takes the last writer’s whole list when two people change tracks at the same time', async () => {
    const doc = document1()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    const first = a.engine.audio.add(input('Shared'))
    await frames()
    expect(b.engine.audio.get(first!.id)).toBeDefined()

    // Both edit before either hears the other: Ada adds a track, Bo changes the volume of the one that exists.
    a.engine.audio.add(input('Ada’s second'))
    b.engine.audio.setVolume(first!.id, 0.1)
    await frames()
    const left = a.engine.audio.tracks()
    const right = b.engine.audio.tracks()
    // Whatever the order, both editors end up on the same list, and it is one of the two writers' lists, not a mix.
    expect(left).toEqual(right)
    const names = left.map((t) => t.name)
    expect([['Shared', 'Ada’s second'], ['Shared']]).toContainEqual(names)
  })
})
