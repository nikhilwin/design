/**
 * Animation travels through the real-time binding like any other property: `animation` on an object and `transition`
 * on a page are plain JSON properties, so the generic property diff carries them and `collab/` has no code for them.
 * Two editors on the in-memory server prove it, including how the other editor's canvas takes a change (in place: the
 * object is not rebuilt, so a collaborator's selection survives somebody else animating the object).
 */
import { createBlankDocument } from '@/lib/document'
import type { RealtimeConnection } from '@/types/adapter'
import type { DoryDocument, ObjectAnimation } from '@/types/document'
import { type ConnectionPlan, FakeCollabServer, settle } from '../collab/fakeServer'
import { CollabSession } from '../collab/session'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from '../engine/editor'
import { installImageStub } from '../test/imageStub'
import { serializedRect } from './testing'

const owner = (id: string, name: string): ConnectionPlan => ({ user: { id, name }, role: 'owner' })

function document2(): DoryDocument {
  const doc = createBlankDocument(800, 600)
  return { ...doc, pages: [{ ...doc.pages[0], id: 'page-1', objects: [serializedRect('a', 200, 200), serializedRect('b', 500, 400)] }, { ...doc.pages[0], id: 'page-2', objects: [] }] }
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
  return { engine, session, view }
}

async function frames(): Promise<void> {
  await settle(4)
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await settle(4)
}

const animationOf = (engine: EditorEngine, id: string): ObjectAnimation | undefined => engine.state.doc.pages[0].objects.find((o) => o.id === id)?.animation as ObjectAnimation | undefined

describe('animation in a live room', () => {
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

  it('shares an animation, its changes and its removal, and a page transition', async () => {
    const doc = document2()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()

    a.engine.select(['a'], 'page-1')
    a.engine.animation.setPreset('enter', 'rise')
    a.engine.animation.setPreset('emphasis', 'pulse')
    await frames()
    expect(animationOf(b.engine, 'a')).toEqual(animationOf(a.engine, 'a'))
    expect(animationOf(b.engine, 'a')?.enter?.preset).toBe('rise')
    expect(animationOf(b.engine, 'b')).toBeUndefined()

    b.engine.select(['a'], 'page-1')
    b.engine.animation.patch('enter', { durationMs: 1800, delayMs: 300 })
    a.engine.pages.setTransition('page-2', { preset: 'push', durationMs: 900, easing: 'ease-in-out', direction: 'left' })
    await frames()
    expect(animationOf(a.engine, 'a')?.enter).toMatchObject({ durationMs: 1800, delayMs: 300 })
    expect(b.engine.state.doc.pages[1].transition).toEqual({ preset: 'push', durationMs: 900, easing: 'ease-in-out', direction: 'left' })

    a.engine.animation.remove('emphasis', ['a'])
    b.engine.pages.setTransitionAll(null)
    await frames()
    for (const peer of [a, b]) {
      expect(Object.keys(animationOf(peer.engine, 'a') ?? {})).toEqual(['enter'])
      expect(peer.engine.state.doc.pages.some((p) => 'transition' in p)).toBe(false)
    }
    a.engine.animation.remove('enter', ['a'])
    await frames()
    expect('animation' in b.engine.state.doc.pages[0].objects[0]).toBe(false)
    expect(JSON.stringify(a.engine.state.doc)).toBe(JSON.stringify(b.engine.state.doc))

    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('merges animations of different objects set at the same moment', async () => {
    const doc = document2()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    a.engine.animation.setPreset('enter', 'fade', ['a'])
    b.engine.animation.setPreset('exit', 'zoom', ['b'])
    await frames()
    for (const peer of [a, b]) {
      expect(animationOf(peer.engine, 'a')?.enter?.preset).toBe('fade')
      expect(animationOf(peer.engine, 'b')?.exit?.preset).toBe('zoom')
    }
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('takes a collaborator’s animation without rebuilding the object or losing the selection', async () => {
    const doc = document2()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    b.engine.select(['a'], 'page-1')
    await frames()
    const live = b.view.canvas.getObjects().find((o) => (o as { id?: string }).id === 'a')
    expect(live).toBeDefined()
    a.engine.animation.setPreset('enter', 'pop', ['a'])
    await frames()
    expect(animationOf(b.engine, 'a')?.enter?.preset).toBe('pop')
    expect(b.view.canvas.getObjects().find((o) => (o as { id?: string }).id === 'a')).toBe(live)
    expect(b.engine.state.selection.ids).toEqual(['a'])
    expect(b.engine.state.selection.objects[0].animation).toMatchObject({ enter: { preset: 'pop' } })
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('undoes only the user’s own animation edits', async () => {
    const doc = document2()
    const server = new FakeCollabServer(doc)
    const a = await open(server, owner('u1', 'Ada'), doc)
    const b = await open(server, owner('u2', 'Bo'), doc)
    await frames()
    a.engine.animation.setPreset('enter', 'fade', ['a'])
    await frames()
    b.engine.animation.setPreset('enter', 'drop', ['b'])
    await frames()
    await a.engine.undo()
    await frames()
    for (const peer of [a, b]) {
      expect(animationOf(peer.engine, 'a')).toBeUndefined()
      expect(animationOf(peer.engine, 'b')?.enter?.preset).toBe('drop')
    }
    for (const peer of [a, b]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })
})
