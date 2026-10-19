import { createBlankDocument } from '@/lib/document'
import type { AssetRef, EditorAdapter } from '@/types/adapter'
import type { DocObject, DoryDocument } from '@/types/document'
import {
  AssetManager,
  UnsaveableDocumentError,
  UploadError,
  assertSaveable,
  isInlineSrc,
  validateImageFile,
} from './assets'

function docWith(objects: DocObject[]): DoryDocument {
  const d = createBlankDocument(100, 100)
  return { ...d, pages: [{ ...d.pages[0], objects }] }
}

function fakeAdapter(): { adapter: EditorAdapter; uploads: number } {
  const state = { uploads: 0 }
  const adapter = {
    uploadAsset: vi.fn(async (): Promise<AssetRef> => {
      state.uploads += 1
      return { id: `asset-${state.uploads}`, url: `/media/a${state.uploads}.png`, thumbUrl: '', width: 1, height: 1, name: 'x', kind: 'image' }
    }),
    resolveSrc: vi.fn(async (s: string) => `resolved:${s}`),
  } as unknown as EditorAdapter
  return {
    adapter,
    get uploads() {
      return state.uploads
    },
  }
}

describe('upload validation', () => {
  it('accepts supported image types and rejects others / oversized files', () => {
    expect(() => validateImageFile(new Blob(['x'], { type: 'image/png' }))).not.toThrow()
    expect(() => validateImageFile(new Blob(['x'], { type: 'application/pdf' }))).toThrow(UploadError)
    expect(() => validateImageFile(new Blob([new Uint8Array(20)], { type: 'image/png' }), 10)).toThrow(/larger than/)
  })

  it('recognises inline srcs', () => {
    expect(isInlineSrc('data:image/png;base64,AA')).toBe(true)
    expect(isInlineSrc('blob:http://x/1')).toBe(true)
    expect(isInlineSrc('idb://abc')).toBe(false)
    expect(isInlineSrc('/media/a.png')).toBe(false)
  })
})

describe('assertSaveable', () => {
  it('passes durable and idb:// srcs and small data URIs', () => {
    expect(() => assertSaveable(docWith([{ id: 'a', type: 'image', src: '/media/a.png' }, { id: 'b', type: 'image', src: 'idb://x' }, { id: 'c', type: 'image', src: 'data:image/png;base64,AAAA' }]))).not.toThrow()
  })

  it('rejects blob: anywhere, including nested groups', () => {
    const nested: DocObject = { id: 'g', type: 'group', objects: [{ id: 'i', type: 'image', src: 'blob:http://x/1' }] }
    expect(() => assertSaveable(docWith([nested]))).toThrow(UnsaveableDocumentError)
  })

  it('rejects data: strings over 64 KB', () => {
    const big = `data:image/png;base64,${'A'.repeat(70_000)}`
    expect(() => assertSaveable(docWith([{ id: 'a', type: 'image', src: big }]))).toThrow(/too large/)
  })
})

describe('AssetManager', () => {
  it('caches resolved srcs and passes inline srcs through', async () => {
    const { adapter } = fakeAdapter()
    const assets = new AssetManager(adapter)
    expect(await assets.resolve('idb://1')).toBe('resolved:idb://1')
    expect(await assets.resolve('idb://1')).toBe('resolved:idb://1')
    expect(adapter.resolveSrc).toHaveBeenCalledTimes(1)
    expect(await assets.resolve('data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
  })

  it('persistInline uploads each inline src once and rewrites objects and backgrounds', async () => {
    const fake = fakeAdapter()
    const assets = new AssetManager(fake.adapter)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Blob(['png']), { headers: { 'Content-Type': 'image/png' } }))
    const src = 'data:image/png;base64,AAAA'
    const doc: DoryDocument = docWith([
      { id: 'a', type: 'image', src },
      { id: 'g', type: 'group', objects: [{ id: 'b', type: 'image', src }] },
      { id: 'k', type: 'image', src: '/media/keep.png' },
    ])
    doc.pages[0].background = { type: 'image', src, fit: 'cover' }
    const out = await assets.persistInline(doc)
    expect(fake.uploads).toBe(1)
    expect(out.pages[0].objects[0].src).toBe('/media/a1.png')
    expect(out.pages[0].objects[0].assetId).toBe('asset-1')
    expect((out.pages[0].objects[1].objects as DocObject[])[0].src).toBe('/media/a1.png')
    expect(out.pages[0].objects[2].src).toBe('/media/keep.png')
    expect(out.pages[0].background).toMatchObject({ src: '/media/a1.png' })
    expect(doc.pages[0].objects[0].src).toBe(src)
    fetchSpy.mockRestore()
  })

  it('returns the same document when nothing is inline', async () => {
    const assets = new AssetManager(fakeAdapter().adapter)
    const doc = docWith([{ id: 'a', type: 'image', src: '/media/a.png' }])
    expect(await assets.persistInline(doc)).toBe(doc)
  })
})

