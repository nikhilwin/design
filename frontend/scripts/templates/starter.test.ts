/**
 * The generated starter templates (`backend/data/templates/*.json`) loaded through the editor's own document path:
 * `migrateDocument`, `deserializeObjects` and `serializeObjects`. They must open without a console error, rebuild every
 * object, round-trip, and survive being applied to a design of another size.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StaticCanvas } from 'fabric'
import { createBlankDocument } from '@/lib/document'
import type { DocObject, DoryDocument, SlotSpec } from '@/types/document'
import { installImageStub } from '@/editor/test/imageStub'
import { migrateDocument } from '@/editor/engine/migrations'
import { rotatedBounds } from '@/editor/engine/geometry'
import { objectCenter } from '@/editor/engine/magicResize'
import { type LoadContext, deserializeObjects, serializeObjects } from '@/editor/engine/serialization'
import { applyTemplate } from '@/editor/panels/templateOps'
import { FONT_PICKS, type FontPick } from './fontPalette'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../backend/data/templates')
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { templates: { slug: string; fonts: string[] }[] }
const documents = manifest.templates.map((entry) => ({ ...entry, doc: JSON.parse(readFileSync(join(directory, `${entry.slug}.json`), 'utf8')) as DoryDocument }))

const context: LoadContext = { resolveSrc: async (src) => src, ensureFonts: async () => undefined }

const walk = (objects: readonly DocObject[]): DocObject[] => objects.flatMap((o) => [o, ...(Array.isArray(o.objects) ? walk(o.objects as DocObject[]) : [])])

async function rebuild(objects: DocObject[], width: number, height: number): Promise<{ canvas: StaticCanvas; out: DocObject[] }> {
  const canvas = new StaticCanvas(document.createElement('canvas'), { width, height, renderOnAddRemove: false })
  canvas.add(...(await deserializeObjects(objects, context)))
  return { canvas, out: serializeObjects(canvas) }
}

describe('starter templates', () => {
  let restoreImages: () => void
  beforeAll(() => {
    restoreImages = installImageStub()
  })
  afterAll(() => restoreImages())

  it('are the ten the manifest lists', () => {
    expect(documents.map((d) => d.slug)).toMatchInlineSnapshot(`
      [
        "bold-sale-announcement",
        "serif-quote-card",
        "rooftop-event-story",
        "modern-pitch-deck",
        "night-bloom-concert-poster",
        "grand-opening-flyer",
        "botanical-celebration-invitation",
        "modern-resume",
        "bold-youtube-thumbnail",
        "clean-business-card",
      ]
    `)
  })

  it('have the object counts they were designed with (top-level objects per page)', () => {
    const counts = Object.fromEntries(documents.map((d) => [d.slug, d.doc.pages.map((p) => p.objects.length)]))
    expect(counts).toMatchInlineSnapshot(`
      {
        "bold-sale-announcement": [
          19,
        ],
        "bold-youtube-thumbnail": [
          8,
        ],
        "botanical-celebration-invitation": [
          20,
        ],
        "clean-business-card": [
          3,
          12,
        ],
        "grand-opening-flyer": [
          15,
        ],
        "modern-pitch-deck": [
          12,
          17,
          23,
        ],
        "modern-resume": [
          64,
        ],
        "night-bloom-concert-poster": [
          17,
        ],
        "rooftop-event-story": [
          16,
        ],
        "serif-quote-card": [
          3,
        ],
      }
    `)
  })

  describe.each(documents)('$slug', ({ slug, doc, fonts }) => {
    it('opens through the editor without a console message and keeps its shape', () => {
      const messages = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
      const migrated = migrateDocument(structuredClone(doc))
      expect(migrated.pages).toHaveLength(doc.pages.length)
      expect([migrated.width, migrated.height, migrated.unit]).toEqual([doc.width, doc.height, doc.unit])
      expect(migrated.pages.map((p) => p.objects.length)).toEqual(doc.pages.map((p) => p.objects.length))
      for (const spy of messages) expect(spy).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    it('rebuilds every object and writes it back in the same order, with the same names and ids', async () => {
      const messages = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
      for (const page of doc.pages) {
        const { canvas, out } = await rebuild(page.objects, doc.width, doc.height)
        expect(canvas.getObjects()).toHaveLength(page.objects.length)
        expect(out.map((o) => [o.id, o.type, o.name, o.locked ?? false])).toEqual(page.objects.map((o) => [o.id, o.type, o.name, o.locked ?? false]))
        // Nothing fell back to the "unavailable" stand-in, which would keep the raw JSON.
        for (const live of canvas.getObjects()) expect((live as unknown as { rawDoc?: unknown }).rawDoc).toBeUndefined()
        canvas.dispose()
      }
      for (const spy of messages) expect(spy).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    it('is stable: writing a rebuilt page again changes nothing but measured text sizes', async () => {
      for (const page of doc.pages) {
        const first = await rebuild(page.objects, doc.width, doc.height)
        const second = await rebuild(first.out, doc.width, doc.height)
        expect(second.out).toEqual(first.out)
        first.canvas.dispose()
        second.canvas.dispose()
      }
    })

    it('keeps every object inside its page', async () => {
      for (const page of doc.pages) {
        const { canvas } = await rebuild(page.objects.filter((o) => o.type !== 'textbox'), doc.width, doc.height)
        for (const live of canvas.getObjects()) {
          // A framed photo is larger than its frame and clipped to it: what shows is the frame.
          const slot = (live as unknown as { slot?: SlotSpec }).slot
          const box = slot ? rotatedBounds(slot.cx, slot.cy, slot.width, slot.height, slot.angle) : live.getBoundingRect()
          const name = String((live as unknown as { name?: string }).name)
          // A stroke is measured with half its width on either side of the path; that is not paint outside the page.
          const slack = (live.stroke ? live.strokeWidth / 2 : 0) + 0.6
          expect(box.left, `${name} left`).toBeGreaterThanOrEqual(-slack)
          expect(box.top, `${name} top`).toBeGreaterThanOrEqual(-slack)
          expect(box.left + box.width, `${name} right`).toBeLessThanOrEqual(doc.width + slack)
          expect(box.top + box.height, `${name} bottom`).toBeLessThanOrEqual(doc.height + slack)
        }
        canvas.dispose()
      }
    })

    it('uses only palette fonts at weights the catalogue installs, and the manifest names exactly those', () => {
      const palette = new Map<string, FontPick>(Object.values(FONT_PICKS).map((pick) => [pick.family, pick]))
      const used = new Set<string>()
      for (const object of doc.pages.flatMap((p) => walk(p.objects)).filter((o) => o.type === 'textbox')) {
        const family = String(object.fontFamily).split(',')[0].replace(/"/g, '').trim()
        const pick = palette.get(family)
        expect(pick, `${slug}: ${family} is not in the palette`).toBeDefined()
        expect(pick?.weights as readonly number[], `${family} ${String(object.fontWeight)}`).toContain(object.fontWeight)
        used.add(family)
      }
      expect([...used].sort()).toEqual([...fonts].sort())
    })

    it.each([
      ['an Instagram post', 1080, 1080],
      ['an A4 page', 794, 1123],
      ['a 16:9 slide', 1920, 1080],
    ])('survives being applied to %s', (_label, width, height) => {
      const target = createBlankDocument(width, height)
      const applied = applyTemplate({ ...target, pages: [{ ...target.pages[0], objects: [{ id: 'x', type: 'rect', left: 1, top: 1, width: 1, height: 1 }] }] }, target.pages[0].id, doc, 'replace')
      expect(applied).not.toBeNull()
      const page = applied?.doc.pages[0]
      expect(page?.objects).toHaveLength(doc.pages[0].objects.length)
      for (const object of page?.objects ?? []) {
        const centre = objectCenter(object)
        const w = Math.abs(Number(object.width ?? 0) * Number(object.scaleX ?? 1))
        const h = Math.abs(Number(object.height ?? 0) * Number(object.scaleY ?? 1))
        const slot = object.slot as SlotSpec | undefined
        const box = slot ? rotatedBounds(slot.cx, slot.cy, slot.width, slot.height, slot.angle) : rotatedBounds(centre.x, centre.y, w, h, Number(object.angle ?? 0))
        expect(Number.isFinite(box.left + box.top + box.width + box.height), String(object.name)).toBe(true)
        expect(box.left, `${String(object.name)} left`).toBeGreaterThanOrEqual(-1)
        expect(box.top, `${String(object.name)} top`).toBeGreaterThanOrEqual(-1)
        expect(box.left + box.width, `${String(object.name)} right`).toBeLessThanOrEqual(width + 1)
        expect(box.top + box.height, `${String(object.name)} bottom`).toBeLessThanOrEqual(height + 1)
      }
    })
  })
})
