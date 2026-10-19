/**
 * The timeline is a chunk of its own and its sections (the audio rows) are chunks too. These specs run in a file of their
 * own because a chunk that has arrived stays: only the first render here sees the timeline on its way.
 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { enter, rectObject, setupEditor } from '../animation/testing'
import { registerTimelineSection } from '../animation/sections'
import { EditorProvider } from '../EditorProvider'
import { LazyTimelineHost } from './TimelineLoader'
import { setTimelineView } from './timelineVisibility'

class FakeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

let unregister: (() => void) | null = null
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 })
  globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver
})
afterEach(() => act(() => unregister?.()))

describe('opening the timeline', () => {
  it('shows it once the code of its sections has arrived too, so rows never join afterwards and move the lanes', async () => {
    let arrive: () => void = () => undefined
    let asked = 0
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve
    })
    unregister = registerTimelineSection({
      id: 'late-rows',
      order: 500,
      Section: () => <div data-testid="late-rows" />,
      preload: () => {
        asked += 1
        return arrived
      },
    })
    const doc = createBlankDocument(800, 600)
    doc.pages[0] = { ...doc.pages[0], id: 'p1', durationSec: 5, objects: [rectObject('r', 100, 100, enter('fade', 0, 600))] }
    const ctx = await setupEditor({ doc })
    await act(async () => {
      render(
        <EditorProvider engine={ctx.engine} portalRoot={document.body}>
          <LazyTimelineHost />
        </EditorProvider>,
      )
    })
    await act(async () => setTimelineView(ctx.engine, { open: true, collapsed: false }))
    // The timeline's own code is in by now (modules resolve quickly here), but a section's is not.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(asked).toBe(1)
    expect(screen.queryByTestId('ed-timeline')).toBeNull()

    await act(async () => {
      arrive()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(screen.getByTestId('ed-timeline')).toBeInTheDocument()
    expect(screen.getByTestId('late-rows')).toBeInTheDocument()
  })
})
