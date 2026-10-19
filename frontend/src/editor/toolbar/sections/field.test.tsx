import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorProvider } from '../../EditorProvider'
import { EditorEngine } from '../../engine/editor'
import { EMPTY_SELECTION } from '../../store/editorStore'
import { FieldPanel, OverflowSections } from './common'

function mount() {
  const doc = createBlankDocument(800, 600)
  doc.pages[0].objects.push({ id: 'other', type: 'textbox', field: { key: 'headline', type: 'text' } })
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
  engine.store.setState({ selection: { ...EMPTY_SELECTION, pageId: engine.state.doc.pages[0].id, ids: ['o'], kinds: ['text'], objects: [{ id: 'o', type: 'textbox' }], version: 1 } })
  render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <FieldPanel type="text" />
    </EditorProvider>,
  )
  return engine
}

describe('FieldPanel', () => {
  it('cleans typed keys and blocks a key already used on the page', () => {
    const engine = mount()
    const key = screen.getByRole('textbox', { name: 'Field key' })
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    fireEvent.change(key, { target: { value: 'Hero Title' } })
    expect(key).toHaveValue('hero_title')
    expect(apply).toBeEnabled()
    fireEvent.change(key, { target: { value: 'headline' } })
    expect(screen.getByRole('alert')).toHaveTextContent('already used')
    expect(apply).toBeDisabled()
    engine.dispose()
  })

  it('toggles shrink-to-fit and updates the minimum font size in OverflowSections', () => {
    const doc = createBlankDocument(800, 600)
    const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
    const spy = vi.spyOn(engine.style, 'setTextFit')
    engine.store.setState({
      selection: {
        ...EMPTY_SELECTION,
        pageId: doc.pages[0].id,
        ids: ['t1'],
        kinds: ['text'],
        objects: [{ id: 't1', type: 'textbox', fontSize: 40, fit: { mode: 'shrink' } }],
        version: 1,
      },
    })
    render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <OverflowSections />
      </EditorProvider>,
    )
    const toggle = screen.getByRole('switch', { name: 'Shrink to fit' })
    expect(toggle).toBeChecked()
    const minInput = screen.getByTestId('ed-fit-min-size')
    expect(minInput).toHaveValue(20)
    fireEvent.change(minInput, { target: { value: '16' } })
    expect(spy).toHaveBeenCalledWith({ mode: 'shrink', minFontSize: 16 }, 'fit-min')
    fireEvent.click(toggle)
    expect(spy).toHaveBeenCalledWith(null)
    engine.dispose()
  })
})
