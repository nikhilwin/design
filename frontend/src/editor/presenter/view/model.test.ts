import { describe, expect, it } from 'vitest'
import type { PagePreview } from '../channel'
import { initialState, type SlideshowConfig } from '../machine'
import { bestFrame, configOf, extrapolate, frameWidthFor, pageClock, SIGNAL_LOST_MS } from './model'

const page = (id: string, durationSec: number | null): PagePreview => ({ id, name: id, notes: '', durationSec, width: 1920, height: 1080 })
const config: SlideshowConfig = configOf([page('a', 10), page('b', null), page('c', 4)])

describe('configOf', () => {
  it('takes the count and the times from the pages', () => {
    expect(config).toEqual({ count: 3, durations: [10, null, 4] })
  })
})

describe('extrapolate', () => {
  it('moves the total clock and a running page clock forward', () => {
    const s = { ...initialState(config, { autoAdvance: true }), pageMs: 2000, totalMs: 9000 }
    expect(extrapolate(config, s, 1500)).toMatchObject({ pageMs: 3500, totalMs: 10_500, index: 0 })
  })

  it('never lets the page clock pass its time, nor change the page', () => {
    const s = { ...initialState(config, { autoAdvance: true }), pageMs: 9000 }
    const later = extrapolate(config, s, 4000)
    expect(later.pageMs).toBe(10_000)
    expect(later.index).toBe(0)
  })

  it('keeps the page clock still when paused, blacked out, waiting or auto-advance is off', () => {
    const base = { ...initialState(config, { autoAdvance: true }), pageMs: 2000 }
    expect(extrapolate(config, { ...base, paused: true }, 1000).pageMs).toBe(2000)
    expect(extrapolate(config, { ...base, blackout: true }, 1000).pageMs).toBe(2000)
    expect(extrapolate(config, { ...base, index: 1 }, 1000).pageMs).toBe(2000)
    expect(extrapolate(config, { ...base, autoAdvance: false }, 1000).pageMs).toBe(2000)
    expect(extrapolate(config, { ...base, autoAdvance: false }, 1000).totalMs).toBe(1000)
  })

  it('stops everything on the end screen and caps how far it runs ahead', () => {
    const ended = { ...initialState(config), ended: true, totalMs: 500 }
    expect(extrapolate(config, ended, 3000)).toBe(ended)
    expect(extrapolate(config, initialState(config), 60_000).totalMs).toBe(5000)
    expect(extrapolate(config, initialState(config), -50)).toEqual(initialState(config))
  })

  it('treats a lost signal as longer than the heartbeat', () => {
    expect(SIGNAL_LOST_MS).toBeGreaterThan(2000)
  })
})

describe('pageClock', () => {
  it('describes every situation', () => {
    const on = initialState(config, { autoAdvance: true })
    expect(pageClock(config, initialState(config))).toEqual({ kind: 'off' })
    expect(pageClock(config, { ...on, ended: true })).toEqual({ kind: 'off' })
    expect(pageClock(config, { ...on, paused: true })).toEqual({ kind: 'paused' })
    expect(pageClock(config, { ...on, index: 1 })).toEqual({ kind: 'waits' })
    expect(pageClock(config, { ...on, pageMs: 4000 })).toEqual({ kind: 'running', remainingMs: 6000, progress: 0.4 })
  })
})

describe('frameWidthFor', () => {
  it('rounds device pixels up to a step within limits', () => {
    expect(frameWidthFor(500, 1)).toBe(640)
    expect(frameWidthFor(500, 2)).toBe(1120)
    expect(frameWidthFor(10, 1)).toBe(160)
    expect(frameWidthFor(5000, 2)).toBe(1600)
    expect(frameWidthFor(0, 1)).toBe(160)
    expect(frameWidthFor(500, Number.NaN)).toBe(640)
  })
})

describe('bestFrame', () => {
  const frames = [
    { width: 320, url: 'small' },
    { width: 960, url: 'large' },
    { width: 1280, url: 'huge' },
  ]
  it('prefers the exact width, then the next larger, then the largest smaller', () => {
    expect(bestFrame(frames, 960)?.url).toBe('large')
    expect(bestFrame(frames, 640)?.url).toBe('large')
    expect(bestFrame(frames, 2000)?.url).toBe('huge')
    expect(bestFrame([], 640)).toBeNull()
  })
})
