import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useResource } from './useResource'

describe('useResource', () => {
  it('loads once, exposes the data and lets the caller edit it after a change was saved', async () => {
    const load = vi.fn(async () => ['a', 'b'])
    const { result } = renderHook(() => useResource(load))
    expect(result.current.data).toBeNull()
    await waitFor(() => expect(result.current.data).toEqual(['a', 'b']))
    act(() => result.current.update((cur) => [...cur, 'c']))
    expect(result.current.data).toEqual(['a', 'b', 'c'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reports a failure and loads again on reload', async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce('back')
    const { result } = renderHook(() => useResource(load))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.data).toBeNull()
    act(() => result.current.reload())
    expect(result.current.failed).toBe(false)
    await waitFor(() => expect(result.current.data).toBe('back'))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a loader and ignores an answer that arrives after unmounting', async () => {
    const idle = renderHook(() => useResource<string>(null))
    expect(idle.result.current).toMatchObject({ data: null, failed: false })

    let resolve: (value: string) => void = () => undefined
    const slow = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const { result, unmount } = renderHook(() => useResource(slow))
    unmount()
    resolve('late')
    await Promise.resolve()
    expect(result.current.data).toBeNull()
  })

  it('ignores edits while nothing is loaded', () => {
    const { result } = renderHook(() => useResource<string[]>(null))
    act(() => result.current.update((cur) => [...cur, 'x']))
    expect(result.current.data).toBeNull()
  })
})
