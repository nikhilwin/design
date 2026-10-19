import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { Presenter } from './Presenter'

class FakeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

const rect = (id: string, animation?: Record<string, unknown>) => ({ id, type: 'rect', left: 200, top: 150, width: 100, height: 60, fill: '#ff0000', stroke: null, strokeWidth: 0, originX: 'center', originY: 'center', ...(animation ? { animation } : {}) })
const fade = (delayMs: number, durationMs: number) => ({ enter: { preset: 'fade', durationMs, delayMs, easing: 'linear' } })

function deck(): DoryDocument {
  const doc = createBlankDocument(400, 300)
  doc.pages[0] = { ...doc.pages[0], durationSec: 3, objects: [rect('a', fade(500, 1000))] }
  doc.pages.push({ ...doc.pages[0], id: 'p2', durationSec: 3, objects: [rect('b')], transition: { preset: 'push', durationMs: 800, easing: 'linear', direction: 'right' } })
  doc.pages.push({ ...doc.pages[0], id: 'p3', durationSec: 3, objects: [], transition: undefined })
  return doc
}

async function setup(doc: DoryDocument) {
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd', title: 'Deck', mode: 'guest' }, ephemeral: true })
  await act(async () => {
    render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <Presenter />
      </EditorProvider>,
    )
  })
  return engine
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    fireEvent.keyDown(document, { key: k })
  })
}

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }))
}

describe('Presenter with motion', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
    vi.stubGlobal('BroadcastChannel', class { postMessage(): void {} addEventListener(): void {} removeEventListener(): void {} close(): void {} })
    stubReducedMotion(false)
    sessionStorage.clear()
  })
  afterEach(() => {
    engine?.dispose()
    engine = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  })

  it('uses the animated stage and draws the first page', async () => {
    engine = await setup(deck())
    await waitFor(() => expect(screen.getByTestId('present-frame')).toHaveAttribute('data-ready', 'true'))
    expect(screen.getByTestId('present-transition')).toHaveAttribute('data-live', 'false')
  })

  it('keeps the plain stage for a design without motion', async () => {
    const doc = createBlankDocument(400, 300)
    doc.pages[0].objects = [rect('a')]
    engine = await setup(doc)
    await waitFor(() => expect(screen.getByTestId('present-frame')).toHaveAttribute('data-ready', 'true'))
    expect(screen.queryByTestId('present-transition')).toBeNull()
  })

  it('starts the page time after the page has built up: its animations first, then its time', async () => {
    engine = await setup(deck())
    // Page 1 builds up for 1.5 s and then stays 3 s: 4.5 s in all.
    expect(screen.getByTestId('present-countdown')).toHaveTextContent(t.presenter.timeLeft('0:05'))
  })

  it('counts the transition into the time of the page that comes in', async () => {
    engine = await setup(deck())
    await key('ArrowRight')
    // Page 2: 0.8 s of transition and 3 s: 3.8 s.
    expect(screen.getByTestId('present-countdown')).toHaveTextContent(t.presenter.timeLeft('0:04'))
  })

  it('plays the transition of the page it arrives at, over the stage, and then takes it away', async () => {
    engine = await setup(deck())
    await waitFor(() => expect(screen.getByTestId('present-frame')).toHaveAttribute('data-ready', 'true'))
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    await key('ArrowRight')
    await waitFor(() => expect(screen.getByTestId('present-transition')).toHaveAttribute('data-live', 'true'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.getByTestId('present-transition')).toHaveAttribute('data-live', 'true')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(screen.getByTestId('present-transition')).toHaveAttribute('data-live', 'false')
    expect(screen.getByTestId('present-frame')).toHaveAttribute('data-page-id', 'p2')
  })

  it('shows a page without a transition at once', async () => {
    engine = await setup(deck())
    await key('ArrowRight')
    await key('ArrowRight')
    await waitFor(() => expect(screen.getByTestId('present-frame')).toHaveAttribute('data-page-id', 'p3'))
    await waitFor(() => expect(screen.getByTestId('present-frame')).toHaveAttribute('data-ready', 'true'))
    expect(screen.getByTestId('present-transition')).toHaveAttribute('data-live', 'false')
  })

  it('under reduced motion plays no animation and fades instead of any transition', async () => {
    stubReducedMotion(true)
    engine = await setup(deck())
    // No build-up: page 1 is 3 s.
    expect(screen.getByTestId('present-countdown')).toHaveTextContent(t.presenter.timeLeft('0:03'))
    await key('ArrowRight')
    // Page 2 has a quarter second of fade.
    expect(screen.getByTestId('present-countdown')).toHaveTextContent(t.presenter.timeLeft('0:04'))
  })

  it('does not change the design', async () => {
    engine = await setup(deck())
    const before = JSON.stringify(engine.state.doc)
    await key('ArrowRight')
    await key('ArrowRight')
    expect(JSON.stringify(engine.state.doc)).toBe(before)
  })
})
