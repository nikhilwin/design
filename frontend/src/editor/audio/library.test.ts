import { describe, expect, it, vi } from 'vitest'
import { CatalogueError, CatalogueStore, type CatalogueEntry, durationBand, facetsOf, filterEntries, parseCatalogue, readEntry, trackInputFor } from './library'

const BASE = '/media/audio/'

const row = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sunrise-run',
  kind: 'music',
  title: 'Sunrise Run',
  mood: 'upbeat',
  genre: 'pop',
  tags: ['happy', 'energetic'],
  bpm: 124,
  key: 'C major',
  loop: true,
  channels: 2,
  durationMs: 30_974,
  lufs: -16,
  bytes: 228_316,
  peaks: [10, 80, 100],
  file: 'music/sunrise-run-3d0f7ef96135.ogg',
  license: 'CC0-1.0',
  source: 'doory',
  ...patch,
})

const sfx = (patch: Record<string, unknown> = {}): Record<string, unknown> => row({ id: 'pop-small', kind: 'sfx', title: 'Small Pop', mood: undefined, category: 'ui', genre: undefined, tags: ['pop', 'bubble'], bpm: undefined, key: undefined, loop: false, durationMs: 120, file: 'sfx/pop-small-aaaaaaaaaaaa.ogg', ...patch })

const catalogue = (tracks: unknown[]) => JSON.stringify({ schema: 1, release: '2026.10.1', license: { spdx: 'CC0-1.0' }, tracks, packs: [] })

describe('readEntry', () => {
  it('reads a row and resolves its file against the catalogue folder', () => {
    expect(readEntry(row(), BASE)).toMatchObject({ id: 'sunrise-run', kind: 'music', mood: 'upbeat', bpm: 124, key: 'C major', url: '/media/audio/music/sunrise-run-3d0f7ef96135.ogg', loop: true, channels: 2, source: 'doory' })
  })

  it.each([
    ['a path above the folder', { file: '../secret.ogg' }],
    ['an absolute path', { file: '/etc/passwd' }],
    ['a full address', { file: 'https://evil.example/a.ogg' }],
    ['a protocol-relative address', { file: '//evil.example/a.ogg' }],
    ['an empty file', { file: '' }],
    ['a path with a dot segment inside', { file: 'music/../../a.ogg' }],
    ['an id with capitals', { id: 'Sunrise' }],
    ['no title', { title: '   ' }],
    ['no duration', { durationMs: undefined }],
    ['a duration of a year', { durationMs: 10 ** 10 }],
    ['a music row without a mood', { mood: 'angry' }],
    ['an unknown kind', { kind: 'video' }],
  ])('leaves out a row with %s', (_name, patch) => {
    expect(readEntry(row(patch), BASE)).toBeNull()
  })

  it('leaves out an effect without a category and anything that is not an object', () => {
    expect(readEntry(sfx({ category: 'weather' }), BASE)).toBeNull()
    for (const raw of [null, 5, 'a', []]) expect(readEntry(raw, BASE)).toBeNull()
  })

  it('limits text and drops unusable optional values', () => {
    const entry = readEntry(row({ title: `${'x'.repeat(200)}\u0000y`, tags: Array(20).fill('a'), bpm: 9999, lufs: 'loud', peaks: ['a', 5, NaN] }), BASE)
    expect(entry?.title.length).toBeLessThanOrEqual(80)
    expect(entry?.tags).toHaveLength(8)
    expect(entry).not.toHaveProperty('bpm')
    expect(entry).not.toHaveProperty('lufs')
    expect(entry?.peaks).toEqual([5])
  })
})

describe('parseCatalogue', () => {
  it('reads the rows it can and skips the rest, and ignores duplicates', () => {
    const parsed = parseCatalogue(catalogue([row(), { nope: 1 }, row({ title: 'Again' }), sfx()]))
    expect(parsed.entries.map((e) => e.id)).toEqual(['sunrise-run', 'pop-small'])
    expect(parsed.release).toBe('2026.10.1')
    expect(parsed.license).toBe('CC0-1.0')
  })

  it('reads pack credits and keeps only https homepages', () => {
    const body = JSON.stringify({ schema: 1, release: '1', license: {}, tracks: [row()], packs: [{ id: 'open', name: 'Open', homepage: 'javascript:alert(1)', license: { spdx: 'CC0-1.0' }, attribution: 'By A.' }, { id: 'ok', name: 'Ok', homepage: 'https://example.org', license: { spdx: 'CC0-1.0' }, attribution: '' }] })
    const { packs } = parseCatalogue(body)
    expect(packs).toEqual([expect.objectContaining({ id: 'open', homepage: '' }), expect.objectContaining({ id: 'ok', homepage: 'https://example.org' })])
  })

  it('refuses text that is not a catalogue', () => {
    for (const body of ['', 'not json', '[]', '{"schema":2,"tracks":[]}', '{"schema":1}']) {
      expect(() => parseCatalogue(body)).toThrow(CatalogueError)
    }
  })

  it('takes the base folder from where the catalogue came from', () => {
    const { entries } = parseCatalogue(catalogue([row()]), '/cdn/audio/index.json')
    expect(entries[0].url).toBe('/cdn/audio/music/sunrise-run-3d0f7ef96135.ogg')
  })
})

describe('filterEntries', () => {
  const entries = parseCatalogue(
    catalogue([
      row(),
      row({ id: 'still-water', title: 'Still Water', mood: 'calm', genre: 'ambient', tags: ['peaceful', 'piano'], bpm: 68, durationMs: 42_350, file: 'music/still-water-bbbbbbbbbbbb.ogg' }),
      row({ id: 'rising-horizon', title: 'Rising Horizon', mood: 'cinematic', genre: 'orchestral', tags: ['epic', 'trailer'], durationMs: 47_000, file: 'music/rising-horizon-cccccccccccc.ogg' }),
      sfx(),
      sfx({ id: 'whoosh-fast', title: 'Fast Whoosh', category: 'whoosh', tags: ['whoosh', 'swoosh'], durationMs: 450, file: 'sfx/whoosh-fast-dddddddddddd.ogg' }),
      sfx({ id: 'riser-long', title: 'Long Riser', category: 'riser', tags: ['build'], durationMs: 3500, file: 'sfx/riser-long-eeeeeeeeeeee.ogg' }),
    ]),
  ).entries
  const ids = (list: CatalogueEntry[]): string[] => list.map((e) => e.id)

  it('lists one kind at a time in catalogue order', () => {
    expect(ids(filterEntries(entries, { kind: 'music', query: '' }))).toEqual(['sunrise-run', 'still-water', 'rising-horizon'])
    expect(ids(filterEntries(entries, { kind: 'sfx', query: '' }))).toEqual(['pop-small', 'whoosh-fast', 'riser-long'])
  })

  it('searches titles, tags, moods, genres and keys, ignoring case and accents, every word must match', () => {
    expect(ids(filterEntries(entries, { kind: 'music', query: 'PEACEFUL' }))).toEqual(['still-water'])
    expect(ids(filterEntries(entries, { kind: 'music', query: 'orch' }))).toEqual(['rising-horizon'])
    expect(ids(filterEntries(entries, { kind: 'music', query: 'c major pop' }))).toEqual(['sunrise-run', 'rising-horizon'].filter((id) => id === 'sunrise-run'))
    expect(ids(filterEntries(entries, { kind: 'music', query: 'cinematic epic' }))).toEqual(['rising-horizon'])
    expect(filterEntries(entries, { kind: 'music', query: 'zzz' })).toEqual([])
    expect(ids(filterEntries(entries, { kind: 'sfx', query: 'whoosh' }))).toEqual(['whoosh-fast'])
  })

  it('puts title matches before tag matches', () => {
    const list = parseCatalogue(catalogue([row({ id: 'a-tagged', title: 'Alpha', tags: ['rise'], file: 'music/a-aaaaaaaaaaaa.ogg' }), row({ id: 'b-titled', title: 'Rise Up', tags: [], file: 'music/b-bbbbbbbbbbbb.ogg' })])).entries
    expect(ids(filterEntries(list, { kind: 'music', query: 'rise' }))).toEqual(['b-titled', 'a-tagged'])
  })

  it('filters by mood, category, genre and duration', () => {
    expect(ids(filterEntries(entries, { kind: 'music', query: '', mood: 'calm' }))).toEqual(['still-water'])
    expect(ids(filterEntries(entries, { kind: 'sfx', query: '', category: 'whoosh' }))).toEqual(['whoosh-fast'])
    expect(ids(filterEntries(entries, { kind: 'music', query: '', genre: 'orchestral' }))).toEqual(['rising-horizon'])
    expect(ids(filterEntries(entries, { kind: 'music', query: '', duration: 'short' }))).toEqual(['sunrise-run'])
    expect(ids(filterEntries(entries, { kind: 'music', query: '', duration: 'medium' }))).toEqual(['still-water'])
    expect(ids(filterEntries(entries, { kind: 'music', query: '', duration: 'long' }))).toEqual(['rising-horizon'])
    expect(ids(filterEntries(entries, { kind: 'sfx', query: '', duration: 'long' }))).toEqual(['riser-long'])
  })

  it('sorts', () => {
    expect(ids(filterEntries(entries, { kind: 'music', query: '', sort: 'title' }))).toEqual(['rising-horizon', 'still-water', 'sunrise-run'])
    expect(ids(filterEntries(entries, { kind: 'music', query: '', sort: 'longest' }))).toEqual(['rising-horizon', 'still-water', 'sunrise-run'])
    expect(ids(filterEntries(entries, { kind: 'sfx', query: '', sort: 'shortest' }))).toEqual(['pop-small', 'whoosh-fast', 'riser-long'])
  })

  it('counts what each filter would show', () => {
    const facets = facetsOf(entries, 'music')
    expect(facets.moods).toEqual([{ value: 'upbeat', count: 1 }, { value: 'calm', count: 1 }, { value: 'cinematic', count: 1 }])
    expect(facets.bands).toEqual({ short: 1, medium: 1, long: 1 })
    expect(facetsOf(entries, 'sfx').categories.map((c) => c.value)).toEqual(['ui', 'whoosh', 'riser'])
  })

  it('has duration bands that differ for music and effects', () => {
    expect([durationBand('music', 30_000), durationBand('music', 40_000), durationBand('music', 50_000)]).toEqual(['short', 'medium', 'long'])
    expect([durationBand('sfx', 500), durationBand('sfx', 2000), durationBand('sfx', 4000)]).toEqual(['short', 'medium', 'long'])
  })

  it('stays fast on a big catalogue', () => {
    const many = Array.from({ length: 3000 }, (_, i) => readEntry(row({ id: `t${i}`, title: `Track ${i} ${i % 7 ? 'mellow' : 'bright'}`, file: `music/t${i}-aaaaaaaaaaaa.ogg` }), BASE) as CatalogueEntry)
    const started = performance.now()
    const found = filterEntries(many, { kind: 'music', query: 'bright track' })
    expect(found.length).toBeGreaterThan(400)
    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('trackInputFor', () => {
  it('makes a music loop and a one-shot effect', () => {
    const [music] = parseCatalogue(catalogue([row()])).entries
    expect(trackInputFor(music, { type: 'design' })).toMatchObject({ kind: 'music', name: 'Sunrise Run', src: music.url, durationMs: 30_974, libraryId: 'sunrise-run' })
    const [effect] = parseCatalogue(catalogue([sfx()])).entries
    expect(trackInputFor(effect, { type: 'page', pageId: 'p1' })).toMatchObject({ kind: 'sfx', scope: { type: 'page', pageId: 'p1' } })
  })
})

describe('CatalogueStore', () => {
  it('loads once on first use and tells its listeners', async () => {
    const parsed = { ...parseCatalogue(catalogue([row()])), fromCache: false }
    const load = vi.fn(async () => parsed)
    const store = new CatalogueStore(load)
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.getSnapshot().status).toBe('loading')
    store.ensure()
    store.ensure()
    await Promise.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(listener).toHaveBeenCalled()
  })

  it('reports a failure and tries again on reload', async () => {
    const parsed = { ...parseCatalogue(catalogue([row()])), fromCache: false }
    const load = vi.fn().mockRejectedValueOnce(new CatalogueError('not-installed', 'Not installed.')).mockResolvedValueOnce(parsed)
    const store = new CatalogueStore(load)
    store.ensure()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', code: 'not-installed', message: 'Not installed.' })
    // A re-render calls `ensure()` again: it must not start another request on its own.
    store.ensure()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    store.reload()
    expect(store.getSnapshot().status).toBe('loading')
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().status).toBe('ready')
  })

  it('ignores the answer of a load that a reload has replaced', async () => {
    const parsed = { ...parseCatalogue(catalogue([row()])), fromCache: false }
    let rejectFirst: (error: Error) => void = () => undefined
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockResolvedValueOnce(parsed)
    const store = new CatalogueStore(load)
    store.ensure()
    store.reload()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().status).toBe('ready')
    rejectFirst(new Error('late'))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().status).toBe('ready')
  })
})
