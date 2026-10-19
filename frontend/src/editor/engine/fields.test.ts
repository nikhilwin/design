import { describe, expect, it } from 'vitest'
import type { DocObject, DocPage } from '@/types/document'
import { FIELD_KEY, collectFields, duplicateKeys, fieldTypeFor, keyClashes, readField } from './fields'

const obj = (id: string, field?: unknown, objects?: DocObject[]): DocObject => ({ id, type: 'rect', ...(field ? { field } : {}), ...(objects ? { objects } : {}) })
const pageOf = (id: string, objects: DocObject[]): DocPage => ({ id, background: { type: 'solid', color: '#fff' }, objects }) as DocPage

describe('template fields', () => {
  it('accepts lower-case keys that start with a letter, up to 40 characters', () => {
    expect(FIELD_KEY.test('headline')).toBe(true)
    expect(FIELD_KEY.test('photo_2')).toBe(true)
    expect(FIELD_KEY.test('a'.repeat(40))).toBe(true)
    for (const bad of ['', '2nd', '_x', 'Hero', 'hero-title', 'a'.repeat(41)]) expect(FIELD_KEY.test(bad)).toBe(false)
  })

  it('reads only well-formed tags', () => {
    expect(readField({ key: 'name', type: 'text', label: 'Name' })).toEqual({ key: 'name', type: 'text', label: 'Name' })
    expect(readField({ key: 'name', type: 'text', label: '' })).toEqual({ key: 'name', type: 'text' })
    expect(readField({ key: 'Name', type: 'text' })).toBeNull()
    expect(readField({ key: 'name', type: 'video' })).toBeNull()
    expect(readField('name')).toBeNull()
  })

  it('maps object kinds to field types', () => {
    expect(fieldTypeFor('text')).toBe('text')
    expect(fieldTypeFor('image')).toBe('image')
    expect(fieldTypeFor('placeholder')).toBe('image')
    expect(fieldTypeFor('shape')).toBe('color')
    expect(fieldTypeFor('group')).toBeNull()
  })

  it('collects tags on every page, inside groups too', () => {
    const doc = {
      pages: [
        pageOf('p1', [obj('a', { key: 'title', type: 'text' }), obj('g', undefined, [obj('b', { key: 'photo', type: 'image' })])]),
        pageOf('p2', [obj('c', { key: 'title', type: 'text' })]),
      ],
    }
    expect(collectFields(doc).map((u) => [u.field.key, u.objectId, u.page])).toEqual([
      ['title', 'a', 1],
      ['photo', 'b', 1],
      ['title', 'c', 2],
    ])
    expect(duplicateKeys(doc)).toEqual([])
  })

  it('flags a key used twice on one page or with another type', () => {
    const doc = {
      pages: [
        pageOf('p1', [obj('a', { key: 'title', type: 'text' }), obj('b', { key: 'title', type: 'text' }), obj('c', { key: 'logo', type: 'image' })]),
        pageOf('p2', [obj('d', { key: 'logo', type: 'color' })]),
      ],
    }
    expect(duplicateKeys(doc)).toEqual(['logo', 'title'])
    expect(keyClashes(doc, 'title', 'text', 'a', 1)).toBe(true)
    expect(keyClashes(doc, 'logo', 'image', 'x', 3)).toBe(true)
    expect(keyClashes(doc, 'free', 'text', 'a', 1)).toBe(false)
  })
})
