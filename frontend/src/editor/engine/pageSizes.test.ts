import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { createBlankDocument } from '@/lib/document'
import type { DocObject, DocPage, DoryDocument } from '@/types/document'
import { addPage, movePage, removePage } from './docOps'
import { resizeDocument, resizePage } from './magicResize'
import { migrateDocument } from './migrations'
import { fitBox, getPageSize, isUniform, newPageSize, normalizeSizes, pageSizes, widestPage, withPageSize } from './pageSizes'

const rect = (id: string, left = 50, top = 50): DocObject => ({ id, type: 'rect', left, top, width: 40, height: 20, scaleX: 1, scaleY: 1 })

/** A poster, a flyer and a card in one design, in the canonical form. */
function mixed(): DoryDocument {
  const base = createBlankDocument(1080, 1920)
  const flyer: DocPage = { id: 'flyer', background: { type: 'solid', color: '#ffffff' }, objects: [rect('f1', 200, 300)], width: 794, height: 1123 }
  const card: DocPage = { id: 'card', background: { type: 'solid', color: '#ffffff' }, objects: [], width: 336, height: 192 }
  return { ...base, pages: [{ ...base.pages[0], id: 'poster', objects: [rect('p1', 540, 960)] }, flyer, card] }
}

describe('page size resolution', () => {
  it('a page without an override has the document size, one with an override its own', () => {
    const doc = mixed()
    expect(getPageSize(doc, 'poster')).toEqual({ width: 1080, height: 1920 })
    expect(getPageSize(doc, 'flyer')).toEqual({ width: 794, height: 1123 })
    expect(getPageSize(doc, 'card')).toEqual({ width: 336, height: 192 })
    expect(pageSizes(doc)).toHaveLength(3)
  })

  it('each side falls back on its own, so an older document with one override keeps its meaning', () => {
    const doc: DoryDocument = { ...createBlankDocument(500, 400), pages: [{ id: 'a', background: { type: 'solid', color: '#fff' }, objects: [], width: 900 }] }
    expect(getPageSize(doc, 'a')).toEqual({ width: 900, height: 400 })
  })

  it('an unknown page id gives the document size', () => {
    expect(getPageSize(mixed(), 'nope')).toEqual({ width: 1080, height: 1920 })
  })

  it('reports uniformity and the widest page', () => {
    expect(isUniform(createBlankDocument(10, 10))).toBe(true)
    expect(isUniform(mixed())).toBe(false)
    expect(widestPage(mixed())).toBe(1080)
    expect(widestPage(movePage(mixed(), 'poster', 2))).toBe(1080)
  })

  it('a new page takes the size of the page before it (the first page for index 0)', () => {
    const doc = mixed()
    expect(newPageSize(doc, 3)).toEqual({ width: 336, height: 192 })
    expect(newPageSize(doc, 2)).toEqual({ width: 794, height: 1123 })
    expect(newPageSize(doc, 0)).toEqual({ width: 1080, height: 1920 })
  })
})

describe('normalizeSizes', () => {
  it('returns the same document when it is already canonical', () => {
    const doc = mixed()
    expect(normalizeSizes(doc)).toBe(doc)
    const plain = createBlankDocument(100, 100)
    expect(normalizeSizes(plain)).toBe(plain)
  })

  it('moves the document size to the first page and keeps every page size', () => {
    const doc = movePage(mixed(), 'card', 0)
    const before = pageSizes(doc)
    const out = normalizeSizes(doc)
    expect(out.width).toBe(336)
    expect(out.height).toBe(192)
    expect(pageSizes(out)).toEqual(before)
    expect(out.pages[0].width).toBeUndefined()
    expect(out.pages[1]).toMatchObject({ id: 'poster', width: 1080, height: 1920 })
  })

  it('drops an override that equals the document size', () => {
    const base = createBlankDocument(300, 200)
    const doc: DoryDocument = { ...base, pages: [{ ...base.pages[0], width: 300, height: 200 }] }
    const out = normalizeSizes(doc)
    expect(out.pages[0].width).toBeUndefined()
    expect(out.pages[0].height).toBeUndefined()
  })

  it('completes a half override so a page always carries both sides or none', () => {
    const base = createBlankDocument(300, 200)
    const doc: DoryDocument = { ...base, pages: [base.pages[0], { id: 'b', background: base.pages[0].background, objects: [], width: 640 }] }
    expect(normalizeSizes(doc).pages[1]).toMatchObject({ width: 640, height: 200 })
  })

  it('stays canonical after removing or moving pages', () => {
    const removed = normalizeSizes(removePage(mixed(), 'poster'))
    expect(removed).toMatchObject({ width: 794, height: 1123 })
    expect(getPageSize(removed, 'card')).toEqual({ width: 336, height: 192 })
    const moved = normalizeSizes(movePage(mixed(), 'flyer', 0))
    expect(moved).toMatchObject({ width: 794, height: 1123 })
    expect(getPageSize(moved, 'poster')).toEqual({ width: 1080, height: 1920 })
  })

  it('withPageSize changes one page and leaves the others alone', () => {
    const out = withPageSize(mixed(), 'flyer', { width: 600, height: 800 })
    expect(getPageSize(out, 'flyer')).toEqual({ width: 600, height: 800 })
    expect(getPageSize(out, 'poster')).toEqual({ width: 1080, height: 1920 })
    expect(getPageSize(out, 'card')).toEqual({ width: 336, height: 192 })
    expect(withPageSize(mixed(), 'nope', { width: 1, height: 1 })).toEqual(mixed())
  })

  it('withPageSize on the first page moves the document size but not the other pages', () => {
    const doc = addPage(createBlankDocument(500, 500), 1)
    const out = withPageSize(doc, doc.pages[0].id, { width: 800, height: 400 })
    expect(out).toMatchObject({ width: 800, height: 400 })
    expect(getPageSize(out, doc.pages[1].id)).toEqual({ width: 500, height: 500 })
  })

  it('clamps to the document format’s 1..20000 px', () => {
    const out = withPageSize(mixed(), 'card', { width: 999999, height: 0 })
    expect(getPageSize(out, 'card')).toEqual({ width: 20000, height: 1 })
  })
})

describe('resizePage', () => {
  it('maps the content of one page and leaves every other page untouched', () => {
    const doc = mixed()
    const out = resizePage(doc, 'flyer', 397, 561.5, 'scale')
    expect(getPageSize(out, 'flyer')).toEqual({ width: 397, height: 562 })
    expect(out.pages[0]).toBe(doc.pages[0])
    expect(out.pages[2]).toBe(doc.pages[2])
    const o = out.pages[1].objects[0]
    expect(o.scaleX as number).toBeCloseTo(0.5, 1)
  })

  it('keep changes only the size', () => {
    const doc = mixed()
    const out = resizePage(doc, 'flyer', 400, 400, 'keep')
    expect(out.pages[1].objects[0]).toBe(doc.pages[1].objects[0])
  })

  it('magic repositions proportionally', () => {
    const out = resizePage(mixed(), 'flyer', 1588, 1123, 'magic')
    expect(out.pages[1].objects[0].left as number).toBeCloseTo(400, 0)
  })

  it('does nothing for the same size or an unknown page', () => {
    const doc = mixed()
    expect(resizePage(doc, 'flyer', 794, 1123, 'scale')).toBe(doc)
    expect(resizePage(doc, 'nope', 10, 10, 'scale')).toBe(doc)
  })

  it('resizing the first page moves the document size and keeps the other pages as they were', () => {
    const doc = addPage(createBlankDocument(500, 500), 1)
    const out = resizePage(doc, doc.pages[0].id, 1000, 250, 'keep')
    expect(out).toMatchObject({ width: 1000, height: 250 })
    expect(getPageSize(out, doc.pages[1].id)).toEqual({ width: 500, height: 500 })
  })

  it('maps ruler guides with the content and drops the ones outside the new page', () => {
    const base = createBlankDocument(1000, 1000)
    const doc: DoryDocument = { ...base, pages: [{ ...base.pages[0], guides: [{ orientation: 'vertical', pos: 800 }, { orientation: 'horizontal', pos: 500 }] }] }
    const scaled = resizePage(doc, doc.pages[0].id, 500, 500, 'scale')
    expect(scaled.pages[0].guides).toEqual([{ orientation: 'vertical', pos: 400 }, { orientation: 'horizontal', pos: 250 }])
    const kept = resizePage(doc, doc.pages[0].id, 600, 600, 'keep')
    expect(kept.pages[0].guides).toEqual([{ orientation: 'horizontal', pos: 500 }])
    const gone = resizePage(doc, doc.pages[0].id, 100, 100, 'keep')
    expect(gone.pages[0].guides).toBeUndefined()
  })

  it('resizeDocument makes every page the same size again', () => {
    const out = resizeDocument(mixed(), 600, 600, 'scale')
    expect(isUniform(out)).toBe(true)
    expect(out.pages.every((p) => p.width === undefined && p.height === undefined)).toBe(true)
  })
})

describe('loading documents with page sizes', () => {
  it('opens a document without overrides exactly as before', () => {
    const doc = addPage(createBlankDocument(400, 300), 1)
    const out = migrateDocument(doc)
    expect(out.width).toBe(400)
    expect(out.pages.every((p) => p.width === undefined)).toBe(true)
  })

  it('drops overrides that are not numbers and clamps the rest', () => {
    const raw = {
      schemaVersion: 1,
      width: 400,
      height: 300,
      unit: 'px',
      pages: [
        { id: 'a', background: { type: 'solid', color: '#fff' }, objects: [] },
        { id: 'b', background: { type: 'solid', color: '#fff' }, objects: [], width: '90', height: null },
        { id: 'c', background: { type: 'solid', color: '#fff' }, objects: [], width: 999999, height: -5 },
      ],
    }
    const out = migrateDocument(raw)
    expect(getPageSize(out, 'b')).toEqual({ width: 400, height: 300 })
    expect(getPageSize(out, 'c')).toEqual({ width: 20000, height: 1 })
  })

  it('writes the canonical form: the document size follows the first page', () => {
    const raw = {
      schemaVersion: 1,
      width: 400,
      height: 300,
      unit: 'px',
      pages: [{ id: 'a', background: { type: 'solid', color: '#fff' }, objects: [], width: 800, height: 600 }, { id: 'b', background: { type: 'solid', color: '#fff' }, objects: [] }],
    }
    const out = migrateDocument(raw)
    expect(out).toMatchObject({ width: 800, height: 600 })
    expect(getPageSize(out, 'b')).toEqual({ width: 400, height: 300 })
  })
})

describe('fitBox', () => {
  it('keeps the proportions inside the box', () => {
    expect(fitBox({ width: 1080, height: 1920 }, 96, 120)).toEqual({ width: 68, height: 120 })
    expect(fitBox({ width: 1920, height: 1080 }, 96, 120)).toEqual({ width: 96, height: 54 })
    expect(fitBox({ width: 20000, height: 1 }, 96, 120)).toEqual({ width: 96, height: 1 })
  })
})

/* ------------------------------------------------------------------------------------------------
 * The lint-like check: a page has its own size, so nothing may read the size of the *document* except the
 * files that implement the rules. A reader of `doc.width` would be right only for the first page.
 * ------------------------------------------------------------------------------------------------ */

const SRC = join(__dirname, '..', '..')

/** Files that may read `DoryDocument.width` / `.height`, and why. */
const ALLOWED: Record<string, string> = {
  'editor/engine/docOps.ts': 'pageSize(): the fallback of a page without an override',
  'editor/engine/pageSizes.ts': 'getPageSize(), newPageSize(), normalizeSizes(): the rules themselves',
  'lib/local/repository.ts': 'the dashboard card of a guest design: the document size is the size of its first page',
  'features/editor/adapters/migrateLocalDesign.ts': 'the width and height the server lists a design with: the size of its first page',
  'lib/document.ts': 'building a document of one size',
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** `.width` / `.height` property accesses whose object is typed `DoryDocument`. */
function documentSizeReads(files: string[]): string[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    types: [],
    baseUrl: SRC,
    paths: { '@/*': ['*'] },
  }
  const program = ts.createProgram(files, options)
  const checker = program.getTypeChecker()
  const found: string[] = []
  for (const sf of program.getSourceFiles()) {
    if (!files.includes(sf.fileName)) continue
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && (node.name.text === 'width' || node.name.text === 'height')) {
        const symbol = checker.getTypeAtLocation(node.expression).getSymbol() ?? checker.getTypeAtLocation(node.expression).aliasSymbol
        if (symbol?.getName() === 'DoryDocument') {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
          found.push(`${relative(SRC, sf.fileName).split(sep).join('/')}:${line + 1}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return [...new Set(found)]
}

describe('document size readers', () => {
  it('nothing outside the allow-list reads the width or height of a DoryDocument', () => {
    const files = sourceFiles(SRC)
    const reads = documentSizeReads(files)
    const stray = reads.filter((where) => !(where.split(':')[0] in ALLOWED))
    expect(stray, 'read the size of a page with getPageSize(doc, pageId) or pageSize(doc, page)').toEqual([])
  }, 120_000)

  it('the allow-list only names files that exist', () => {
    for (const file of Object.keys(ALLOWED)) expect(() => statSync(join(SRC, file))).not.toThrow()
  })

  it('catches a reader (the check itself works)', () => {
    const probe = join(SRC, 'editor', 'engine', '__probe__.ts')
    const text = "import type { DoryDocument } from '@/types/document'\nexport const w = (d: DoryDocument): number => d.width\n"
    const host = ts.createCompilerHost({})
    const read = host.readFile.bind(host)
    host.readFile = (name) => (name === probe ? text : read(name))
    host.fileExists = ((exists) => (name: string) => name === probe || exists(name))(host.fileExists.bind(host))
    const program = ts.createProgram([probe], { noEmit: true, skipLibCheck: true, strict: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, types: [], baseUrl: SRC, paths: { '@/*': ['*'] } }, host)
    const checker = program.getTypeChecker()
    const sf = program.getSourceFile(probe)
    let hits = 0
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'width' && checker.getTypeAtLocation(node.expression).getSymbol()?.getName() === 'DoryDocument') hits += 1
      ts.forEachChild(node, visit)
    }
    if (sf) visit(sf)
    expect(hits).toBe(1)
  })
})
