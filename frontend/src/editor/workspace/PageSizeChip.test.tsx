import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
import { PageSizeChip } from './PageSizeChip'

function setup(mode: 'guest' | 'shared-view' = 'guest') {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(1080, 1920), meta: { id: 'd', title: 'T', mode }, ephemeral: true })
  engine.pages.add(1, { width: 336, height: 192 })
  const [first, second] = engine.state.doc.pages
  render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <PageSizeChip pageId={second.id} number={2} />
      <PageSizeChip pageId={first.id} number={1} />
    </EditorProvider>,
  )
  return { engine, first, second }
}

describe('PageSizeChip', () => {
  let engine: EditorEngine | null = null
  afterEach(() => engine?.dispose())

  it('shows the size of its own page in the unit of the design', () => {
    const ctx = setup()
    engine = ctx.engine
    const chips = screen.getAllByTestId('ed-page-size')
    expect(chips[0]).toHaveTextContent('336 × 192 px')
    expect(chips[1]).toHaveTextContent('1080 × 1920 px')
    expect(chips[0]).toHaveAccessibleName('Page 2 is 336 × 192 px. Change its size')
  })

  it('follows the page when its size changes', async () => {
    const ctx = setup()
    engine = ctx.engine
    act(() => ctx.engine.pages.setSize(ctx.second.id, 500, 400, 'keep'))
    expect(await screen.findByText('500 × 400 px')).toBeInTheDocument()
  })

  it('opens the size menu of that page, starting on "this page", and applies to that page only', async () => {
    const ctx = setup()
    engine = ctx.engine
    await userEvent.click(screen.getAllByTestId('ed-page-size')[0])
    const pop = await screen.findByTestId('ed-canvas-size-pop')
    expect(pop).toHaveAttribute('data-page-id', ctx.second.id)
    expect(screen.getByTestId('ed-scope-page')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('ed-flip-canvas-h')).toBeNull()
    expect(screen.getByTestId('ed-canvas-width')).toHaveValue(336)
    await userEvent.click(screen.getByTestId('ed-preset-a5'))
    const sizes = ctx.engine.state.doc.pages.map((p) => ctx.engine.pageSizeOf(p.id))
    expect(sizes[0]).toEqual({ width: 1080, height: 1920 })
    expect(sizes[1]).toEqual({ width: 559, height: 794 })
  })

  it('is plain text in a view-only link', () => {
    const ctx = setup('shared-view')
    engine = ctx.engine
    expect(screen.getAllByTestId('ed-page-size')[0].tagName).toBe('SPAN')
    expect(screen.queryByRole('button', { name: /Change its size/ })).toBeNull()
  })
})
