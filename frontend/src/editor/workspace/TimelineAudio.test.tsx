import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { AudioTrack } from '@/types/document'
import { playbackOf } from '../animation/playback'
import { enter, rectObject, setupEditor } from '../animation/testing'
import { audioRuntime } from '../audio/runtime'
import { FakeContext, fakeBuffer } from '../audio/testing'
import '../builtins/audio'
import { EditorProvider } from '../EditorProvider'
import type { EditorEngine } from '../engine/editor'
import { installPointerEvents } from '../panels/commentsTesting'
import { AudioSync } from '../panels/AudioSync'
import { t } from '../strings'
import { TimelineHost } from './Timeline'
import { setTimelineView } from './timelineVisibility'

const COPY = t.audio.timeline

class FakeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

const track = (patch: Partial<AudioTrack> = {}): AudioTrack => ({
  id: 'a1',
  kind: 'sfx',
  name: 'Whoosh',
  src: '/media/audio/sfx/whoosh-bbbbbbbbbbbb.ogg',
  scope: { type: 'page', pageId: 'p1' },
  startMs: 1000,
  durationMs: 6000,
  trimStartMs: 0,
  trimEndMs: 2000,
  volume: 0.8,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  muted: false,
  ...patch,
})

async function open(options: { tracks?: AudioTrack[]; mode?: 'guest' | 'shared-view'; width?: number; second?: boolean; objects?: boolean } = {}) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => options.width ?? 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 })
  const doc = createBlankDocument(800, 600)
  doc.pages[0] = { ...doc.pages[0], id: 'p1', durationSec: 5, objects: options.objects === false ? [] : [rectObject('r', 100, 100, enter('fade', 0, 600))] }
  doc.pages.push({ ...doc.pages[0], id: 'p2', durationSec: 4, objects: [] })
  if (options.tracks) doc.audioTracks = options.tracks
  const ctx = await setupEditor({ doc, mode: options.mode })
  if (options.second) await act(async () => ctx.engine.setActivePage('p2'))
  await act(async () => {
    render(
      <EditorProvider engine={ctx.engine} portalRoot={document.body}>
        <TimelineHost />
        <AudioSync />
      </EditorProvider>,
    )
  })
  await act(async () => setTimelineView(ctx.engine, { open: true, collapsed: false }))
  // The audio rows are a chunk of their own (`builtins/audio.tsx`): let it arrive before the rows are looked for.
  await act(async () => {
    await import('./TimelineAudio')
  })
  return ctx
}

const tracksOf = (engine: EditorEngine) => engine.audio.tracks()
const pxPerMsOf = (bar: HTMLElement, startMs: number): number => parseFloat(bar.style.left) / startMs

describe('Timeline audio rows', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    installPointerEvents()
    localStorage.clear()
  })
  afterEach(() => {
    engine?.dispose()
    engine = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    document.body.innerHTML = ''
  })

  it('offers to add audio under the animations when the page has none', async () => {
    const ctx = await open()
    engine = ctx.engine
    const row = screen.getByTestId('tl-audio-empty')
    expect(row).toBeInTheDocument()
    await userEvent.click(within(row).getByTestId('tl-audio-add'))
    expect(ctx.engine.state.ui.panelId).toBe('audio')
  })

  it('does not offer it in a view-only design', async () => {
    const ctx = await open({ mode: 'shared-view' })
    engine = ctx.engine
    expect(screen.queryByTestId('tl-audio-empty')).toBeNull()
  })

  it('shows the timeline, not its empty state, for a page that has only sound, and reaches the end of the page', async () => {
    const ctx = await open({ objects: false, tracks: [track()] })
    engine = ctx.engine
    expect(screen.queryByTestId('tl-empty')).toBeNull()
    expect(screen.getByTestId('tl-audio-a1')).toBeInTheDocument()
    // The page lasts 5 s: the axis reaches at least that far.
    expect(screen.getByTestId('tl-readout')).toHaveTextContent('0:05.0')
  })

  it('draws a bar for a track of the page, named for the person who reads it', async () => {
    const ctx = await open({ tracks: [track()] })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-audio-bar-a1')
    expect(bar).toHaveAccessibleName(COPY.bar('Whoosh', t.audio.tracks.kinds.sfx, t.audio.tracks.scopes.page(1), '0:01.0', '2 s'))
    expect(screen.getByRole('group', { name: COPY.lane('Whoosh') })).toBeInTheDocument()
    expect(bar).toHaveAttribute('data-scope', 'page')
    expect(parseFloat(bar.style.left)).toBeGreaterThan(0)
  })

  it('draws a track of the whole design where it reaches the page, entering from the left on a later page', async () => {
    const ctx = await open({ second: true, tracks: [track({ id: 'm', kind: 'music', name: 'Theme', scope: { type: 'design' }, startMs: 0, trimEndMs: 3000, loop: true })] })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-audio-bar-m')
    expect(bar).toHaveAttribute('data-clipped', 'true')
    expect(bar).toHaveAttribute('data-scope', 'design')
    expect(parseFloat(bar.style.left)).toBe(0)
    // Page 1 lasts 5 s on the design clock, so a loop of 3 s that began there has its first pass behind it; a looping tail is drawn.
    expect(bar.querySelector('[data-edge="start"]')).toBeNull()
  })

  it('leaves out the tracks of other pages', async () => {
    const ctx = await open({ tracks: [track({ id: 'other', scope: { type: 'page', pageId: 'p2' } })] })
    engine = ctx.engine
    expect(screen.queryByTestId('tl-audio-bar-other')).toBeNull()
    expect(screen.getByTestId('tl-audio-empty')).toBeInTheDocument()
  })

  it('moves a track with the keyboard and trims its end with Alt, and deletes it', async () => {
    const ctx = await open({ tracks: [track()] })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-audio-bar-a1')
    bar.focus()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(tracksOf(ctx.engine)[0].startMs).toBe(1200)
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(tracksOf(ctx.engine)[0].startMs).toBe(200)
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}')
    expect(tracksOf(ctx.engine)[0].trimEndMs).toBe(2100)
    await userEvent.keyboard('{Delete}')
    expect(tracksOf(ctx.engine)).toHaveLength(0)
    expect(ctx.engine.state.history.undoLabel).toBe(t.audio.history.remove)
  })

  it('drags a bar to move it, snapping to a tenth of a second, as one undo step', async () => {
    const ctx = await open({ tracks: [track()] })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-audio-bar-a1')
    const k = pxPerMsOf(bar, 1000)
    const startX = parseFloat(bar.style.left) + 6
    fireEvent.pointerDown(bar, { clientX: startX, button: 0, pointerId: 1 })
    for (const dx of [10, 40, 0.5 * k * 1000 + 2]) fireEvent.pointerMove(bar, { clientX: startX + dx, pointerId: 1, buttons: 1 })
    fireEvent.pointerUp(bar, { clientX: startX + 0.5 * k * 1000 + 2, pointerId: 1 })
    expect(tracksOf(ctx.engine)[0].startMs).toBe(1500)
    expect(tracksOf(ctx.engine)[0].trimEndMs).toBe(2000)
    await act(async () => {
      await ctx.engine.undo()
    })
    expect(tracksOf(ctx.engine)[0].startMs).toBe(1000)
  })

  it('trims the start with the left edge: the sound before it is cut and the rest stays where it was', async () => {
    const ctx = await open({ tracks: [track({ trimEndMs: 3000 })] })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-audio-bar-a1')
    const k = pxPerMsOf(bar, 1000)
    const edge = bar.querySelector('[data-edge="start"]') as HTMLElement
    const x = parseFloat(bar.style.left)
    fireEvent.pointerDown(edge, { clientX: x + 1, button: 0, pointerId: 2 })
    fireEvent.pointerMove(bar, { clientX: x + 1 + 0.4 * k * 1000, pointerId: 2, buttons: 1 })
    fireEvent.pointerUp(bar, { clientX: x + 1 + 0.4 * k * 1000, pointerId: 2 })
    const after = tracksOf(ctx.engine)[0]
    expect(after.trimStartMs).toBe(400)
    expect(after.startMs).toBe(1400)
    expect(after.trimEndMs).toBe(3000)
  })

  it('trims the end with the right edge', async () => {
    const ctx = await open({ tracks: [track({ trimEndMs: 3000 })] })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-audio-bar-a1')
    const k = pxPerMsOf(bar, 1000)
    const edge = bar.querySelector('[data-edge="end"]') as HTMLElement
    const x = parseFloat(bar.style.left) + parseFloat(bar.style.width)
    fireEvent.pointerDown(edge, { clientX: x - 1, button: 0, pointerId: 3 })
    fireEvent.pointerMove(bar, { clientX: x - 1 - 0.5 * k * 1000, pointerId: 3, buttons: 1 })
    fireEvent.pointerUp(bar, { clientX: x - 1 - 0.5 * k * 1000, pointerId: 3 })
    expect(tracksOf(ctx.engine)[0].trimEndMs).toBe(2500)
    expect(tracksOf(ctx.engine)[0].startMs).toBe(1000)
  })

  it('does not change anything in a view-only design', async () => {
    const ctx = await open({ mode: 'shared-view', tracks: [track()] })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-audio-bar-a1')
    expect(bar.querySelector('[data-edge]')).toBeNull()
    bar.focus()
    await userEvent.keyboard('{ArrowRight}{Delete}')
    expect(tracksOf(ctx.engine)[0].startMs).toBe(1000)
    expect(screen.getByTestId('tl-audio-mute-a1')).toBeDisabled()
  })

  it('mutes a track from its row and solos it for playback', async () => {
    const ctx = await open({ tracks: [track(), track({ id: 'a2', name: 'Pop', startMs: 3000 })] })
    engine = ctx.engine
    await userEvent.click(screen.getByTestId('tl-audio-mute-a1'))
    expect(tracksOf(ctx.engine)[0].muted).toBe(true)
    expect(screen.getByTestId('tl-audio-bar-a1')).toHaveAttribute('data-muted', 'true')
    await userEvent.click(screen.getByTestId('tl-audio-solo-a2'))
    expect(audioRuntime(ctx.engine).player.getSnapshot().soloId).toBe('a2')
    expect(screen.getByTestId('tl-audio-bar-a1')).toHaveAttribute('data-dim', 'true')
    expect(screen.getByTestId('tl-audio-solo-a2')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByTestId('tl-audio-solo-a2'))
    expect(audioRuntime(ctx.engine).player.getSnapshot().soloId).toBeNull()
  })

  it('lists the tracks in the compact timeline of a narrow screen', async () => {
    const ctx = await open({ tracks: [track()], width: 400 })
    engine = ctx.engine
    const list = screen.getByTestId('tl-audio-list')
    expect(list).toHaveTextContent('Whoosh')
    expect(list).toHaveTextContent('0:01.0')
    await userEvent.click(within(list).getByRole('button', { name: t.audio.tracks.mute('Whoosh') }))
    expect(tracksOf(ctx.engine)[0].muted).toBe(true)
  })
})

describe('AudioSync', () => {
  let engine: EditorEngine | null = null
  let context: FakeContext
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    installPointerEvents()
    localStorage.clear()
    context = new FakeContext()
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return context
    })
  })
  afterEach(() => {
    engine?.dispose()
    engine = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    document.body.innerHTML = ''
  })

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
  }

  it('plays the page sound with the timeline: play starts it at the playhead, pause suspends it, stop silences it', async () => {
    const ctx = await open({ tracks: [track({ startMs: 0, trimEndMs: 4000, kind: 'music', loop: true })] })
    engine = ctx.engine
    vi.spyOn(ctx.engine.audio.sources, 'load').mockResolvedValue(fakeBuffer(10))
    const playback = playbackOf(ctx.engine)
    await act(async () => playback.seek(1500, 5000))
    await act(async () => playback.play(5000))
    await settle()
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].started?.offset).toBeCloseTo(1.5, 3)
    await act(async () => playback.pause())
    await settle()
    expect(context.state).toBe('suspended')
    await act(async () => playback.play(5000))
    await settle()
    expect(context.state).toBe('running')
    expect(context.sources).toHaveLength(1)
    await act(async () => playback.stop())
    await settle()
    expect(audioRuntime(ctx.engine).player.getSnapshot().status).toBe('idle')
    expect(context.sources[0].stopped).not.toBeNull()
  })

  it('plays no sound at another speed, and none when the page has none', async () => {
    const ctx = await open({ tracks: [track({ startMs: 0 })] })
    engine = ctx.engine
    const load = vi.spyOn(ctx.engine.audio.sources, 'load').mockResolvedValue(fakeBuffer(10))
    const playback = playbackOf(ctx.engine)
    await act(async () => playback.setSpeed(2))
    await act(async () => playback.play(5000))
    await settle()
    expect(load).not.toHaveBeenCalled()
    await act(async () => playback.stop())
    await act(async () => ctx.engine.setActivePage('p2'))
    await act(async () => playback.setSpeed(1))
    await act(async () => playback.play(5000))
    await settle()
    expect(load).not.toHaveBeenCalled()
  })
})
