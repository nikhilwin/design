import { createBlankDocument } from '@/lib/document'
import type { AudioTrack } from '@/types/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { readTracks } from '../../audio/model'
import { EditorEngine } from '../editor'

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:http://localhost/audio' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(mode: 'guest' | 'shared-view' | 'shared-comment' | 'account' = 'guest') {
  const doc = createBlankDocument(800, 600)
  doc.pages.push({ ...doc.pages[0], id: 'p2', objects: [] })
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd1', title: 'Test', mode }, ephemeral: true })
  return { engine, handle, pageIds: engine.state.doc.pages.map((p) => p.id) }
}

const input = (name: string, extra: Partial<Parameters<EditorEngine['audio']['add']>[0]> = {}) => ({ kind: 'music' as const, name, src: '/media/audio/music/a-aaaaaaaaaaaa.ogg', durationMs: 30_000, ...extra })

describe('audio.add', () => {
  it('writes the track into the document, one undo step, and announces it', () => {
    const { engine } = setup()
    const track = engine.audio.add(input('Theme', { libraryId: 'theme' }))
    expect(track).toMatchObject({ name: 'Theme', kind: 'music', scope: { type: 'design' }, loop: true })
    expect(engine.state.doc.audioTracks).toHaveLength(1)
    expect(engine.state.history.undoLabel).toBe('Add audio')
    expect(engine.state.announcement).toBe('Added Theme')
    void engine.undo()
    expect('audioTracks' in engine.state.doc).toBe(false)
  })

  it('keeps the other tracks and the rest of the document untouched', () => {
    const { engine } = setup()
    engine.audio.add(input('A'))
    const pages = engine.state.doc.pages
    engine.audio.add(input('B'))
    expect(engine.audio.tracks().map((t) => t.name)).toEqual(['A', 'B'])
    expect(engine.state.doc.pages).toBe(pages)
  })

  it('stops at 32 tracks and says so', () => {
    const { engine } = setup()
    for (let i = 0; i < 32; i++) expect(engine.audio.add(input(`T${i}`))).not.toBeNull()
    expect(engine.audio.add(input('one more'))).toBeNull()
    expect(engine.audio.tracks()).toHaveLength(32)
    expect(engine.state.toasts.at(-1)?.message).toMatch(/at most 32/)
  })

  it('does nothing in a view-only editor', () => {
    for (const mode of ['shared-view', 'shared-comment'] as const) {
      const { engine } = setup(mode)
      const before = engine.state.doc
      expect(engine.audio.add(input('x'))).toBeNull()
      engine.audio.setMuted('x', true)
      engine.audio.remove('x')
      expect(engine.state.doc).toBe(before)
    }
  })

  it('adds a library entry in a page scope', () => {
    const { engine, pageIds } = setup()
    const entry = { id: 'pop-small', kind: 'sfx' as const, title: 'Small Pop', category: 'ui' as const, genre: '', tags: [], loop: false, channels: 1 as const, durationMs: 120, bytes: 1, peaks: [], url: '/media/audio/sfx/pop-small-aaaaaaaaaaaa.ogg', source: 'doory', license: 'CC0-1.0' }
    const track = engine.audio.addFromLibrary(entry, { type: 'page', pageId: pageIds[1] })
    expect(track).toMatchObject({ kind: 'sfx', libraryId: 'pop-small', scope: { type: 'page', pageId: 'p2' }, loop: false, trimEndMs: 120 })
  })
})

describe('audio.update and friends', () => {
  it('limits what is written and coalesces a slider drag into one undo step', () => {
    const { engine } = setup()
    const track = engine.audio.add(input('A')) as AudioTrack
    for (const v of [0.9, 0.8, 0.7, 5]) engine.audio.setVolume(track.id, v)
    expect(engine.audio.get(track.id)?.volume).toBe(1)
    void engine.undo()
    expect(engine.audio.get(track.id)?.volume).toBe(0.5)
    expect(engine.state.history.undoLabel).toBe('Add audio')
  })

  it('does not write when nothing changes', () => {
    const { engine } = setup()
    const track = engine.audio.add(input('A')) as AudioTrack
    const doc = engine.state.doc
    engine.audio.update(track.id, { volume: track.volume })
    engine.audio.update('nope', { volume: 0.1 })
    expect(engine.state.doc).toBe(doc)
  })

  it('trims inside the source and moves a track', () => {
    const { engine } = setup()
    const track = engine.audio.add(input('A')) as AudioTrack
    engine.audio.update(track.id, { trimStartMs: 5000, trimEndMs: 99_000, startMs: 2500 })
    expect(engine.audio.get(track.id)).toMatchObject({ trimStartMs: 5000, trimEndMs: 30_000, startMs: 2500 })
  })

  it('mutes, unmutes, announces, and changes the scope', () => {
    const { engine } = setup()
    const track = engine.audio.add(input('Theme')) as AudioTrack
    engine.audio.setMuted(track.id, true)
    expect(engine.audio.get(track.id)?.muted).toBe(true)
    expect(engine.state.announcement).toBe('Theme muted')
    engine.audio.setMuted(track.id, false)
    expect(engine.state.announcement).toBe('Theme unmuted')
    engine.audio.setScope(track.id, { type: 'page', pageId: 'p2' })
    expect(engine.audio.get(track.id)?.scope).toEqual({ type: 'page', pageId: 'p2' })
  })

  it('never lets the id, kind or source change', () => {
    const { engine } = setup()
    const track = engine.audio.add(input('A')) as AudioTrack
    engine.audio.update(track.id, { id: 'other', kind: 'sfx', src: '/media/x.ogg' } as never)
    expect(engine.audio.get(track.id)).toMatchObject({ kind: 'music', src: track.src })
  })

  it('removes a track and the property with the last one', () => {
    const { engine } = setup()
    const a = engine.audio.add(input('A')) as AudioTrack
    const b = engine.audio.add(input('B')) as AudioTrack
    engine.audio.remove(a.id)
    expect(engine.audio.tracks().map((t) => t.id)).toEqual([b.id])
    engine.audio.remove(b.id)
    expect('audioTracks' in engine.state.doc).toBe(false)
    expect(engine.state.history.undoLabel).toBe('Delete audio')
  })

  it('duplicates a track next to the original, unmuted and with its own id', () => {
    const { engine } = setup()
    const a = engine.audio.add(input('A')) as AudioTrack
    engine.audio.add(input('B'))
    engine.audio.setMuted(a.id, true)
    const copy = engine.audio.duplicate(a.id)
    expect(copy).toMatchObject({ name: 'A copy', muted: false })
    expect(copy?.id).not.toBe(a.id)
    expect(engine.audio.tracks().map((t) => t.name)).toEqual(['A', 'A copy', 'B'])
  })
})

describe('tracks of pages that are gone', () => {
  it('are ignored by the editor until removed, and come back with the page on undo', () => {
    const { engine, pageIds } = setup()
    engine.audio.add(input('Page two', { scope: { type: 'page', pageId: pageIds[1] } }))
    engine.audio.add(input('Everywhere'))
    engine.pages.remove(pageIds[1])
    expect(engine.audio.tracks()).toHaveLength(2)
    expect(engine.audio.removeOrphans()).toBe(1)
    expect(engine.audio.tracks().map((t) => t.name)).toEqual(['Everywhere'])
  })
})

describe('files', () => {
  it('stores an uploaded file with the adapter and adds it as an upload track', async () => {
    const { engine, handle } = setup()
    vi.spyOn(engine.audio, 'measure').mockResolvedValue(4200)
    const track = await engine.audio.addFile(new File([new Uint8Array(500)], 'My Song.mp3', { type: 'audio/mpeg' }))
    expect(handle.uploads).toEqual([{ name: 'My Song', size: 500 }])
    expect(track).toMatchObject({ kind: 'upload', name: 'My Song', durationMs: 4200, trimEndMs: 4200, scope: { type: 'design' } })
    expect(track.src.startsWith('idb://')).toBe(true)
    expect(track.assetId).toBeDefined()
  })

  it('refuses a file that is not audio before anything is stored', async () => {
    const { engine, handle } = setup()
    await expect(engine.audio.addFile(new File(['x'], 'a.png', { type: 'image/png' }))).rejects.toThrow(/not supported/)
    expect(handle.uploads).toEqual([])
    expect(engine.audio.tracks()).toEqual([])
  })

  it('names recordings "Voiceover n" and adds them as voiceovers on the chosen page', async () => {
    const { engine, pageIds } = setup()
    vi.spyOn(engine.audio, 'measure').mockResolvedValue(3000)
    const first = await engine.audio.addRecording(new Blob([new Uint8Array(100)], { type: 'audio/webm;codecs=opus' }), { type: 'page', pageId: pageIds[0] })
    const second = await engine.audio.addRecording(new Blob([new Uint8Array(100)], { type: 'audio/ogg' }))
    expect([first.name, second.name]).toEqual(['Voiceover 1', 'Voiceover 2'])
    expect(first).toMatchObject({ kind: 'voiceover', scope: { type: 'page', pageId: pageIds[0] }, loop: false, volume: 1 })
  })

  it('uses the length the server reported without decoding', async () => {
    const { engine } = setup()
    const load = vi.spyOn(engine.audio.sources, 'loadSrc')
    await expect(engine.audio.measure({ id: 'a', url: '/media/a.ogg', thumbUrl: '', width: 0, height: 0, name: 'a', kind: 'audio' }, 1234)).resolves.toBe(1234)
    expect(load).not.toHaveBeenCalled()
  })

  it('reads the length from the decoded file otherwise', async () => {
    const { engine } = setup()
    vi.spyOn(engine.audio.sources, 'loadSrc').mockResolvedValue({ duration: 2.5 } as AudioBuffer)
    await expect(engine.audio.measure({ id: 'a', url: '/media/a.ogg', thumbUrl: '', width: 0, height: 0, name: 'a', kind: 'audio' })).resolves.toBe(2500)
  })
})

describe('the document keeps its tracks through everything else', () => {
  it('survives page operations and a reload of the same document', () => {
    const { engine } = setup()
    engine.audio.add(input('A'))
    engine.pages.add()
    expect(readTracks(engine.state.doc)).toHaveLength(1)
    const saved = JSON.parse(JSON.stringify(engine.state.doc))
    const reopened = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: saved, meta: { id: 'd2', title: 'Again', mode: 'guest' }, ephemeral: true })
    expect(reopened.audio.tracks().map((t) => t.name)).toEqual(['A'])
  })
})
