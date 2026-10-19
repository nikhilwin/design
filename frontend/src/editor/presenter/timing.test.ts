import { describe, expect, it } from 'vitest'
import { clampDuration, DEFAULT_DURATION_SEC, formatClock, formatDuration, hasTimings, pageDuration, resolveDurations } from './timing'

describe('clampDuration', () => {
  it('rounds and limits to 1-600', () => {
    expect(clampDuration(5)).toBe(5)
    expect(clampDuration(0.2)).toBe(1)
    expect(clampDuration(2.5)).toBe(3)
    expect(clampDuration(601)).toBe(600)
    expect(clampDuration(-3)).toBe(1)
  })

  it('refuses everything that is not a finite number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, {}, true]) expect(clampDuration(bad)).toBeNull()
  })
})

describe('pageDuration and resolveDurations', () => {
  it('only accepts a usable number in range', () => {
    expect(pageDuration({ durationSec: 8 })).toBe(8)
    expect(pageDuration({})).toBeNull()
    expect(pageDuration({ durationSec: 0 })).toBeNull()
    expect(pageDuration({ durationSec: 601 })).toBeNull()
    expect(pageDuration({ durationSec: Number.NaN })).toBeNull()
    expect(pageDuration({ durationSec: '4' as unknown as number })).toBeNull()
  })

  it('uses the default for every page of a design without any time', () => {
    expect(hasTimings([{}, {}])).toBe(false)
    expect(resolveDurations([{}, {}, {}])).toEqual([DEFAULT_DURATION_SEC, DEFAULT_DURATION_SEC, DEFAULT_DURATION_SEC])
    expect(resolveDurations([{}, {}], 12)).toEqual([12, 12])
  })

  it('follows the pages of a timed design: a page without a time waits', () => {
    expect(hasTimings([{}, { durationSec: 3 }])).toBe(true)
    expect(resolveDurations([{ durationSec: 2 }, {}, { durationSec: 30 }])).toEqual([2, null, 30])
  })

  it('treats an unusable time as no time', () => {
    expect(resolveDurations([{ durationSec: 0 }, { durationSec: 9 }])).toEqual([null, 9])
    expect(resolveDurations([{ durationSec: 0 }])).toEqual([DEFAULT_DURATION_SEC])
  })
})

describe('formatting', () => {
  it('formats page times', () => {
    expect(formatDuration(5)).toBe('5 s')
    expect(formatDuration(59)).toBe('59 s')
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(90)).toBe('1:30')
    expect(formatDuration(600)).toBe('10:00')
  })

  it('formats clock readings', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7_400)).toBe('0:07')
    expect(formatClock(725_000)).toBe('12:05')
    expect(formatClock(3_723_000)).toBe('1:02:03')
    expect(formatClock(-5)).toBe('0:00')
  })
})
