import type { DocPage } from '@/types/document'
import { PageSnapshots, VERSIONS_KEPT } from './snapshots'

const render = vi.hoisted(() => ({ renderPageToCanvas: vi.fn(), canvasToBlob: vi.fn() }))
vi.mock('./render', () => render)

const page = (id: string, version = 0): DocPage => ({ id, background: { type: 'solid', color: '#ffffff' }, objects: [], name: `v${version}` })
const SIZE = { width: 800, height: 600 }
const created: string[] = []
const revoked: string[] = []

/** Lets the queue (one `setTimeout(0)` per request) run until it is idle. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('PageSnapshots', () => {
  beforeEach(() => {
    created.length = 0
    revoked.length = 0
    render.renderPageToCanvas.mockReset().mockResolvedValue({})
    render.canvasToBlob.mockReset().mockResolvedValue(new Blob(['x']))
    let n = 0
    // jsdom has neither function.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => {
        const url = `blob:test/${++n}`
        created.push(url)
        return url
      },
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: (url: string) => void revoked.push(url) })
  })
  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('renders a page once for however many consumers ask', async () => {
    const snapshots = new PageSnapshots(() => ({}) as never)
    const p = page('a')
    const [one, two] = await Promise.all([snapshots.get(p, SIZE), snapshots.get(p, SIZE)])
    expect(one).toBe(two)
    expect(render.renderPageToCanvas).toHaveBeenCalledTimes(1)
    expect(await snapshots.get(p, SIZE)).toBe(one)
    expect(render.renderPageToCanvas).toHaveBeenCalledTimes(1)
    snapshots.dispose()
  })

  it('does not render a page everybody stopped waiting for, and renders the newest request first', async () => {
    const snapshots = new PageSnapshots(() => ({}) as never)
    const order: string[] = []
    render.renderPageToCanvas.mockImplementation(async (p: DocPage) => {
      order.push(p.id)
      return {}
    })
    const gone = new AbortController()
    const results = [
      snapshots.get(page('scrolled-past'), SIZE, gone.signal),
      snapshots.get(page('older'), SIZE, new AbortController().signal),
      snapshots.get(page('newest'), SIZE, new AbortController().signal),
    ]
    gone.abort()
    await drain()
    expect(order).toEqual(['newest', 'older'])
    expect(await results[0]).toBe('')
    expect(await results[2]).toMatch(/^blob:/)
    snapshots.dispose()
  })

  it('asks again for a page whose request was skipped', async () => {
    const snapshots = new PageSnapshots(() => ({}) as never)
    const p = page('a')
    const gone = new AbortController()
    const first = snapshots.get(p, SIZE, gone.signal)
    gone.abort()
    await drain()
    expect(await first).toBe('')
    const url = await snapshots.get(p, SIZE)
    expect(url).toMatch(/^blob:/)
    snapshots.dispose()
  })

  it('releases the bitmaps of old versions of a page, keeping the latest few', async () => {
    const snapshots = new PageSnapshots(() => ({}) as never)
    const versions = Array.from({ length: VERSIONS_KEPT + 2 }, (_, i) => page('a', i))
    for (const v of versions) await snapshots.get(v, SIZE)
    expect(created).toHaveLength(versions.length)
    expect(revoked).toEqual(created.slice(0, 2))
    // The oldest version is rendered again if it comes back (an undo) instead of showing a released bitmap.
    await snapshots.get(versions[0], SIZE)
    expect(created).toHaveLength(versions.length + 1)
    snapshots.dispose()
    expect(revoked).toHaveLength(created.length)
  })

  it('keeps the bitmaps of different pages apart', async () => {
    const snapshots = new PageSnapshots(() => ({}) as never)
    for (const id of ['a', 'b', 'c', 'd', 'e']) await snapshots.get(page(id), SIZE)
    expect(revoked).toEqual([])
    snapshots.dispose()
  })
})
