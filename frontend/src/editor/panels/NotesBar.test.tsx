import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
import { NOTES_MAX_LENGTH } from '../presenter/timing'
import { t } from '../strings'
import { NotesHost } from './NotesBar'
import { isNotesOpen, setNotesOpen, toggleNotes } from './notesVisibility'

function setup(mode: 'guest' | 'shared-view' = 'guest', patch: (doc: DoryDocument) => void = () => undefined) {
  const doc = createBlankDocument(800, 600)
  doc.pages.push({ ...doc.pages[0], id: 'second', name: 'Second', objects: [] })
  patch(doc)
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd', title: 'T', mode }, ephemeral: true })
  const ids = engine.state.doc.pages.map((p) => p.id)
  render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <NotesHost />
    </EditorProvider>,
  )
  return { engine, ids }
}

describe('NotesBar', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    engine?.dispose()
    engine = null
  })

  it('renders nothing until it is switched on, and remembers the choice', () => {
    const ctx = setup()
    engine = ctx.engine
    expect(screen.queryByTestId('ed-notes')).toBeNull()
    expect(isNotesOpen(ctx.engine)).toBe(false)
    act(() => setNotesOpen(ctx.engine, true))
    expect(screen.getByTestId('ed-notes')).toBeInTheDocument()
    expect(localStorage.getItem('doory.editor.notes.v1')).toBe('1')
    act(() => toggleNotes(ctx.engine))
    expect(screen.queryByTestId('ed-notes')).toBeNull()
    expect(localStorage.getItem('doory.editor.notes.v1')).toBe('0')
  })

  it('works when storage refuses to write', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const ctx = setup()
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    expect(screen.getByTestId('ed-notes')).toBeInTheDocument()
    spy.mockRestore()
  })

  it('shows the notes of the active page with a counter and an accessible name', () => {
    const ctx = setup('guest', (doc) => {
      doc.pages[0].notes = 'Hello there'
    })
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    const field = screen.getByRole('textbox', { name: t.notes.forPage('Page 1') })
    expect(field).toHaveValue('Hello there')
    expect(field).toHaveAttribute('maxlength', String(NOTES_MAX_LENGTH))
    expect(screen.getByTestId('ed-notes-counter')).toHaveTextContent('11 / 5000')
  })

  it('writes typing into the document after a short pause, as one undo step', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    await user.click(screen.getByTestId('ed-notes-text'))
    await user.keyboard('Hi!')
    expect(ctx.engine.state.doc.pages[0].notes).toBeUndefined()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(ctx.engine.state.doc.pages[0].notes).toBe('Hi!')
    expect(screen.getByTestId('ed-notes-counter')).toHaveTextContent('3 / 5000')
    await act(async () => {
      await ctx.engine.undo()
    })
    expect(ctx.engine.state.doc.pages[0].notes).toBeUndefined()
  })

  it('writes what is still waiting when the field loses focus or the page changes', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    await user.click(screen.getByTestId('ed-notes-text'))
    await user.keyboard('Now')
    await user.tab()
    expect(ctx.engine.state.doc.pages[0].notes).toBe('Now')
    await user.click(screen.getByTestId('ed-notes-text'))
    await user.keyboard(' more')
    act(() => ctx.engine.setActivePage(ctx.ids[1]))
    expect(ctx.engine.state.doc.pages[0].notes).toBe('Now more')
    expect(screen.getByTestId('ed-notes-page')).toHaveTextContent('Second')
    expect(screen.getByTestId('ed-notes-text')).toHaveValue('')
  })

  it('adopts a change that arrives from elsewhere, but not over typing that is still waiting', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    act(() => ctx.engine.pages.setNotes(ctx.ids[0], 'From a collaborator'))
    expect(screen.getByTestId('ed-notes-text')).toHaveValue('From a collaborator')
    await user.click(screen.getByTestId('ed-notes-text'))
    await user.keyboard('!')
    act(() => ctx.engine.pages.setNotes(ctx.ids[0], 'Another remote edit'))
    expect(screen.getByTestId('ed-notes-text')).toHaveValue('From a collaborator!')
    await waitFor(() => expect(ctx.engine.state.doc.pages[0].notes).toBe('From a collaborator!'))
  })

  it('warns at the limit and never stores more than the limit', async () => {
    const ctx = setup()
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    const field = screen.getByTestId('ed-notes-text')
    await userEvent.click(field)
    await userEvent.paste('y'.repeat(NOTES_MAX_LENGTH + 10))
    await userEvent.tab()
    expect(ctx.engine.state.doc.pages[0].notes).toHaveLength(NOTES_MAX_LENGTH)
    expect(screen.getByTestId('ed-notes-counter')).toHaveAttribute('data-full', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(t.notes.limit(NOTES_MAX_LENGTH))
  })

  it('closes with its button', async () => {
    const ctx = setup()
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    await userEvent.click(screen.getByRole('button', { name: t.notes.close }))
    expect(screen.queryByTestId('ed-notes')).toBeNull()
  })
})

describe('NotesBar in a view-only link', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    engine?.dispose()
    engine = null
  })

  it('shows the notes read-only', async () => {
    const ctx = setup('shared-view', (doc) => {
      doc.pages[0].notes = 'Read me'
    })
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    const field = screen.getByRole('textbox')
    expect(field).toHaveValue('Read me')
    expect(field).toHaveAttribute('readonly')
    expect(screen.getByText(t.notes.viewOnly)).toBeInTheDocument()
    await userEvent.type(field, 'x')
    expect(field).toHaveValue('Read me')
    ctx.engine.pages.setNotes(ctx.ids[0], 'sneaky')
    expect(ctx.engine.state.doc.pages[0].notes).toBe('Read me')
  })

  it('says so when the page has no notes, instead of an empty field', () => {
    const ctx = setup('shared-view')
    engine = ctx.engine
    act(() => setNotesOpen(ctx.engine, true))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('ed-notes-empty')).toHaveTextContent(t.notes.empty)
  })
})
