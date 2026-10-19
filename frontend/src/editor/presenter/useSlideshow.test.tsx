import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, type SlideshowConfig } from './machine'
import { TICK_MS, useSlideshow } from './useSlideshow'

const config: SlideshowConfig = { count: 3, durations: [2, 2, 2] }

describe('useSlideshow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('starts from the options', () => {
    const { result } = renderHook(() => useSlideshow(config, { index: 1, autoAdvance: true, loop: true, now: () => Date.now() }))
    expect(result.current[0]).toEqual(initialState(config, { index: 1, autoAdvance: true, loop: true }))
  })

  it('feeds the clock to the machine: pages advance by their time', () => {
    const { result } = renderHook(() => useSlideshow(config, { autoAdvance: true, now: () => Date.now() }))
    advance(1500)
    expect(result.current[0].index).toBe(0)
    advance(600)
    expect(result.current[0].index).toBe(1)
    advance(2100)
    expect(result.current[0].index).toBe(2)
  })

  it('does not count time while auto-advance is off, but keeps the total clock', () => {
    const { result } = renderHook(() => useSlideshow(config, { now: () => Date.now() }))
    advance(5000)
    expect(result.current[0]).toMatchObject({ index: 0, pageMs: 0 })
    expect(result.current[0].totalMs).toBeGreaterThanOrEqual(4000)
  })

  it('applies the actions it hands out', () => {
    const { result } = renderHook(() => useSlideshow(config, { now: () => Date.now() }))
    act(() => result.current[1]({ type: 'next' }))
    expect(result.current[0].index).toBe(1)
    act(() => result.current[1]({ type: 'togglePause' }))
    expect(result.current[0].autoAdvance).toBe(true)
  })

  it('time spent idle does not count towards the page that starts running', () => {
    const { result } = renderHook(() => useSlideshow({ count: 3, durations: [null, 2, 2] }, { autoAdvance: true, now: () => Date.now() }))
    advance(900)
    expect(result.current[0].index).toBe(0)
    act(() => result.current[1]({ type: 'next' }))
    advance(1800)
    expect(result.current[0].index).toBe(1)
    advance(400)
    expect(result.current[0].index).toBe(2)
  })

  it('ticks often while running and rarely while idle, without losing time on the way', () => {
    const { result } = renderHook(() => useSlideshow({ count: 2, durations: [1, null] }, { autoAdvance: true, now: () => Date.now() }))
    expect(TICK_MS).toBeLessThanOrEqual(100)
    advance(1200)
    expect(result.current[0].index).toBe(1)
    // Page 2 waits for the presenter: from here the clock only needs to keep the total.
    const before = result.current[0].totalMs
    advance(10_000)
    expect(result.current[0].index).toBe(1)
    expect(result.current[0].totalMs).toBeGreaterThan(before + 2000)
  })

  it('stops its timer when it unmounts', () => {
    const { unmount } = renderHook(() => useSlideshow(config, { now: () => Date.now() }))
    const pending = vi.getTimerCount()
    unmount()
    expect(vi.getTimerCount()).toBeLessThan(pending)
  })
})
