import { createBlankDocument } from '@/lib/document'
import type { DocObject, DoryDocument } from '@/types/document'
import { MAX_PAGES } from '@/types/document'
import { addPage } from '../engine/docOps'
import { getPageSize } from '../engine/pageSizes'
import { applyTemplate, fitTemplatePages } from './templateOps'

const rect = (id: string, left = 50, top = 50): DocObject => ({ id, type: 'rect', left, top, width: 40, height: 20 })

function template(width: number, height: number, pages = 1): DoryDocument {
  let d = createBlankDocument(width, height)
  d = { ...d, pages: [{ ...d.pages[0], objects: [rect('t1', width / 2, height / 2)] }] }
  for (let i = 1; i < pages; i++) d = addPage(d, i, { id: `tp${i}`, background: { type: 'solid', color: '#000000' }, objects: [rect(`t${i + 1}`)] })
  return d
}

function design(width = 200, height = 100, withContent = true): DoryDocument {
  const d = createBlankDocument(width, height)
  return withContent ? { ...d, pages: [{ ...d.pages[0], objects: [rect('mine')] }] } : d
}

describe('fitTemplatePages', () => {
  it('gives every page and object a fresh id and leaves the template untouched', () => {
    const tpl = template(200, 100, 2)
    const pages = fitTemplatePages(tpl, { width: 200, height: 100 })
    expect(pages).toHaveLength(2)
    expect(pages[0].id).not.toBe(tpl.pages[0].id)
    expect(pages[0].objects[0].id).not.toBe('t1')
    expect(tpl.pages[0].objects[0].id).toBe('t1')
  })

  it('scales the content uniformly when the sizes differ', () => {
    const pages = fitTemplatePages(template(100, 100), { width: 200, height: 200 })
    expect(pages[0].objects[0].left).toBeCloseTo(100, 0)
    expect(pages[0].objects[0].width).toBe(40)
    expect(pages[0].objects[0].scaleX ?? 1).toBeGreaterThan(1)
  })
})

describe('applyTemplate', () => {
  it('replace swaps the content of the active page and keeps its id and name', () => {
    const doc = { ...design(), pages: [{ ...design().pages[0], id: 'p1', name: 'Cover' }] }
    const out = applyTemplate(doc, 'p1', template(200, 100, 3), 'replace')
    expect(out?.doc.pages).toHaveLength(1)
    expect(out?.doc.pages[0].id).toBe('p1')
    expect(out?.doc.pages[0].name).toBe('Cover')
    expect(out?.doc.pages[0].objects[0].id).not.toBe('mine')
    expect(out?.added).toBe(0)
    expect(doc.pages[0].objects[0].id).toBe('mine')
  })

  it('add inserts only the first template page after the active page and activates it', () => {
    let doc = design()
    doc = addPage(doc, 1)
    const active = doc.pages[0].id
    const out = applyTemplate(doc, active, template(200, 100, 3), 'add')
    expect(out?.doc.pages).toHaveLength(3)
    expect(out?.doc.pages[2].id).toBe(doc.pages[1].id)
    expect(out?.activePageId).toBe(out?.doc.pages[1].id)
    expect(out?.added).toBe(1)
  })

  it('add-all inserts every template page in order', () => {
    const doc = design()
    const out = applyTemplate(doc, doc.pages[0].id, template(200, 100, 3), 'add-all')
    expect(out?.doc.pages).toHaveLength(4)
    expect(out?.added).toBe(3)
    expect(out?.doc.pages[2].background).toMatchObject({ type: 'solid', color: '#000000' })
  })

  it('an empty design takes the size of the template; one with content keeps its own', () => {
    const blank = design(300, 300, false)
    const empty = applyTemplate(blank, blank.pages[0].id, template(1080, 1080), 'replace')
    expect(empty?.doc.width).toBe(1080)
    expect(empty?.doc.height).toBe(1080)
    const busy = design(300, 300)
    const kept = applyTemplate(busy, busy.pages[0].id, template(1080, 1080), 'replace')
    expect(kept?.doc.width).toBe(300)
  })

  it('stops at the page limit and reports a refusal when no page fits', () => {
    let doc = design()
    while (doc.pages.length < MAX_PAGES) doc = addPage(doc, doc.pages.length)
    expect(applyTemplate(doc, doc.pages[0].id, template(200, 100), 'add')).toBeNull()
    expect(applyTemplate(doc, doc.pages[0].id, template(200, 100), 'replace')).not.toBeNull()
  })

  it('returns null for an unknown page', () => {
    expect(applyTemplate(design(), 'nope', template(200, 100), 'replace')).toBeNull()
  })
})

describe('applyTemplate with pages of different sizes', () => {
  it('add puts the template page in as a page of its own size and leaves the design size alone', () => {
    const doc = design(1080, 1080)
    const out = applyTemplate(doc, doc.pages[0].id, template(1920, 1080), 'add')
    expect(out?.doc).toMatchObject({ width: 1080, height: 1080 })
    expect(getPageSize(out!.doc, out!.activePageId)).toEqual({ width: 1920, height: 1080 })
    expect(getPageSize(out!.doc, doc.pages[0].id)).toEqual({ width: 1080, height: 1080 })
    // Nothing is scaled: the template's object keeps its geometry.
    const added = out!.doc.pages[1].objects[0]
    expect(added.left).toBe(960)
    expect(added.scaleX ?? 1).toBe(1)
  })

  it('add-all keeps the size of every template page, including a template that mixes sizes', () => {
    const tpl = template(1080, 1080, 2)
    tpl.pages[1] = { ...tpl.pages[1], width: 600, height: 400 }
    const doc = design(500, 500)
    const out = applyTemplate(doc, doc.pages[0].id, tpl, 'add-all')
    expect(out?.doc.pages.map((p) => getPageSize(out.doc, p.id))).toEqual([
      { width: 500, height: 500 },
      { width: 1080, height: 1080 },
      { width: 600, height: 400 },
    ])
  })

  it('a page added of the design’s own size carries no override', () => {
    const doc = design(1080, 1080)
    const out = applyTemplate(doc, doc.pages[0].id, template(1080, 1080), 'add')
    expect(out?.doc.pages[1].width).toBeUndefined()
  })

  it('replace fits the template into the size the page already has, in a design of mixed sizes', () => {
    let doc = design(1080, 1080)
    doc = addPage(doc, 1, { id: 'card', background: { type: 'solid', color: '#ffffff' }, objects: [rect('mine2')], width: 400, height: 200 })
    const out = applyTemplate(doc, 'card', template(1000, 1000), 'replace')
    expect(getPageSize(out!.doc, 'card')).toEqual({ width: 400, height: 200 })
    expect(getPageSize(out!.doc, doc.pages[0].id)).toEqual({ width: 1080, height: 1080 })
    const o = out!.doc.pages[1].objects[0]
    expect(o.scaleX as number).toBeCloseTo(0.2, 2)
  })

  it('replace-resize gives the page the template’s size and the other pages keep theirs', () => {
    let doc = design(1080, 1080)
    doc = addPage(doc, 1, { id: 'card', background: { type: 'solid', color: '#ffffff' }, objects: [rect('mine2')], width: 400, height: 200 })
    const out = applyTemplate(doc, 'card', template(1920, 1080), 'replace-resize')
    expect(getPageSize(out!.doc, 'card')).toEqual({ width: 1920, height: 1080 })
    expect(getPageSize(out!.doc, doc.pages[0].id)).toEqual({ width: 1080, height: 1080 })
    expect(out!.doc.pages[1].objects[0].left).toBe(960)
    expect(out?.added).toBe(0)
  })

  it('replace-resize on the first page moves the design size and keeps the other pages', () => {
    let doc = design(1080, 1080)
    doc = addPage(doc, 1)
    const second = getPageSize(doc, doc.pages[1].id)
    const out = applyTemplate(doc, doc.pages[0].id, template(1920, 1080), 'replace-resize')
    expect(out?.doc).toMatchObject({ width: 1920, height: 1080 })
    expect(getPageSize(out!.doc, doc.pages[1].id)).toEqual(second)
  })

  it('an empty design of one size takes the template’s size on every page', () => {
    const blank = addPage(design(300, 300, false), 1)
    const out = applyTemplate(blank, blank.pages[0].id, template(1080, 1350), 'replace')
    expect(out?.doc).toMatchObject({ width: 1080, height: 1350 })
    expect(out?.doc.pages.every((p) => getPageSize(out.doc, p.id).width === 1080)).toBe(true)
  })

  it('an empty design that already mixes sizes changes only the page the template goes on', () => {
    const blank = addPage(design(300, 300, false), 1, { id: 'b', background: { type: 'solid', color: '#ffffff' }, objects: [], width: 100, height: 100 })
    const out = applyTemplate(blank, 'b', template(1080, 1350), 'replace')
    expect(getPageSize(out!.doc, 'b')).toEqual({ width: 1080, height: 1350 })
    expect(getPageSize(out!.doc, blank.pages[0].id)).toEqual({ width: 300, height: 300 })
  })

  it('template sizes are clamped to the document format’s limits', () => {
    const tpl = template(100, 100)
    tpl.pages[0] = { ...tpl.pages[0], width: 99_999, height: 0 }
    const doc = design(500, 500)
    const out = applyTemplate(doc, doc.pages[0].id, tpl, 'add')
    expect(getPageSize(out!.doc, out!.activePageId)).toEqual({ width: 20_000, height: 1 })
  })
})
