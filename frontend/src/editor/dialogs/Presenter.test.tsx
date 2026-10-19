import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
import { newSessionId } from '../presenter/channel'
import { stashViewWindow } from '../presenter/viewWindow'
import { t } from '../strings'
import { Presenter } from './Presenter'

vi.mock('../presenter/frames', () => {
  class FakeCache {
    get = vi.fn((_page: unknown, width: number) => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, width)
      canvas.height = Math.max(1, Math.round(width / 2))
      return Promise.resolve(canvas)
    })
    peek = vi.fn(() => null)
    prefetch = vi.fn()
    clear = vi.fn()
  }
  return { FrameCache: FakeCache, createFrameCache: () => new FakeCache() }
})

class FakeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

interface Options {
  mutate?: (doc: DoryDocument) => void
  props?: Record<string, unknown>
}

async function setup({ mutate, props }: Options = {}) {
  const doc = createBlankDocument(1600, 900)
  doc.pages.push({ ...doc.pages[0], id: 'p2', name: 'Second', objects: [], notes: 'Second notes <b>x</b>' })
  doc.pages.push({ ...doc.pages[0], id: 'p3', objects: [] })
  doc.pages[0].notes = 'First notes'
  mutate?.(doc)
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd', title: 'Deck', mode: 'guest' }, ephemeral: true })
  const close = vi.spyOn(engine, 'closeDialog')
  let view: ReturnType<typeof render> | null = null
  // The first page renders asynchronously: let it settle inside act so the test starts from a steady stage.
  await act(async () => {
    view = render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <Presenter props={props} />
      </EditorProvider>,
    )
  })
  return { engine, close, view }
}

const counter = (): string => screen.getByTestId('present-counter').textContent ?? ''
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    fireEvent.keyDown(document, { key: k, ...init })
  })
}

describe('Presenter', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 720 })
    vi.stubGlobal('BroadcastChannel', class { postMessage(): void {} addEventListener(): void {} removeEventListener(): void {} close(): void {} })
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

  it('shows the first page when the editor has it active, and renders it onto the stage', async () => {
    const ctx = await setup()
    engine = ctx.engine
    expect(screen.getByRole('dialog', { name: t.presenter.label })).toHaveAttribute('aria-modal', 'true')
    expect(counter()).toBe('1 / 3')
    await waitFor(() => expect(screen.getByTestId('present-frame')).toHaveAttribute('data-ready', 'true'))
    expect(screen.getByTestId('present-frame')).toHaveAccessibleName(t.presenter.stage(1, 3, ''))
  })

  it('starts on the page that was active in the editor', async () => {
    const doc = createBlankDocument(800, 600)
    doc.pages.push({ ...doc.pages[0], id: 'b', objects: [] })
    const ctx = await setup({ mutate: (d) => Object.assign(d, { pages: [...doc.pages.slice(0, 1), ...d.pages.slice(1)] }) })
    engine = ctx.engine
    expect(counter()).toBe('1 / 3')
  })

  it('moves with the keys of the key map and stops at the end screen', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await key('ArrowRight')
    expect(counter()).toBe('2 / 3')
    await key(' ')
    expect(counter()).toBe('3 / 3')
    await key('ArrowLeft')
    expect(counter()).toBe('2 / 3')
    await key('End')
    await key('PageDown')
    expect(screen.getByTestId('present-end')).toHaveTextContent(t.presenter.endTitle)
    fireEvent.click(screen.getByTestId('present-end-restart'))
    expect(counter()).toBe('1 / 3')
    expect(screen.queryByTestId('present-end')).toBeNull()
    await key('r')
    await key('Home')
    expect(counter()).toBe('1 / 3')
  })

  it('leaves Ctrl and Alt chords to the browser', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await key('ArrowRight', { ctrlKey: true })
    await key('ArrowRight', { altKey: true })
    expect(counter()).toBe('1 / 3')
  })

  it('does not let the key reach the editor: the handler stops it', async () => {
    const ctx = await setup()
    engine = ctx.engine
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    await key('ArrowRight')
    document.removeEventListener('keydown', seen)
    expect(seen).not.toHaveBeenCalled()
  })

  it('toggles the black screen, the notes (as text) and the laser', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await key('b')
    expect(screen.getByTestId('present-black')).toBeInTheDocument()
    await key('b')
    expect(screen.queryByTestId('present-black')).toBeNull()
    await key('n')
    expect(screen.getByTestId('present-notes')).toHaveTextContent('First notes')
    await key('ArrowRight')
    expect(screen.getByTestId('present-notes')).toHaveTextContent('Second notes <b>x</b>')
    expect(screen.getByTestId('present-notes').querySelector('b')).toBeNull()
    await key('ArrowRight')
    expect(screen.getByTestId('present-notes')).toHaveTextContent(t.presenter.noNotes)
    await key('n')
    expect(screen.queryByTestId('present-notes')).toBeNull()
    await key('l')
    expect(screen.getByTestId('present-overlay')).toHaveAttribute('data-laser', 'true')
    await key('l')
    expect(screen.getByTestId('present-overlay')).not.toHaveAttribute('data-laser')
  })

  it('any key brings the page back from a black screen and also navigates', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await key('b')
    await key('ArrowRight')
    expect(screen.queryByTestId('present-black')).toBeNull()
    expect(counter()).toBe('2 / 3')
  })

  it('lists the keys with ? and closes the list before leaving with Escape', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await key('?', { shiftKey: true })
    expect(screen.getByTestId('present-help-panel')).toHaveTextContent(t.presenter.keys[0].does)
    await key('Escape')
    expect(screen.queryByTestId('present-help-panel')).toBeNull()
    expect(ctx.close).not.toHaveBeenCalled()
    await key('Escape')
    expect(ctx.close).toHaveBeenCalledTimes(1)
  })

  it('a focused control keeps Space for itself', async () => {
    const ctx = await setup()
    engine = ctx.engine
    const loop = screen.getByTestId('present-loop')
    loop.focus()
    act(() => {
      fireEvent.keyDown(loop, { key: ' ' })
    })
    expect(counter()).toBe('1 / 3')
  })

  it('names the toggles once and says their state with aria-pressed', async () => {
    const ctx = await setup()
    engine = ctx.engine
    const auto = screen.getByRole('button', { name: t.presenter.autoAdvance })
    expect(auto).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(auto)
    expect(screen.getByRole('button', { name: t.presenter.autoAdvance })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: t.presenter.loop }))
    expect(screen.getByRole('button', { name: t.presenter.loop })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: t.presenter.notes }))
    expect(screen.getByRole('button', { name: t.presenter.notes })).toHaveAttribute('aria-pressed', 'true')
  })

  it('auto-advances by the page times of a timed design, pauses and loops', async () => {
    vi.useFakeTimers()
    const ctx = await setup({ mutate: (d) => d.pages.forEach((p) => (p.durationSec = 2)) })
    engine = ctx.engine
    expect(screen.getByRole('button', { name: t.presenter.autoAdvance })).toHaveAttribute('aria-pressed', 'true')
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(counter()).toBe('1 / 3')
    expect(screen.getByTestId('present-countdown')).toHaveTextContent(t.presenter.timeLeft('0:01'))
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(counter()).toBe('2 / 3')
    await key('p')
    expect(screen.getByTestId('present-countdown')).toHaveTextContent(t.presenter.paused)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(counter()).toBe('2 / 3')
    await key('p')
    fireEvent.click(screen.getByTestId('present-loop'))
    await act(async () => {
      vi.advanceTimersByTime(4300)
    })
    expect(counter()).toBe('1 / 3')
    expect(screen.queryByTestId('present-end')).toBeNull()
  })

  it('a design with a time on some pages makes the others wait; one with none can be played at 5 s', async () => {
    vi.useFakeTimers()
    const ctx = await setup({ mutate: (d) => (d.pages[0].durationSec = 1) })
    engine = ctx.engine
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(counter()).toBe('2 / 3')
    expect(screen.getByTestId('present-countdown')).toHaveTextContent(t.presenter.waits)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(counter()).toBe('2 / 3')
  })

  it('works on the design as it was when it started', async () => {
    const ctx = await setup()
    engine = ctx.engine
    act(() => {
      ctx.engine.pages.add(3)
      ctx.engine.pages.setNotes('p2', 'Changed while presenting')
    })
    await key('End')
    expect(counter()).toBe('3 / 3')
    await key('ArrowLeft')
    await key('n')
    expect(screen.getByTestId('present-notes')).toHaveTextContent('Second notes')
  })

  it('exits with the button and with Escape', async () => {
    const ctx = await setup()
    engine = ctx.engine
    fireEvent.click(screen.getByTestId('present-exit'))
    expect(ctx.close).toHaveBeenCalledTimes(1)
    await key('Escape')
    expect(ctx.close).toHaveBeenCalledTimes(2)
  })

  it('keeps the focus inside while it is open', async () => {
    const ctx = await setup()
    engine = ctx.engine
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    act(() => {
      fireEvent.keyDown(outside, { key: 'Tab' })
    })
    expect(screen.getByTestId('present-overlay').contains(document.activeElement)).toBe(true)
    outside.remove()
  })

  it('"Present with notes" without a window says so and shows the notes itself', async () => {
    const ctx = await setup({ props: { session: newSessionId(), withNotes: true } })
    engine = ctx.engine
    expect(screen.getByTestId('present-message')).toHaveTextContent(t.presenter.blockedTitle)
    expect(screen.getByTestId('present-notes')).toHaveTextContent('First notes')
  })

  it('"Present with notes" with a window keeps quiet', async () => {
    const session = newSessionId()
    stashViewWindow(session, { closed: false, focus: vi.fn() } as unknown as Window)
    const ctx = await setup({ props: { session, withNotes: true } })
    engine = ctx.engine
    expect(screen.queryByTestId('present-message')).toBeNull()
    expect(screen.queryByTestId('present-notes')).toBeNull()
  })

  it('the presenter view button tells a blocked pop-up from success', async () => {
    const ctx = await setup()
    engine = ctx.engine
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(screen.getByTestId('present-view'))
    expect(open).toHaveBeenCalledTimes(1)
    expect(String(open.mock.calls[0][0])).toContain('presenter-view.html?session=')
    expect(screen.getByTestId('present-message')).toHaveTextContent(t.presenter.blockedTitle)
    expect(screen.getByTestId('present-notes')).toBeInTheDocument()
    open.mockReturnValue({ closed: false, focus: vi.fn() } as unknown as Window)
    fireEvent.click(screen.getByTestId('present-view'))
    expect(screen.getByTestId('present-message')).toHaveTextContent(t.presenter.viewOpened)
    open.mockRestore()
  })

  it('without BroadcastChannel it says the presenter view is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const ctx = await setup()
    engine = ctx.engine
    fireEvent.click(screen.getByTestId('present-view'))
    expect(screen.getByTestId('present-message')).toHaveTextContent(t.presenter.viewUnsupported)
  })
})
