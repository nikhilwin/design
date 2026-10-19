import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { DoryDocument } from '@/types/document'
import { FakeCollabServer, type ConnectionPlan } from './fakeServer'
import { BACKOFF_MAX_MS, CollabProvider, type ProviderEvents, type ProviderState, backoffDelay } from './provider'
import { docOf, page, shape } from './testing'
import { readDocument, rootsOf } from './schema'

const owner: ConnectionPlan = { user: { id: 'u1', name: 'Ada' }, role: 'owner' }

function client(server: FakeCollabServer, plan: ConnectionPlan = owner, events: ProviderEvents = {}, auth?: { token: string; password?: string }) {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  const provider = new CollabProvider({ url: 'ws://test/ws/designs/d1/', doc, awareness, auth, createSocket: server.socketFactory(plan), random: () => 0.5, ...events })
  const states: ProviderState[] = []
  provider.subscribe((s) => states.push(s))
  return { doc, awareness, provider, states }
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const seed: DoryDocument = docOf([page([shape()])])

describe('CollabProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs in, syncs the design into an empty document and reports live', async () => {
    const server = new FakeCollabServer(seed)
    const { provider, doc } = client(server)
    expect(provider.getState().status).toBe('connecting')
    provider.connect()
    await tick()
    const state = provider.getState()
    expect(state).toMatchObject({ status: 'live', synced: true, role: 'owner', canWrite: true, user: { id: 'u1', name: 'Ada' }, attempt: 0 })
    expect(readDocument(rootsOf(doc), null)?.pages[0].objects).toHaveLength(1)
    provider.destroy()
  })

  it('sends local changes to the server and receives theirs', async () => {
    const server = new FakeCollabServer(seed)
    const a = client(server)
    const b = client(server, { user: { id: 'u2', name: 'Bo' }, role: 'owner' })
    a.provider.connect()
    b.provider.connect()
    await tick()
    a.doc.getMap('meta').set('width', 999)
    await tick(60)
    expect(b.doc.getMap('meta').get('width')).toBe(999)
    expect(server.doc.getMap('meta').get('width')).toBe(999)
    b.doc.getMap('meta').set('unit', 'mm')
    await tick(60)
    expect(a.doc.getMap('meta').get('unit')).toBe('mm')
    a.provider.destroy()
    b.provider.destroy()
  })

  it('sends changes that follow each other closely in a few frames, and loses none of them', async () => {
    const server = new FakeCollabServer(seed)
    const a = client(server)
    a.provider.connect()
    await tick()
    const before = server.received.length
    for (let i = 0; i < 100; i++) {
      a.doc.getMap('meta').set(`k${i}`, i)
      await tick(1)
    }
    await tick(100)
    const frames = server.received.slice(before).filter((r) => r.bytes && r.bytes[0] === 0 && r.bytes[1] === 2)
    expect(frames.length).toBeLessThanOrEqual(5)
    expect(frames.length).toBeGreaterThan(0)
    for (let i = 0; i < 100; i++) expect(server.doc.getMap('meta').get(`k${i}`)).toBe(i)
    a.provider.destroy()
  })

  it('sends what is waiting before it saves, and before it closes', async () => {
    const server = new FakeCollabServer(seed)
    const a = client(server)
    a.provider.connect()
    await tick()
    a.doc.getMap('meta').set('late', 1)
    const flushed = a.provider.flush()
    await tick()
    await flushed
    expect(server.doc.getMap('meta').get('late')).toBe(1)
    a.doc.getMap('meta').set('last', 2)
    a.provider.destroy()
    await tick()
    expect(server.doc.getMap('meta').get('last')).toBe(2)
  })

  it('keeps changes made while it reconnects back until the server has been told what it missed', async () => {
    // The server refuses an update that builds on a change it does not have, and it closes the connection. After a
    // reconnect, an edit made on a slow link used to overtake the answer that carries the earlier ones.
    const server = new FakeCollabServer(seed)
    const a = client(server)
    a.provider.connect()
    await tick()
    server.dropAll()
    await tick()
    a.doc.getMap('meta').set('offline', 1)
    server.stallHandshake = true
    await tick(2000)
    a.doc.getMap('meta').set('during', 2)
    await tick(200)
    server.releaseHandshake()
    await tick(200)
    expect(a.provider.getState().status).toBe('live')
    expect(server.doc.getMap('meta').get('offline')).toBe(1)
    expect(server.doc.getMap('meta').get('during')).toBe(2)
    a.doc.getMap('meta').set('after', 3)
    await tick(100)
    expect(server.doc.getMap('meta').get('after')).toBe(3)
    a.provider.destroy()
  })

  it('notices changes made offline that a read-only connection will never take, and does not let them through if the right comes back', async () => {
    const server = new FakeCollabServer(seed)
    const edit: ConnectionPlan = { user: { id: 'u2', name: 'Bo' }, role: 'edit', token: 't' }
    const view: ConnectionPlan = { ...edit, role: 'view' }
    const a = client(server, edit, {}, { token: 't' })
    a.provider.connect()
    await tick()
    expect(a.provider.getState()).toMatchObject({ status: 'live', canWrite: true, unsentChanges: false })
    server.dropAll()
    await tick()
    a.doc.getMap('meta').set('offline', 1)
    server.replacePlans(view)
    await tick(2000)
    expect(a.provider.getState()).toMatchObject({ status: 'read-only', canWrite: false, unsentChanges: true })
    expect(server.doc.getMap('meta').get('offline')).toBeUndefined()
    // Promoted again: the window refuses to send what it still shows but the server never had.
    server.replacePlans(edit)
    server.dropAll()
    await tick(4000)
    expect(a.provider.getState()).toMatchObject({ status: 'forbidden', reason: 'unsent_changes', canWrite: false })
    expect(server.doc.getMap('meta').get('offline')).toBeUndefined()
    a.provider.destroy()
  })

  it('does not call a read-only window with nothing of its own unsent', async () => {
    const server = new FakeCollabServer(seed)
    const viewer = client(server, { user: { id: 'u3', name: 'Cy' }, role: 'view', token: 't' }, {}, { token: 't' })
    viewer.provider.connect()
    await tick()
    server.dropAll()
    await tick(2000)
    expect(viewer.provider.getState()).toMatchObject({ status: 'read-only', unsentChanges: false })
    viewer.provider.destroy()
  })

  it('sends the share-link credentials as the first frame and is refused with a wrong token', async () => {
    const server = new FakeCollabServer(seed)
    const plan: ConnectionPlan = { user: { id: 'u2', name: 'Bo' }, role: 'edit', token: 'secret' }
    const good = client(server, plan, {}, { token: 'secret', password: 'pw' })
    good.provider.connect()
    await tick()
    expect(server.received[0].text).toBe(JSON.stringify({ type: 'auth', token: 'secret', password: 'pw' }))
    expect(good.provider.getState()).toMatchObject({ status: 'live', role: 'edit' })

    const bad = client(server, plan, {}, { token: 'nope' })
    bad.provider.connect()
    await tick()
    expect(bad.provider.getState()).toMatchObject({ status: 'forbidden', reason: 'forbidden', synced: false })
    await tick(60_000)
    expect(server.connections).toBe(2)
    good.provider.destroy()
    bad.provider.destroy()
  })

  it('treats view and comment roles as read-only and never sends their updates', async () => {
    const server = new FakeCollabServer(seed)
    const viewer = client(server, { user: { id: 'u3', name: 'Cy' }, role: 'view', token: 't' }, {}, { token: 't' })
    viewer.provider.connect()
    await tick()
    expect(viewer.provider.getState()).toMatchObject({ status: 'read-only', canWrite: false, role: 'view', synced: true })
    const before = server.received.length
    viewer.doc.getMap('meta').set('width', 1)
    await tick()
    expect(server.received.slice(before).filter((r) => r.bytes && r.bytes[1] !== 0)).toHaveLength(0)
    expect(server.doc.getMap('meta').get('width')).not.toBe(1)
    viewer.provider.destroy()
  })

  it('reconnects with back-off after a drop and merges edits made while offline', async () => {
    const server = new FakeCollabServer(seed)
    const a = client(server)
    const b = client(server, { user: { id: 'u2', name: 'Bo' }, role: 'owner' })
    a.provider.connect()
    b.provider.connect()
    await tick()
    server.dropAll()
    await tick()
    expect(a.provider.getState()).toMatchObject({ status: 'offline', synced: true, attempt: 1 })
    a.doc.getMap('meta').set('width', 321)
    b.doc.getMap('meta').set('unit', 'in')
    await tick(500)
    expect(a.provider.getState().status).toBe('offline')
    await tick(1500)
    await tick()
    expect(a.provider.getState()).toMatchObject({ status: 'live', attempt: 0 })
    expect(server.doc.getMap('meta').get('width')).toBe(321)
    expect(b.doc.getMap('meta').get('width')).toBe(321)
    expect(a.doc.getMap('meta').get('unit')).toBe('in')
    a.provider.destroy()
    b.provider.destroy()
  })

  it('keeps retrying while the server is down, with growing delays, and recovers', async () => {
    const server = new FakeCollabServer(seed)
    server.down = true
    const { provider } = client(server)
    provider.connect()
    await tick()
    const delays: number[] = []
    let last = server.connections
    for (let t = 0; t < 120_000; t += 250) {
      await tick(250)
      if (server.connections !== last) {
        delays.push(t)
        last = server.connections
      }
    }
    expect(provider.getState()).toMatchObject({ status: 'connecting', synced: false })
    expect(provider.getState().attempt).toBeGreaterThanOrEqual(5)
    const gaps = delays.slice(1).map((d, i) => d - delays[i])
    expect(gaps[0]).toBeLessThan(gaps[gaps.length - 1])
    expect(Math.max(...gaps)).toBeLessThanOrEqual(BACKOFF_MAX_MS + 250)
    server.down = false
    await tick(BACKOFF_MAX_MS + 500)
    expect(provider.getState().status).toBe('live')
    provider.destroy()
  })

  it('computes jittered, capped delays', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000)
    expect(backoffDelay(0, () => 0)).toBe(500)
    expect(backoffDelay(3, () => 1)).toBe(8000)
    expect(backoffDelay(20, () => 1)).toBe(BACKOFF_MAX_MS)
    expect(backoffDelay(20, () => 0)).toBe(BACKOFF_MAX_MS / 2)
  })

  it('asks the shell to sign in after 4401, and reconnects once it did', async () => {
    const server = new FakeCollabServer(seed)
    const plan: ConnectionPlan = { ...owner, refuse: { code: 4401, reason: 'not_authenticated' } }
    const onSignInRequired = vi.fn(async () => {
      delete plan.refuse
      return true
    })
    const { provider } = client(server, plan, { onSignInRequired })
    provider.connect()
    await tick()
    expect(onSignInRequired).toHaveBeenCalledTimes(1)
    await tick()
    expect(provider.getState()).toMatchObject({ status: 'live', synced: true })
    expect(server.connections).toBe(2)
    provider.destroy()
  })

  it('refreshes the session quietly first, and asks only once when the server keeps refusing', async () => {
    const server = new FakeCollabServer(seed)
    const refreshSession = vi.fn(async () => true)
    const onSignInRequired = vi.fn(async () => true)
    const { provider } = client(server, { ...owner, refuse: { code: 4401, reason: 'session_ended' } }, { refreshSession, onSignInRequired })
    provider.connect()
    await tick(60_000)
    // refresh → retry → 4401 → one prompt → retry → 4401 → stop (the shell says "signed in" but the server disagrees)
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(onSignInRequired).toHaveBeenCalledTimes(1)
    expect(server.connections).toBe(3)
    expect(provider.getState().status).toBe('signed-out')
    await provider.signIn()
    await tick(1000)
    expect(onSignInRequired).toHaveBeenCalledTimes(2)
    expect(server.connections).toBe(4)
    provider.destroy()
  })

  it('stays signed out when the user does not sign in', async () => {
    const server = new FakeCollabServer(seed)
    const onSignInRequired = vi.fn(async () => false)
    const { provider } = client(server, { ...owner, refuse: { code: 4401, reason: 'session_ended' } }, { onSignInRequired })
    provider.connect()
    await tick(60_000)
    expect(provider.getState()).toMatchObject({ status: 'signed-out', reason: 'session_ended' })
    expect(server.connections).toBe(1)
    await provider.signIn()
    expect(onSignInRequired).toHaveBeenCalledTimes(2)
    provider.destroy()
  })

  it.each([
    [4404, 'design_trashed', 'not-found'],
    [4413, 'document_too_large', 'too-large'],
    [4403, 'link_revoked', 'forbidden'],
    [4400, 'bad_frame', 'unavailable'],
  ] as const)('stops on close code %i (%s) and does not reconnect', async (code, reason, status) => {
    const server = new FakeCollabServer(seed)
    const { provider } = client(server, { ...owner, refuse: { code, reason } })
    provider.connect()
    await tick()
    expect(provider.getState()).toMatchObject({ status, reason })
    await tick(120_000)
    expect(server.connections).toBe(1)
    provider.destroy()
  })

  it('waits at least ten seconds after a rate-limit close, and reconnects once for a changed role', async () => {
    const server = new FakeCollabServer(seed)
    const { provider } = client(server, { ...owner, refuse: { code: 4429, reason: 'too_many_connections' } })
    provider.connect()
    await tick()
    expect(provider.getState().status).toBe('busy')
    await tick(9_000)
    expect(server.connections).toBe(1)
    await tick(2_000)
    expect(server.connections).toBe(2)
    provider.destroy()

    const changed = new FakeCollabServer(seed)
    const second = client(changed, { ...owner, refuse: { code: 4403, reason: 'role_changed' } })
    second.provider.connect()
    await tick(5_000)
    expect(changed.connections).toBe(2)
    expect(second.provider.getState().status).toBe('forbidden')
    second.provider.destroy()
  })

  it('forwards title, saved and replaced frames', async () => {
    const server = new FakeCollabServer(seed)
    server.title = 'From the server'
    server.revision = 7
    const events = { onTitle: vi.fn(), onSaved: vi.fn(), onReplaced: vi.fn() }
    const { provider } = client(server, owner, events)
    provider.connect()
    await tick()
    expect(events.onTitle).toHaveBeenCalledWith('From the server')
    expect(events.onSaved).toHaveBeenCalledWith(7)
    server.sockets.forEach((s) => s.deliver(JSON.stringify({ type: 'title', title: 'Renamed' })))
    server.sockets.forEach((s) => s.deliver(JSON.stringify({ type: 'replaced', reason: 'version_restored', revision: 9 })))
    await tick()
    expect(events.onTitle).toHaveBeenLastCalledWith('Renamed')
    expect(events.onReplaced).toHaveBeenCalledTimes(1)
    provider.destroy()
  })

  it('relays awareness with the server-written identity and forgets peers on disconnect', async () => {
    const server = new FakeCollabServer(seed)
    const a = client(server)
    const b = client(server, { user: { id: 'u2', name: 'Bo' }, role: 'owner' })
    a.awareness.setLocalState({ user: { color: '#336699' }, cursor: { pageId: 'p', x: 1, y: 2 } })
    a.provider.connect()
    b.provider.connect()
    await tick()
    const seen = b.awareness.getStates().get(a.awareness.clientID)
    expect(seen).toMatchObject({ cursor: { x: 1, y: 2 }, user: { id: 'u1', name: 'Ada', color: '#336699', role: 'owner' } })
    a.provider.destroy()
    await tick()
    expect(b.awareness.getStates().has(a.awareness.clientID)).toBe(false)
    b.provider.destroy()
  })

  it('does not send a frame the server would refuse as too large', async () => {
    const server = new FakeCollabServer(seed)
    server.maxFrameBytes = 2_000
    const { provider, doc } = client(server)
    provider.connect()
    await tick()
    doc.getMap('meta').set('big', 'x'.repeat(5_000))
    await tick(60)
    expect(provider.getState()).toMatchObject({ status: 'too-large', reason: 'frame_too_large' })
    expect(server.doc.getMap('meta').get('big')).toBeUndefined()
    provider.destroy()
  })

  it('pings to keep the connection warm and reconnects when the server stops answering', async () => {
    const server = new FakeCollabServer(seed)
    const { provider } = client(server)
    provider.connect()
    await tick()
    await tick(20_500)
    expect(server.received.some((r) => r.text === '{"type":"ping"}')).toBe(true)
    expect(provider.getState().status).toBe('live')
    provider.destroy()
  })

  it('does not accumulate listeners, timers or sockets across many reconnects', async () => {
    const server = new FakeCollabServer(seed)
    const { provider, doc, awareness } = client(server)
    provider.connect()
    await tick()
    const observers = (target: { _observers: Map<string, Set<unknown>> }, event: string): number => target._observers.get(event)?.size ?? 0
    const before = { doc: observers(doc as never, 'update'), awareness: observers(awareness as never, 'update') }
    let timers = 0
    for (let round = 0; round < 40; round++) {
      server.dropAll()
      await tick(0)
      await tick(35_000)
      expect(provider.getState().status).toBe('live')
      expect(server.sockets.size).toBe(1)
      timers = Math.max(timers, vi.getTimerCount())
    }
    expect(observers(doc as never, 'update')).toBe(before.doc)
    expect(observers(awareness as never, 'update')).toBe(before.awareness)
    expect(timers).toBeLessThanOrEqual(5)
    provider.destroy()
  })

  it('leaves no timers or listeners behind after destroy', async () => {
    const server = new FakeCollabServer(seed)
    const { provider, doc, awareness } = client(server)
    provider.connect()
    await tick()
    provider.destroy()
    awareness.destroy()
    await tick()
    expect(vi.getTimerCount()).toBe(0)
    expect(server.sockets.size).toBe(0)
    const before = server.received.length
    doc.getMap('meta').set('width', 5)
    await tick(60_000)
    expect(server.received.length).toBe(before)
  })
})
