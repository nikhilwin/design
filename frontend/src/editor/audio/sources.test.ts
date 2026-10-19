import { describe, expect, it, vi } from 'vitest'
import { FetchError } from './cache'
import { AudioLoadError, SourceStore } from './sources'

const buffer = (seconds: number, channels = 2, rate = 48000): AudioBuffer =>
  ({ duration: seconds, length: Math.round(seconds * rate), numberOfChannels: channels, sampleRate: rate, getChannelData: () => new Float32Array(1) }) as unknown as AudioBuffer

const bytes = (n = 1000): ArrayBuffer => new ArrayBuffer(n)

describe('SourceStore', () => {
  it('fetches and decodes a file once, however often and however simultaneously it is asked for', async () => {
    const fetchBytes = vi.fn(async () => bytes())
    const decode = vi.fn(async () => buffer(2))
    const store = new SourceStore({ fetchBytes, decode })
    const [a, b] = await Promise.all([store.loadSrc('/media/a.ogg'), store.loadSrc('/media/a.ogg')])
    expect(a).toBe(b)
    await store.loadSrc('/media/a.ogg')
    expect(fetchBytes).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(store.peek('/media/a.ogg')).toBe(a)
  })

  it('resolves a guest address before fetching', async () => {
    const fetchBytes = vi.fn(async () => bytes())
    const store = new SourceStore({ resolveSrc: async (src) => `blob:resolved/${src.slice(6)}`, fetchBytes, decode: async () => buffer(1) })
    await store.loadSrc('idb://0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a')
    expect(fetchBytes).toHaveBeenCalledWith('blob:resolved/0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a')
  })

  it('names the file that is missing from the browser', async () => {
    const store = new SourceStore({
      resolveSrc: async () => {
        throw new Error('gone')
      },
    })
    await expect(store.loadSrc('idb://0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a', 'Intro')).rejects.toMatchObject({ code: 'missing', message: expect.stringContaining('“Intro”') })
  })

  it('tells a missing file from a failing network', async () => {
    const missing = new SourceStore({ fetchBytes: async () => Promise.reject(new FetchError('HTTP 404', 404)) })
    await expect(missing.loadSrc('/media/a.ogg', 'Theme')).rejects.toMatchObject({ code: 'missing' })
    const server = new SourceStore({ fetchBytes: async () => Promise.reject(new FetchError('HTTP 500', 500)) })
    await expect(server.loadSrc('/media/a.ogg')).rejects.toMatchObject({ code: 'network' })
    const offline = new SourceStore({ fetchBytes: async () => Promise.reject(new TypeError('Failed to fetch')) })
    await expect(offline.loadSrc('/media/a.ogg')).rejects.toMatchObject({ code: 'network' })
  })

  it('reports a file the browser cannot decode', async () => {
    const store = new SourceStore({ fetchBytes: async () => bytes(), decode: async () => Promise.reject(new DOMException('bad', 'EncodingError')) })
    const error = await store.loadSrc('/media/a.m4a', 'Song').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AudioLoadError)
    expect(error).toMatchObject({ code: 'decode', message: expect.stringContaining('could not be decoded') })
  })

  it('refuses a sound that is too long to hold in memory, and an oversize download', async () => {
    const long = new SourceStore({ fetchBytes: async () => bytes(), decode: async () => buffer(16 * 60) })
    await expect(long.loadSrc('/media/a.mp3')).rejects.toMatchObject({ code: 'too-long' })
    const huge = new SourceStore({ fetchBytes: async () => bytes(40 * 1024 * 1024), decode: async () => buffer(1) })
    await expect(huge.loadSrc('/media/b.mp3')).rejects.toMatchObject({ code: 'too-long' })
  })

  it('does not remember a failure', async () => {
    let n = 0
    const store = new SourceStore({ fetchBytes: async () => (n++ === 0 ? Promise.reject(new TypeError('x')) : bytes()), decode: async () => buffer(1) })
    await expect(store.loadSrc('/media/a.ogg')).rejects.toBeInstanceOf(AudioLoadError)
    await expect(store.loadSrc('/media/a.ogg')).resolves.toBeDefined()
  })

  it('forgets the least recently used buffers beyond its memory budget', async () => {
    const store = new SourceStore({ fetchBytes: async () => bytes(), decode: async () => buffer(10), budgetBytes: 10 * 48000 * 2 * 4 * 2.5 })
    for (const name of ['a', 'b', 'c']) await store.loadSrc(`/media/${name}.ogg`)
    expect(store.peek('/media/a.ogg')).toBeUndefined()
    expect(store.peek('/media/b.ogg')).toBeDefined()
    expect(store.peek('/media/c.ogg')).toBeDefined()
  })

  it('lets one caller give up without cancelling the load for the others', async () => {
    let finish: (b: AudioBuffer) => void = () => undefined
    const store = new SourceStore({ fetchBytes: async () => bytes(), decode: () => new Promise<AudioBuffer>((resolve) => (finish = resolve)) })
    const controller = new AbortController()
    const impatient = store.loadSrc('/media/a.ogg', '', controller.signal)
    const patient = store.loadSrc('/media/a.ogg')
    controller.abort()
    await expect(impatient).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    await Promise.resolve()
    finish(buffer(1))
    await expect(patient).resolves.toBeDefined()
  })

  it('does not decode what the person has already aborted', async () => {
    const store = new SourceStore({ fetchBytes: async () => bytes(), decode: async () => buffer(1) })
    const controller = new AbortController()
    controller.abort()
    await expect(store.loadSrc('/media/a.ogg', '', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
