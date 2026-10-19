import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectAnimation } from '@/types/document'
import { playbackOf } from '../animation/playback'
import { registerTimelineSection } from '../animation/sections'
import { enter, rectObject, setupEditor, textObject } from '../animation/testing'
import { EditorProvider } from '../EditorProvider'
import { installPointerEvents } from '../panels/commentsTesting'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { TimelineHost } from './Timeline'
import { TimelineRow } from './TimelineRow'
import { isTimelineOpenForTest } from './timelineTesting'
import { setTimelineView, toggleTimeline } from './timelineVisibility'

const COPY = t.animation.timeline

class FakeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function width(px: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => px })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 })
}

async function open(options: Parameters<typeof setupEditor>[0] = {}, opts: { width?: number; shown?: boolean } = {}) {
  width(opts.width ?? 1200)
  const ctx = await setupEditor(options)
  await act(async () => {
    render(
      <EditorProvider engine={ctx.engine} portalRoot={document.body}>
        <TimelineHost />
      </EditorProvider>,
    )
  })
  if (opts.shown !== false) await act(async () => setTimelineView(ctx.engine, { open: true, collapsed: false }))
  return ctx
}

const objectsOf = (engine: EditorEngine) => engine.state.doc.pages[0].objects
const animationOf = (engine: EditorEngine, id: string): ObjectAnimation | undefined => objectsOf(engine).find((o) => o.id === id)?.animation as ObjectAnimation | undefined

const animated = () => [
  rectObject('a', 100, 100, { ...enter('fade', 0, 600), emphasis: { preset: 'float', durationMs: 2400, delayMs: 600, easing: 'linear', loop: true } }),
  textObject('t', 300, 300, enter('rise', 500, 800)),
  rectObject('plain', 600, 400),
]

describe('Timeline', () => {
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
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    document.body.innerHTML = ''
  })

  it('is not there until it is switched on, and the choice is remembered', async () => {
    const ctx = await open({ objects: animated() }, { shown: false })
    engine = ctx.engine
    expect(screen.queryByTestId('ed-timeline')).toBeNull()
    expect(isTimelineOpenForTest(ctx.engine)).toBe(false)
    await act(async () => toggleTimeline(ctx.engine))
    expect(screen.getByRole('region', { name: COPY.region })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('doory.editor.timeline.v1') ?? '{}')).toEqual({ open: true, collapsed: false })
    await act(async () => toggleTimeline(ctx.engine))
    expect(screen.queryByTestId('ed-timeline')).toBeNull()
  })

  it('still works when storage refuses to write', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const ctx = await open({ objects: animated() }, { shown: false })
    engine = ctx.engine
    await act(async () => toggleTimeline(ctx.engine))
    expect(screen.getByTestId('ed-timeline')).toBeInTheDocument()
    spy.mockRestore()
  })

  it('has a lane for each animated element, with a bar for each animation', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    expect(screen.getAllByRole('group').filter((g) => g.dataset.testid?.startsWith('tl-lane-'))).toHaveLength(2)
    expect(screen.queryByTestId('tl-lane-plain')).toBeNull()
    const bar = screen.getByTestId('tl-bar-a-enter')
    expect(bar).toHaveAccessibleName(COPY.bar('Enter', 'Fade', '0:00.0', '0.6 s'))
    expect(screen.getByTestId('tl-bar-a-emphasis')).toHaveAttribute('data-looping', 'true')
    expect(screen.getByTestId('tl-bar-t-enter')).toHaveAccessibleName(COPY.bar('Enter', 'Rise', '0:00.5', '0.8 s'))
  })

  it('lists lanes by their start', async () => {
    const ctx = await open({ objects: [rectObject('late', 100, 100, enter('fade', 2000)), rectObject('early', 300, 100, enter('fade', 0))] })
    engine = ctx.engine
    const lanes = screen.getAllByRole('group').filter((g) => g.dataset.testid?.startsWith('tl-lane-'))
    expect(lanes.map((l) => l.dataset.testid)).toEqual(['tl-lane-early', 'tl-lane-late'])
  })

  it('selects the element of a lane or a bar, and follows the selection made on the canvas', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    await userEvent.click(within(screen.getByTestId('tl-lane-t')).getByRole('button', { name: /Hello/ }))
    expect(ctx.engine.state.selection.ids).toEqual(['t'])
    expect(within(screen.getByTestId('tl-lane-t')).getByRole('button', { pressed: true })).toBeInTheDocument()
    await act(async () => ctx.engine.select(['a']))
    expect(screen.getByTestId('tl-lane-a')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('tl-lane-t')).not.toHaveAttribute('data-selected')
  })

  it('moves a bar by keyboard, changes its length with Alt, and removes it with Delete', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-bar-t-enter')
    bar.focus()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(animationOf(ctx.engine, 't')?.enter?.delayMs).toBe(700)
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(animationOf(ctx.engine, 't')?.enter?.delayMs).toBe(0)
    await userEvent.keyboard('{Alt>}{ArrowRight}{ArrowRight}{/Alt}')
    expect(animationOf(ctx.engine, 't')?.enter?.durationMs).toBe(1000)
    await userEvent.keyboard('{Delete}')
    expect(animationOf(ctx.engine, 't')).toBeUndefined()
  })

  it('drags a bar to move it, and its edges to change its start and end, as single undo steps', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-bar-t-enter')
    const track = bar.parentElement as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 30, width: 1000, height: 30, x: 0, y: 0, toJSON: () => ({}) })
    const msPerPx = 1 / (parseFloat(bar.style.width) / 800)
    const startX = parseFloat(bar.style.left) + 20
    const depth = ctx.engine.history.depth
    fireEvent.pointerDown(bar, { clientX: startX, button: 0, pointerId: 1 })
    for (const dx of [10, 40, 90]) fireEvent.pointerMove(bar, { clientX: startX + dx, pointerId: 1, buttons: 1 })
    fireEvent.pointerUp(bar, { clientX: startX + 90, pointerId: 1 })
    const moved = animationOf(ctx.engine, 't')?.enter
    expect(moved?.delayMs).toBe(Math.round((500 + 90 * msPerPx) / 100) * 100)
    expect(moved?.durationMs).toBe(800)
    expect(ctx.engine.history.depth).toBe(depth + 1)

    const edge = bar.querySelector('[data-edge="end"]') as HTMLElement
    const endX = parseFloat(bar.style.left) + parseFloat(bar.style.width)
    fireEvent.pointerDown(edge, { clientX: endX, button: 0, pointerId: 2 })
    fireEvent.pointerMove(bar, { clientX: endX + 50, pointerId: 2, buttons: 1 })
    fireEvent.pointerUp(bar, { clientX: endX + 50, pointerId: 2 })
    expect(animationOf(ctx.engine, 't')?.enter?.delayMs).toBe(moved?.delayMs)
    expect(animationOf(ctx.engine, 't')?.enter?.durationMs).toBeGreaterThan(800)
  })

  it('selects the element when its bar is pressed', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    fireEvent.pointerDown(screen.getByTestId('tl-bar-a-enter'), { clientX: 5, button: 0, pointerId: 1 })
    fireEvent.pointerUp(screen.getByTestId('tl-bar-a-enter'), { pointerId: 1 })
    expect(ctx.engine.state.selection.ids).toEqual(['a'])
  })

  it('moves the playhead from the ruler and shows the time', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    const ruler = screen.getByRole('slider', { name: COPY.scrub })
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 26, width: 1000, height: 26, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(ruler, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(ruler, { clientX: 300, pointerId: 1 })
    const time = playbackOf(ctx.engine).state.timeMs
    expect(time).toBeGreaterThan(0)
    expect(playbackOf(ctx.engine).state.active).toBe(true)
    expect(playbackOf(ctx.engine).state.playing).toBe(false)
    expect(screen.getByTestId('tl-readout')).toHaveTextContent(/^0:0\d\.\d/)
    ruler.focus()
    await userEvent.keyboard('{Home}')
    expect(playbackOf(ctx.engine).state.timeMs).toBe(0)
    await userEvent.keyboard('{ArrowRight}')
    expect(playbackOf(ctx.engine).state.timeMs).toBe(100)
  })

  it('plays, pauses, restarts and repeats', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    const pb = playbackOf(ctx.engine)
    await userEvent.click(screen.getByTestId('tl-play'))
    expect(pb.state).toMatchObject({ active: true, playing: true })
    expect(screen.getByTestId('tl-play')).toHaveAccessibleName(COPY.pause)
    await userEvent.click(screen.getByTestId('tl-play'))
    expect(pb.state.playing).toBe(false)
    await act(async () => pb.seek(1500, 5000))
    await userEvent.click(screen.getByTestId('tl-restart'))
    expect(pb.state.timeMs).toBe(0)
    await userEvent.click(screen.getByTestId('tl-loop'))
    expect(pb.state.loop).toBe(true)
    await userEvent.selectOptions(screen.getByTestId('tl-speed'), '2')
    expect(pb.state.speed).toBe(2)
  })

  it('draws the end of the page, and warns when animations run past it', async () => {
    const objects = [rectObject('a', 100, 100, { ...enter('fade', 0, 1000), exit: { preset: 'fade', durationMs: 500, delayMs: 5800, easing: 'ease-in' } })]
    const ctx = await open({ objects })
    engine = ctx.engine
    expect(screen.queryByTestId('tl-end')).toBeNull()
    expect(screen.queryByTestId('tl-overrun')).toBeNull()
    await act(async () => ctx.engine.pages.setDuration(ctx.pageId, 4))
    expect(screen.getByTestId('tl-end')).toBeInTheDocument()
    expect(screen.getByTestId('tl-overrun')).toHaveTextContent(COPY.overrun('1.3 s'))
    expect(screen.getByTestId('tl-bar-a-exit')).toHaveAttribute('data-late', 'true')
    await userEvent.click(screen.getByTestId('tl-extend'))
    expect(ctx.engine.state.doc.pages[0].durationSec).toBe(6)
    expect(screen.queryByTestId('tl-overrun')).toBeNull()
  })

  it('folds down to its transport bar and unfolds again', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    await userEvent.click(screen.getByTestId('tl-collapse'))
    expect(screen.getByTestId('ed-timeline')).toHaveAttribute('data-collapsed', 'true')
    expect(screen.queryByTestId('tl-scroller')).toBeNull()
    expect(screen.getByTestId('tl-play')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('tl-collapse'))
    expect(screen.getByTestId('tl-scroller')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('tl-close'))
    expect(screen.queryByTestId('ed-timeline')).toBeNull()
  })

  it('zooms the time axis', async () => {
    const ctx = await open({ objects: animated() })
    engine = ctx.engine
    const before = parseFloat(screen.getByTestId('tl-bar-a-enter').style.width)
    expect(screen.getByTestId('tl-zoom-out')).toBeDisabled()
    await userEvent.click(screen.getByTestId('tl-zoom-in'))
    expect(parseFloat(screen.getByTestId('tl-bar-a-enter').style.width)).toBeGreaterThan(before * 1.4)
    await userEvent.click(screen.getByTestId('tl-zoom-out'))
    expect(parseFloat(screen.getByTestId('tl-bar-a-enter').style.width)).toBeCloseTo(before, 3)
  })

  it('says what to do on a page without animations', async () => {
    const ctx = await open({ objects: [rectObject('plain', 100, 100)] })
    engine = ctx.engine
    expect(screen.getByTestId('tl-empty')).toHaveTextContent(COPY.empty)
    expect(screen.getByTestId('tl-play')).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: COPY.openPanel }))
    expect(ctx.engine.state.ui.panelId).toBe('animate')
  })

  it('turns into a list on a narrow screen, with a slider for the playhead and a chip for each animation', async () => {
    const ctx = await open({ objects: animated() }, { width: 390 })
    engine = ctx.engine
    expect(screen.queryByTestId('tl-scroller')).toBeNull()
    const list = screen.getByRole('list', { name: COPY.list })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    const chip = within(list).getByRole('button', { name: COPY.chip('Enter', 'Rise', '0:00.5', '0:01.3') })
    await userEvent.click(chip)
    expect(ctx.engine.state.selection.ids).toEqual(['t'])
    const scrub = screen.getByTestId('tl-scrub')
    fireEvent.change(scrub, { target: { value: '1200' } })
    expect(playbackOf(ctx.engine).state.timeMs).toBe(1200)
  })

  it('is read-only in a view-only design: bars cannot be changed, and the page cannot be fitted', async () => {
    const doc = (await import('@/lib/document')).createBlankDocument(800, 600)
    doc.pages[0].objects = [rectObject('a', 100, 100, { ...enter('fade', 0, 1000), exit: { preset: 'fade', durationMs: 500, delayMs: 5800, easing: 'ease-in' } })]
    doc.pages[0].durationSec = 4
    const ctx = await open({ doc, mode: 'shared-view' })
    engine = ctx.engine
    const bar = screen.getByTestId('tl-bar-a-enter')
    expect(bar.querySelector('[data-edge]')).toBeNull()
    bar.focus()
    await userEvent.keyboard('{ArrowRight}{Delete}')
    expect(animationOf(ctx.engine, 'a')?.enter?.delayMs).toBe(0)
    expect(screen.queryByTestId('tl-extend')).toBeNull()
    await userEvent.click(screen.getByTestId('tl-play'))
    expect(playbackOf(ctx.engine).state.playing).toBe(true)
  })

  it('shows the rows of a registered section on the same axis, and keeps the timeline from being empty for them', async () => {
    const off = registerTimelineSection({
      id: 'test-audio',
      order: 10,
      hasContent: () => true,
      extentMs: () => 20_000,
      Section: ({ pxPerMs, contentWidth, lengthMs }) => (
        <TimelineRow name="Music" label="Music" contentWidth={contentWidth} testId="tl-row-music">
          <div data-testid="music-clip" data-width={Math.round(lengthMs * pxPerMs)} style={{ position: 'absolute', left: 0, width: lengthMs * pxPerMs }} />
        </TimelineRow>
      ),
      List: () => <p data-testid="music-list">Music</p>,
    })
    try {
      const ctx = await open({ objects: [rectObject('plain', 600, 400)] })
      engine = ctx.engine
      // No animations, but the section has something: no empty state, a row for it, and an axis as long as its content.
      expect(screen.queryByTestId('tl-empty')).toBeNull()
      expect(screen.getByTestId('tl-row-music')).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Music' })).toBeInTheDocument()
      expect(screen.getByTestId('tl-readout')).toHaveTextContent('0:20.0')
      expect(Number(screen.getByTestId('music-clip').dataset.width)).toBeGreaterThan(100)
    } finally {
      await act(async () => off())
    }
    // Taken away again, the timeline is what it was.
    expect(screen.queryByTestId('tl-row-music')).toBeNull()
    expect(screen.getByTestId('tl-empty')).toBeInTheDocument()
  })

  it('puts the list of a section on a narrow screen', async () => {
    const off = registerTimelineSection({ id: 'test-audio-list', order: 10, hasContent: () => true, Section: () => null, List: () => <p data-testid="music-list">Music</p> })
    try {
      const ctx = await open({ objects: animated() }, { width: 400 })
      engine = ctx.engine
      expect(screen.getByTestId('music-list')).toBeInTheDocument()
    } finally {
      await act(async () => off())
    }
  })
})
