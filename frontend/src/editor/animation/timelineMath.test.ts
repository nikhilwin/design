import { describe, expect, it } from 'vitest'
import type { DocObject, DocPage, ObjectAnimation } from '@/types/document'
import { pageSpans } from './model'
import { dragBar, fitScale, fittingDurationSec, formatSeconds, formatTime, lanesOf, overrunOf, pageHoldEndMs, pageMarkerMs, previewLengthMs, roundToStep, rulerTicks, snapTargets, snapTime, tickStep, timeToX, xToTime } from './timelineMath'

const obj = (id: string, animation?: ObjectAnimation): DocObject => ({ id, type: 'rect', left: 0, top: 0, width: 10, height: 10, ...(animation ? { animation } : {}) })
const page = (objects: DocObject[], durationSec?: number): DocPage => ({ id: 'p', background: { type: 'solid', color: '#fff' }, objects, ...(durationSec ? { durationSec } : {}) })
const enter = (delayMs: number, durationMs: number): ObjectAnimation => ({ enter: { preset: 'fade', durationMs, delayMs, easing: 'linear' } })

describe('time and pixels', () => {
  it('converts both ways', () => {
    expect(timeToX(2000, 0.1)).toBe(200)
    expect(xToTime(200, 0.1)).toBeCloseTo(2000, 9)
    expect(xToTime(10, 0)).toBe(0)
  })

  it('fits the page into the track', () => {
    expect(fitScale(800, 3500)).toBeCloseTo(800 / 5000, 9)
    expect(fitScale(800, 0)).toBeCloseTo(800 / 2000, 9)
    expect(fitScale(0, 100)).toBeGreaterThan(0)
  })

  it('rounds to a tenth of a second', () => {
    expect(roundToStep(149)).toBe(100)
    expect(roundToStep(150)).toBe(200)
    expect(roundToStep(-60)).toBe(-100)
  })
})

describe('ruler', () => {
  it('picks a tick step that keeps the labels apart at every scale', () => {
    for (const px of [0.002, 0.01, 0.05, 0.1, 0.5, 1, 4]) {
      const step = tickStep(px)
      expect(step * px).toBeGreaterThanOrEqual(56 - 1e-9)
    }
    expect(tickStep(0.1)).toBe(1000)
    expect(tickStep(1)).toBe(100)
    expect(tickStep(1e-9)).toBe(300_000)
  })

  it('labels whole seconds', () => {
    const ticks = rulerTicks(3000, 500)
    expect(ticks.map((t) => t.ms)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000])
    expect(ticks.filter((t) => t.major).map((t) => t.ms)).toEqual([0, 1000, 2000, 3000])
    expect(rulerTicks(10_000, 5000).every((t) => t.major)).toBe(true)
  })

  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(3200)).toBe('0:03')
    expect(formatTime(3200, true)).toBe('0:03.2')
    expect(formatTime(85_400, true)).toBe('1:25.4')
    expect(formatTime(Number.NaN)).toBe('0:00')
    expect(formatTime(-5)).toBe('0:00')
    expect(formatSeconds(600)).toBe('0.6 s')
    expect(formatSeconds(2000)).toBe('2 s')
  })
})

describe('snapping', () => {
  it('goes to a target within reach, otherwise to the grid', () => {
    expect(snapTime(1130, [1180, 3000], 100)).toBe(1180)
    expect(snapTime(1130, [1500], 100)).toBe(1100)
    expect(snapTime(1130, [], 100)).toBe(1100)
  })

  it('takes the nearest of several targets', () => {
    expect(snapTime(1000, [940, 1010, 1060], 100)).toBe(1010)
  })

  it('collects the edges of the other bars, but not the dragged one', () => {
    const spans = pageSpans(page([obj('a', enter(0, 500)), obj('b', enter(1000, 500))]))
    expect(snapTargets(spans, { objectId: 'a', slot: 'enter' }, [2500, null])).toEqual([0, 1000, 1500, 2500])
  })
})

describe('dragging a bar', () => {
  const bar = { delayMs: 1000, durationMs: 600 }

  it('moves it on the grid and keeps its length', () => {
    expect(dragBar('move', bar, 1730, [], 50)).toEqual({ delayMs: 1700, durationMs: 600 })
    expect(dragBar('move', bar, -300, [], 50)).toEqual({ delayMs: 0, durationMs: 600 })
    expect(dragBar('move', bar, 999_999, [], 50).delayMs).toBe(60_000)
  })

  it('snaps either edge of a moving bar to a target', () => {
    // Its start comes within reach of 2000...
    expect(dragBar('move', bar, 1960, [2000], 60).delayMs).toBe(2000)
    // ...and so does its end (start + 600 = 2530 is near 2500).
    expect(dragBar('move', bar, 1930, [2500], 60).delayMs).toBe(1900)
  })

  it('drags the start without moving the end', () => {
    expect(dragBar('start', bar, 700, [], 50)).toEqual({ delayMs: 700, durationMs: 900 })
    expect(dragBar('start', bar, 1590, [], 50)).toEqual({ delayMs: 1500, durationMs: 100 })
    expect(dragBar('start', bar, 5000, [], 50)).toEqual({ delayMs: 1500, durationMs: 100 })
    expect(dragBar('start', bar, -400, [], 50)).toEqual({ delayMs: 0, durationMs: 1600 })
  })

  it('drags the end without moving the start', () => {
    expect(dragBar('end', bar, 2400, [], 50)).toEqual({ delayMs: 1000, durationMs: 1400 })
    expect(dragBar('end', bar, 1010, [], 50)).toEqual({ delayMs: 1000, durationMs: 100 })
    expect(dragBar('end', bar, 99_999, [], 50).durationMs).toBe(10_000)
  })

  it('never leaves the document ranges whatever it is given', () => {
    for (const kind of ['move', 'start', 'end'] as const) {
      for (const ms of [-1e9, -1, 0, 1, 1e4, 1e9]) {
        const r = dragBar(kind, bar, ms, [0, 5000], 80)
        expect(r.delayMs).toBeGreaterThanOrEqual(0)
        expect(r.delayMs).toBeLessThanOrEqual(60_000)
        expect(r.durationMs).toBeGreaterThanOrEqual(100)
        expect(r.durationMs).toBeLessThanOrEqual(10_000)
      }
    }
  })
})

describe('lanes', () => {
  it('has one lane per animated object, earliest first, upper objects first among equals', () => {
    const p = page([obj('plain'), obj('late', enter(2000, 500)), obj('a', enter(0, 500)), obj('b', { ...enter(0, 500), exit: { preset: 'fade', durationMs: 500, delayMs: 3000, easing: 'ease-in' } })])
    const lanes = lanesOf(p)
    expect(lanes.map((l) => l.object.id)).toEqual(['b', 'a', 'late'])
    expect(lanes[0].spans).toHaveLength(2)
    expect(lanes[0].z).toBe(3)
  })

  it('is empty for a page without animation', () => {
    expect(lanesOf(page([obj('a')]))).toEqual([])
  })
})

describe('the end of the page', () => {
  it('has no marker without a page time and builds it from the build-up and the time with one', () => {
    const p = page([obj('a', enter(0, 1000))])
    expect(pageMarkerMs(p)).toBeNull()
    expect(pageMarkerMs({ ...p, durationSec: 4 })).toBe(5000)
    expect(pageHoldEndMs(p)).toBe(6000)
  })

  it('reports animations that run past the page and the time that would make them fit', () => {
    const p = page([obj('a', { ...enter(0, 1000), exit: { preset: 'fade', durationMs: 500, delayMs: 5800, easing: 'ease-in' } })], 4)
    const over = overrunOf(p)
    expect(over?.overMs).toBe(6300 - 5000)
    expect(over?.spans.map((s) => s.slot)).toEqual(['exit'])
    expect(fittingDurationSec(p)).toBe(6)
    expect(overrunOf({ ...p, durationSec: 6 })).toBeNull()
    expect(overrunOf({ ...p, durationSec: undefined })).toBeNull()
  })

  it('does not count a looping emphasis as running late', () => {
    const p = page([obj('a', { emphasis: { preset: 'float', durationMs: 2400, delayMs: 3000, easing: 'linear', loop: true } })], 2)
    expect(overrunOf(p)).toBeNull()
  })

  it('previews until everything is over', () => {
    expect(previewLengthMs(page([]))).toBe(500)
    expect(previewLengthMs(page([obj('a', enter(0, 1200))]))).toBe(1200)
    expect(previewLengthMs(page([obj('a', enter(0, 1200))], 5))).toBe(6200)
    expect(previewLengthMs(page([obj('a', { emphasis: { preset: 'float', durationMs: 2400, delayMs: 500, easing: 'linear', loop: true } })]))).toBe(4400)
  })
})
