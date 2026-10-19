import { normalizeHex } from '@/features/brand/colors'
import { DESIGN_DRAG_TYPE, hasDraggedDesigns, readDraggedDesigns, setDraggedDesigns } from './dragDrop'
import { TRASH_RETENTION_DAYS, daysUntilPurge } from './trash'

describe('daysUntilPurge', () => {
  const now = Date.parse('2025-06-30T12:00:00Z')
  it('counts down from 30 days and never goes negative', () => {
    expect(daysUntilPurge('2025-06-30T11:00:00Z', now)).toBe(TRASH_RETENTION_DAYS)
    expect(daysUntilPurge('2025-06-25T12:00:00Z', now)).toBe(25)
    expect(daysUntilPurge('2025-05-01T00:00:00Z', now)).toBe(0)
    expect(daysUntilPurge('garbage', now)).toBe(TRASH_RETENTION_DAYS)
  })
})

describe('normalizeHex', () => {
  it('expands short hex and lower-cases', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('e11d48')).toBe('#e11d48')
    expect(normalizeHex(' #E11D48 ')).toBe('#e11d48')
  })

  it('rejects anything that is not a 3 or 6 digit hex colour', () => {
    for (const bad of ['', '#', '#12', '#12345', '#gggggg', 'red', '#e11d48ff', 'rgb(1,2,3)']) expect(normalizeHex(bad)).toBeNull()
  })
})

describe('design drag payload', () => {
  function transfer() {
    const store = new Map<string, string>()
    return {
      get types() {
        return [...store.keys()]
      },
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
      effectAllowed: 'none',
    } as unknown as DataTransfer
  }

  it('round-trips design ids and is detectable while dragging', () => {
    const dataTransfer = transfer()
    setDraggedDesigns({ dataTransfer }, ['a', 'b'])
    expect(hasDraggedDesigns(dataTransfer)).toBe(true)
    expect(dataTransfer.types).toContain(DESIGN_DRAG_TYPE)
    expect(readDraggedDesigns(dataTransfer)).toEqual(['a', 'b'])
  })

  it('ignores unrelated or malformed drags', () => {
    const dataTransfer = transfer()
    expect(hasDraggedDesigns(dataTransfer)).toBe(false)
    expect(readDraggedDesigns(dataTransfer)).toEqual([])
    dataTransfer.setData(DESIGN_DRAG_TYPE, '{not json')
    expect(readDraggedDesigns(dataTransfer)).toEqual([])
    dataTransfer.setData(DESIGN_DRAG_TYPE, JSON.stringify([1, 'ok', null]))
    expect(readDraggedDesigns(dataTransfer)).toEqual(['ok'])
    expect(readDraggedDesigns(null)).toEqual([])
  })
})
