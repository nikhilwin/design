import { createBlankDocument } from '@/lib/document'
import { LocalRepository, createMemoryStore } from '@/lib/local'
import type { AudioTrack } from '@/types/document'
import { createGuestAdapter } from './guestAdapter'
import { removeMissingAssetReferences } from './migrateLocalDesign'

const memoryRepo = () => new LocalRepository(async () => ({ store: createMemoryStore(), mode: 'memory' }))

function build() {
  const repo = memoryRepo()
  const adapter = createGuestAdapter({ localId: 'local-1', repository: repo, ensureSignedIn: async () => true, onMigrated: () => undefined })
  return { repo, adapter }
}

const ID = '0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a'
const OTHER = '7d0d52a4-2a3c-4e2b-a8cf-0c8b1b6f3f10'

const track = (src: string, id = 't1'): AudioTrack => ({ id, kind: 'music', name: 'T', src, scope: { type: 'design' }, startMs: 0, trimStartMs: 0, trimEndMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false, muted: false })

describe('the guest adapter and audio', () => {
  it('stores an audio file in the browser and refers to it as idb://', async () => {
    const { repo, adapter } = build()
    const ref = await adapter.uploadAsset(new File([new Uint8Array(5000)], 'song.mp3', { type: 'audio/mpeg' }), { name: 'Song' })
    expect(ref).toMatchObject({ kind: 'audio', name: 'Song', width: 0, height: 0, thumbUrl: '' })
    expect(ref.url).toBe(`idb://${ref.id}`)
    expect((await repo.getAsset(ref.id))?.mime).toBe('audio/mpeg')
  })

  it('accepts a recording that has no useful type', async () => {
    const { adapter } = build()
    const ref = await adapter.uploadAsset(new File([new Uint8Array(100)], 'Voiceover 1.webm', { type: '' }), { name: 'Voiceover 1' })
    expect(ref.kind).toBe('audio')
  })

  it('takes audio up to 25 MB, more than a picture', async () => {
    const { adapter } = build()
    await expect(adapter.uploadAsset(new File([new Uint8Array(11 * 1024 * 1024)], 'long.wav', { type: 'audio/wav' }))).resolves.toMatchObject({ kind: 'audio' })
    await expect(adapter.uploadAsset(new File([new Uint8Array(26 * 1024 * 1024)], 'huge.wav', { type: 'audio/wav' }))).rejects.toThrow(/25 MB/)
  })

  it('still reads pictures the way it did', async () => {
    const { adapter } = build()
    vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 20, close: () => undefined }))
    await expect(adapter.uploadAsset(new File(['x'], 'a.png', { type: 'image/png' }))).resolves.toMatchObject({ kind: 'image', width: 10, height: 20 })
    vi.unstubAllGlobals()
  })

  it('lists audio only when asked for it, like the server', async () => {
    const { adapter } = build()
    vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 20, close: () => undefined }))
    await adapter.uploadAsset(new File(['x'], 'a.png', { type: 'image/png' }))
    await adapter.uploadAsset(new File([new Uint8Array(10)], 'a.mp3', { type: 'audio/mpeg' }))
    vi.unstubAllGlobals()
    const everything = await adapter.services.assets.list({})
    expect(everything.results.map((a) => a.kind)).toEqual(['image'])
    const sounds = await adapter.services.assets.list({ kind: 'audio' })
    expect(sounds.results.map((a) => [a.kind, a.mime])).toEqual([['audio', 'audio/mpeg']])
  })

  it('resolves a stored sound to a URL the browser can fetch', async () => {
    const { adapter } = build()
    const url = 'blob:http://localhost/xyz'
    const create = vi.fn(() => url)
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create }))
    const ref = await adapter.uploadAsset(new File([new Uint8Array(10)], 'a.ogg', { type: 'audio/ogg' }))
    await expect(adapter.resolveSrc(ref.url)).resolves.toBe(url)
    vi.unstubAllGlobals()
  })
})

describe('missing sounds when a guest design moves to an account', () => {
  it('drops the tracks whose file is gone and keeps the others', () => {
    const doc = { ...createBlankDocument(10, 10), audioTracks: [track(`idb://${ID}`, 'gone'), track(`idb://${OTHER}`, 'kept'), track('/media/audio/music/a-aaaaaaaaaaaa.ogg', 'library')] }
    const result = removeMissingAssetReferences(doc, new Set([ID]))
    expect(result.audioTracks?.map((t) => t.id)).toEqual(['kept', 'library'])
  })

  it('removes the list when no track is left, and leaves a design without audio alone', () => {
    const doc = { ...createBlankDocument(10, 10), audioTracks: [track(`idb://${ID}`)] }
    expect('audioTracks' in removeMissingAssetReferences(doc, new Set([ID]))).toBe(false)
    expect('audioTracks' in removeMissingAssetReferences(createBlankDocument(10, 10), new Set([ID]))).toBe(false)
  })
})
