import { describe, expect, it, vi } from 'vitest'
import { MAX_FRAME_MS, Playback } from './playback'

describe('Playback', () => {
  it('starts idle', () => {
    expect(new Playback().state).toEqual({ active: false, playing: false, timeMs: 0, speed: 1, loop: false })
  })

  it('plays from the playhead and starts over from the end', () => {
    const p = new Playback()
    p.play(3000)
    expect(p.state).toMatchObject({ active: true, playing: true, timeMs: 0 })
    p.advance(50, 3000)
    p.pause()
    expect(p.state).toMatchObject({ active: true, playing: false, timeMs: 50 })
    p.play(3000)
    expect(p.state.timeMs).toBe(50)
    p.seek(3000, 3000)
    p.play(3000)
    expect(p.state.timeMs).toBe(0)
  })

  it('moves at the chosen speed and never skips more than a frame at once', () => {
    const p = new Playback()
    p.setSpeed(2)
    p.play(10_000)
    p.advance(16, 10_000)
    expect(p.state.timeMs).toBe(32)
    p.advance(5000, 10_000)
    expect(p.state.timeMs).toBe(32 + MAX_FRAME_MS * 2)
  })

  it('ignores the clock while paused or when the time is not a time', () => {
    const p = new Playback()
    p.advance(16, 1000)
    expect(p.state.timeMs).toBe(0)
    p.play(1000)
    p.advance(Number.NaN, 1000)
    p.advance(-5, 1000)
    expect(p.state.timeMs).toBe(0)
  })

  it('ends at the end, or goes round when looping', () => {
    const p = new Playback()
    p.play(150)
    p.advance(100, 150)
    p.advance(100, 150)
    expect(p.state).toMatchObject({ active: false, playing: false, timeMs: 0 })
    p.setLoop(true)
    p.play(150)
    p.advance(100, 150)
    p.advance(100, 150)
    expect(p.state).toMatchObject({ active: true, playing: true, timeMs: 50 })
  })

  it('seeking brings the preview up paused, limited to the length', () => {
    const p = new Playback()
    p.seek(1200, 2000)
    expect(p.state).toMatchObject({ active: true, playing: false, timeMs: 1200 })
    p.seek(9999, 2000)
    expect(p.state.timeMs).toBe(2000)
    p.seek(-4, 2000)
    expect(p.state.timeMs).toBe(0)
    p.seek(Number.NaN, 2000)
    expect(p.state.timeMs).toBe(0)
  })

  it('stop puts everything back', () => {
    const p = new Playback()
    p.play(1000)
    p.advance(60, 1000)
    p.stop()
    expect(p.state).toMatchObject({ active: false, playing: false, timeMs: 0 })
  })

  it('toggle plays and pauses', () => {
    const p = new Playback()
    p.toggle(1000)
    expect(p.state.playing).toBe(true)
    p.toggle(1000)
    expect(p.state.playing).toBe(false)
  })

  it('tells its listeners only when something changed', () => {
    const p = new Playback()
    const listener = vi.fn()
    const off = p.subscribe(listener)
    p.setSpeed(1)
    expect(listener).not.toHaveBeenCalled()
    p.setSpeed(1.5)
    p.setLoop(true)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    p.setSpeed(2)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
