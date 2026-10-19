import { describe, expect, it } from 'vitest'
import type { TemplateField } from '@/types/api'
import { autoMap, checkRows, parseTable } from './bulkTable'

const field = (key: string, type: TemplateField['type'], label: string | null = null): TemplateField => ({ key, type, label, pages: [1], object_ids: [key], current: null, fit: null, overflow: false })
const FIELDS = [field('name', 'text', 'Full name'), field('photo', 'image'), field('accent', 'color')]

describe('parseTable', () => {
  it('reads CSV with quotes, escaped quotes, line breaks in cells and blank lines', () => {
    expect(parseTable('name,quote\r\n"Lovelace, Ada","She said ""hi""\nthere"\n\n Grace , x\n')).toEqual({
      headers: ['name', 'quote'],
      rows: [
        ['Lovelace, Ada', 'She said "hi"\nthere'],
        ['Grace', 'x'],
      ],
    })
  })

  it('reads tab-separated text pasted from a spreadsheet and semicolon CSV', () => {
    expect(parseTable('a\tb\n1,5\t2').rows).toEqual([['1,5', '2']])
    expect(parseTable('a;b\n1,5;2').rows).toEqual([['1,5', '2']])
  })
})

describe('autoMap', () => {
  it('matches columns by key or label, ignoring case and punctuation', () => {
    expect(autoMap(['Full Name', 'PHOTO', 'other'], FIELDS)).toEqual({ name: 0, photo: 1, accent: -1 })
  })
})

describe('checkRows', () => {
  it('turns cells into values by field type and reports problems per row', () => {
    const table = parseTable('name,photo,accent\nAda,https://x.example/a.jpg,#7a64e0\nGrace,http://x.example/b.jpg,red\n,My upload,')
    const checks = checkRows(table, { name: 0, photo: 1, accent: 2 }, FIELDS)
    expect(checks[0]).toEqual({ index: 1, values: { name: 'Ada', photo: { url: 'https://x.example/a.jpg' }, accent: '#7a64e0' }, errors: {} })
    expect(checks[1].errors).toEqual({ photo: 'https', accent: 'color' })
    expect(checks[2]).toEqual({ index: 3, values: { photo: 'My upload' }, errors: {} })
  })
})
