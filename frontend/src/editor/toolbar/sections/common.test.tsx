import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorProvider } from '../../EditorProvider'
import { EditorEngine } from '../../engine/editor'
import { EMPTY_SELECTION } from '../../store/editorStore'
import { PositionPanel } from './common'

function mount(locked: boolean) {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
  const select = (isLocked: boolean): void =>
    engine.store.setState({ selection: { ...EMPTY_SELECTION, pageId: engine.state.doc.pages[0].id, ids: ['o'], kinds: ['shape'], bounds: { x: 10, y: 20, width: 100, height: 50, angle: 30 }, locked: isLocked, version: 1 } })
  select(locked)
  render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <PositionPanel />
    </EditorProvider>,
  )
  return { engine, select }
}

describe('PositionPanel', () => {
  it('lets an unlocked selection be turned', () => {
    const { engine } = mount(false)
    expect(screen.getByRole('textbox', { name: 'Rotation' })).toBeEnabled()
    engine.dispose()
  })

  it('freezes the angle of a locked selection, like the Rotate button, and releases it on unlock', () => {
    const { engine, select } = mount(true)
    expect(screen.getByRole('textbox', { name: 'Rotation' })).toBeDisabled()
    act(() => select(false))
    expect(screen.getByRole('textbox', { name: 'Rotation' })).toBeEnabled()
    engine.dispose()
  })
})
