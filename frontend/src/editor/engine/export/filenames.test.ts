import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { getSizePresets } from '@/lib/sizePresets'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorEngine } from '../editor'
import fixture from '../fixtures/export-filenames.json'
import { type StructuredParts, presetParts, structuredFilename } from './filenames'
import { runExport } from './exporter'
import { DEFAULT_EXPORT_OPTIONS } from './registry'
import { zipFilename } from './zip'

describe('structured file names', () => {
  it.each(fixture.cases)('$expected (the same as the server)', ({ input, expected }) => {
    expect(structuredFilename(input as StructuredParts)).toBe(expected)
  })

  it('names platform and preset only for a page still at the preset size', () => {
    const story = getSizePresets().byId.get('instagram-story')
    expect(presetParts(story, 1080, 1920)).toEqual({ platform: 'instagram', preset: 'instagram-story' })
    expect(presetParts(story, 1080, 1080)).toEqual({ platform: null, preset: null })
    expect(presetParts(undefined, 1080, 1920)).toEqual({ platform: null, preset: null })
    expect(presetParts(story && { ...story, platform: 'Meta' }, 1080, 1920)).toEqual({ platform: 'meta', preset: 'instagram-story' })
  })

  it('the ZIP keeps its old name unless names are structured', () => {
    expect(zipFilename('My Design!')).toBe('My-Design.zip')
    expect(zipFilename('My Design!', { style: 'structured', unix: 1792259000 })).toBe('my-design_1792259000.zip')
  })
})

describe('runExport file names', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  async function story(pages: number) {
    const doc = createBlankDocument(1080, 1920)
    doc.meta = { ...doc.meta, presetId: 'instagram-story' }
    const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'x', title: 'Summer Sale', mode: 'guest' }, ephemeral: true })
    for (let i = 1; i < pages; i++) engine.pages.add()
    return engine
  }

  it('simple names stay as they were', async () => {
    const engine = await story(2)
    const files = await runExport(engine, { formatId: 'svg', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS, bundle: false })
    expect(files.map((f) => f.filename)).toEqual(['Summer-Sale-01.svg', 'Summer-Sale-02.svg'])
    engine.dispose()
  })

  it('every file and the ZIP of one run share the same timestamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1792259000_400)
    const engine = await story(2)
    const filenames = { style: 'structured', timestamp: true } as const
    const files = await runExport(engine, { formatId: 'svg', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS, bundle: false, filenames })
    expect(files.map((f) => f.filename)).toEqual([
      'summer-sale_instagram_instagram-story_1080x1920_p01_1792259000.svg',
      'summer-sale_instagram_instagram-story_1080x1920_p02_1792259000.svg',
    ])
    const [zip] = await runExport(engine, { formatId: 'svg', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS, filenames })
    expect(zip.filename).toBe('summer-sale_1792259000.zip')
    const [pdf] = await runExport(engine, { formatId: 'pdf', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS, filenames: { style: 'structured', timestamp: false } })
    expect(pdf.filename).toBe('summer-sale_instagram_instagram-story_1080x1920.pdf')
    engine.dispose()
  })

  it('a custom size has no platform or preset part, and one page no page number', async () => {
    const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: createBlankDocument(200, 100), meta: { id: 'x', title: 'Summer Sale', mode: 'guest' }, ephemeral: true })
    const [file] = await runExport(engine, { formatId: 'svg', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS, filenames: { style: 'structured', timestamp: false } })
    expect(file.filename).toBe('summer-sale_200x100.svg')
    engine.dispose()
  })
})
