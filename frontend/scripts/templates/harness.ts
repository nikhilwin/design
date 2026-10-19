/**
 * Browser side of the template pipeline (served by Vite at /scripts/templates/harness.html and driven by `build.ts`).
 * It loads the real fonts through the editor's own `FontManager`, composes every design with the engine's classes and
 * renders pages with the engine's exporter, so what is written and what is photographed is what the editor shows.
 */
import type { FontFamily, Page } from '@/types/api'
import type { DoryDocument } from '@/types/document'
import { FontManager } from '@/editor/engine/fonts'
import { pageSize } from '@/editor/engine/docOps'
import { canvasToBlob, renderPageToCanvas } from '@/editor/engine/render'
import type { LoadContext } from '@/editor/engine/serialization'
import { DESIGNS } from './designs'

export interface GeneratedTemplate {
  slug: string
  title: string
  category: string
  tags: string[]
  description: string
  preset: string
  featured: boolean
  fonts: string[]
  document: DoryDocument
}

export interface StarterApi {
  generate(): Promise<GeneratedTemplate[]>
  /** Renders one page of a document to a data URL. `longSide` scales the page so its longer side has that many pixels. */
  render(document: DoryDocument, pageIndex: number, options: { longSide?: number; multiplier?: number; type: 'image/png' | 'image/webp'; quality?: number }): Promise<string>
}

declare global {
  interface Window {
    __starter?: StarterApi
  }
}

async function loadCatalog(): Promise<FontFamily[]> {
  const response = await fetch('/__fonts/catalog.json')
  if (!response.ok) throw new Error('The font catalog is not served')
  return (await response.json()) as FontFamily[]
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read the image'))
    reader.readAsDataURL(blob)
  })
}

function familiesOf(doc: DoryDocument): string[] {
  const found = new Set<string>()
  const visit = (objects: readonly Record<string, unknown>[]): void => {
    for (const o of objects) {
      if (typeof o.fontFamily === 'string') found.add(o.fontFamily.split(',')[0].replace(/["']/g, '').trim())
      if (Array.isArray(o.objects)) visit(o.objects as Record<string, unknown>[])
    }
  }
  for (const page of doc.pages) visit(page.objects)
  return [...found].sort()
}

async function main(): Promise<void> {
  const catalog = await loadCatalog()
  const fonts = new FontManager(async (q): Promise<Page<FontFamily>> => {
    const needle = q.q?.toLowerCase() ?? ''
    const results = catalog.filter((f) => f.family.toLowerCase().includes(needle))
    return { count: results.length, next: null, previous: null, results }
  })
  fonts.remember(catalog)
  for (const family of catalog) {
    for (const variant of family.variants) await fonts.load(family.family, variant.weight, variant.style)
  }
  const context: LoadContext = { resolveSrc: async (src) => src, ensureFonts: (uses) => fonts.ensure(uses) }

  window.__starter = {
    async generate() {
      return Promise.all(DESIGNS.map(async (design) => {
        const document = (await design.build()).build()
        return {
          slug: design.slug,
          title: design.title,
          category: design.category,
          tags: design.tags,
          description: design.description,
          preset: design.preset ?? '',
          featured: design.featured === true,
          fonts: familiesOf(document),
          document,
        }
      }))
    },
    async render(doc, pageIndex, options) {
      const page = doc.pages[pageIndex]
      const size = pageSize(doc, page)
      const multiplier = options.longSide ? options.longSide / Math.max(size.width, size.height) : (options.multiplier ?? 1)
      const canvas = await renderPageToCanvas(page, size, context, { multiplier })
      return readAsDataUrl(await canvasToBlob(canvas, options.type, options.quality))
    },
  }
  document.title = 'ready'
}

void main().catch((error: unknown) => {
  document.title = `failed: ${error instanceof Error ? error.message : String(error)}`
})
