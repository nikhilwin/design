import { SCHEMA_VERSION } from '@/types/document'
import { DocumentError, type Migration, migrateDocument, runMigrations } from './migrations'

const base = { schemaVersion: 1, width: 800, height: 600, unit: 'px', pages: [{ id: 'p1', background: { type: 'solid', color: '#fff' }, objects: [{ id: 'a', type: 'Rect' }] }] }

describe('migrateDocument', () => {
  it('accepts a valid current document and lower-cases object types', () => {
    const doc = migrateDocument(base)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.pages[0].objects[0].type).toBe('rect')
    expect(doc.pages[0].objects[0].id).toBe('a')
  })

  it('does not mutate its input', () => {
    const input = structuredClone(base)
    migrateDocument(input)
    expect(input).toEqual(base)
  })

  it('rejects non-objects and newer versions with a clear error', () => {
    expect(() => migrateDocument(null)).toThrow(DocumentError)
    expect(() => migrateDocument([])).toThrow(DocumentError)
    expect(() => migrateDocument({ ...base, schemaVersion: 99 })).toThrow(/newer version/)
    expect(() => migrateDocument({ ...base, schemaVersion: 0 })).toThrow(DocumentError)
  })

  it('defaults missing fields: ids, background, unit, sizes', () => {
    const doc = migrateDocument({ pages: [{ objects: [{ type: 'rect' }, { nope: true }] }] })
    expect(doc.width).toBe(1080)
    expect(doc.unit).toBe('px')
    expect(doc.pages[0].id).toMatch(/[0-9a-f-]{36}/)
    expect(doc.pages[0].background).toEqual({ type: 'solid', color: '#ffffff' })
    expect(doc.pages[0].objects).toHaveLength(1)
    expect(doc.pages[0].objects[0].id).toMatch(/[0-9a-f-]{36}/)
  })

  it('creates one blank page when pages are missing or empty', () => {
    expect(migrateDocument({ ...base, pages: [] }).pages).toHaveLength(1)
    expect(migrateDocument({ ...base, pages: undefined }).pages).toHaveLength(1)
  })

  it('de-duplicates object and page ids', () => {
    const doc = migrateDocument({
      ...base,
      pages: [
        { id: 'p', objects: [{ id: 'x', type: 'rect' }, { id: 'x', type: 'rect' }] },
        { id: 'p', objects: [] },
      ],
    })
    const ids = doc.pages[0].objects.map((o) => o.id)
    expect(new Set(ids).size).toBe(2)
    expect(doc.pages[0].id).not.toBe(doc.pages[1].id)
  })

  it('clamps dimensions and caps pages at 100', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, objects: [] }))
    const doc = migrateDocument({ ...base, width: 999999, height: -4, pages: many })
    expect(doc.width).toBe(20000)
    expect(doc.height).toBe(1)
    expect(doc.pages).toHaveLength(100)
  })

  it('repairs invalid backgrounds', () => {
    const doc = migrateDocument({ ...base, pages: [{ id: 'p', background: { type: 'gradient', stops: [] }, objects: [] }] })
    expect(doc.pages[0].background.type).toBe('solid')
  })

  it('normalises nested group children', () => {
    const doc = migrateDocument({ ...base, pages: [{ id: 'p', objects: [{ id: 'g', type: 'Group', objects: [{ type: 'Rect' }, 5] }] }] })
    const children = doc.pages[0].objects[0].objects as { id: string; type: string }[]
    expect(children).toHaveLength(1)
    expect(children[0].type).toBe('rect')
    expect(children[0].id).toBeTruthy()
  })

  it('chains migrations in order and reports a missing step', () => {
    const calls: number[] = []
    const step =
      (n: number): Migration =>
      (d) => {
        calls.push(n)
        return { ...d, schemaVersion: n + 1 }
      }
    const out = runMigrations({ schemaVersion: 1 }, 1, 4, { 1: step(1), 2: step(2), 3: step(3) })
    expect(calls).toEqual([1, 2, 3])
    expect(out.schemaVersion).toBe(4)
    expect(() => runMigrations({}, 1, 3, { 1: step(1) })).toThrow(/No migration from version 2/)
    expect(runMigrations({ a: 1 }, 2, 2, {})).toEqual({ a: 1 })
  })
})
