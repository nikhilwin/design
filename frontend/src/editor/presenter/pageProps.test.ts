import { describe, expect, it } from 'vitest'
import type { DocPage, DoryDocument } from '@/types/document'
import { pageNotes, sanitizeNotes, setAllDurations, setPageDuration, setPageNotes } from './pageProps'
import { NOTES_MAX_LENGTH } from './timing'

const page = (id: string, extra: Partial<DocPage> = {}): DocPage => ({ id, background: { type: 'solid', color: '#ffffff' }, objects: [], ...extra })
const docOf = (...pages: DocPage[]): DoryDocument => ({ schemaVersion: 1, width: 800, height: 600, unit: 'px', pages })

describe('sanitizeNotes', () => {
  it('keeps ordinary text, including emoji and accents, untouched', () => {
    expect(sanitizeNotes('Grüße 🎨\nsecond line')).toBe('Grüße 🎨\nsecond line')
  })

  it('turns CRLF and CR into LF', () => {
    expect(sanitizeNotes('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('drops NUL characters and lone surrogates the server would refuse', () => {
    expect(sanitizeNotes('a\u0000b')).toBe('ab')
    expect(sanitizeNotes('x\ud83dy')).toBe('xy')
    expect(sanitizeNotes('x\ude00y')).toBe('xy')
    expect(sanitizeNotes('\ud83d')).toBe('')
  })

  it('caps the length and never cuts a surrogate pair in half', () => {
    expect(sanitizeNotes('a'.repeat(NOTES_MAX_LENGTH + 50))).toHaveLength(NOTES_MAX_LENGTH)
    const nearEdge = 'a'.repeat(NOTES_MAX_LENGTH - 1) + '🎨'
    const cut = sanitizeNotes(nearEdge)
    expect(cut).toBe('a'.repeat(NOTES_MAX_LENGTH - 1))
    expect(cut.charCodeAt(cut.length - 1)).toBe(97)
  })
})

describe('setPageNotes', () => {
  it('sets the notes of one page and shares everything else', () => {
    const doc = docOf(page('a'), page('b'))
    const next = setPageNotes(doc, 'b', 'Say hello')
    expect(next.pages[1].notes).toBe('Say hello')
    expect(next.pages[0]).toBe(doc.pages[0])
    expect(pageNotes(next.pages[1])).toBe('Say hello')
  })

  it('removes the property for empty or blank text instead of storing an empty string', () => {
    const doc = docOf(page('a', { notes: 'x' }))
    const next = setPageNotes(doc, 'a', '  \n ')
    expect('notes' in next.pages[0]).toBe(false)
    expect(setPageNotes(next, 'a', '')).toBe(next)
  })

  it('returns the same document when nothing changes or the page is unknown', () => {
    const doc = docOf(page('a', { notes: 'same' }))
    expect(setPageNotes(doc, 'a', 'same')).toBe(doc)
    expect(setPageNotes(doc, 'missing', 'x')).toBe(doc)
  })

  it('stores sanitised text', () => {
    const next = setPageNotes(docOf(page('a')), 'a', 'one\r\ntwo\u0000')
    expect(next.pages[0].notes).toBe('one\ntwo')
  })
})

describe('setPageDuration', () => {
  it('sets, rounds and clamps to 1-600 seconds', () => {
    const doc = docOf(page('a'))
    expect(setPageDuration(doc, 'a', 7).pages[0].durationSec).toBe(7)
    expect(setPageDuration(doc, 'a', 7.6).pages[0].durationSec).toBe(8)
    expect(setPageDuration(doc, 'a', 0).pages[0].durationSec).toBe(1)
    expect(setPageDuration(doc, 'a', -40).pages[0].durationSec).toBe(1)
    expect(setPageDuration(doc, 'a', 99999).pages[0].durationSec).toBe(600)
  })

  it('ignores values that are not numbers', () => {
    const doc = docOf(page('a', { durationSec: 4 }))
    expect(setPageDuration(doc, 'a', Number.NaN)).toBe(doc)
    expect(setPageDuration(doc, 'a', Number.POSITIVE_INFINITY)).toBe(doc)
    expect(setPageDuration(doc, 'a', '9' as unknown as number)).toBe(doc)
  })

  it('removes the property for null and leaves no undefined behind', () => {
    const next = setPageDuration(docOf(page('a', { durationSec: 4 })), 'a', null)
    expect('durationSec' in next.pages[0]).toBe(false)
  })

  it('returns the same document when nothing changes', () => {
    const doc = docOf(page('a', { durationSec: 4 }), page('b'))
    expect(setPageDuration(doc, 'a', 4)).toBe(doc)
    expect(setPageDuration(doc, 'b', null)).toBe(doc)
    expect(setPageDuration(doc, 'missing', 4)).toBe(doc)
  })
})

describe('setAllDurations', () => {
  it('gives every page the time and keeps pages that already have it', () => {
    const doc = docOf(page('a', { durationSec: 6 }), page('b'), page('c', { durationSec: 9 }))
    const next = setAllDurations(doc, 6)
    expect(next.pages.map((p) => p.durationSec)).toEqual([6, 6, 6])
    expect(next.pages[0]).toBe(doc.pages[0])
  })

  it('clears every page for null', () => {
    const next = setAllDurations(docOf(page('a', { durationSec: 6 }), page('b', { durationSec: 3 })), null)
    expect(next.pages.some((p) => 'durationSec' in p)).toBe(false)
  })

  it('clamps and ignores non-numbers', () => {
    const doc = docOf(page('a'))
    expect(setAllDurations(doc, 5000).pages[0].durationSec).toBe(600)
    expect(setAllDurations(doc, Number.NaN)).toBe(doc)
    expect(setAllDurations(doc, null)).toBe(doc)
  })
})
