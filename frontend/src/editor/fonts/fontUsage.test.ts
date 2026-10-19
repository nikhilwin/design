import { createBlankDocument } from '@/lib/document'
import type { DocObject, DoryDocument } from '@/types/document'
import { countTextLayersUsing } from './fontUsage'

function docWith(...objects: DocObject[]): DoryDocument {
  const doc = createBlankDocument(400, 300)
  return { ...doc, pages: [{ ...doc.pages[0], objects }] }
}

const text = (id: string, fontFamily: string, extra: Record<string, unknown> = {}): DocObject => ({ id, type: 'textbox', text: 'Hi', fontFamily, ...extra })

describe('countTextLayersUsing', () => {
  it('counts text layers by their first family, ignoring case and quotes', () => {
    const doc = docWith(text('a', '"Brand Sans", sans-serif'), text('b', 'brand sans'), text('c', '"Other", serif'), { id: 'r', type: 'rect' })
    expect(countTextLayersUsing(doc, 'Brand Sans')).toBe(2)
    expect(countTextLayersUsing(doc, 'Other')).toBe(1)
    expect(countTextLayersUsing(doc, 'Missing')).toBe(0)
  })

  it('looks inside groups and per-character styles, and counts a layer once', () => {
    const styled = text('s', '"Other", serif', { styles: [{ start: 0, end: 1, style: { fontFamily: '"Brand Sans", sans-serif' } }, { start: 1, end: 2, style: { fontFamily: 'Brand Sans' } }] })
    const doc = docWith({ id: 'g', type: 'group', objects: [text('inner', 'Brand Sans'), styled] })
    expect(countTextLayersUsing(doc, 'Brand Sans')).toBe(2)
  })

  it('counts across pages', () => {
    const doc = docWith(text('a', 'Brand Sans'))
    const two: DoryDocument = { ...doc, pages: [...doc.pages, { ...doc.pages[0], id: 'p2', objects: [text('b', 'Brand Sans')] }] }
    expect(countTextLayersUsing(two, 'Brand Sans')).toBe(2)
  })
})
