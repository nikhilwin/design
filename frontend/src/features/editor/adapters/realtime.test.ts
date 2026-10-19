import { http as mswHttp, HttpResponse } from 'msw'
import { resetClientState } from '@/lib/api'
import { server } from '@/test/msw'
import { createAccountAdapter } from './accountAdapter'
import { createRealtimeConnection, flushLiveRoom, realtimeAddress } from './realtime'
import { createSharedAdapter } from './sharedAdapter'

const features = { stock_photos: false, server_pdf: false, google_login: false, email_verification: false }

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=tok; path=/'
})

describe('the address of a room', () => {
  it('is on this site, secure when the page is, and carries only the design id', () => {
    expect(realtimeAddress('abc-123', { protocol: 'https:', host: 'doory.example' })).toBe('wss://doory.example/ws/designs/abc-123/')
    expect(realtimeAddress('abc-123', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws/designs/abc-123/')
    expect(realtimeAddress('a/../b?x=1', { protocol: 'https:', host: 'h' })).toBe('wss://h/ws/designs/a%2F..%2Fb%3Fx%3D1/')
  })
})

describe('account adapter', () => {
  it('offers a room only when the server has real-time editing', () => {
    expect(createAccountAdapter('d1', () => 1, { config: { features } }).realtime).toBeNull()
    const adapter = createAccountAdapter('d1', () => 1, { config: { features: { ...features, realtime: true } } })
    expect(adapter.realtime?.url).toMatch(/^wss?:\/\/.+\/ws\/designs\/d1\/$/)
    expect(adapter.realtime?.auth).toBeUndefined()
  })

  it('renames over REST without a document, and says who is not signed in', async () => {
    let body: unknown
    server.use(
      mswHttp.patch('/api/v1/designs/d1/', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ id: 'd1', revision: 4 })
      }),
    )
    const requireSignIn = vi.fn(async () => true)
    const adapter = createAccountAdapter('d1', () => 1, { config: { features: { ...features, realtime: true } }, requireSignIn })
    await adapter.realtime?.setTitle?.('New title')
    expect(body).toEqual({ title: 'New title' })
    expect(await adapter.realtime?.requireSignIn()).toBe(true)
    expect(await createAccountAdapter('d1', () => 1, { config: { features: { ...features, realtime: true } } }).realtime?.requireSignIn()).toBe(false)
  })

  it('stores the thumbnail of the first page for the owner, since the room does not draw one', async () => {
    let seen = ''
    server.use(
      mswHttp.put('/api/v1/designs/d1/thumbnail/', ({ request }) => {
        seen = request.headers.get('content-type') ?? ''
        return HttpResponse.json({ thumbnail_url: '/media/t.webp' })
      }),
    )
    const adapter = createAccountAdapter('d1', () => 1, { config: { features: { ...features, realtime: true } } })
    await adapter.realtime?.uploadThumbnail?.(new Blob(['x'], { type: 'image/webp' }))
    expect(seen).toContain('multipart/form-data')
    expect(createSharedAdapter({ token: 't'.repeat(32), role: 'edit', getRevision: () => 1, ensureSignedIn: async () => true, live: { designId: 'd', requireSignIn: async () => true } }).realtime?.uploadThumbnail).toBeUndefined()
  })

  it('checks the session with GET /auth/me/ before asking for a sign-in', async () => {
    let user: unknown = { id: 'u1' }
    server.use(mswHttp.get('/api/v1/auth/me/', () => HttpResponse.json({ user })))
    const adapter = createAccountAdapter('d1', () => 1, { config: { features: { ...features, realtime: true } } })
    expect(await adapter.realtime?.refreshSession?.()).toBe(true)
    user = null
    expect(await adapter.realtime?.refreshSession?.()).toBe(false)
  })

  it('saves the live room before a version is made or restored', async () => {
    const order: string[] = []
    server.use(
      mswHttp.post('/api/v1/designs/d1/versions/', () => {
        order.push('create')
        return HttpResponse.json({ id: 'v1' })
      }),
      mswHttp.post('/api/v1/designs/d1/versions/v1/restore/', () => {
        order.push('restore')
        return HttpResponse.json({ id: 'd1', document: { pages: [] } })
      }),
    )
    const adapter = createAccountAdapter('d1', () => 1, { config: { features: { ...features, realtime: true } } })
    adapter.realtime!.flushRef.current = async () => void order.push('flush')
    await adapter.services.versions?.create('Before')
    await adapter.services.versions?.restore('v1')
    expect(order).toEqual(['flush', 'create', 'flush', 'restore'])
  })

  it('does not wait for a room that is not there', async () => {
    const adapter = createAccountAdapter('d1', () => 1, { config: { features } })
    await expect(flushLiveRoom(adapter.realtime)).resolves.toBeUndefined()
    await expect(flushLiveRoom(null)).resolves.toBeUndefined()
  })
})

describe('shared adapter', () => {
  const base = { token: 'tok'.repeat(10), role: 'edit' as const, getRevision: () => 1, ensureSignedIn: async () => true }

  it('has no room without a signed-in visitor', () => {
    expect(createSharedAdapter(base).realtime).toBeNull()
  })

  it('joins the design\'s room with the link\'s credentials in the first frame, and cannot rename', async () => {
    const requireSignIn = vi.fn(async () => true)
    const adapter = createSharedAdapter({ ...base, password: 'pw', live: { designId: 'design-9', requireSignIn } })
    expect(adapter.realtime?.url).toMatch(/\/ws\/designs\/design-9\/$/)
    expect(adapter.realtime?.auth).toEqual({ token: base.token, password: 'pw' })
    expect(adapter.realtime?.setTitle).toBeNull()
    expect(await adapter.realtime?.requireSignIn()).toBe(true)
  })
})

describe('opening the room early', () => {
  it('opens one room, hands it over once, and lets go of it when released', async () => {
    const connection = createRealtimeConnection({ designId: 'd', setTitle: null, requireSignIn: async () => false })
    const sockets: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        binaryType = ''
        readyState = 0
        onopen = null
        onmessage = null
        onclose = null
        onerror = null
        constructor(url: string) {
          sockets.push(url)
        }
        send() {}
        close() {}
      },
    )
    connection.early.start()
    connection.early.start()
    await vi.waitFor(() => expect(connection.early.room).not.toBeNull())
    expect(sockets).toHaveLength(1)
    connection.early.release()
    expect(connection.early.room).toBeNull()
    // Released before the room code had loaded: nothing opens.
    connection.early.start()
    connection.early.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(connection.early.room).toBeNull()
    vi.unstubAllGlobals()
  })
})
