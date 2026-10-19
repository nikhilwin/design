import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { context2d } from '../animation/canvasFx'
import { playbackOf } from '../animation/playback'
import { enter, rectObject, setupEditor } from '../animation/testing'
import { previewMultiplier } from '../animation/timelineMath'
import { EditorProvider } from '../EditorProvider'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { TimelinePreview } from './TimelinePreview'

async function open() {
  const ctx = await setupEditor({ objects: [rectObject('a', 400, 300, enter('fade', 200, 400), { fill: '#ff0000', width: 200, height: 200 })] })
  const scroller = document.createElement('div')
  document.body.appendChild(scroller)
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null }
  ref.current = scroller
  await act(async () => {
    render(
      <EditorProvider engine={ctx.engine} portalRoot={document.body}>
        <TimelinePreview scrollRef={ref} />
      </EditorProvider>,
    )
  })
  return ctx
}

const frameCanvas = (): HTMLCanvasElement => screen.getByTestId('ed-preview-frame').querySelector('canvas') as HTMLCanvasElement
const pixel = (x: number, y: number): number[] => Array.from(context2d(frameCanvas()).getImageData(x, y, 1, 1).data)

describe('TimelinePreview', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['x'], { type: 'image/webp' })))
  })
  afterEach(() => {
    engine?.dispose()
    engine = null
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('is not there until the playback starts', async () => {
    const ctx = await open()
    engine = ctx.engine
    expect(screen.queryByTestId('ed-preview')).toBeNull()
    await act(async () => playbackOf(ctx.engine).seek(0, 1000))
    expect(screen.getByRole('region', { name: t.animation.preview.region })).toBeInTheDocument()
  })

  it('draws the page at the playhead, with the animated element hidden before its start and in place after its end', async () => {
    const ctx = await open()
    engine = ctx.engine
    const playback = playbackOf(ctx.engine)
    await act(async () => playback.seek(0, 1000))
    await waitFor(() => expect(screen.getByTestId('ed-preview-frame')).toHaveAttribute('data-status', 'ready'))
    expect(pixel(400, 300)).toEqual([255, 255, 255, 255])
    await act(async () => playback.seek(1000, 1000))
    expect(pixel(400, 300)).toEqual([255, 0, 0, 255])
    await act(async () => playback.seek(400, 1000))
    const mid = pixel(400, 300)
    expect(mid[0]).toBe(255)
    expect(mid[1]).toBeGreaterThan(20)
    expect(mid[1]).toBeLessThan(235)
  })

  it('does not change the design, the history or the selection', async () => {
    const ctx = await open()
    engine = ctx.engine
    const before = JSON.stringify(ctx.engine.state.doc)
    const depth = ctx.engine.history.depth
    await act(async () => playbackOf(ctx.engine).seek(300, 1000))
    await waitFor(() => expect(screen.getByTestId('ed-preview-frame')).toHaveAttribute('data-status', 'ready'))
    expect(JSON.stringify(ctx.engine.state.doc)).toBe(before)
    expect(ctx.engine.history.depth).toBe(depth)
    expect(ctx.engine.persistence.isDirty()).toBe(false)
  })

  it('stops with Escape and pauses with Space, and keeps the editor’s other shortcuts away from the page', async () => {
    const ctx = await open()
    engine = ctx.engine
    const playback = playbackOf(ctx.engine)
    await act(async () => playback.play(1000))
    expect(playback.state.playing).toBe(true)
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    await act(async () => {
      document.body.dispatchEvent(space)
    })
    expect(space.defaultPrevented).toBe(true)
    expect(playback.state.playing).toBe(false)
    // The editor's own key handler skips a key that is already handled: it is marked as such before it gets there.
    const del = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    await act(async () => {
      document.body.dispatchEvent(del)
    })
    expect(del.defaultPrevented).toBe(true)
    const select = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
    await act(async () => {
      document.body.dispatchEvent(select)
    })
    expect(select.defaultPrevented).toBe(true)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      document.body.dispatchEvent(esc)
    })
    expect(playback.state.active).toBe(false)
    expect(screen.queryByTestId('ed-preview')).toBeNull()
  })

  it('keeps the editor’s keys away even when a button of the transport has the focus, but lets that button take Space and Enter', async () => {
    const ctx = await open()
    engine = ctx.engine
    await act(async () => playbackOf(ctx.engine).seek(0, 1000))
    const controls = screen.getByTestId('ed-preview-toggle')
    const del = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    await act(async () => {
      controls.dispatchEvent(del)
    })
    expect(del.defaultPrevented).toBe(true)
    for (const key of [' ', 'Enter', 'Tab']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      await act(async () => {
        controls.dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(false)
    }
    expect(playbackOf(ctx.engine).state.playing).toBe(false)
  })

  it('lets a text field keep its keys', async () => {
    const ctx = await open()
    engine = ctx.engine
    await act(async () => playbackOf(ctx.engine).seek(0, 1000))
    const input = document.createElement('input')
    document.body.appendChild(input)
    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    await act(async () => {
      input.dispatchEvent(key)
    })
    expect(key.defaultPrevented).toBe(false)
  })

  it('has buttons to pause and stop for those without a keyboard', async () => {
    const ctx = await open()
    engine = ctx.engine
    const playback = playbackOf(ctx.engine)
    await act(async () => playback.play(1000))
    await act(async () => screen.getByTestId('ed-preview-toggle').click())
    expect(playback.state.playing).toBe(false)
    expect(screen.getByTestId('ed-preview-toggle')).toHaveAccessibleName(t.animation.preview.play)
    await act(async () => screen.getByTestId('ed-preview-stop').click())
    expect(playback.state.active).toBe(false)
  })

  it('runs the clock while it plays, and ends at the end of the page', async () => {
    const ctx = await open()
    engine = ctx.engine
    const playback = playbackOf(ctx.engine)
    await act(async () => playback.seek(0, 1000))
    await waitFor(() => expect(screen.getByTestId('ed-preview-frame')).toHaveAttribute('data-status', 'ready'))
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    await act(async () => playback.play(1000))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(playback.state.timeMs).toBeGreaterThan(100)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(playback.state.active).toBe(false)
  })

  it('tells assistive technology which page is playing', async () => {
    const ctx = await open()
    engine = ctx.engine
    await act(async () => playbackOf(ctx.engine).seek(0, 1000))
    expect(screen.getByTestId('ed-preview-frame')).toHaveAttribute('role', 'img')
    expect(screen.getByTestId('ed-preview-frame')).toHaveAttribute('aria-label', t.animation.preview.page(1))
    expect(ctx.engine.state.announcement).toBe(t.animation.preview.started(1))
  })
})

describe('previewMultiplier', () => {
  it('follows the zoom at the device’s pixel ratio', () => {
    expect(previewMultiplier(0.5, 2, { width: 1000, height: 1000 })).toBe(1)
    expect(previewMultiplier(1, 1, { width: 800, height: 600 })).toBe(1)
  })

  it('never asks for a bitmap beyond twelve megapixels', () => {
    const m = previewMultiplier(8, 3, { width: 4000, height: 4000 })
    expect(4000 * m * 4000 * m).toBeLessThanOrEqual(12_000_001)
  })

  it('keeps a sensible floor for a tiny zoom', () => {
    expect(previewMultiplier(0, 1, { width: 100, height: 100 })).toBe(0.05)
  })
})
