import type { DoryDocument } from '@/types/document'
import { installImageStub } from '../test/imageStub'
import { FakeCollabServer } from './fakeServer'
import { CollabSession } from './session'
import { byId, frames, live, move, objects, open, owner, seedDocument } from './engineTesting'
import { shape } from './testing'

// Two editors and a server in one test take a moment on a busy machine.
vi.setConfig({ testTimeout: 30_000 })

describe('CollabSession with two editors', () => {
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

  it('opens on the server copy without touching a document that already matches it', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    await frames()
    expect(a.session.store.getState()).toMatchObject({ status: 'live', synced: true, role: 'owner', canWrite: true })
    expect(a.engine.state.doc).toBe(a.opened)
    expect(a.engine.state.history.canUndo).toBe(false)
    a.session.destroy()
    a.engine.dispose()
  })

  it('tells the user when the design is full, and keeps trying', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, { ...owner('u1', 'Ada'), refuse: { code: 4429, reason: 'design_full' } }, doc)
    await frames()
    expect(a.session.store.getState()).toMatchObject({ status: 'busy', reason: 'design_full', notice: { tone: 'warning', title: 'This design is full' } })
    a.session.destroy()
    a.engine.dispose()
  })

  it('tells writers when the server cannot store the design, and stops telling them when it can again', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    await frames()
    expect(a.session.store.getState().notice).toBeNull()
    server.sockets.forEach((s) => s.deliver(JSON.stringify({ type: 'warning', code: 'document_invalid', message: 'invalid_document' })))
    await frames()
    expect(a.session.store.getState().notice).toMatchObject({ tone: 'warning', title: 'This design is not being saved' })
    // A reconnect carries the revision of the last save in `ready`; only a real save clears the notice.
    server.sockets.forEach((s) => s.deliver(JSON.stringify({ type: 'saved', revision: 4, at: new Date().toISOString() })))
    await frames()
    expect(a.session.store.getState().notice).toBeNull()
    a.session.destroy()
    a.engine.dispose()
  })

  it('does not offer to reset the design to how it was opened while others are editing it', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    await frames()
    move(a, 'rect-1', 5)
    expect(a.engine.state.doc).not.toBe(a.opened)
    expect(a.engine.canResetDesign).toBe(false)
    a.session.destroy()
    expect(a.engine.canResetDesign).toBe(true)
    a.engine.dispose()
  })

  it('shows the server copy when it is newer than the design the editor was opened with', async () => {
    const opened = await seedDocument()
    const newer: DoryDocument = { ...opened, pages: [{ ...opened.pages[0], objects: [...opened.pages[0].objects, shape({ id: 'extra', left: 5 })] }] }
    const server = new FakeCollabServer(newer)
    const a = await open(server, owner('u1', 'Ada'), opened)
    await frames()
    expect(objects(a).map((o) => o.id)).toEqual(['rect-1', 'rect-2', 'extra'])
    expect(live(a)).toHaveLength(3)
    a.session.destroy()
    a.engine.dispose()
  })

  it('shares edits both ways and updates the other canvas in place', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    const liveBefore = live(b).find((o) => (o as { id?: string }).id === 'rect-2')
    move(a, 'rect-2', 25)
    await frames()
    expect(byId(a, 'rect-2')?.left).toBe(325)
    expect(byId(b, 'rect-2')?.left).toBe(325)
    expect(live(b).find((o) => (o as { id?: string }).id === 'rect-2')).toBe(liveBefore)
    expect(liveBefore?.left).toBe(325)
    await a.engine.insert.shape('ellipse')
    await frames()
    expect(objects(b)).toHaveLength(3)
    expect(live(b)).toHaveLength(3)
    expect(b.engine.state.doc.pages[0].objects.map((o) => o.id)).toEqual(a.engine.state.doc.pages[0].objects.map((o) => o.id))
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('never saves over REST while the room is live, and the history is the room\'s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const doc = await seedDocument()
      const server = new FakeCollabServer(doc)
      const a = await open(server, owner('u1', 'Ada'), doc)
      await vi.advanceTimersByTimeAsync(200)
      move(a, 'rect-1', 5)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(a.handle.saves).toHaveLength(0)
      expect(a.engine.persistence.isDirty()).toBe(false)
      a.session.destroy()
      a.engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges concurrent edits of different objects and of different properties', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    move(a, 'rect-1', 10)
    b.engine.select(['rect-1'])
    b.engine.style.setOpacity(0.5)
    move(b, 'rect-2', -10)
    await frames()
    for (const peer of [a, b]) {
      expect(byId(peer, 'rect-1')).toMatchObject({ left: 110, opacity: 0.5 })
      expect(byId(peer, 'rect-2')?.left).toBe(290)
    }
    expect(JSON.stringify(a.engine.state.doc)).toBe(JSON.stringify(b.engine.state.doc))
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('undoes only the user\'s own changes', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    a.engine.sealHistory()
    move(a, 'rect-1', 40)
    await frames()
    b.engine.sealHistory()
    move(b, 'rect-2', 40)
    await frames()
    expect(byId(a, 'rect-2')?.left).toBe(340)
    expect(a.engine.state.history).toMatchObject({ canUndo: true, canRedo: false })
    await a.engine.undo()
    await frames()
    for (const peer of [a, b]) {
      expect(byId(peer, 'rect-1')?.left).toBe(100)
      expect(byId(peer, 'rect-2')?.left).toBe(340)
    }
    expect(a.engine.state.history).toMatchObject({ canUndo: false, canRedo: true })
    expect(b.engine.state.history.canRedo).toBe(false)
    await a.engine.redo()
    await frames()
    expect(byId(b, 'rect-1')?.left).toBe(140)
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('leaves the other person\'s value when both changed the same property, and still undoes the rest', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    a.engine.select(['rect-1'])
    a.engine.sealHistory()
    a.engine.arrange.nudge(10, 0)
    a.engine.style.setOpacity(0.3)
    await frames()
    b.engine.select(['rect-1'])
    b.engine.arrange.nudge(100, 0)
    await frames()
    expect(byId(a, 'rect-1')).toMatchObject({ left: 210, opacity: 0.3 })
    await a.engine.undo()
    await a.engine.undo()
    await frames()
    for (const peer of [a, b]) expect(byId(peer, 'rect-1')).toMatchObject({ left: 210, opacity: 1 })
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('groups bursts like the snapshot history does', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    await frames()
    a.engine.select(['rect-1'])
    a.engine.sealHistory()
    for (let i = 0; i < 6; i++) a.engine.arrange.nudge(1, 0)
    expect(byId(a, 'rect-1')?.left).toBe(106)
    await a.engine.undo()
    expect(byId(a, 'rect-1')?.left).toBe(100)
    expect(a.engine.state.history.canUndo).toBe(false)
    a.session.destroy()
    a.engine.dispose()
  })

  it('writes the edits made before the first sync on top of the server copy', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    move(a, 'rect-1', 7)
    await frames()
    expect(byId(a, 'rect-1')?.left).toBe(107)
    expect(server.doc.getMap('pages').size).toBe(1)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    expect(byId(b, 'rect-1')?.left).toBe(107)
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('shares what was edited before the room was joined, as a change from the design the server has', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    // An editor that has been saving over REST for a while: it edits first, and joins the room afterwards.
    const lone = await open(server, owner('u1', 'Ada'), doc)
    lone.session.destroy()
    expect(lone.engine.liveSession).toBeNull()
    move(lone, 'rect-1', 25)
    expect(byId(lone, 'rect-1')?.left).toBe(125)
    const realtime = { url: 'ws://test/', setTitle: null, requireSignIn: async () => false, flushRef: { current: null }, early: { room: null, start: () => undefined, release: () => undefined } }
    const rejoined = new CollabSession(lone.engine, realtime, { createSocket: server.socketFactory(owner('u1', 'Ada')), random: () => 0.5 })
    rejoined.start()
    const other = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    expect(byId(other, 'rect-1')?.left).toBe(125)
    expect(byId(lone, 'rect-1')?.left).toBe(125)
    rejoined.destroy()
    other.session.destroy()
    lone.engine.dispose()
    other.engine.dispose()
  })

  it('follows pages and objects that other people add and remove, keeping what the user has selected', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    b.engine.select(['rect-2'])
    a.engine.select(['rect-1'])
    a.engine.arrange.delete()
    await frames()
    expect(objects(b).map((o) => o.id)).toEqual(['rect-2'])
    expect(b.engine.state.selection.ids).toEqual(['rect-2'])
    a.engine.pages.add(1)
    await frames()
    expect(b.engine.state.doc.pages).toHaveLength(2)
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('shows a read-only role the live design and keeps it from editing', async () => {
    const doc = await seedDocument()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const v = await open(server, { user: { id: 'u3', name: 'Cy' }, role: 'view', token: 't' }, doc, { auth: { token: 't' } })
    await frames()
    expect(v.session.store.getState()).toMatchObject({ status: 'read-only', canWrite: false })
    expect(v.engine.readOnly).toBe(true)
    move(a, 'rect-1', 30)
    await frames()
    expect(byId(v, 'rect-1')?.left).toBe(130)
    for (const peer of [a, v]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('falls back to REST autosave when the server cannot be reached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const doc = await seedDocument()
      const server = new FakeCollabServer(doc)
      server.down = true
      const a = await open(server, owner('u1', 'Ada'), doc)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(a.session.store.getState().status).toBe('fallback')
      expect(a.engine.liveSession).toBeNull()
      a.engine.select(['rect-1'])
      a.engine.arrange.nudge(3, 0)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(a.handle.saves.length).toBeGreaterThan(0)
      a.engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
