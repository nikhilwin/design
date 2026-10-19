import { createBlankDocument } from '@/lib/document'
import type { DocObject, DoryDocument } from '@/types/document'
import { objectCenter, resizeDocument, resizePageContent } from './magicResize'

const rectObj = (over: Partial<DocObject> = {}): DocObject => ({ id: 'r', type: 'rect', left: 100, top: 100, width: 100, height: 50, scaleX: 1, scaleY: 1, ...over })

function docWith(objects: DocObject[], w = 1000, h = 1000): DoryDocument {
  const d = createBlankDocument(w, h)
  return { ...d, pages: [{ ...d.pages[0], objects }] }
}

describe('resizeDocument', () => {
  it('keep: only changes the page size', () => {
    const d = docWith([rectObj()])
    const r = resizeDocument(d, 500, 500, 'keep')
    expect(r.width).toBe(500)
    expect(r.pages[0].objects[0]).toBe(d.pages[0].objects[0])
  })

  it('scale: uniform scale and centring (letterbox)', () => {
    const d = docWith([rectObj()])
    const r = resizeDocument(d, 500, 250, 'scale')
    const o = r.pages[0].objects[0]
    expect(o.scaleX).toBeCloseTo(0.25)
    expect(o.scaleY).toBeCloseTo(0.25)
    // centre (100,100) -> (25 + 125, 25)
    expect(o.left).toBeCloseTo(150)
    expect(o.top).toBeCloseTo(25)
  })

  it('magic: keeps relative position and scales uniformly', () => {
    const d = docWith([rectObj({ left: 500, top: 500 })])
    const r = resizeDocument(d, 2000, 1000, 'magic')
    const o = r.pages[0].objects[0]
    expect(o.left).toBeCloseTo(1000)
    expect(o.top).toBeCloseTo(500)
    expect(o.scaleX).toBe(o.scaleY)
    expect(o.scaleX).toBeCloseTo(1)
  })

  it('magic: clamps objects inside the new page', () => {
    const d = docWith([rectObj({ left: 950, top: 500, width: 100, height: 100 })])
    const o = resizeDocument(d, 500, 1000, 'magic').pages[0].objects[0]
    expect((o.left as number) + 50 * (o.scaleX as number) * 1).toBeLessThanOrEqual(500 + 1e-6)
  })

  it('magic: stretches full-bleed backgrounds to cover', () => {
    const bg = rectObj({ id: 'bg', left: 500, top: 500, width: 1000, height: 1000 })
    const r = resizeDocument(docWith([bg]), 2000, 1000, 'magic')
    const o = r.pages[0].objects[0]
    expect(o.scaleX).toBeCloseTo(2)
    expect(o.left).toBeCloseTo(1000)
    expect(o.top).toBeCloseTo(500)
  })

  it('bakes text scale into fontSize and width', () => {
    const t: DocObject = { id: 't', type: 'textbox', left: 500, top: 500, width: 400, height: 80, fontSize: 40, scaleX: 1, scaleY: 1 }
    const o = resizeDocument(docWith([t]), 500, 500, 'magic').pages[0].objects[0]
    expect(o.fontSize).toBeCloseTo(20)
    expect(o.width).toBeCloseTo(200)
    expect(o.scaleX).toBe(1)
  })

  it('does not mutate the source document', () => {
    const d = docWith([rectObj()])
    const before = JSON.stringify(d)
    resizeDocument(d, 300, 300, 'magic')
    expect(JSON.stringify(d)).toBe(before)
  })

  it('clears per-page size overrides and clamps absurd sizes', () => {
    const d = docWith([])
    const withOverride: DoryDocument = { ...d, pages: [{ ...d.pages[0], width: 50, height: 60 }] }
    const r = resizeDocument(withOverride, 99999, 0, 'keep')
    expect(r.width).toBe(20000)
    expect(r.height).toBe(1)
    expect(r.pages[0].width).toBeUndefined()
  })

  it('scales shadows with the object', () => {
    const o = rectObj({ shadow: { color: '#000', blur: 20, offsetX: 10, offsetY: 10 } })
    const r = resizePageContent({ id: 'p', background: { type: 'solid', color: '#fff' }, objects: [o] }, { w: 1000, h: 1000 }, { w: 500, h: 500 }, 'magic')
    expect((r.objects[0].shadow as { blur: number }).blur).toBeCloseTo(10)
  })

  it('rotates around the origin point when computing the centre', () => {
    const o: DocObject = { id: 'x', type: 'rect', left: 0, top: 0, width: 100, height: 0, angle: 90, originX: 'left', originY: 'top' }
    const c = objectCenter(o)
    expect(c.x).toBeCloseTo(0)
    expect(c.y).toBeCloseTo(50)
  })
})
