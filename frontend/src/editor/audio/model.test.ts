import { describe, expect, it } from 'vitest'
import type { AudioTrack, DoryDocument } from '@/types/document'
import { MAX_TRACKS, KIND_DEFAULTS, createTrack, ducks, isAudible, isPlayableSrc, normalizeTrack, orphanedTracks, patchTrack, readTracks, trimmedLengthMs, withTracks } from './model'

const track = (patch: Partial<AudioTrack> = {}): AudioTrack => ({
  id: 't1',
  kind: 'music',
  name: 'Theme',
  src: '/media/audio/music/theme-0123456789ab.ogg',
  scope: { type: 'design' },
  startMs: 0,
  durationMs: 40_000,
  trimStartMs: 0,
  trimEndMs: 40_000,
  volume: 0.5,
  fadeInMs: 800,
  fadeOutMs: 1500,
  loop: true,
  muted: false,
  ...patch,
})

const doc = (audioTracks?: unknown): DoryDocument =>
  ({ schemaVersion: 1, width: 100, height: 100, unit: 'px', pages: [{ id: 'p1', background: { type: 'solid', color: '#fff' }, objects: [] }], audioTracks }) as DoryDocument

describe('normalizeTrack', () => {
  it('keeps a valid track as it is', () => {
    expect(normalizeTrack(track())).toEqual(track())
  })

  it('refuses what is not a track', () => {
    for (const raw of [null, 5, 'a', [], {}, { id: '' }, { id: 'x' }, { id: 'x', kind: 'video', src: '/a.ogg' }, { id: 'x', kind: 'sfx', src: '' }, { id: 'x'.repeat(65), kind: 'sfx', src: '/a.ogg' }]) {
      expect(normalizeTrack(raw)).toBeNull()
    }
  })

  it('limits every number to its range', () => {
    const t = normalizeTrack({ ...track(), startMs: -50, volume: 4, fadeInMs: 10 ** 9, fadeOutMs: -1, trimStartMs: -5 })
    expect(t).toMatchObject({ startMs: 0, volume: 1, fadeInMs: 60_000, fadeOutMs: 0, trimStartMs: 0 })
  })

  it('falls back to the defaults of its kind for settings that are not numbers', () => {
    const t = normalizeTrack({ id: 'x', kind: 'voiceover', src: '/media/a.weba', volume: 'loud', fadeInMs: NaN, loop: 'yes' })
    expect(t).toMatchObject({ volume: KIND_DEFAULTS.voiceover.volume, fadeInMs: 0, loop: false, muted: false })
  })

  it('swaps a trim that is the wrong way round and widens one that is too short', () => {
    expect(normalizeTrack(track({ trimStartMs: 9000, trimEndMs: 3000 }))).toMatchObject({ trimStartMs: 3000, trimEndMs: 9000 })
    const short = normalizeTrack(track({ trimStartMs: 5000, trimEndMs: 5001 }))
    expect(trimmedLengthMs(short as AudioTrack)).toBeGreaterThanOrEqual(50)
  })

  it('keeps the trim inside the source when the source length is known', () => {
    expect(normalizeTrack(track({ durationMs: 10_000, trimStartMs: 2000, trimEndMs: 99_000 }))).toMatchObject({ trimStartMs: 2000, trimEndMs: 10_000 })
  })

  it('cleans the name and drops unknown fields', () => {
    const t = normalizeTrack({ ...track(), name: '  A\u0000  loud\n\tname  ', extra: 1 })
    expect(t?.name).toBe('A loud name')
    expect(t).not.toHaveProperty('extra')
    expect(normalizeTrack({ ...track(), name: 'x'.repeat(500) })?.name).toHaveLength(200)
  })

  it('does not cut a surrogate pair in half', () => {
    const name = `${'a'.repeat(199)}😀`
    const out = normalizeTrack({ ...track(), name })?.name as string
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('\ud83d')).toBe(false)
  })

  it('turns a scope it does not understand into the design scope', () => {
    expect(normalizeTrack(track({ scope: { type: 'page', pageId: 'p1' } }))?.scope).toEqual({ type: 'page', pageId: 'p1' })
    for (const scope of [null, 'page', { type: 'page' }, { type: 'page', pageId: 5 }, { type: 'all' }]) {
      expect(normalizeTrack({ ...track(), scope })?.scope).toEqual({ type: 'design' })
    }
  })

  it('keeps optional ids only when they are strings', () => {
    expect(normalizeTrack({ ...track(), assetId: 'a1', libraryId: 'sunrise-run', duckUnderVoiceover: false })).toMatchObject({ assetId: 'a1', libraryId: 'sunrise-run', duckUnderVoiceover: false })
    const t = normalizeTrack({ ...track(), assetId: 5, libraryId: {}, duckUnderVoiceover: 'no' })
    expect(t).not.toHaveProperty('assetId')
    expect(t).not.toHaveProperty('libraryId')
    expect(t).not.toHaveProperty('duckUnderVoiceover')
  })
})

describe('sources', () => {
  it.each([
    ['https://cdn.example.com/a.mp3', true],
    ['/media/assets/u/a.wav', true],
    ['idb://0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a', true],
    ['//evil.example/a.ogg', false],
    ['http://example.com/a.ogg', false],
    ['javascript:alert(1)', false],
    ['data:audio/wav;base64,AAAA', false],
    ['blob:https://x.example/uuid', false],
    ['idb://not-a-uuid', false],
    ['https://', false],
    ['', false],
    [5, false],
  ])('%s -> %s', (src, ok) => {
    expect(isPlayableSrc(src)).toBe(ok)
  })
})

describe('readTracks', () => {
  it('is empty for a document without audio', () => {
    expect(readTracks(doc())).toEqual([])
    expect(readTracks(doc('nope'))).toEqual([])
    expect(readTracks(doc([]))).toEqual([])
  })

  it('drops unreadable entries and duplicate ids', () => {
    const list = readTracks(doc([track(), { nope: 1 }, track({ name: 'copy' }), track({ id: 't2' })]))
    expect(list.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(list[0].name).toBe('Theme')
  })

  it('reads at most 32 tracks', () => {
    const many = Array.from({ length: 40 }, (_, i) => track({ id: `t${i}` }))
    expect(readTracks(doc(many))).toHaveLength(MAX_TRACKS)
  })

  it('keeps references of tracks that are already normal, and caches per array', () => {
    const raw = [track()]
    const d = doc(raw)
    const list = readTracks(d)
    expect(list[0]).toBe(raw[0])
    expect(readTracks(d)).toBe(list)
  })
})

describe('withTracks', () => {
  it('writes the list and removes the property for an empty one', () => {
    const d = doc()
    const written = withTracks(d, [track()])
    expect(written.audioTracks).toEqual([track()])
    expect(d.audioTracks).toBeUndefined()
    const cleared = withTracks(written, [])
    expect('audioTracks' in cleared).toBe(false)
    expect(withTracks(d, [])).toBe(d)
  })
})

describe('createTrack', () => {
  it('uses the defaults of the kind and trims to the whole source', () => {
    const t = createTrack({ kind: 'music', name: 'Theme', src: '/media/a.ogg', durationMs: 30_000, libraryId: 'theme' })
    expect(t).toMatchObject({ kind: 'music', startMs: 0, trimStartMs: 0, trimEndMs: 30_000, loop: true, volume: 0.5, fadeInMs: 800, libraryId: 'theme', muted: false })
    expect(t.scope).toEqual({ type: 'design' })
    expect(normalizeTrack(t)).toEqual(t)
  })

  it('keeps fades inside a short sound', () => {
    const t = createTrack({ kind: 'music', name: 'Blip', src: '/media/a.ogg', durationMs: 600 })
    expect(t.fadeInMs + t.fadeOutMs).toBeLessThanOrEqual(600)
  })

  it('gives sounds without a name the name of their kind', () => {
    expect(createTrack({ kind: 'voiceover', name: '  ', src: '/media/a.weba', durationMs: 1000 }).name).toBe('Voiceover')
  })

  it('never makes two tracks with one id', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createTrack({ kind: 'sfx', name: 'a', src: '/a.ogg', durationMs: 100 }).id))
    expect(ids.size).toBe(20)
  })
})

describe('patchTrack', () => {
  it('applies a patch and limits it again', () => {
    expect(patchTrack(track(), { volume: 3, fadeInMs: -9 })).toMatchObject({ volume: 1, fadeInMs: 0 })
    expect(patchTrack(track(), { trimEndMs: 100_000 }).trimEndMs).toBe(40_000)
  })

  it('removes a setting patched to undefined', () => {
    expect(patchTrack(track({ duckUnderVoiceover: true }), { duckUnderVoiceover: undefined })).not.toHaveProperty('duckUnderVoiceover')
  })

  it('never changes id, kind or source', () => {
    const patched = patchTrack(track(), { id: 'other', kind: 'sfx', src: '/x.ogg' } as never)
    expect(patched).toMatchObject({ id: 't1', kind: 'music', src: '/media/audio/music/theme-0123456789ab.ogg' })
  })
})

describe('small rules', () => {
  it('ducks music unless told otherwise', () => {
    expect(ducks(track())).toBe(true)
    expect(ducks(track({ kind: 'sfx' }))).toBe(false)
    expect(ducks(track({ duckUnderVoiceover: false }))).toBe(false)
    expect(ducks(track({ kind: 'upload', duckUnderVoiceover: true }))).toBe(true)
  })

  it('is audible unless muted or silent', () => {
    expect(isAudible(track())).toBe(true)
    expect(isAudible(track({ muted: true }))).toBe(false)
    expect(isAudible(track({ volume: 0 }))).toBe(false)
  })

  it('finds tracks of pages that are gone', () => {
    const tracks = [track(), track({ id: 'a', scope: { type: 'page', pageId: 'p1' } }), track({ id: 'b', scope: { type: 'page', pageId: 'gone' } })]
    expect(orphanedTracks(tracks, new Set(['p1'])).map((t) => t.id)).toEqual(['b'])
  })
})
