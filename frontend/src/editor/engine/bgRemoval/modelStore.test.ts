import { BackgroundRemovalError } from '../bgRemoval'
import type { ModelDescriptor } from './model'
import { loadModel, MODEL_CACHE } from './modelStore'

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31) % 251)
const HASH = 'f'.repeat(64)

const model: ModelDescriptor = {
  id: 'm',
  name: 'M',
  url: 'https://doory.example/media/models/m/m-ffffffffffff.onnx',
  bytes: BYTES.length,
  sha256: HASH,
  input: { name: 'in', size: 64, mean: [0, 0, 0], std: [1, 1, 1], rescale: '255' },
  output: 'out',
}

const hash = async (data: ArrayBuffer): Promise<string> => (data.byteLength === BYTES.length && new Uint8Array(data)[5] === BYTES[5] ? HASH : '0'.repeat(64))

function streamed(data: Uint8Array, chunk = 100, init: ResponseInit = {}): Response {
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= data.length) return controller.close()
        controller.enqueue(data.slice(offset, offset + chunk))
        offset += chunk
      },
    }),
    init,
  )
}

class FakeCache {
  entries = new Map<string, Response>()
  putError: Error | null = null
  async match(url: string) {
    return this.entries.get(url)?.clone()
  }
  async put(url: string, response: Response) {
    if (this.putError) throw this.putError
    this.entries.set(url, response)
  }
  async delete(url: string) {
    return this.entries.delete(url)
  }
}

function storage(cache: FakeCache | null = new FakeCache()): { caches: CacheStorage; cache: FakeCache | null; opened: string[] } {
  const opened: string[] = []
  const caches = {
    open: async (name: string) => {
      opened.push(name)
      if (!cache) throw new Error('blocked')
      return cache
    },
  } as unknown as CacheStorage
  return { caches, cache, opened }
}

const fetchOf = (...responses: Array<Response | Error>) =>
  vi.fn(async () => {
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next ?? new Response(null, { status: 500 })
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>

describe('loadModel', () => {
  it('downloads with progress from the same origin, verifies and caches the file', async () => {
    const { caches, cache, opened } = storage()
    const fetchImpl = fetchOf(streamed(BYTES))
    const seen: Array<[string, number]> = []
    const data = await loadModel(model, (phase, percent) => seen.push([phase, percent]), undefined, { fetchImpl, caches, digest: hash })
    expect(new Uint8Array(data)).toEqual(BYTES)
    expect(fetchImpl).toHaveBeenCalledWith(model.url, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(seen[0]).toEqual(['downloading', 0])
    expect(seen.at(-1)).toEqual(['downloading', 100])
    expect(seen.every(([phase]) => phase === 'downloading')).toBe(true)
    const percents = seen.map(([, p]) => p)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    expect(percents.length).toBeGreaterThan(5)
    expect(opened).toEqual([MODEL_CACHE])
    const stored = cache?.entries.get(model.url)
    expect(stored?.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(BYTES)
  })

  it('uses the cached copy without touching the network', async () => {
    const { caches, cache } = storage()
    cache!.entries.set(model.url, new Response(BYTES))
    const fetchImpl = fetchOf()
    const seen: number[] = []
    const data = await loadModel(model, (_phase, percent) => seen.push(percent), undefined, { fetchImpl, caches, digest: hash })
    expect(new Uint8Array(data)).toEqual(BYTES)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(seen).toEqual([0, 100])
  })

  it('throws away a cached copy that is damaged and downloads again', async () => {
    const { caches, cache } = storage()
    const damaged = BYTES.slice()
    damaged[5] ^= 0xff
    cache!.entries.set(model.url, new Response(damaged))
    const fetchImpl = fetchOf(streamed(BYTES))
    const data = await loadModel(model, undefined, undefined, { fetchImpl, caches, digest: hash })
    expect(new Uint8Array(data)).toEqual(BYTES)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(await cache!.entries.get(model.url)!.arrayBuffer())).toEqual(BYTES)
  })

  it('throws away a cached copy of the wrong size', async () => {
    const { caches, cache } = storage()
    cache!.entries.set(model.url, new Response(BYTES.slice(0, 10)))
    const fetchImpl = fetchOf(streamed(BYTES))
    await loadModel(model, undefined, undefined, { fetchImpl, caches, digest: hash })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses a download whose hash is not the announced one and caches nothing', async () => {
    const { caches, cache } = storage()
    const tampered = BYTES.slice()
    tampered[5] ^= 0xff
    const error = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(streamed(tampered)), caches, digest: hash }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackgroundRemovalError)
    expect((error as Error).message).toMatch(/does not match/)
    expect(cache!.entries.size).toBe(0)
  })

  it('says the model is not installed on a 404 and reports other statuses', async () => {
    const missing = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(new Response('nope', { status: 404 })), caches: null, digest: null }).catch((e: unknown) => e)
    expect((missing as Error).message).toMatch(/not installed/)
    const broken = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(new Response('', { status: 502 })), caches: null, digest: null }).catch((e: unknown) => e)
    expect((broken as Error).message).toMatch(/HTTP 502/)
  })

  it('rejects a file of the wrong length, such as an HTML page served in place of the model', async () => {
    const html = new TextEncoder().encode('<!doctype html><title>Doory</title>')
    const short = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(streamed(html)), caches: null, digest: null }).catch((e: unknown) => e)
    expect((short as Error).message).toMatch(/incomplete/)
    const long = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(streamed(new Uint8Array(BYTES.length + 50))), caches: null, digest: null }).catch((e: unknown) => e)
    expect((long as Error).message).toMatch(/larger than expected/)
  })

  it('maps a network failure to a clear error', async () => {
    const error = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(new TypeError('Failed to fetch')), caches: null, digest: null }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackgroundRemovalError)
    expect((error as Error).message).toMatch(/could not be downloaded/)
  })

  it('stops downloading when aborted', async () => {
    const controller = new AbortController()
    let pulls = 0
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++
          if (pulls === 3) controller.abort()
          c.enqueue(new Uint8Array(10))
        },
      }),
    )
    const error = await loadModel(model, undefined, controller.signal, { fetchImpl: fetchOf(endless), caches: null, digest: null }).catch((e: unknown) => e)
    expect((error as Error).name).toBe('AbortError')
    expect(pulls).toBeLessThan(20)
  })

  it('does not start when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = fetchOf(streamed(BYTES))
    await expect(loadModel(model, undefined, controller.signal, { fetchImpl, caches: null, digest: null })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('works without Cache Storage or hashing (insecure context) and checks the size only', async () => {
    const data = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(streamed(BYTES)), caches: null, digest: null })
    expect(new Uint8Array(data)).toEqual(BYTES)
  })

  it('still works when the cache cannot be opened or written', async () => {
    const blocked = storage(null)
    const a = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(streamed(BYTES)), caches: blocked.caches, digest: hash })
    expect(new Uint8Array(a)).toEqual(BYTES)
    const full = storage()
    full.cache!.putError = new DOMException('Quota', 'QuotaExceededError')
    const b = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(streamed(BYTES)), caches: full.caches, digest: hash })
    expect(new Uint8Array(b)).toEqual(BYTES)
  })

  it('verifies the real SHA-256 with the page\'s crypto by default', async () => {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', BYTES)), (b) => b.toString(16).padStart(2, '0')).join('')
    const real = { ...model, sha256: digest }
    const ok = await loadModel(real, undefined, undefined, { fetchImpl: fetchOf(streamed(BYTES)), caches: null })
    expect(new Uint8Array(ok)).toEqual(BYTES)
    const flipped = BYTES.slice()
    flipped[0] ^= 1
    const error = await loadModel(real, undefined, undefined, { fetchImpl: fetchOf(streamed(flipped)), caches: null }).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/does not match/)
  })

  it('has no body to read', async () => {
    const error = await loadModel(model, undefined, undefined, { fetchImpl: fetchOf(new Response(null, { status: 200 })), caches: null, digest: null }).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/no content/)
  })
})
