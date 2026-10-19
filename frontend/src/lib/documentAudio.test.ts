import type { AudioTrack } from '@/types/document'
import { collectLocalAssetIds, createBlankDocument, rewriteLocalAssetSrcs } from './document'

const ID = '0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a'

const track = (src: string): AudioTrack => ({ id: 't1', kind: 'voiceover', name: 'V', src, scope: { type: 'page', pageId: 'p' }, startMs: 0, trimStartMs: 0, trimEndMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false, muted: false })

describe('local files used by audio tracks', () => {
  it('are found with the pictures', () => {
    const doc = { ...createBlankDocument(10, 10), audioTracks: [track(`idb://${ID}`)] }
    expect(collectLocalAssetIds(doc)).toEqual([ID])
  })

  it('are rewritten to the uploaded address and asset id', () => {
    const doc = { ...createBlankDocument(10, 10), audioTracks: [track(`idb://${ID}`)] }
    const out = rewriteLocalAssetSrcs(doc, new Map([[ID, { url: '/media/assets/u/a.weba', assetId: 'server-id' }]]))
    expect(out.audioTracks?.[0]).toMatchObject({ src: '/media/assets/u/a.weba', assetId: 'server-id', scope: { type: 'page', pageId: 'p' } })
    expect(collectLocalAssetIds(out)).toEqual([])
  })

  it('leave a design without audio exactly as it was', () => {
    const doc = createBlankDocument(10, 10)
    expect('audioTracks' in rewriteLocalAssetSrcs(doc, new Map())).toBe(false)
  })
})
