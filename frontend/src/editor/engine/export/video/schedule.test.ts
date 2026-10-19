import { describe, expect, it } from 'vitest'
import { FrameCursor, frameCount, frameDurationUs, frameStartMs, frameTimestampUs, framePlans, gifDelayCs, repeatsPrevious } from './schedule'
import { compileTimeline } from './timeline'
import { allPages, deck, doc, page } from './testing'

describe('frame count and timestamps', () => {
  it('has a whole number of frames for a length that is a whole number of frames, and one more for a part of one', () => {
    expect(frameCount(15_000, 24)).toBe(360)
    expect(frameCount(15_010, 24)).toBe(361)
    expect(frameCount(1000, 30)).toBe(30)
    expect(frameCount(1, 60)).toBe(1)
  })

  it('has no frames for no time, and never fewer than one for some', () => {
    expect(frameCount(0, 30)).toBe(0)
    expect(frameCount(-5, 30)).toBe(0)
    expect(frameCount(500, 0)).toBe(0)
  })

  it('computes a timestamp from the index, so it does not drift', () => {
    // 24 fps does not divide a microsecond: 41 666.67 us per frame. After an hour the error is still under a microsecond.
    const hour = 24 * 3600
    expect(Math.abs(frameTimestampUs(hour, 24) - 3_600_000_000)).toBeLessThanOrEqual(0.5)
    expect(frameTimestampUs(0, 24)).toBe(0)
    expect(frameTimestampUs(1, 24)).toBe(41_667)
    expect(frameTimestampUs(3, 24)).toBe(125_000)
    expect(frameStartMs(3, 24)).toBe(125)
  })

  it('has frame lengths that add up exactly to the timestamp of the end', () => {
    for (const fps of [24, 30, 60, 15, 7]) {
      let sum = 0
      for (let i = 0; i < 500; i++) sum += frameDurationUs(i, fps)
      expect(sum).toBe(frameTimestampUs(500, fps))
    }
  })

  it('has lengths that differ by at most a microsecond', () => {
    const lengths = new Set<number>()
    for (let i = 0; i < 1000; i++) lengths.add(frameDurationUs(i, 24))
    expect([...lengths].sort()).toEqual([41_666, 41_667])
  })
})

describe('gifDelayCs', () => {
  it('adds up to the length of the timeline in centiseconds', () => {
    for (const fps of [5, 10, 15, 20]) {
      const total = 7_330
      const frames = frameCount(total, fps)
      let sum = 0
      for (let i = 0; i < frames; i++) sum += gifDelayCs(i, fps, total)
      expect(sum).toBe(Math.round(total / 10))
    }
  })

  it('alternates the delays of 15 fps (66.7 ms) between 6 and 7 hundredths', () => {
    const delays = Array.from({ length: 9 }, (_, i) => gifDelayCs(i, 15, 60_000))
    expect(delays).toEqual([7, 6, 7, 7, 6, 7, 7, 6, 7])
  })

  it('is never negative, even for a frame that starts at the very end', () => {
    expect(gifDelayCs(1, 10, 100)).toBeGreaterThanOrEqual(0)
  })
})

describe('FrameCursor', () => {
  const timeline = compileTimeline(allPages(deck()), { pageSeconds: null })
  // a: 0..5500   b: 5500..9300 (transition 5500..6300)   c: 9300..15500 (transition 9300..9800)

  it('starts on the first page at the start of its clock', () => {
    const cursor = new FrameCursor(timeline, 30)
    expect(cursor.at(0)).toMatchObject({ kind: 'page', pageMs: 0 })
    expect(cursor.at(0).segment.page.id).toBe('a')
  })

  it('is in a transition from the first frame of the next page\'s slot, with a progress in 0..1', () => {
    const cursor = new FrameCursor(timeline, 10)
    // 10 fps: frame 55 starts at 5500 ms, the start of b.
    const first = cursor.at(55)
    expect(first).toMatchObject({ kind: 'transition', progress: 0 })
    expect(first.segment.page.id).toBe('b')
    const middle = cursor.at(59)
    expect(middle.kind === 'transition' && middle.progress).toBeCloseTo(0.5)
    // Frame 63 starts at 6300 ms: the transition is over and the page clock starts at 0.
    expect(cursor.at(63)).toMatchObject({ kind: 'page', pageMs: 0 })
    expect(cursor.at(66)).toMatchObject({ kind: 'page', pageMs: 300 })
  })

  it('puts a frame that starts exactly on a boundary in the later segment, with integer arithmetic at 24 fps too', () => {
    const cursor = new FrameCursor(timeline, 24)
    // 24 fps: 5500 ms is frame 132 exactly.
    expect(cursor.at(131).segment.page.id).toBe('a')
    expect(cursor.at(132).segment.page.id).toBe('b')
    expect(cursor.at(132).kind).toBe('transition')
  })

  it('visits every frame once and ends in the last page', () => {
    const plans = [...framePlans(timeline, 24)]
    expect(plans).toHaveLength(frameCount(timeline.totalMs, 24))
    expect(plans.at(-1)?.segment.page.id).toBe('c')
    const ids = plans.map((p) => p.segment.page.id)
    expect(ids).toEqual([...ids].sort())
  })

  it('answers out of order as well as in order', () => {
    const cursor = new FrameCursor(timeline, 10)
    const forward = [cursor.at(10), cursor.at(60), cursor.at(120)].map((p) => [p.kind, p.segment.page.id])
    const back = [cursor.at(120), cursor.at(60), cursor.at(10)].map((p) => [p.kind, p.segment.page.id]).reverse()
    expect(back).toEqual(forward)
  })

  it('never moves the page clock past the end of the page', () => {
    const cursor = new FrameCursor(timeline, 10)
    const last = cursor.at(frameCount(timeline.totalMs, 10) - 1)
    expect(last.kind === 'page' && last.pageMs).toBeLessThanOrEqual(last.segment.bodyMs)
  })

  it('handles a transition-less design as plain pages', () => {
    const plain = compileTimeline(allPages(doc([page('a', { durationSec: 1 }), page('b', { durationSec: 1 })])), { pageSeconds: null })
    const cursor = new FrameCursor(plain, 4)
    expect(cursor.at(3)).toMatchObject({ kind: 'page', pageMs: 750 })
    expect(cursor.at(4)).toMatchObject({ kind: 'page', pageMs: 0 })
    expect(cursor.at(4).segment.page.id).toBe('b')
  })
})

describe('repeatsPrevious', () => {
  it('is true once a page has settled, so a GIF can lengthen a frame instead of storing another', () => {
    const timeline = compileTimeline(allPages(deck()), { pageSeconds: null })
    const cursor = new FrameCursor(timeline, 10)
    // Page a settles at 1500 ms (frame 15). The frame at 1500 shows the settled page, the one after repeats it.
    expect(repeatsPrevious(cursor.at(16), cursor.at(15))).toBe(true)
    expect(repeatsPrevious(cursor.at(15), cursor.at(14))).toBe(false)
    expect(repeatsPrevious(cursor.at(0), null)).toBe(false)
  })

  it('is false across a transition and across pages', () => {
    const timeline = compileTimeline(allPages(deck()), { pageSeconds: null })
    const cursor = new FrameCursor(timeline, 10)
    expect(repeatsPrevious(cursor.at(55), cursor.at(54))).toBe(false)
    expect(repeatsPrevious(cursor.at(56), cursor.at(55))).toBe(false)
    expect(repeatsPrevious(cursor.at(63), cursor.at(62))).toBe(false)
  })
})
