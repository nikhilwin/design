import { describe, expect, it } from 'vitest'
import type { AudioTrack } from '@/types/document'
import { buildClock } from './clock'
import { moveEdit, timelineItems, timesOf, trimEndEdit, trimStartEdit } from './timelineModel'

const track = (patch: Partial<AudioTrack> = {}): AudioTrack => ({
  id: 't',
  kind: 'sfx',
  name: 'Track',
  src: '/media/a.ogg',
  scope: { type: 'design' },
  startMs: 0,
  durationMs: 10_000,
  trimStartMs: 0,
  trimEndMs: 2000,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  muted: false,
  ...patch,
})

const clock = buildClock(['a', 'b', 'c'], [4000, 6000, 5000])

describe('timelineItems', () => {
  it('lists the page tracks of the page and the design tracks that reach it, on the page clock', () => {
    const items = timelineItems(
      [
        track({ id: 'own', scope: { type: 'page', pageId: 'b' }, startMs: 1000 }),
        track({ id: 'other', scope: { type: 'page', pageId: 'a' } }),
        track({ id: 'music', kind: 'music', loop: true, trimEndMs: 3000 }),
        track({ id: 'early', startMs: 500 }),
        track({ id: 'late', startMs: 12_000 }),
      ],
      clock,
      'b',
    )
    expect(items.map((i) => i.track.id)).toEqual(['music', 'own'])
    const music = items[0]
    // Page b starts at 4 s on the design clock: the music began 4 s before the page and runs on to the end of the show.
    expect(music).toMatchObject({ startMs: -4000, endMs: 11_000, fullEndMs: -1000, scopeEndMs: 6000 })
    expect(items[1]).toMatchObject({ startMs: 1000, endMs: 3000, fullEndMs: 3000 })
  })

  it('lists the tracks of the whole design first, then those of the page by start, ties in document order', () => {
    const items = timelineItems(
      [
        track({ id: 'late', scope: { type: 'page', pageId: 'a' }, startMs: 2000 }),
        track({ id: 'music', kind: 'music', loop: true }),
        track({ id: 'early-b', scope: { type: 'page', pageId: 'a' }, startMs: 500 }),
        track({ id: 'early-a', scope: { type: 'page', pageId: 'a' }, startMs: 500 }),
      ],
      clock,
      'a',
    )
    expect(items.map((i) => i.track.id)).toEqual(['music', 'early-b', 'early-a', 'late'])
  })

  it('cuts a track at the end of its page', () => {
    const [item] = timelineItems([track({ scope: { type: 'page', pageId: 'a' }, trimEndMs: 9000 })], clock, 'a')
    // The sound would go on for 9 s; the page ends after 4 s.
    expect(item).toMatchObject({ startMs: 0, endMs: 4000, fullEndMs: 9000, scopeEndMs: 4000 })
  })

  it('leaves out a track that ends before the page or starts after it', () => {
    const items = timelineItems([track({ id: 'x', startMs: 0, trimEndMs: 1000 }), track({ id: 'y', startMs: 4000, trimEndMs: 1000 })], clock, 'c')
    expect(items).toEqual([])
  })

  it('knows nothing of a page that is not in the clock', () => {
    expect(timelineItems([track()], clock, 'gone')).toEqual([])
  })

  it('does not list a track of a deleted page', () => {
    expect(timelineItems([track({ scope: { type: 'page', pageId: 'gone' } })], clock, 'a')).toEqual([])
  })
})

describe('what a drag does', () => {
  const from = timesOf(track({ startMs: 1000, trimStartMs: 500, trimEndMs: 4500 }))

  it('moves the bar and keeps it inside its scope', () => {
    expect(moveEdit(from, 250)).toEqual({ startMs: 1250 })
    expect(moveEdit(from, -5000)).toEqual({ startMs: 0 })
  })

  it('trims the start by cutting the sound and keeping the rest in place', () => {
    expect(trimStartEdit(from, 700)).toEqual({ startMs: 1700, trimStartMs: 1200 })
    // Dragging left gives back the sound that was cut, until the file or the scope begins.
    expect(trimStartEdit(from, -200)).toEqual({ startMs: 800, trimStartMs: 300 })
    expect(trimStartEdit(from, -900)).toEqual({ startMs: 500, trimStartMs: 0 })
    expect(trimStartEdit(timesOf(track({ startMs: 100, trimStartMs: 800, trimEndMs: 4500 })), -900)).toEqual({ startMs: 0, trimStartMs: 700 })
  })

  it('does not trim the start past the end', () => {
    expect(trimStartEdit(from, 99_999)).toEqual({ startMs: 1000 + 3950, trimStartMs: 500 + 3950 })
  })

  it('trims the end within the file and never below the start', () => {
    expect(trimEndEdit(from, -1000, 10_000)).toEqual({ trimEndMs: 3500 })
    expect(trimEndEdit(from, 99_999, 10_000)).toEqual({ trimEndMs: 10_000 })
    expect(trimEndEdit(from, -99_999, 10_000)).toEqual({ trimEndMs: 550 })
    // A file of unknown length can still be shortened but not made longer than it was.
    expect(trimEndEdit(from, 500, 0)).toEqual({ trimEndMs: 4500 })
  })
})
