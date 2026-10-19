import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { CanvasSizeButton } from './CanvasSizeButton'

async function setup() {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
  const resize = vi.spyOn(engine.pages, 'resize').mockImplementation(() => undefined)
  render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <CanvasSizeButton />
    </EditorProvider>,
  )
  await userEvent.click(screen.getByRole('button', { name: t.canvasSize.button }))
  return { engine, resize, width: screen.getByTestId('ed-canvas-width'), height: screen.getByTestId('ed-canvas-height'), apply: screen.getByTestId('ed-canvas-apply') }
}

describe('canvas size fields (the document format’s 1-20 000 px)', () => {
  let engine: EditorEngine | null = null
  afterEach(() => engine?.dispose())

  it('show the limit as tooltip and accessible description, in the unit of the field', async () => {
    const ctx = await setup()
    engine = ctx.engine
    for (const field of [ctx.width, ctx.height]) {
      expect(field).toHaveAttribute('title', 'Between 1 and 20000 px')
      expect(field).toHaveAttribute('min', '1')
      expect(field).toHaveAttribute('max', '20000')
      expect(field).toHaveAccessibleDescription(t.canvasSize.range(1, 20000))
    }
    await userEvent.click(screen.getByRole('button', { name: 'mm' }))
    expect(screen.getByTestId('ed-canvas-width')).toHaveAttribute('title', 'Between 0.3 and 5291.6 mm')
    await userEvent.click(screen.getByRole('button', { name: 'in' }))
    expect(screen.getByTestId('ed-canvas-height')).toHaveAttribute('title', 'Between 0.02 and 208.33 in')
  })

  it.each([
    ['99999', '20000'],
    ['0', '1'],
    ['-40', '1'],
  ])('pull %s back to %s when the field is left', async (typed, expected) => {
    const ctx = await setup()
    engine = ctx.engine
    await userEvent.clear(ctx.width)
    await userEvent.type(ctx.width, typed)
    expect(ctx.width).toHaveAttribute('aria-invalid', 'true')
    expect(ctx.apply).toBeDisabled()
    await userEvent.tab()
    expect(ctx.width).toHaveValue(Number(expected))
    expect(ctx.width).toHaveAttribute('aria-invalid', 'false')
    expect(ctx.apply).toBeEnabled()
  })

  it('apply the clamped size, never the typed one', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await userEvent.clear(ctx.height)
    await userEvent.type(ctx.height, '1000000')
    await userEvent.tab()
    await userEvent.click(ctx.apply)
    expect(ctx.resize).toHaveBeenCalledExactlyOnceWith(800, 20000, 'scale', { scope: 'all', pageId: ctx.engine.state.activePageId })
  })

  it('Enter on a value outside the limit shows the limit’s answer and applies nothing', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await userEvent.clear(ctx.width)
    await userEvent.type(ctx.width, '50000{Enter}')
    expect(ctx.width).toHaveValue(20000)
    expect(ctx.resize).not.toHaveBeenCalled()
    await userEvent.type(ctx.width, '{Enter}')
    expect(ctx.resize).toHaveBeenCalledExactlyOnceWith(20000, 600, 'scale', { scope: 'all', pageId: ctx.engine.state.activePageId })
  })

  it('keep an empty field invalid with a message instead of inventing a size', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await userEvent.clear(ctx.width)
    await userEvent.tab()
    expect(ctx.width).toHaveValue(null)
    expect(screen.getByRole('alert')).toHaveTextContent(t.canvasSize.invalid(1, 20000))
    expect(ctx.apply).toBeDisabled()
  })

  it('stay in range in millimetres: the largest value is accepted back as 20 000 px', async () => {
    const ctx = await setup()
    engine = ctx.engine
    await userEvent.click(screen.getByRole('button', { name: 'mm' }))
    const width = screen.getByTestId('ed-canvas-width')
    await userEvent.clear(width)
    await userEvent.type(width, '99999')
    await userEvent.tab()
    expect(width).toHaveValue(5291.6)
    await userEvent.click(screen.getByTestId('ed-canvas-apply'))
    expect(ctx.resize).toHaveBeenCalledExactlyOnceWith(20000, expect.any(Number), 'scale', { scope: 'all', pageId: ctx.engine.state.activePageId })
  })
})

describe('canvas size on a design with several pages', () => {
  let engine: EditorEngine | null = null
  afterEach(() => engine?.dispose())

  async function setupMany(mixed: boolean) {
    const handle = createMemoryAdapter()
    const eng = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
    eng.pages.add(1, mixed ? { width: 300, height: 400 } : undefined)
    const resize = vi.spyOn(eng.pages, 'resize').mockImplementation(() => undefined)
    render(
      <EditorProvider engine={eng} portalRoot={document.body}>
        <CanvasSizeButton />
      </EditorProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: t.canvasSize.button }))
    return { engine: eng, resize }
  }

  it('offers this page and all pages, and starts on all pages when the pages share a size', async () => {
    const ctx = await setupMany(false)
    engine = ctx.engine
    expect(screen.getByTestId('ed-scope-all')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('ed-scope-page')).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByTestId('ed-canvas-apply'))
    expect(ctx.resize).toHaveBeenCalledExactlyOnceWith(800, 600, 'scale', { scope: 'all', pageId: ctx.engine.state.activePageId })
  })

  it('starts on this page when the sizes already differ, so a resize cannot flatten the design', async () => {
    const ctx = await setupMany(true)
    engine = ctx.engine
    expect(screen.getByTestId('ed-scope-page')).toHaveAttribute('aria-pressed', 'true')
    // The fields show the size of the page in view (the second page).
    expect(screen.getByTestId('ed-canvas-width')).toHaveValue(300)
    expect(screen.getByTestId('ed-canvas-height')).toHaveValue(400)
    await userEvent.clear(screen.getByTestId('ed-canvas-width'))
    await userEvent.type(screen.getByTestId('ed-canvas-width'), '350')
    await userEvent.click(screen.getByTestId('ed-canvas-apply'))
    expect(ctx.resize).toHaveBeenCalledExactlyOnceWith(350, 400, 'scale', { scope: 'page', pageId: ctx.engine.state.activePageId })
  })

  it('marks the preset that matches the page in view', async () => {
    const ctx = await setupMany(true)
    engine = ctx.engine
    expect(screen.getByTestId('ed-preset-a4')).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByTestId('ed-scope-all'))
    await userEvent.click(screen.getByTestId('ed-preset-a4'))
    expect(ctx.resize).toHaveBeenCalledExactlyOnceWith(794, 1123, 'scale', { scope: 'all', pageId: ctx.engine.state.activePageId })
  })

  it('a design of one page has no scope choice', async () => {
    const ctx = await setup()
    engine = ctx.engine
    expect(screen.queryByTestId('ed-canvas-scope')).toBeNull()
  })
})
