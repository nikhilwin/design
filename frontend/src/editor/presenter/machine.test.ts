import { describe, expect, it } from 'vitest'
import {
  currentDuration,
  initialState,
  isRunning,
  MAX_TICK_MS,
  pageProgress,
  reduce,
  remainingMs,
  type SlideshowAction,
  type SlideshowConfig,
  type SlideshowState,
} from './machine'

const config = (durations: (number | null)[]): SlideshowConfig => ({ count: durations.length, durations })
const run = (cfg: SlideshowConfig, state: SlideshowState, ...actions: SlideshowAction[]): SlideshowState => actions.reduce((s, a) => reduce(cfg, s, a), state)
const tickFor = (cfg: SlideshowConfig, state: SlideshowState, ms: number, step = 100): SlideshowState => {
  let s = state
  for (let t = 0; t < ms; t += step) s = reduce(cfg, s, { type: 'tick', dt: Math.min(step, ms - t) })
  return s
}

describe('navigation', () => {
  const cfg = config([null, null, null])

  it('starts on the requested page, clamped', () => {
    expect(initialState(cfg).index).toBe(0)
    expect(initialState(cfg, { index: 2 }).index).toBe(2)
    expect(initialState(cfg, { index: 9 }).index).toBe(2)
    expect(initialState(cfg, { index: -4 }).index).toBe(0)
    expect(initialState(cfg, { index: Number.NaN }).index).toBe(0)
  })

  it('moves forward and back without leaving the deck', () => {
    let s = initialState(cfg)
    s = run(cfg, s, { type: 'next' }, { type: 'next' })
    expect(s.index).toBe(2)
    s = run(cfg, s, { type: 'prev' })
    expect(s.index).toBe(1)
    s = run(cfg, initialState(cfg), { type: 'prev' })
    expect(s.index).toBe(0)
  })

  it('jumps to the first, last and a given page', () => {
    let s = run(cfg, initialState(cfg), { type: 'last' })
    expect(s.index).toBe(2)
    s = run(cfg, s, { type: 'first' })
    expect(s.index).toBe(0)
    s = run(cfg, s, { type: 'goto', index: 1 })
    expect(s.index).toBe(1)
    expect(run(cfg, s, { type: 'goto', index: 99 }).index).toBe(2)
    expect(run(cfg, s, { type: 'goto', index: -1 }).index).toBe(0)
  })

  it('shows the end screen after the last page, and Back returns to it', () => {
    let s = run(cfg, initialState(cfg, { index: 2 }), { type: 'next' })
    expect(s.ended).toBe(true)
    expect(s.index).toBe(2)
    expect(run(cfg, s, { type: 'next' })).toBe(s)
    s = run(cfg, s, { type: 'prev' })
    expect(s.ended).toBe(false)
    expect(s.index).toBe(2)
  })

  it('wraps to the first page when looping instead of ending', () => {
    const s = run(cfg, initialState(cfg, { index: 2, loop: true }), { type: 'next' })
    expect(s).toMatchObject({ ended: false, index: 0 })
  })

  it('a single-page deck ends after one Next', () => {
    const one = config([null])
    expect(run(one, initialState(one), { type: 'next' }).ended).toBe(true)
  })

  it('restart returns to the start with zeroed clocks and keeps the choices', () => {
    const cfg2 = config([2, 2])
    let s = initialState(cfg2, { autoAdvance: true, loop: true })
    s = tickFor(cfg2, s, 2500)
    s = run(cfg2, s, { type: 'togglePause' }, { type: 'toggleBlackout' }, { type: 'restart' })
    expect(s).toMatchObject({ index: 0, ended: false, paused: false, blackout: false, pageMs: 0, totalMs: 0, autoAdvance: true, loop: true })
  })
})

describe('auto-advance', () => {
  it('advances when the page time is up', () => {
    const cfg = config([3, 3, 3])
    let s = initialState(cfg, { autoAdvance: true })
    s = tickFor(cfg, s, 2900)
    expect(s.index).toBe(0)
    s = tickFor(cfg, s, 100)
    expect(s.index).toBe(1)
    expect(s.pageMs).toBe(0)
  })

  it('uses each page its own time', () => {
    const cfg = config([1, 4, 2])
    let s = initialState(cfg, { autoAdvance: true })
    s = tickFor(cfg, s, 1000)
    expect(s.index).toBe(1)
    s = tickFor(cfg, s, 3900)
    expect(s.index).toBe(1)
    s = tickFor(cfg, s, 100)
    expect(s.index).toBe(2)
  })

  it('does nothing while auto-advance is off', () => {
    const cfg = config([1, 1])
    const s = tickFor(cfg, initialState(cfg), 5000)
    expect(s.index).toBe(0)
    expect(s.pageMs).toBe(0)
    expect(s.totalMs).toBe(5000)
  })

  it('ends the show after the last page, or wraps when looping', () => {
    const cfg = config([1, 1])
    const ended = tickFor(cfg, initialState(cfg, { autoAdvance: true }), 2000)
    expect(ended.ended).toBe(true)
    expect(tickFor(cfg, ended, 5000).totalMs).toBe(ended.totalMs)
    const looped = tickFor(cfg, initialState(cfg, { autoAdvance: true, loop: true }), 2000)
    expect(looped).toMatchObject({ ended: false, index: 0 })
  })

  it('a page without a time waits for the presenter and stops the countdown', () => {
    const cfg = config([1, null, 1])
    let s = tickFor(cfg, initialState(cfg, { autoAdvance: true }), 1000)
    expect(s.index).toBe(1)
    expect(isRunning(cfg, s)).toBe(false)
    s = tickFor(cfg, s, 60_000)
    expect(s.index).toBe(1)
    s = run(cfg, s, { type: 'next' })
    expect(s.index).toBe(2)
    expect(isRunning(cfg, s)).toBe(true)
  })

  it('pausing holds the countdown and resuming continues it', () => {
    const cfg = config([4, 4])
    let s = tickFor(cfg, initialState(cfg, { autoAdvance: true }), 3000)
    s = run(cfg, s, { type: 'togglePause' })
    expect(s.paused).toBe(true)
    s = tickFor(cfg, s, 10_000)
    expect(s.index).toBe(0)
    expect(s.pageMs).toBe(3000)
    s = run(cfg, s, { type: 'togglePause' })
    s = tickFor(cfg, s, 1000)
    expect(s.index).toBe(1)
  })

  it('"play" with auto-advance off switches it on from a fresh page clock', () => {
    const cfg = config([2, 2])
    const s = run(cfg, initialState(cfg), { type: 'togglePause' })
    expect(s).toMatchObject({ autoAdvance: true, paused: false, pageMs: 0 })
  })

  it('switching auto-advance on or off restarts the page clock and clears a pause', () => {
    const cfg = config([4, 4])
    let s = tickFor(cfg, initialState(cfg, { autoAdvance: true }), 2000)
    s = run(cfg, s, { type: 'togglePause' }, { type: 'setAutoAdvance', on: false })
    expect(s).toMatchObject({ autoAdvance: false, paused: false, pageMs: 0 })
    expect(run(cfg, s, { type: 'setAutoAdvance', on: false })).toBe(s)
  })

  it('moving by hand restarts the page clock', () => {
    const cfg = config([4, 4, 4])
    let s = tickFor(cfg, initialState(cfg, { autoAdvance: true }), 3000)
    s = run(cfg, s, { type: 'next' })
    expect(s.pageMs).toBe(0)
    s = tickFor(cfg, s, 3900)
    expect(s.index).toBe(1)
  })

  it('a black-out suspends the countdown and any navigation lifts it', () => {
    const cfg = config([2, 2, 2])
    let s = tickFor(cfg, initialState(cfg, { autoAdvance: true }), 1000)
    s = run(cfg, s, { type: 'toggleBlackout' })
    expect(s.blackout).toBe(true)
    s = tickFor(cfg, s, 10_000)
    expect(s.index).toBe(0)
    expect(s.pageMs).toBe(1000)
    expect(run(cfg, s, { type: 'next' })).toMatchObject({ blackout: false, index: 1 })
    expect(run(cfg, s, { type: 'toggleBlackout' }).blackout).toBe(false)
  })

  it('carries the overshoot of a long tick into the next page', () => {
    const cfg = config([2, 2, 2])
    const s = reduce(cfg, initialState(cfg, { autoAdvance: true }), { type: 'tick', dt: 1900 })
    const next = reduce(cfg, s, { type: 'tick', dt: 300 })
    expect(next.index).toBe(1)
    expect(next.pageMs).toBe(200)
  })

  it('caps one tick, so waking from sleep cannot skip the deck', () => {
    const cfg = config([1, 1, 1, 1, 1])
    const s = reduce(cfg, initialState(cfg, { autoAdvance: true }), { type: 'tick', dt: 3_600_000 })
    expect(s.totalMs).toBe(MAX_TICK_MS)
    expect(s.index).toBeLessThanOrEqual(2)
  })

  it('terminates on a looping deck of one-second pages even for the largest tick', () => {
    const cfg = config([1])
    const s = reduce(cfg, initialState(cfg, { autoAdvance: true, loop: true }), { type: 'tick', dt: 10_000 })
    expect(s.ended).toBe(false)
  })

  it('a tick without countdown only moves the total clock', () => {
    const cfg = config([1, 1])
    const s = reduce(cfg, initialState(cfg, { autoAdvance: true }), { type: 'tick', dt: 900, countdown: false })
    expect(s).toMatchObject({ totalMs: 900, pageMs: 0, index: 0 })
    expect(reduce(cfg, s, { type: 'tick', dt: 200, countdown: false }).index).toBe(0)
  })

  it('ignores ticks that are not positive finite numbers', () => {
    const cfg = config([1, 1])
    const s = initialState(cfg, { autoAdvance: true })
    for (const dt of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(reduce(cfg, s, { type: 'tick', dt })).toBe(s)
  })

  it('the total clock stops on the end screen', () => {
    const cfg = config([null])
    const s = run(cfg, initialState(cfg), { type: 'tick', dt: 500 }, { type: 'next' }, { type: 'tick', dt: 500 })
    expect(s.ended).toBe(true)
    expect(s.totalMs).toBe(500)
  })
})

describe('derived values', () => {
  const cfg = config([10, null])

  it('reports the remaining time and progress of a timed page', () => {
    const s = tickFor(cfg, initialState(cfg, { autoAdvance: true }), 4000)
    expect(currentDuration(cfg, s)).toBe(10)
    expect(remainingMs(cfg, s)).toBe(6000)
    expect(pageProgress(cfg, s)).toBeCloseTo(0.4)
  })

  it('has no countdown without auto-advance, on a waiting page or at the end', () => {
    const s = initialState(cfg)
    expect(remainingMs(cfg, s)).toBeNull()
    expect(pageProgress(cfg, s)).toBe(0)
    const waiting = run(cfg, initialState(cfg, { autoAdvance: true }), { type: 'next' })
    expect(remainingMs(cfg, waiting)).toBeNull()
    expect(remainingMs(cfg, run(cfg, waiting, { type: 'next' }))).toBeNull()
  })
})
