import { afterEach, describe, expect, it, vi } from 'vitest'
import { CACHE_NAME, fetchAudio, fetchCatalogueText, FetchError, isLibraryUrl } from './cache'

function fakeCaches() {
  const store = new Map<string, Response>()
  const caches = {
    open: vi.fn(async (name: string) => {
      expect(name).toBe(CACHE_NAME)
      return {
        match: async (url: string) => store.get(url)?.clone(),
        put: async (url: string, response: Response) => void store.set(url, response),
      }
    }),
  }
  return { caches, store }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isLibraryUrl', () => {
  it('is true for the library folder of this site only', () => {
    expect(isLibraryUrl('/media/audio/music/a-aaaaaaaaaaaa.ogg')).toBe(true)
    expect(isLibraryUrl('/media/audio/index.json')).toBe(true)
    expect(isLibraryUrl('/media/assets/u/a.mp3')).toBe(false)
    expect(isLibraryUrl('https://evil.example/media/audio/a.ogg')).toBe(false)
    expect(isLibraryUrl('blob:http://localhost/xyz')).toBe(false)
  })
})

describe('fetchAudio', () => {
  it('keeps a library file after the first download and serves it from the copy afterwards', async () => {
    const { caches, store } = fakeCaches()
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('caches', caches)
    vi.stubGlobal('fetch', fetchMock)
    expect(new Uint8Array(await fetchAudio('/media/audio/sfx/pop-aaaaaaaaaaaa.ogg'))).toEqual(new Uint8Array([1, 2, 3]))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.has('/media/audio/sfx/pop-aaaaaaaaaaaa.ogg')).toBe(true)
    fetchMock.mockRejectedValue(new TypeError('offline'))
    expect(new Uint8Array(await fetchAudio('/media/audio/sfx/pop-aaaaaaaaaaaa.ogg'))).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not keep files that are not the library’s', async () => {
    const { caches, store } = fakeCaches()
    vi.stubGlobal('caches', caches)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9]))))
    await fetchAudio('/media/assets/u/a.mp3')
    await Promise.resolve()
    expect(store.size).toBe(0)
  })

  it('throws FetchError for an HTTP error and works without Cache Storage', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(fetchAudio('/media/audio/x-aaaaaaaaaaaa.ogg')).rejects.toMatchObject({ name: 'FetchError', status: 404 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([7]))))
    expect(new Uint8Array(await fetchAudio('/media/audio/x-aaaaaaaaaaaa.ogg'))).toEqual(new Uint8Array([7]))
  })
})

describe('fetchCatalogueText', () => {
  it('asks the network first and falls back to the offline copy', async () => {
    const { caches } = fakeCaches()
    vi.stubGlobal('caches', caches)
    const fetchMock = vi.fn(async () => new Response('{"fresh":true}'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchCatalogueText('/media/audio/index.json')).toEqual({ text: '{"fresh":true}', fromCache: false })
    expect(fetchMock).toHaveBeenCalledWith('/media/audio/index.json', expect.objectContaining({ cache: 'no-cache' }))
    await Promise.resolve()
    await Promise.resolve()
    fetchMock.mockRejectedValue(new TypeError('offline'))
    expect(await fetchCatalogueText('/media/audio/index.json')).toEqual({ text: '{"fresh":true}', fromCache: true })
  })

  it('does not hide a missing catalogue behind an old copy, and rethrows when there is no copy', async () => {
    const { caches } = fakeCaches()
    vi.stubGlobal('caches', caches)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(fetchCatalogueText('/media/audio/index.json')).rejects.toBeInstanceOf(FetchError)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    await expect(fetchCatalogueText('/media/audio/index.json')).rejects.toBeInstanceOf(TypeError)
  })
})
