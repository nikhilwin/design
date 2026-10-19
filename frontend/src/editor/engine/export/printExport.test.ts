import { inflateSync, unzlibSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { EditorAdapter } from '@/types/adapter'
import type { DocObject, DocPage, DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorEngine } from '../editor'
import { mmToPx } from '../units'
import { renderPageToSvg } from '../render'
import { runExport } from './exporter'
import { DEFAULT_EXPORT_OPTIONS, parsePageRange } from './registry'

const rect = (id: string, left: number, top: number, extra: Partial<DocObject> = {}): DocObject => ({
  id,
  type: 'rect',
  left,
  top,
  width: 40,
  height: 20,
  scaleX: 1,
  scaleY: 1,
  fill: '#e11d48',
  originX: 'center',
  originY: 'center',
  ...extra,
})

function documentOf(...sizes: [number, number][]): DoryDocument {
  const base = createBlankDocument(sizes[0][0], sizes[0][1])
  const pages: DocPage[] = sizes.map(([width, height], i) => ({
    id: `p${i}`,
    background: { type: 'solid', color: '#ffeedd' },
    objects: [rect(`r${i}`, 30, 30, i === 0 ? { link: { url: 'https://example.com/a?x=1&y=2' } } : {})],
    ...(i === 0 ? {} : { width, height }),
  }))
  return { ...base, pages }
}

function makeEngine(doc: DoryDocument) {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'm', title: 'Menu', mode: 'guest' }, ephemeral: true })
  return { engine, handle }
}

const readBlob = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as ArrayBuffer)
    r.onerror = () => reject(r.error)
    r.readAsArrayBuffer(blob)
  })

/** The text of a PDF with its (zlib) streams expanded, so page boxes and drawing operators can be read. */
async function pdfText(blob: Blob): Promise<string> {
  const raw = new Uint8Array(await readBlob(blob))
  const latin1 = new TextDecoder('latin1')
  const out: string[] = [latin1.decode(raw)]
  const source = out[0]
  for (const match of source.matchAll(/stream\r?\n/g)) {
    const start = (match.index ?? 0) + match[0].length
    const end = source.indexOf('endstream', start)
    if (end < 0) continue
    const chunk = raw.subarray(start, end)
    try {
      out.push(latin1.decode(unzlibSync(chunk)))
    } catch {
      try {
        out.push(latin1.decode(inflateSync(chunk)))
      } catch {
        /* an image or font stream: nothing to read */
      }
    }
  }
  return out.join('\n')
}

const PT_PER_MM = 72 / 25.4
const mediaBoxes = (text: string): [number, number][] => [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])])

type ExportPdf = NonNullable<EditorAdapter['exportPdf']>

afterEach(() => vi.restoreAllMocks())

describe('print-quality PDF request', () => {
  async function run(options = DEFAULT_EXPORT_OPTIONS, pages: { kind: 'all' } | { kind: 'pages'; pages: number[] } = { kind: 'all' }, doc = documentOf([1080, 1080], [794, 1123], [336, 192])) {
    const { engine, handle } = makeEngine(doc)
    const exportPdf = vi.fn<ExportPdf>(async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }))
    handle.adapter.exportPdf = exportPdf
    engine.store.setState({ mode: 'account' })
    await runExport(engine, { formatId: 'pdf-server', pages, options })
    engine.dispose()
    return exportPdf.mock.calls[0][0]
  }

  it('sends the trim size of every page, the bleed and the marks', async () => {
    const input = await run({ ...DEFAULT_EXPORT_OPTIONS, bleedMm: 3, cropMarks: true })
    expect(input.sizes).toEqual([
      { width: 1080, height: 1080 },
      { width: 794, height: 1123 },
      { width: 336, height: 192 },
    ])
    expect(input.bleedMm).toBe(3)
    expect(input.cropMarks).toBe(true)
    expect({ width: input.width, height: input.height }).toEqual(input.sizes?.[0])
    expect(input.title).toBe('Menu')
    expect(input.lang).toBe('en')
  })

  it('sends no bleed and no marks for the Screen setup', async () => {
    const input = await run()
    expect(input.bleedMm).toBe(0)
    expect(input.cropMarks).toBe(false)
  })

  it('the pages show the bleed: viewBox is the page grown by the bleed, the layout is not scaled', async () => {
    const input = await run({ ...DEFAULT_EXPORT_OPTIONS, bleedMm: 3, cropMarks: false })
    const b = mmToPx(3)
    input.svgPages.forEach((svg, i) => {
      const size = input.sizes?.[i] ?? { width: 0, height: 0 }
      const root = svg.match(/<svg[^>]*>/)?.[0] ?? ''
      const viewBox = root.match(/viewBox="([^"]+)"/)?.[1].split(' ').map(Number) ?? []
      expect(viewBox[0]).toBeCloseTo(-b, 3)
      expect(viewBox[1]).toBeCloseTo(-b, 3)
      expect(viewBox[2]).toBeCloseTo(size.width + 2 * b, 3)
      expect(viewBox[3]).toBeCloseTo(size.height + 2 * b, 3)
      expect(Number(root.match(/ width="([\d.]+)"/)?.[1])).toBeCloseTo(size.width + 2 * b, 3)
    })
  })

  it('the pages leave out the XML declaration and DOCTYPE the print server refuses', async () => {
    const input = await run()
    for (const svg of input.svgPages) {
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).not.toContain('<!DOCTYPE')
      expect(svg).not.toContain('<?xml')
    }
  })

  it('wraps linked objects in <a href> and nothing else', async () => {
    const input = await run()
    expect(input.svgPages[0]).toMatch(/<a href="https:\/\/example\.com\/a\?x=1&amp;y=2"><g [^>]*id="r0"/)
    expect(input.svgPages[1]).not.toContain('<a ')
    expect(input.svgPages[0]).not.toContain('data-link')
  })

  it('lists only the pages that were chosen, with their sizes', async () => {
    const input = await run(DEFAULT_EXPORT_OPTIONS, { kind: 'pages', pages: [2, 3] })
    expect(input.sizes).toEqual([
      { width: 794, height: 1123 },
      { width: 336, height: 192 },
    ])
    expect(input.svgPages).toHaveLength(2)
  })

  it('reports where it is: preparing, sending, printing', async () => {
    const { engine, handle } = makeEngine(documentOf([300, 200], [300, 200]))
    handle.adapter.exportPdf = vi.fn(async (input) => {
      input.onUploadProgress?.(0.5)
      input.onUploadProgress?.(1)
      return new Blob(['%PDF-1.7'])
    })
    engine.store.setState({ mode: 'account' })
    const seen: [number, string | undefined][] = []
    await runExport(engine, { formatId: 'pdf-server', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS, onProgress: (f, stage) => seen.push([f, stage]) })
    expect(seen.map(([, stage]) => stage)).toEqual(['rendering', 'rendering', 'uploading', 'uploading', 'printing', undefined])
    const fractions = seen.map(([f]) => f)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
    expect(fractions.at(-1)).toBe(1)
    engine.dispose()
  })

  it('cancelling stops the request: the adapter gets the signal', async () => {
    const { engine, handle } = makeEngine(documentOf([300, 200]))
    const controller = new AbortController()
    handle.adapter.exportPdf = vi.fn(
      (input) =>
        new Promise<Blob>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          controller.abort()
        }),
    )
    engine.store.setState({ mode: 'account' })
    await expect(runExport(engine, { formatId: 'pdf-server', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    engine.dispose()
  })

  it('an error of the service reaches the caller as it is', async () => {
    const { engine, handle } = makeEngine(documentOf([300, 200]))
    const failure = Object.assign(new Error('busy'), { code: 'export_busy' })
    handle.adapter.exportPdf = vi.fn(async () => {
      throw failure
    })
    engine.store.setState({ mode: 'account' })
    await expect(runExport(engine, { formatId: 'pdf-server', pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS })).rejects.toBe(failure)
    engine.dispose()
  })
})

describe('page SVG for print', () => {
  const ctxOf = (engine: EditorEngine) => engine.loadContext

  it('links go in after the images were embedded: a link target is never fetched', async () => {
    const { engine } = makeEngine(documentOf([200, 100]))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const svg = await renderPageToSvg(engine.state.doc.pages[0], { width: 200, height: 100 }, ctxOf(engine), { links: true, bare: true })
    expect(svg).toContain('<a href="https://example.com/a?x=1&amp;y=2">')
    expect(fetchSpy).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('only http and https addresses become links', async () => {
    const doc = documentOf([200, 100])
    doc.pages[0].objects = [
      rect('a', 20, 20, { link: { url: 'javascript:alert(1)' } }),
      rect('b', 60, 20, { link: { url: 'data:text/html,hi' } }),
      rect('c', 100, 20, { link: { url: '/relative' } }),
      rect('d', 140, 20, { link: { url: 'mailto:me@example.com' } }),
      rect('e', 180, 20, { link: { url: 'https://ok.example/' } }),
    ]
    const { engine } = makeEngine(doc)
    const svg = await renderPageToSvg(engine.state.doc.pages[0], { width: 200, height: 100 }, ctxOf(engine), { links: true, bare: true })
    expect(svg.match(/<a /g)).toHaveLength(1)
    expect(svg).toContain('href="https://ok.example/"')
    expect(svg).not.toContain('javascript')
    expect(svg).not.toContain('mailto')
    engine.dispose()
  })

  it('a link in a group wraps the object inside the group', async () => {
    const doc = documentOf([200, 100])
    doc.pages[0].objects = [{ id: 'g', type: 'group', left: 50, top: 50, scaleX: 1, scaleY: 1, originX: 'center', originY: 'center', width: 50, height: 30, objects: [rect('inner', 0, 0, { link: { url: 'https://inner.example/' } })] }]
    const { engine } = makeEngine(doc)
    const svg = await renderPageToSvg(engine.state.doc.pages[0], { width: 200, height: 100 }, ctxOf(engine), { links: true, bare: true })
    expect(svg).toContain('href="https://inner.example/"')
    engine.dispose()
  })

  it('links are only written when asked for', async () => {
    const { engine } = makeEngine(documentOf([200, 100]))
    const plain = await renderPageToSvg(engine.state.doc.pages[0], { width: 200, height: 100 }, ctxOf(engine))
    expect(plain).not.toContain('<a ')
    expect(plain).toContain('<!DOCTYPE')
    engine.dispose()
  })

  it('a hostile address cannot break out of the attribute', async () => {
    const doc = documentOf([200, 100])
    doc.pages[0].objects = [rect('a', 20, 20, { link: { url: 'https://example.com/"><script>alert(1)</script>' } })]
    const { engine } = makeEngine(doc)
    const svg = await renderPageToSvg(engine.state.doc.pages[0], { width: 200, height: 100 }, ctxOf(engine), { links: true, bare: true })
    expect(svg).not.toContain('<script')
    expect(svg).not.toMatch(/<a href="[^"]*"[^>]*>\s*<script/)
    engine.dispose()
  })

  it('the first row and column of the page are fully covered by its background', async () => {
    const { engine } = makeEngine(documentOf([40, 30]))
    const svg = await renderPageToSvg(engine.state.doc.pages[0], { width: 40, height: 30 }, ctxOf(engine), { bare: true })
    const clip = svg.match(/<clipPath[^>]*>\s*<rect transform="matrix\(1 0 0 1 ([\d.-]+) ([\d.-]+)\)" x="([\d.-]+)" y="([\d.-]+)"[^>]*width="([\d.]+)" height="([\d.]+)"/)
    expect(clip).not.toBeNull()
    const [, cx, cy, x, y, w, h] = (clip ?? []).map(Number)
    expect(cx + x).toBeCloseTo(0, 6)
    expect(cy + y).toBeCloseTo(0, 6)
    expect(w).toBe(40)
    expect(h).toBe(30)
    engine.dispose()
  })
})

describe('client PDF with print options', () => {
  async function build(options: Partial<typeof DEFAULT_EXPORT_OPTIONS>, doc = documentOf([400, 300], [200, 500])) {
    const { engine } = makeEngine(doc)
    const [file] = await runExport(engine, { formatId: 'pdf', pages: { kind: 'all' }, options: { ...DEFAULT_EXPORT_OPTIONS, ...options } })
    engine.dispose()
    return pdfText(file.blob)
  }

  it('is the trim size of every page when there is no bleed and no marks', async () => {
    const text = await build({})
    const boxes = mediaBoxes(text)
    expect(boxes).toHaveLength(2)
    expect(boxes[0][0]).toBeCloseTo(300, 0)
    expect(boxes[0][1]).toBeCloseTo(225, 0)
    expect(boxes[1][0]).toBeCloseTo(150, 0)
    expect(boxes[1][1]).toBeCloseTo(375, 0)
  })

  it('each page grows by the bleed and the margin of the marks on every side', async () => {
    const text = await build({ bleedMm: 3, cropMarks: true })
    const boxes = mediaBoxes(text)
    expect(boxes).toHaveLength(2)
    const extra = 2 * (3 + 6) * PT_PER_MM
    expect(boxes[0][0]).toBeCloseTo(300 + extra, 0)
    expect(boxes[0][1]).toBeCloseTo(225 + extra, 0)
    expect(boxes[1][0]).toBeCloseTo(150 + extra, 0)
    expect(boxes[1][1]).toBeCloseTo(375 + extra, 0)
  })

  it('bleed alone grows the page by the bleed only', async () => {
    const boxes = mediaBoxes(await build({ bleedMm: 2 }))
    expect(boxes[0][0]).toBeCloseTo(300 + 2 * 2 * PT_PER_MM, 0)
  })

  it('draws eight crop marks on every page, and none without the option', async () => {
    const withMarks = await build({ bleedMm: 3, cropMarks: true })
    expect((withMarks.match(/ l\nS/g) ?? []).length).toBe(16)
    const without = await build({ bleedMm: 3, cropMarks: false })
    expect((without.match(/ l\nS/g) ?? []).length).toBe(0)
  })

  it('names the document and its language', async () => {
    const text = await build({})
    expect(text).toContain('/Title (Menu)')
    expect(text).toContain('/Lang (en)')
  })
})

describe('page ranges', () => {
  it('accepts lists, ranges and spaces, sorted and without duplicates', () => {
    expect(parsePageRange('1-3,5', 9)).toEqual([1, 2, 3, 5])
    expect(parsePageRange(' 1 - 3 , 5 ', 9)).toEqual([1, 2, 3, 5])
    expect(parsePageRange('5,1,3-4,4', 9)).toEqual([1, 3, 4, 5])
    expect(parsePageRange('01', 9)).toEqual([1])
    expect(parsePageRange('9', 9)).toEqual([9])
    expect(parsePageRange('1-9', 9)).toHaveLength(9)
  })

  it('ignores stray commas', () => {
    expect(parsePageRange('1,', 9)).toEqual([1])
    expect(parsePageRange(',1', 9)).toEqual([1])
    expect(parsePageRange('1,,2', 9)).toEqual([1, 2])
  })

  it('refuses everything else', () => {
    for (const text of ['', ' ', ',', ' , ', '-1', '1-', '1--3', '3-1', '0', '0-2', '10', '1-10', 'a', '1a', '1.5', '１', '1 2', '1-2-3', '1;2', '١'])
      expect(parsePageRange(text, 9), JSON.stringify(text)).toBeNull()
  })

  it('does not hang on a huge range', () => {
    expect(parsePageRange('1-999999999', 9)).toBeNull()
  })
})
