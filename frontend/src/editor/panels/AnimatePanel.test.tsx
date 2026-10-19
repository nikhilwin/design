import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectAnimation } from '@/types/document'
import { enter, rectObject, setupEditor, textObject } from '../animation/testing'
import { EditorProvider } from '../EditorProvider'
import { t } from '../strings'
import { AnimatePanel } from './AnimatePanel'
import type { EditorEngine } from '../engine/editor'

const COPY = t.animation.panel

async function open(options: Parameters<typeof setupEditor>[0] = {}, select: string[] = []) {
  const { engine, pageId } = await setupEditor(options)
  await act(async () => {
    render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <AnimatePanel />
      </EditorProvider>,
    )
  })
  if (select.length > 0) await act(async () => engine.select(select, pageId))
  return { engine, pageId }
}

const objectsOf = (engine: EditorEngine) => engine.state.doc.pages[0].objects
const animationOf = (engine: EditorEngine, i = 0): ObjectAnimation | undefined => objectsOf(engine)[i].animation as ObjectAnimation | undefined

describe('AnimatePanel', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['x'], { type: 'image/webp' })))
  })
  afterEach(() => {
    engine?.dispose()
    engine = null
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('starts on the page when nothing is selected and says so on the element tab', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100)] })
    engine = ctx.engine
    expect(screen.getByRole('radio', { name: COPY.page })).toBeChecked()
    expect(screen.getByRole('group', { name: COPY.pageStyle })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: COPY.element }))
    expect(screen.getByTestId('animate-empty')).toHaveTextContent(COPY.emptyTitle)
    await userEvent.click(screen.getByRole('button', { name: COPY.animatePage }))
    expect(screen.getByRole('radio', { name: COPY.page })).toBeChecked()
  })

  it('shows the element tab with a grid of presets as soon as something is selected', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100)] }, ['a'])
    engine = ctx.engine
    expect(screen.getByRole('radio', { name: COPY.element })).toBeChecked()
    expect(screen.getByTestId('animate-selected')).toHaveTextContent(COPY.selected(1))
    for (const id of ['fade', 'rise', 'typewriter', 'neon-flicker']) expect(screen.getByTestId(`animate-enter-${id}`)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: COPY.groups.basic })).toBeInTheDocument()
    expect(screen.queryByTestId('animate-settings')).toBeNull()
  })

  it('sets a preset with its own settings, marks it as chosen and shows its settings', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100)] }, ['a'])
    engine = ctx.engine
    await userEvent.click(screen.getByTestId('animate-enter-slide'))
    expect(animationOf(engine)?.enter).toEqual({ preset: 'slide', durationMs: 700, delayMs: 0, easing: 'ease-out', direction: 'left' })
    expect(screen.getByTestId('animate-enter-slide')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('animate-enter-fade')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('animate-settings')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: COPY.direction })).toBeInTheDocument()
  })

  it('changes the direction, the times, the easing and the strength', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100, enter('slide'))] }, ['a'])
    engine = ctx.engine
    await userEvent.click(screen.getByRole('radio', { name: COPY.directionFrom.up }))
    expect(animationOf(engine)?.enter?.direction).toBe('up')
    const duration = screen.getByRole('textbox', { name: COPY.duration })
    await userEvent.clear(duration)
    await userEvent.type(duration, '2.5{Enter}')
    expect(animationOf(engine)?.enter?.durationMs).toBe(2500)
    const delay = screen.getByRole('textbox', { name: COPY.delay })
    await userEvent.clear(delay)
    await userEvent.type(delay, '1{Enter}')
    expect(animationOf(engine)?.enter?.delayMs).toBe(1000)
    await userEvent.selectOptions(screen.getByTestId('animate-easing'), 'spring')
    expect(animationOf(engine)?.enter?.easing).toBe('spring')
    fireEvent.change(screen.getByRole('slider', { name: COPY.intensity }), { target: { value: '55' } })
    expect(animationOf(engine)?.enter?.intensity).toBe(0.55)
  })

  it('limits what is typed to the document’s ranges', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100, enter('fade'))] }, ['a'])
    engine = ctx.engine
    const duration = screen.getByRole('textbox', { name: COPY.duration })
    await userEvent.clear(duration)
    await userEvent.type(duration, '99{Enter}')
    expect(animationOf(engine)?.enter?.durationMs).toBe(10_000)
    await userEvent.clear(duration)
    await userEvent.type(duration, '0{Enter}')
    expect(animationOf(engine)?.enter?.durationMs).toBe(100)
  })

  it('offers the three kinds and puts a preset into the one that is open', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100)] }, ['a'])
    engine = ctx.engine
    await userEvent.click(screen.getByRole('radio', { name: COPY.slot.emphasis }))
    expect(screen.getByRole('group', { name: COPY.slot.emphasis })).toBeInTheDocument()
    expect(screen.queryByTestId('animate-emphasis-fade')).toBeNull()
    await userEvent.click(screen.getByTestId('animate-emphasis-pulse'))
    expect(animationOf(engine)?.emphasis?.preset).toBe('pulse')
    expect(screen.getByRole('switch', { name: new RegExp(COPY.loop) })).not.toBeChecked()
    await userEvent.click(screen.getByRole('switch', { name: new RegExp(COPY.loop) }))
    expect(animationOf(engine)?.emphasis?.loop).toBe(true)
    await userEvent.click(screen.getByRole('radio', { name: COPY.slot.exit }))
    await userEvent.click(screen.getByTestId('animate-exit-fade'))
    expect(animationOf(engine)?.exit?.easing).toBe('ease-in')
    expect(Object.keys(animationOf(engine) ?? {}).sort()).toEqual(['emphasis', 'exit'])
  })

  it('marks the kinds that are set', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100, enter('fade'))] }, ['a'])
    engine = ctx.engine
    const enterTab = screen.getByRole('radio', { name: new RegExp(COPY.slot.enter) }).closest('label')
    expect(within(enterTab as HTMLElement).getByRole('img', { name: COPY.set })).toBeInTheDocument()
    const exitTab = screen.getByRole('radio', { name: COPY.slot.exit }).closest('label')
    expect(within(exitTab as HTMLElement).queryByRole('img', { name: COPY.set })).toBeNull()
  })

  it('offers text units only for text, and only for presets that can use them', async () => {
    const ctx = await open({ objects: [textObject('t', 200, 100, enter('rise')), rectObject('r', 400, 300, enter('rise'))] }, ['t'])
    engine = ctx.engine
    expect(screen.getByRole('radiogroup', { name: COPY.by })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: COPY.units.word }))
    expect(animationOf(engine)?.enter?.by).toBe('word')
    await userEvent.click(screen.getByRole('radio', { name: COPY.units.object }))
    expect(animationOf(engine)?.enter).not.toHaveProperty('by')
    await userEvent.click(screen.getByTestId('animate-enter-slide'))
    expect(screen.queryByRole('radiogroup', { name: COPY.by })).toBeNull()
    await act(async () => engine!.select(['r']))
    expect(screen.queryByRole('radiogroup', { name: COPY.by })).toBeNull()
  })

  it('removes the animation of the open kind', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100, { ...enter('fade'), exit: { preset: 'fade', durationMs: 500, delayMs: 3000, easing: 'ease-in' } })] }, ['a'])
    engine = ctx.engine
    await userEvent.click(screen.getByTestId('animate-remove'))
    expect(Object.keys(animationOf(engine) ?? {})).toEqual(['exit'])
    expect(screen.queryByTestId('animate-settings')).toBeNull()
  })

  it('puts a slider drag into one undo step', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100, enter('fade'))] }, ['a'])
    engine = ctx.engine
    const depth = engine.history.depth
    const strength = screen.getByRole('slider', { name: COPY.intensity })
    for (const value of ['55', '60', '65', '70']) fireEvent.change(strength, { target: { value } })
    expect(animationOf(engine)?.enter?.intensity).toBe(0.7)
    expect(engine.history.depth).toBe(depth + 1)
  })

  it('applies one change to every selected element', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100), rectObject('b', 300, 300)] })
    engine = ctx.engine
    await act(async () => engine!.selectAll())
    expect(screen.getByTestId('animate-selected')).toHaveTextContent(COPY.selected(2))
    await userEvent.click(screen.getByTestId('animate-enter-pop'))
    expect(objectsOf(engine).map((o) => (o.animation as ObjectAnimation).enter?.preset)).toEqual(['pop', 'pop'])
  })

  it('moves between the tiles with the arrow keys', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100)] }, ['a'])
    engine = ctx.engine
    const fade = screen.getByTestId('animate-enter-fade')
    fade.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByTestId('animate-enter-rise')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(fade).toHaveFocus()
  })

  it('names every tile and says it previews', async () => {
    const ctx = await open({ objects: [rectObject('a', 100, 100)] }, ['a'])
    engine = ctx.engine
    expect(screen.getByRole('button', { name: 'Pop' })).toHaveAttribute('title', COPY.preview('Pop'))
  })

  describe('the page', () => {
    it('animates the whole page in a style and removes the animations again', async () => {
      const ctx = await open({ objects: [rectObject('a', 100, 100), rectObject('b', 400, 300)] })
      engine = ctx.engine
      expect(screen.getByTestId('animate-clear-page')).toBeDisabled()
      await userEvent.click(screen.getByTestId('animate-style-rise'))
      expect(objectsOf(engine).every((o) => (o.animation as ObjectAnimation).enter?.preset === 'rise')).toBe(true)
      expect(screen.getByTestId('animate-clear-page')).toBeEnabled()
      await userEvent.click(screen.getByTestId('animate-clear-page'))
      expect(objectsOf(engine).every((o) => o.animation === undefined)).toBe(true)
    })

    it('sets and removes the transition, with its duration, direction and easing', async () => {
      const ctx = await open({ objects: [rectObject('a', 100, 100)] })
      engine = ctx.engine
      expect(screen.getByTestId('animate-transition-none')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.queryByTestId('animate-transition-settings')).toBeNull()
      await userEvent.click(screen.getByTestId('animate-transition-push'))
      expect(engine.state.doc.pages[0].transition).toEqual({ preset: 'push', durationMs: 700, easing: 'ease-in-out', direction: 'right' })
      expect(screen.getByTestId('animate-transition-push')).toHaveAttribute('aria-pressed', 'true')
      await userEvent.click(screen.getByRole('radio', { name: COPY.transitionFrom.up }))
      expect(engine.state.doc.pages[0].transition?.direction).toBe('up')
      const duration = screen.getByRole('textbox', { name: COPY.duration })
      await userEvent.clear(duration)
      await userEvent.type(duration, '9{Enter}')
      expect(engine.state.doc.pages[0].transition?.durationMs).toBe(3000)
      await userEvent.click(screen.getByTestId('animate-transition-remove'))
      expect(engine.state.doc.pages[0].transition).toBeUndefined()
      await userEvent.click(screen.getByTestId('animate-transition-fade'))
      await userEvent.click(screen.getByTestId('animate-transition-none'))
      expect(engine.state.doc.pages[0].transition).toBeUndefined()
    })

    it('applies the transition to every page', async () => {
      const doc = (await import('@/lib/document')).createBlankDocument(800, 600)
      doc.pages.push({ ...doc.pages[0], id: 'two', objects: [] })
      const ctx = await open({ doc })
      engine = ctx.engine
      await userEvent.click(screen.getByTestId('animate-transition-zoom-in'))
      expect(engine.state.doc.pages[1].transition).toBeUndefined()
      await userEvent.click(screen.getByTestId('animate-transition-all'))
      expect(engine.state.doc.pages.map((p) => p.transition?.preset)).toEqual(['zoom-in', 'zoom-in'])
    })
  })
})
