import { IText, Rect } from 'fabric'
import type { DocObject, DoryDocument } from '@/types/document'
import { installImageStub } from '../test/imageStub'
import { asDory } from '../engine/objects/dory'
import { type Peer, byId, frames, live, objects, open, owner, seedDocument } from './engineTesting'
import { FakeCollabServer, settle } from './fakeServer'

async function pair(doc?: DoryDocument): Promise<{ server: FakeCollabServer; a: Peer; b: Peer; doc: DoryDocument }> {
  const seed = doc ?? (await seedDocument())
  const server = new FakeCollabServer(seed)
  const a = await open(server, owner('u1', 'Ada'), seed)
  const b = await open(server, owner('u2', 'Bo'), seed)
  await frames()
  return { server, a, b, doc: seed }
}

function end(...peers: Peer[]): void {
  for (const peer of peers) {
    peer.session.destroy()
    peer.engine.dispose()
  }
}

const liveObject = (peer: Peer, id: string) => live(peer).find((o) => (o as { id?: string }).id === id)

// Two editors and a server in one test take a moment on a busy machine.
vi.setConfig({ testTimeout: 30_000 })

describe('changes from other people reach the canvas without disturbing the user', () => {
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

  it('keeps the user\'s selection and its Fabric object when somebody moves another object', async () => {
    const { a, b } = await pair()
    b.engine.select(['rect-1'])
    const selected = b.engine.activeView()?.canvas.getActiveObject()
    a.engine.select(['rect-2'])
    a.engine.arrange.nudge(20, 0)
    await frames()
    expect(byId(b, 'rect-2')?.left).toBe(320)
    expect(b.engine.activeView()?.canvas.getActiveObject()).toBe(selected)
    expect(b.engine.state.selection.ids).toEqual(['rect-1'])
    end(a, b)
  })

  it('takes a move of the selected object in place, and follows a change it must rebuild', async () => {
    const { a, b } = await pair()
    b.engine.select(['rect-1'])
    const before = liveObject(b, 'rect-1')
    a.engine.select(['rect-1'])
    a.engine.arrange.nudge(10, 0)
    await frames()
    expect(liveObject(b, 'rect-1')).toBe(before)
    expect(before?.left).toBe(110)
    expect(b.engine.state.selection.ids).toEqual(['rect-1'])
    const bounds = b.engine.state.selection.bounds
    expect(Math.abs((bounds?.x ?? 0) + (bounds?.width ?? 0) / 2 - 110)).toBeLessThan(2)

    a.engine.style.setFill({ type: 'solid', color: '#00ff00' })
    await frames()
    const rebuilt = liveObject(b, 'rect-1')
    expect(rebuilt).not.toBe(before)
    expect(b.engine.activeView()?.canvas.getActiveObject()).toBe(rebuilt)
    expect(b.engine.state.selection.ids).toEqual(['rect-1'])
    expect(b.engine.state.selection.objects[0].fill).toBe('#00ff00')
    end(a, b)
  })

  it('updates the toolbar\'s view of the selected object when somebody else restyles it', async () => {
    const { a, b } = await pair()
    b.engine.select(['rect-2'])
    a.engine.select(['rect-2'])
    a.engine.style.setOpacity(0.25)
    await frames()
    expect(b.engine.state.selection.objects[0].opacity).toBe(0.25)
    end(a, b)
  })

  it('keeps a multi-selection together while one of its members is moved by somebody else', async () => {
    const { a, b } = await pair()
    b.engine.select(['rect-1', 'rect-2'])
    a.engine.select(['rect-1'])
    a.engine.arrange.nudge(5, 0)
    await frames()
    expect(b.engine.state.selection.ids.sort()).toEqual(['rect-1', 'rect-2'])
    expect(byId(b, 'rect-1')?.left).toBe(105)
    end(a, b)
  })

  it('clears the selection of an object somebody else deleted', async () => {
    const { a, b } = await pair()
    b.engine.select(['rect-2'])
    a.engine.select(['rect-2'])
    a.engine.arrange.delete()
    await frames()
    expect(objects(b).map((o) => o.id)).toEqual(['rect-1'])
    expect(b.engine.state.selection.ids).toEqual([])
    end(a, b)
  })

  it('holds back a change to a text being typed in and merges it when the user is done', async () => {
    const { a, b } = await pair()
    await a.engine.insert.text('heading')
    await frames()
    const id = objects(a).find((o) => o.type === 'textbox' || o.type === 'itext')?.id ?? ''
    expect(id).not.toBe('')
    const typing = liveObject(a, id) as IText
    expect(typing.isEditing).toBe(true)
    const colour = '#0000ff'
    b.engine.select([id])
    b.engine.style.text({ fill: { type: 'solid', color: colour } })
    await frames()
    // Bo's change is in the shared state and in Ada's document, but the text she is typing in stays as it is.
    expect(byId(a, id)?.fill).toBe(colour)
    expect(typing.fill).not.toBe(colour)
    expect(liveObject(a, id)).toBe(typing)
    expect(typing.isEditing).toBe(true)
    // She types: the change is hers, the colour stays Bo's.
    typing.insertChars('X', undefined, 0)
    typing.exitEditing()
    await frames()
    for (const peer of [a, b]) {
      expect(byId(peer, id)?.fill).toBe(colour)
      expect(String(byId(peer, id)?.text)).toContain('X')
    }
    expect((liveObject(a, id) as IText).fill).toBe(colour)
    end(a, b)
  })

  it('does not send the other person\'s old version back when the user commits during a catch-up', async () => {
    const { a, b } = await pair()
    a.engine.select(['rect-2'])
    b.engine.select(['rect-1'])
    // Bo moves rect-2 away; before his canvas has caught up, Ada edits rect-1.
    a.engine.arrange.nudge(50, 0)
    b.engine.arrange.nudge(7, 0)
    await frames()
    for (const peer of [a, b]) {
      expect(byId(peer, 'rect-1')?.left).toBe(107)
      expect(byId(peer, 'rect-2')?.left).toBe(350)
    }
    end(a, b)
  })

  it('shows pages, backgrounds and the document size that others change', async () => {
    const { a, b } = await pair()
    a.engine.pages.add(1)
    await frames()
    expect(b.engine.state.doc.pages).toHaveLength(2)
    a.engine.pages.setBackground(a.pageId, { type: 'solid', color: '#112233' })
    await frames()
    expect(b.engine.state.doc.pages[0].background).toEqual({ type: 'solid', color: '#112233' })
    a.engine.pages.move(b.engine.state.doc.pages[1].id, 0)
    await frames()
    expect(b.engine.state.doc.pages.map((p) => p.id)).toEqual(a.engine.state.doc.pages.map((p) => p.id))
    a.engine.pages.remove(a.engine.state.doc.pages[0].id)
    await frames()
    expect(b.engine.state.doc.pages).toHaveLength(1)
    expect(b.engine.state.activePageId).toBe(b.engine.state.doc.pages[0].id)
    end(a, b)
  })

  it('keeps one object per id when the user puts one on the canvas while the same one is being built from elsewhere', async () => {
    const { a, b } = await pair()
    const doc = b.engine.state.doc
    const arriving = { id: 'same-id', type: 'textbox', left: 40, top: 40, width: 120, height: 30, text: 'Hello', fontSize: 20, fontFamily: 'Inter, sans-serif', fill: '#00ff00' }
    const next: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [...doc.pages[0].objects, arriving] }] }
    // Building the new object waits for its font; meanwhile the user does something that adds an object with the same id
    // (ungrouping, or an undo).
    let release: () => void = () => undefined
    vi.spyOn(b.engine.fonts, 'ensure').mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    const applying = b.engine.applyRemoteDocument(next)
    await settle()
    const mine = new Rect({ left: 40, top: 40, width: 30, height: 30 })
    asDory(mine).id = 'same-id'
    b.engine.viewOf(b.pageId)?.canvas.add(mine)
    release()
    await applying
    expect(live(b).filter((o) => (o as { id?: string }).id === 'same-id')).toHaveLength(1)
    end(a, b)
  })

  it('gives everybody both objects when ungrouping puts an object on the page that is already there', async () => {
    const { server, a, b } = await pair()
    // Ada groups rect-2 with a new shape. Somebody's undo then brings rect-2 back next to the group (the page holds it twice: on
    // the page and inside the group).
    await a.engine.insert.shape('ellipse')
    const ellipse = objects(a).find((o) => o.id !== 'rect-1' && o.id !== 'rect-2') as DocObject
    a.engine.select(['rect-2', ellipse.id])
    a.engine.arrange.group()
    await frames()
    const group = objects(a).find((o) => o.type === 'group') as DocObject
    expect(group).toBeTruthy()
    const original = a.opened.pages[0].objects.find((o) => o.id === 'rect-2') as DocObject
    const doc = a.engine.state.doc
    const twice: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [...doc.pages[0].objects, original] }] }
    await a.engine.applyRemoteDocument(twice)
    a.session.binding.writeLocal(doc, twice)
    await frames()
    expect(objects(b).map((o) => o.id)).toEqual(objects(a).map((o) => o.id))
    a.engine.select([group.id])
    a.engine.arrange.ungroup()
    await frames()
    await frames()
    const ids = objects(a).map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(4)
    expect(ids).toContain('rect-2')
    for (const peer of [a, b]) {
      expect(objects(peer).map((o) => o.id)).toEqual(ids)
      expect(live(peer).map((o) => (o as { id?: string }).id)).toEqual(ids)
    }
    expect(JSON.parse(JSON.stringify(b.engine.state.doc))).toEqual(JSON.parse(JSON.stringify(a.engine.state.doc)))
    const shared = server.doc.getMap('pages').get(a.pageId) as import('yjs').Map<unknown>
    expect((shared.get('objectOrder') as import('yjs').Array<string>).toArray()).toEqual(ids)
    end(a, b)
  })

  it('follows properties that no feature of the editor knows about', async () => {
    const { server, a, b } = await pair()
    // A future feature adds properties to an object and a page; the binding needs no change for them.
    const next = JSON.parse(JSON.stringify(a.engine.state.doc)) as DoryDocument
    ;(next.pages[0].objects[0] as DocObject).animation = { kind: 'fade', durationMs: 400, delay: { start: 0.5 } }
    ;(next.pages[0] as unknown as Record<string, unknown>).transition = 'slide'
    await a.engine.applyRemoteDocument(next)
    a.session.binding.writeLocal(a.opened, next)
    await frames()
    expect((byId(b, 'rect-1') as DocObject).animation).toEqual({ kind: 'fade', durationMs: 400, delay: { start: 0.5 } })
    expect((b.engine.state.doc.pages[0] as unknown as Record<string, unknown>).transition).toBe('slide')
    expect(server.doc.getMap('pages').size).toBe(1)
    end(a, b)
  })
})

describe('local undo with other people around', () => {
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

  it('brings back what the user deleted, even after somebody changed another object', async () => {
    const { a, b } = await pair()
    a.engine.select(['rect-1'])
    a.engine.sealHistory()
    a.engine.arrange.delete()
    await frames()
    b.engine.select(['rect-2'])
    b.engine.arrange.nudge(10, 0)
    await frames()
    await a.engine.undo()
    await frames()
    for (const peer of [a, b]) {
      expect(objects(peer).map((o) => o.id).sort()).toEqual(['rect-1', 'rect-2'])
      expect(byId(peer, 'rect-2')?.left).toBe(310)
    }
    end(a, b)
  })

  it('puts the selection back where the undone step was made, and labels the steps', async () => {
    const { a } = await pair()
    a.engine.select(['rect-1'])
    a.engine.sealHistory()
    a.engine.arrange.nudge(10, 0)
    expect(a.engine.state.history.undoLabel).toBeTruthy()
    a.engine.clearSelection()
    await a.engine.undo()
    expect(byId(a, 'rect-1')?.left).toBe(100)
    expect(a.engine.state.selection.ids).toEqual(['rect-1'])
    expect(a.engine.state.history.redoLabel).toBeTruthy()
    end(a)
  })

  it('forgets the steps when the design is replaced from outside', async () => {
    const { server, a, b } = await pair()
    a.engine.select(['rect-1'])
    a.engine.arrange.nudge(10, 0)
    expect(a.engine.state.history.canUndo).toBe(true)
    // The server replaces the design (a version was restored) and says so.
    const restored = JSON.parse(JSON.stringify(b.opened)) as DoryDocument
    restored.pages[0].objects = restored.pages[0].objects.slice(1)
    b.session.binding.writeLocal(b.engine.state.doc, restored)
    await frames()
    server.sockets.forEach((s) => s.deliver(JSON.stringify({ type: 'replaced', reason: 'version_restored', revision: 5 })))
    await frames()
    expect(a.engine.state.history.canUndo).toBe(false)
    expect(objects(a).map((o) => o.id)).toEqual(['rect-2'])
    expect(a.engine.state.toasts.some((x) => x.message.includes('restored'))).toBe(true)
    end(a, b)
  })

  it('restores a version for everybody: the editor that loads it writes it into the room', async () => {
    const { a, b } = await pair()
    const earlier = JSON.parse(JSON.stringify(a.opened)) as DoryDocument
    a.engine.select(['rect-1'])
    a.engine.arrange.nudge(80, 0)
    await frames()
    await a.engine.loadDocument(earlier)
    await frames()
    expect(byId(a, 'rect-1')?.left).toBe(100)
    expect(byId(b, 'rect-1')?.left).toBe(100)
    expect(a.engine.state.history.canUndo).toBe(false)
    end(a, b)
  })
})

describe('what must never reach the shared state', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub()
  })
  afterEach(() => {
    restore()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('keeps images that are still local to this browser out of the room until they are uploaded', async () => {
    const { server, a, b } = await pair()
    const image: DocObject = { id: 'img-1', type: 'rect', left: 50, top: 50, width: 40, height: 40, src: 'blob:http://localhost/abc' }
    const doc = a.engine.state.doc
    const next: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [...doc.pages[0].objects, image] }] }
    const persist = vi.spyOn(a.engine.assets, 'persistInline').mockImplementation(async (d) => ({
      ...d,
      pages: d.pages.map((p) => ({ ...p, objects: p.objects.map((o) => (o.src === 'blob:http://localhost/abc' ? { ...o, src: '/media/uploaded.png' } : o)) })),
    }))
    await a.engine.applyRemoteDocument(next)
    a.session.binding.writeLocal(doc, next)
    // The object exists for Ada, but the room only sees it once the upload is done.
    expect(JSON.stringify(server.doc.toJSON())).not.toContain('blob:')
    await frames()
    expect(persist).toHaveBeenCalled()
    expect(byId(b, 'img-1')?.src).toBe('/media/uploaded.png')
    expect(byId(a, 'img-1')?.src).toBe('/media/uploaded.png')
    expect(JSON.stringify(server.doc.toJSON())).not.toContain('blob:')
    end(a, b)
  })

  it('stops holding objects back when their images cannot be uploaded, and says so', async () => {
    const { a, b } = await pair()
    const doc = a.engine.state.doc
    const image: DocObject = { id: 'img-2', type: 'rect', left: 50, top: 50, width: 40, height: 40, src: 'blob:http://localhost/bad' }
    const next: DoryDocument = { ...doc, pages: [{ ...doc.pages[0], objects: [...doc.pages[0].objects, image] }] }
    vi.spyOn(a.engine.assets, 'persistInline').mockRejectedValue(new Error('offline'))
    await a.engine.applyRemoteDocument(next)
    a.session.binding.writeLocal(doc, next)
    await frames()
    expect(byId(b, 'img-2')).toBeUndefined()
    expect(a.engine.state.toasts.some((x) => x.message.includes('could not be uploaded'))).toBe(true)
    end(a, b)
  })
})

describe('tearing a session down', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('leaves nothing behind: no timers, no listeners on the shared document, the connection closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const seed = await seedDocument()
      const server = new FakeCollabServer(seed)
      const timersBefore = vi.getTimerCount()
      for (let round = 0; round < 5; round++) {
        const peer = await open(server, owner('u1', 'Ada'), seed)
        await vi.advanceTimersByTimeAsync(300)
        peer.engine.select(['rect-1'])
        peer.engine.arrange.nudge(1, 0)
        const ydoc = peer.session.ydoc
        peer.session.destroy()
        peer.engine.dispose()
        await vi.advanceTimersByTimeAsync(10)
        expect(server.sockets.size).toBe(0)
        for (const event of ['update', 'afterTransaction', 'destroy']) expect((ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get(event)?.size ?? 0).toBe(0)
      }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore + 1)
    } finally {
      vi.useRealTimers()
    }
    await settle()
  })
})
