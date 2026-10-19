import { describe, expect, it } from 'vitest'
import type { CommentT } from '@/types/api'
import { buildThreads, countThreads, filterThreads, initials, pinsByPage, placementOf, readingOrder, rightsFor, roundPoint, sameComments, stepInOrder } from './commentOps'

const author = { id: 'u', name: 'Alex Rivera', avatar_url: null }
const other = { id: 'v', name: 'Sam Lee', avatar_url: null }
const c = (id: string, over: Partial<CommentT> = {}): CommentT => ({ id, author, body: id, page_id: 'p1', x: 10, y: 10, parent: null, resolved: false, created_at: '2026-01-01T00:00:00Z', ...over })
const pages = new Set(['p1', 'p2'])

describe('threads', () => {
  it('groups replies under their root, oldest first, and numbers the pinned threads in the order they were started', () => {
    const list = [
      c('r2', { created_at: '2026-01-02T00:00:00Z' }),
      c('r1', { created_at: '2026-01-01T00:00:00Z' }),
      c('b', { parent: 'r1', created_at: '2026-01-04T00:00:00Z' }),
      c('a', { parent: 'r1', created_at: '2026-01-03T00:00:00Z' }),
      c('done', { resolved: true, created_at: '2026-01-05T00:00:00Z' }),
    ]
    const threads = buildThreads(list, pages)
    expect(threads.map((t) => t.root.id)).toEqual(['r1', 'r2', 'done'])
    expect(threads[0].replies.map((r) => r.id)).toEqual(['a', 'b'])
    expect(threads.map((t) => t.number)).toEqual([1, 2, 3])
  })

  it('drops replies whose parent is gone', () => {
    expect(buildThreads([c('orphan', { parent: 'missing' })], pages)).toEqual([])
  })

  it('tells pinned, page-only, page-removed and general threads apart; only pinned ones are numbered', () => {
    expect(placementOf(c('a'), pages)).toBe('pinned')
    expect(placementOf(c('a', { page_id: 'gone' }), pages)).toBe('removed')
    expect(placementOf(c('a', { page_id: 'gone', x: null, y: null }), pages)).toBe('removed')
    expect(placementOf(c('a', { page_id: null, x: null, y: null }), pages)).toBe('general')
    expect(placementOf(c('a', { page_id: null }), pages)).toBe('general')
    expect(placementOf(c('a', { x: null, y: null }), pages)).toBe('page')
    const threads = buildThreads(
      [
        c('a', { created_at: '2026-01-01T00:00:00Z' }),
        c('b', { page_id: 'gone', created_at: '2026-01-02T00:00:00Z' }),
        c('c', { page_id: null, x: null, y: null, created_at: '2026-01-03T00:00:00Z' }),
        c('e', { x: null, y: null, created_at: '2026-01-03T12:00:00Z' }),
        c('d', { created_at: '2026-01-04T00:00:00Z' }),
      ],
      pages,
    )
    expect(threads.map((t) => [t.root.id, t.placement, t.number])).toEqual([
      ['a', 'pinned', 1],
      ['b', 'removed', null],
      ['c', 'general', null],
      ['e', 'page', null],
      ['d', 'pinned', 2],
    ])
  })

  it('keeps a thread attached to its page when the pages are reordered (they are keyed by id)', () => {
    const before = buildThreads([c('a', { page_id: 'p2' })], new Set(['p1', 'p2']))
    const after = buildThreads([c('a', { page_id: 'p2' })], new Set(['p2', 'p1']))
    expect(before[0].placement).toBe('pinned')
    expect(after[0].placement).toBe('pinned')
  })

  it('breaks ties between comments made in the same second by id, so the order is stable', () => {
    const threads = buildThreads([c('b'), c('a')], pages)
    expect(threads.map((t) => t.root.id)).toEqual(['a', 'b'])
  })
})

describe('filters and counts', () => {
  const threads = buildThreads(
    [
      c('a', { created_at: '2026-01-01T00:00:00Z' }),
      c('b', { author: other, resolved: true, created_at: '2026-01-02T00:00:00Z' }),
      c('c', { author: other, created_at: '2026-01-03T00:00:00Z' }),
    ],
    pages,
  )

  it('keeps everything, the open threads or the viewer’s own', () => {
    expect(filterThreads(threads, 'all', author).map((t) => t.root.id)).toEqual(['a', 'b', 'c'])
    expect(filterThreads(threads, 'unresolved', author).map((t) => t.root.id)).toEqual(['a', 'c'])
    expect(filterThreads(threads, 'mine', author).map((t) => t.root.id)).toEqual(['a'])
    expect(filterThreads(threads, 'mine', null)).toEqual([])
  })

  it('always keeps the open thread, so resolving it does not make it vanish from under the reader', () => {
    expect(filterThreads(threads, 'unresolved', author, 'b').map((t) => t.root.id)).toEqual(['a', 'b', 'c'])
  })

  it('counts', () => {
    expect(countThreads(threads, author)).toEqual({ all: 3, unresolved: 2, mine: 1 })
    expect(countThreads(threads, null)).toEqual({ all: 3, unresolved: 2, mine: 0 })
  })
})

describe('pins', () => {
  const threads = buildThreads(
    [
      c('a', { page_id: 'p2', x: 5, y: 5, created_at: '2026-01-01T00:00:00Z' }),
      c('b', { page_id: 'p1', x: 50, y: 5, created_at: '2026-01-02T00:00:00Z' }),
      c('c', { page_id: 'p1', x: 5, y: 5, created_at: '2026-01-03T00:00:00Z' }),
      c('d', { page_id: 'gone', created_at: '2026-01-04T00:00:00Z' }),
      c('e', { page_id: 'p1', x: 5, y: 90, created_at: '2026-01-05T00:00:00Z' }),
    ],
    pages,
  )

  it('collects the pinned threads of each page', () => {
    const byPage = pinsByPage(threads)
    expect([...byPage.keys()].sort()).toEqual(['p1', 'p2'])
    expect(byPage.get('p1')?.map((t) => t.root.id)).toEqual(['b', 'c', 'e'])
  })

  it('walks the pins page by page, top to bottom, left to right', () => {
    expect(readingOrder(threads, ['p1', 'p2'])).toEqual(['c', 'b', 'e', 'a'])
    expect(readingOrder(threads, ['p2', 'p1'])).toEqual(['a', 'c', 'b', 'e'])
  })

  it('steps through the order without wrapping', () => {
    const order = ['c', 'b', 'e']
    expect(stepInOrder(order, 'c', 1)).toBe('b')
    expect(stepInOrder(order, 'e', 1)).toBe('e')
    expect(stepInOrder(order, 'c', -1)).toBe('c')
    expect(stepInOrder(order, null, 1)).toBe('c')
    expect(stepInOrder(order, null, -1)).toBe('e')
    expect(stepInOrder(order, 'unknown', 1)).toBe('c')
    expect(stepInOrder(order, 'b', 'first')).toBe('c')
    expect(stepInOrder(order, 'b', 'last')).toBe('e')
    expect(stepInOrder([], 'b', 1)).toBeNull()
  })
})

describe('rights', () => {
  const all = { resolve: () => undefined, remove: () => undefined, move: () => undefined }
  it('give the owner everything the adapter offers', () => {
    expect(rightsFor(all, { id: 'o', owner: true }, c('a', { author: other }))).toEqual({ resolve: true, remove: true, move: true })
  })
  it('give an author their own comments only, and no resolving unless the adapter offers it', () => {
    const viewer = { id: 'u', owner: false }
    expect(rightsFor({ remove: all.remove, move: all.move }, viewer, c('a'))).toEqual({ resolve: false, remove: true, move: true })
    expect(rightsFor({ remove: all.remove, move: all.move }, viewer, c('a', { author: other }))).toEqual({ resolve: false, remove: false, move: false })
  })
  it('give nobody who is not signed in anything to change', () => {
    expect(rightsFor({ remove: all.remove, move: all.move }, null, c('a'))).toEqual({ resolve: false, remove: false, move: false })
  })
  it('treat an adapter that does not say who is looking like the owner', () => {
    expect(rightsFor(all, undefined, c('a', { author: other }))).toEqual({ resolve: true, remove: true, move: true })
  })
  it('never move a reply on its own', () => {
    expect(rightsFor(all, { id: 'o', owner: true }, c('r', { parent: 'a' })).move).toBe(false)
  })
  it('offer only what the adapter has', () => {
    expect(rightsFor({}, { id: 'o', owner: true }, c('a'))).toEqual({ resolve: false, remove: false, move: false })
  })
})

describe('helpers', () => {
  it('detects a refresh that changed nothing', () => {
    const a = [c('a'), c('b')]
    expect(sameComments(a, [c('a'), c('b')])).toBe(true)
    expect(sameComments(a, a)).toBe(true)
    expect(sameComments(a, [c('a')])).toBe(false)
    expect(sameComments(a, [c('a'), c('b', { resolved: true })])).toBe(false)
    expect(sameComments(a, [c('a'), c('b', { x: 11 })])).toBe(false)
    expect(sameComments(a, [c('a'), c('b', { body: 'edited' })])).toBe(false)
    expect(sameComments(a, [c('a'), c('b', { author: other })])).toBe(false)
  })

  it('makes initials from one or two names', () => {
    expect(initials('Alex Rivera')).toBe('AR')
    expect(initials('  madonna ')).toBe('M')
    expect(initials('Ana Maria Costa')).toBe('AC')
    expect(initials('')).toBe('?')
  })

  it('rounds a point to two decimals', () => {
    expect(roundPoint(1.23456, 7.891)).toEqual({ x: 1.23, y: 7.89 })
    expect(roundPoint(10, 20)).toEqual({ x: 10, y: 20 })
  })
})
