import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useReducedMotion } from '../animation/useReducedMotion'
import { AnimateThumb } from './AnimateThumb'

const subject = { kind: 'anim', slot: 'enter', anim: { preset: 'rise', durationMs: 700, delayMs: 0, easing: 'ease-out' } } as const

function stubReduced(reduced: boolean): { fire(next: boolean): void } {
  let listener: (() => void) | null = null
  const query = { matches: reduced, media: '', addEventListener: (_: string, l: () => void) => (listener = l), removeEventListener: () => (listener = null), addListener: () => undefined, removeListener: () => undefined }
  vi.stubGlobal('matchMedia', () => query)
  return {
    fire(next) {
      query.matches = next
      listener?.()
    },
  }
}

describe('AnimateThumb', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is a button named after the preset, pressed when it is the chosen one, and picks it when clicked', async () => {
    stubReduced(false)
    const onPick = vi.fn()
    render(<AnimateThumb label="Rise" subject={subject} selected onPick={onPick} testId="t" />)
    const button = screen.getByRole('button', { name: 'Rise' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(button)
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('plays while hovered or focused and stops with a still picture afterwards', () => {
    stubReduced(false)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    render(<AnimateThumb label="Rise" subject={subject} selected={false} onPick={() => undefined} testId="t" />)
    const button = screen.getByTestId('t')
    const before = raf.mock.calls.length
    fireEvent.pointerEnter(button)
    expect(raf.mock.calls.length).toBeGreaterThan(before)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    const running = raf.mock.calls.length
    expect(running).toBeGreaterThan(before + 1)
    fireEvent.pointerLeave(button)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(raf.mock.calls.length).toBe(running)
    fireEvent.focus(button)
    expect(raf.mock.calls.length).toBeGreaterThan(running)
    fireEvent.blur(button)
  })

  it('stays a still picture when the system asks for reduced motion', () => {
    stubReduced(true)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    render(<AnimateThumb label="Rise" subject={subject} selected={false} onPick={() => undefined} testId="t" />)
    fireEvent.pointerEnter(screen.getByTestId('t'))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(raf).not.toHaveBeenCalled()
    expect(screen.getByTestId('t')).toHaveAttribute('title', 'Rise')
  })

  it('draws a transition tile too', () => {
    stubReduced(false)
    render(<AnimateThumb label="Push" subject={{ kind: 'transition', transition: { preset: 'push', easing: 'linear', direction: 'right' }, durationMs: 700 }} selected={false} onPick={() => undefined} testId="t" />)
    fireEvent.pointerEnter(screen.getByTestId('t'))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    fireEvent.pointerLeave(screen.getByTestId('t'))
    expect(screen.getByTestId('t').querySelector('canvas')).not.toBeNull()
  })
})

describe('useReducedMotion', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('follows the system setting', () => {
    const media = stubReduced(false)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
    act(() => media.fire(true))
    expect(result.current).toBe(true)
  })

  it('is false where the browser cannot say', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
  })
})

