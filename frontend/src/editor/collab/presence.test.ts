import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { type StoreApi, createStore } from 'zustand/vanilla'
import type { EditorState } from '../store/editorStore'
import { EMPTY_SELECTION } from '../store/editorStore'
import { colorForUser } from './colors'
import { IDLE_AFTER_MS, LOCK_TTL_MS, PUBLISH_INTERVAL_MS, Presence, type PresenceHost, readPeer, safeAvatar } from './presence'

/** Server-stamped awareness state of another user. */
function state(user: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { user: { id: 'u2', name: 'Bo', avatarUrl: null, color: '#0369a1', role: 'edit', ...user }, ...extra }
}

describe('readPeer', () => {
  it('reads a collaborator and trims what the sender controls', () => {
    const peer = readPeer(7, state({}, { cursor: { pageId: 'p1', x: 10, y: 20 }, selection: { pageId: 'p1', ids: ['a', 'b'], box: { cx: 1, cy: 2, w: 3, h: 4, a: 5 } }, view: { pageId: 'p1', x: 1, y: 2, zoom: 0.5 }, editing: { pageId: 'p1', id: 'a', beat: 1 } }))
    expect(peer).toMatchObject({ clientId: 7, userId: 'u2', name: 'Bo', color: '#0369a1', role: 'edit', cursor: { x: 10, y: 20 }, selection: { ids: ['a', 'b'], box: { w: 3 } }, editing: { id: 'a' }, view: { zoom: 0.5 } })
  })

  it('ignores states without the server\'s identity', () => {
    expect(readPeer(1, {})).toBeNull()
    expect(readPeer(1, { user: { name: 'x' } })).toBeNull()
    expect(readPeer(1, null)).toBeNull()
    expect(readPeer(1, 'text')).toBeNull()
  })

  it('does not trust malformed fields', () => {
    const peer = readPeer(
      1,
      state({ color: 'javascript:alert(1)', name: ' '.repeat(3), role: 'admin', avatarUrl: 'javascript:alert(1)' }, { cursor: { pageId: 'p', x: Number.NaN, y: 1 }, selection: { pageId: 'p', ids: [1, null, 'ok'], box: { cx: 'x' } }, view: { pageId: 'p', x: 1, y: 2, zoom: -3 }, editing: { pageId: '', id: 'a' } }),
    )
    expect(peer).toMatchObject({ role: 'view', cursor: null, view: null, editing: null, avatarUrl: null, selection: { ids: ['ok'], box: null } })
    expect(peer?.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(peer?.name).toBe('Someone')
  })

  it('caps what a selection can carry', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `o${i}`)
    expect(readPeer(1, state({}, { selection: { pageId: 'p', ids } }))?.selection?.ids).toHaveLength(24)
  })

  it('accepts only avatars a page may load', () => {
    expect(safeAvatar('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
    expect(safeAvatar('/media/a.png')).toBe('/media/a.png')
    for (const bad of ['//evil.example/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)', 5, null, `https://x/${'a'.repeat(600)}`]) expect(safeAvatar(bad)).toBeNull()
  })
})

interface Fake {
  host: PresenceHost
  store: StoreApi<EditorState>
  locks: Map<string, Set<string>>[]
  toasts: string[]
  announcements: string[]
  stopped: number
}

function fakeEditor(): Fake {
  const store = createStore<EditorState>(() => ({ activePageId: 'p1', selection: EMPTY_SELECTION }) as unknown as EditorState)
  const fake: Fake = { store, locks: [], toasts: [], announcements: [], stopped: 0, host: null as unknown as PresenceHost }
  fake.host = {
    store,
    get state() {
      return store.getState()
    },
    viewOf: () => undefined,
    setRemoteEditLocks: (locks: ReadonlyMap<string, ReadonlySet<string>>) => void fake.locks.push(new Map([...locks].map(([k, v]) => [k, new Set(v)]))),
    stopEditingText: () => void (fake.stopped += 1),
    toast: (message: string) => void fake.toasts.push(message),
    announce: (message: string) => void fake.announcements.push(message),
  } as unknown as PresenceHost
  return fake
}

/** The awareness of a second client, whose state the first one receives. */
function remote(awareness: Awareness, clientId: number, value: Record<string, unknown> | null, clock = 1): void {
  const other = new Awareness(new Y.Doc())
  ;(other as unknown as { clientID: number }).clientID = clientId
  other.meta.set(clientId, { clock: clock - 1, lastUpdated: Date.now() })
  other.setLocalState(value)
  const update = encode(other, clientId)
  apply(awareness, update)
  other.destroy()
}
const encode = (a: Awareness, id: number): Uint8Array => encodeAwarenessUpdate(a, [id])
const apply = (a: Awareness, update: Uint8Array): void => applyAwarenessUpdate(a, update, 'test')

describe('Presence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the others, with their pointer, and forgets them when they go', async () => {
    const awareness = new Awareness(new Y.Doc())
    const fake = fakeEditor()
    const presence = new Presence(awareness, fake.host)
    presence.start()
    remote(awareness, 99, state({ id: 'u2', name: 'Bo' }, { cursor: { pageId: 'p1', x: 5, y: 6 } }))
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.store.getState().peers).toMatchObject([{ clientId: 99, name: 'Bo', cursor: { x: 5, y: 6 } }])
    remote(awareness, 99, null, 2)
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.store.getState().peers).toEqual([])
    presence.stop()
    awareness.destroy()
  })

  it('announces arrivals and departures, but not who was already there', async () => {
    const awareness = new Awareness(new Y.Doc())
    const fake = fakeEditor()
    remote(awareness, 98, state({ id: 'u9', name: 'Early' }))
    const presence = new Presence(awareness, fake.host)
    presence.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.announcements).toEqual([])
    remote(awareness, 99, state({ id: 'u2', name: 'Bo' }))
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.announcements).toEqual(['Bo joined'])
    remote(awareness, 99, null, 2)
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.announcements).toEqual(['Bo joined', 'Bo left'])
    presence.stop()
    awareness.destroy()
  })

  it('marks collaborators idle after a while without change', async () => {
    const awareness = new Awareness(new Y.Doc())
    const presence = new Presence(awareness, fakeEditor().host)
    presence.start()
    remote(awareness, 99, state({}, { cursor: { pageId: 'p1', x: 1, y: 1 } }))
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.store.getState().peers[0].idle).toBe(false)
    await vi.advanceTimersByTimeAsync(IDLE_AFTER_MS + 6_000)
    expect(presence.store.getState().peers[0].idle).toBe(true)
    remote(awareness, 99, state({}, { cursor: { pageId: 'p1', x: 50, y: 1 } }), 2)
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.store.getState().peers[0].idle).toBe(false)
    presence.stop()
    awareness.destroy()
  })

  it('locks the text somebody else edits, and lets go when they stop, leave or go quiet', async () => {
    const awareness = new Awareness(new Y.Doc())
    const fake = fakeEditor()
    const presence = new Presence(awareness, fake.host)
    presence.start()
    remote(awareness, 99, state({}, { selection: { pageId: 'p1', ids: ['t1'] }, editing: { pageId: 'p1', id: 't1', beat: 0 } }))
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.lockOwner('p1', 't1')?.name).toBe('Bo')
    expect(fake.locks[fake.locks.length - 1].get('p1')).toEqual(new Set(['t1']))
    // Nothing refreshes the lock: it expires on its own.
    await vi.advanceTimersByTimeAsync(LOCK_TTL_MS + 6_000)
    expect(presence.lockOwner('p1', 't1')).toBeUndefined()
    expect(fake.locks[fake.locks.length - 1].size).toBe(0)
    // The heartbeat of the sender keeps it.
    remote(awareness, 99, state({}, { selection: { pageId: 'p1', ids: ['t1'] }, editing: { pageId: 'p1', id: 't1', beat: 1 } }), 2)
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.lockOwner('p1', 't1')).toBeDefined()
    remote(awareness, 99, null, 3)
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.lockOwner('p1', 't1')).toBeUndefined()
    presence.stop()
    awareness.destroy()
  })

  it('yields when two people start editing the same text together: the lower connection keeps it', async () => {
    const awareness = new Awareness(new Y.Doc())
    const fake = fakeEditor()
    ;(awareness as unknown as { clientID: number }).clientID = 50
    fake.store.setState({ selection: { ...EMPTY_SELECTION, pageId: 'p1', ids: ['t1'], editing: true } } as Partial<EditorState>)
    const presence = new Presence(awareness, fake.host)
    presence.start()
    remote(awareness, 60, state({ name: 'Higher' }, { editing: { pageId: 'p1', id: 't1', beat: 0 } }))
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.stopped).toBe(0)
    remote(awareness, 40, state({ id: 'u3', name: 'Lower' }, { editing: { pageId: 'p1', id: 't1', beat: 0 } }))
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.stopped).toBe(1)
    expect(fake.toasts[0]).toContain('Lower')
    presence.stop()
    awareness.destroy()
  })

  it('publishes the pointer and the selection at most about fifteen times a second', async () => {
    const awareness = new Awareness(new Y.Doc())
    const presence = new Presence(awareness, fakeEditor().host)
    presence.start()
    const sent: unknown[] = []
    awareness.on('update', () => sent.push(awareness.getLocalState()))
    presence.identify('u1')
    sent.length = 0
    for (let i = 0; i < 100; i++) {
      presence.setCursor({ pageId: 'p1', x: i, y: i })
      await vi.advanceTimersByTimeAsync(10)
    }
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS)
    expect(sent.length).toBeLessThanOrEqual(Math.ceil(1000 / PUBLISH_INTERVAL_MS) + 2)
    expect(sent.length).toBeGreaterThan(5)
    expect(sent[sent.length - 1]).toMatchObject({ cursor: { pageId: 'p1', x: 99, y: 99 }, user: { color: expect.stringMatching(/^#[0-9a-f]{6}$/) } })
    presence.stop()
    awareness.destroy()
  })

  it('announces its colour as soon as it knows who it is, before anything has moved', async () => {
    const awareness = new Awareness(new Y.Doc())
    const presence = new Presence(awareness, fakeEditor().host)
    presence.start()
    presence.identify('user-42')
    await vi.advanceTimersByTimeAsync(200)
    expect(awareness.getLocalState()).toMatchObject({ user: { color: colorForUser('user-42') }, cursor: null, selection: null })
    presence.stop()
    awareness.destroy()
  })

  it('stays within the server\'s awareness size limit with a large selection', async () => {
    const awareness = new Awareness(new Y.Doc())
    const fake = fakeEditor()
    const presence = new Presence(awareness, fake.host)
    presence.start()
    fake.store.setState({ selection: { ...EMPTY_SELECTION, pageId: 'p1', ids: Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) } } as Partial<EditorState>)
    presence.setView({ pageId: 'p1', x: 1, y: 2, zoom: 1 })
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.stringify(awareness.getLocalState()).length).toBeLessThan(2048)
    presence.stop()
    awareness.destroy()
  })

  it('toggles following a collaborator and drops it when they leave', async () => {
    const awareness = new Awareness(new Y.Doc())
    const presence = new Presence(awareness, fakeEditor().host)
    presence.start()
    remote(awareness, 99, state({}))
    await vi.advanceTimersByTimeAsync(200)
    presence.follow(99)
    expect(presence.store.getState().following).toBe(99)
    presence.follow(99)
    expect(presence.store.getState().following).toBeNull()
    presence.follow(99)
    remote(awareness, 99, null, 2)
    await vi.advanceTimersByTimeAsync(200)
    expect(presence.store.getState().following).toBeNull()
    presence.stop()
    awareness.destroy()
  })

  it('leaves no timers behind when it stops', () => {
    const awareness = new Awareness(new Y.Doc())
    const presence = new Presence(awareness, fakeEditor().host)
    presence.start()
    presence.stop()
    awareness.destroy()
    expect(vi.getTimerCount()).toBe(0)
  })
})
