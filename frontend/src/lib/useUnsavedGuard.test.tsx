import { renderHook } from '@testing-library/react'
import { hasUnsavedChanges, useUnsavedGuard } from './useUnsavedGuard'

function leave(): BeforeUnloadEvent {
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
  window.dispatchEvent(event)
  return event
}

describe('hasUnsavedChanges', () => {
  it('is true for every state that still owes the server or the browser a write', () => {
    expect(hasUnsavedChanges({ status: 'dirty' })).toBe(true)
    expect(hasUnsavedChanges({ status: 'saving' })).toBe(true)
    expect(hasUnsavedChanges({ status: 'error', message: 'x' })).toBe(true)
    expect(hasUnsavedChanges({ status: 'conflict' })).toBe(true)
  })

  it('is false once everything is stored, and before the editor has said anything', () => {
    expect(hasUnsavedChanges({ status: 'saved', savedAt: 1 })).toBe(false)
    expect(hasUnsavedChanges({ status: 'local', savedAt: 1 })).toBe(false)
    expect(hasUnsavedChanges({ status: 'idle' })).toBe(false)
    expect(hasUnsavedChanges(null)).toBe(false)
  })
})

describe('useUnsavedGuard', () => {
  it('cancels the unload only while it is active, and stops listening afterwards', () => {
    const { rerender, unmount } = renderHook(({ active }) => useUnsavedGuard(active), { initialProps: { active: false } })
    expect(leave().defaultPrevented).toBe(false)
    rerender({ active: true })
    expect(leave().defaultPrevented).toBe(true)
    rerender({ active: false })
    expect(leave().defaultPrevented).toBe(false)
    rerender({ active: true })
    unmount()
    expect(leave().defaultPrevented).toBe(false)
  })
})
