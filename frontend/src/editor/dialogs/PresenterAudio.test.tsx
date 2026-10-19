import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { AudioTrack } from '@/types/document'
import { FakeContext, fakeBuffer } from '../audio/testing'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
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

const track = (patch: Partial<AudioTrack> = {}): AudioTrack => ({
  id: 'm',
  kind: 'music',
  name: 'Theme',
  src: '/media/audio/music/theme-aaaaaaaaaaaa.ogg',
  scope: { type: 'design' },
  startMs: 0,
  durationMs: 30_000,
  trimStartMs: 0,
  trimEndMs: 30_000,
  volume: 0.5,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: true,
  muted: false,
  ...patch,
})

async function setup(tracks: AudioTrack[], context = new FakeContext(), load: (item: Pick<AudioTrack, 'id'>) => Promise<AudioBuffer> = async () => fakeBuffer(30)) {
  const doc = createBlankDocument(1600, 900)
  doc.pages.push({ ...doc.pages[0], id: 'p2', objects: [] })
  if (tracks.length > 0) doc.audioTracks = tracks
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd', title: 'Deck', mode: 'guest' }, ephemeral: true })
  vi.spyOn(engine.audio.sources, 'load').mockImplementation(load)
  vi.stubGlobal('AudioContext', function AudioContextStub() {
    return context
  })
  await act(async () => {
    render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <Presenter />
      </EditorProvider>,
    )
  })
  return { engine, context }
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    fireEvent.keyDown(document, { key: k })
  })
}

describe('Presenter sound', () => {
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
    vi.restoreAllMocks()
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  })

  it('offers no sound control and makes no audio context for a design without sound', async () => {
    const context = new FakeContext()
    const ctx = await setup([], context)
    engine = ctx.engine
    expect(screen.queryByTestId('present-sound')).toBeNull()
    expect(context.sources).toHaveLength(0)
  })

  it('plays the music with the show, switches it off with M, and carries it across pages', async () => {
    const ctx = await setup([track(), track({ id: 'p', kind: 'sfx', name: 'Pop', scope: { type: 'page', pageId: 'p2' }, trimEndMs: 500, loop: false })])
    engine = ctx.engine
    await waitFor(() => expect(ctx.context.sources).toHaveLength(1))
    expect(ctx.context.sources[0]).toMatchObject({ loop: true })
    const button = screen.getByTestId('present-sound')
    expect(button).toHaveAccessibleName(t.audio.presenter.sound)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    // The master gain is at 1 until the presenter switches the sound off.
    expect(ctx.context.gains[0].gain.value).toBe(1)
    await key('m')
    expect(screen.getByTestId('present-sound')).toHaveAttribute('aria-pressed', 'false')
    expect(ctx.context.gains[0].gain.value).toBe(0)
    await key('ArrowRight')
    await waitFor(() => expect(ctx.context.sources).toHaveLength(2))
    // The music from page 1 was not restarted by moving on.
    expect(ctx.context.sources[0].stopped).toBeNull()
    await key('M')
    expect(ctx.context.gains[0].gain.value).toBe(1)
  })

  it('fades the sound out at the end screen', async () => {
    const ctx = await setup([track()])
    engine = ctx.engine
    await waitFor(() => expect(ctx.context.sources).toHaveLength(1))
    await key('End')
    await key('ArrowRight')
    await key('ArrowRight')
    await waitFor(() => expect(screen.getByTestId('present-end')).toBeInTheDocument())
    await waitFor(() => expect(ctx.context.sources[0].stopped).not.toBeNull())
  })

  it('suspends the sound with the slideshow pause', async () => {
    const ctx = await setup([track()])
    engine = ctx.engine
    await waitFor(() => expect(ctx.context.sources).toHaveLength(1))
    await act(async () => {
      fireEvent.click(screen.getByTestId('present-auto'))
    })
    await key('p')
    await waitFor(() => expect(ctx.context.state).toBe('suspended'))
    await key('p')
    await waitFor(() => expect(ctx.context.state).toBe('running'))
  })

  it('tells the person when the browser holds the sound back, and starts it on a key press', async () => {
    const context = new FakeContext()
    context.state = 'suspended'
    context.refuseResume = true
    const ctx = await setup([track()], context)
    engine = ctx.engine
    expect(await screen.findByTestId('present-message')).toHaveTextContent(t.audio.presenter.blocked)
    context.refuseResume = false
    await key('x')
    await waitFor(() => expect(context.state).toBe('running'))
  })

  it('names a sound that could not be loaded and plays the rest', async () => {
    const ctx = await setup([track({ id: 'bad', name: 'Lost song' }), track({ id: 'ok', name: 'Fine' })], new FakeContext(), async (item) => {
      if (item.id === 'bad') throw new Error('missing')
      return fakeBuffer(30)
    })
    engine = ctx.engine
    expect(await screen.findByTestId('present-message')).toHaveTextContent(t.audio.presenter.failed('Lost song'))
    expect(ctx.context.sources).toHaveLength(1)
  })
})
