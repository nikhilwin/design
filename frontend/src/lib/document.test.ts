import { collectLocalAssetIds, createBlankDocument, rewriteLocalAssetSrcs } from './document'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

describe('document helpers', () => {
  it('creates a blank one-page document with clamped size', () => {
    const doc = createBlankDocument(99999, 0)
    expect(doc.pages).toHaveLength(1)
    expect(doc.width).toBe(20000)
    expect(doc.height).toBe(1)
  })

  it('collects and rewrites idb:// sources everywhere, including backgrounds and groups', () => {
    const doc = createBlankDocument(100, 100)
    doc.pages[0].background = { type: 'image', src: `idb://${ID_B}`, fit: 'cover' }
    doc.pages[0].objects = [
      { id: 'o1', type: 'image', src: `idb://${ID_A}` },
      { id: 'o2', type: 'group', objects: [{ id: 'o3', type: 'image', src: `idb://${ID_A}` }, { id: 'o4', type: 'image', src: 'https://x/y.png' }] },
    ]
    expect(collectLocalAssetIds(doc).sort()).toEqual([ID_A, ID_B])
    const out = rewriteLocalAssetSrcs(
      doc,
      new Map([
        [ID_A, { url: '/media/a.png', assetId: 'asset-a' }],
        [ID_B, { url: '/media/b.png' }],
      ]),
    )
    expect(collectLocalAssetIds(out)).toEqual([])
    expect(JSON.stringify(out)).toContain('/media/a.png')
    expect(out.pages[0].background).toMatchObject({ src: '/media/b.png' })
    expect(out.pages[0].objects[0]).toMatchObject({ src: '/media/a.png', assetId: 'asset-a' })
    expect(JSON.stringify(doc)).toContain('idb://') // original untouched
  })
})
