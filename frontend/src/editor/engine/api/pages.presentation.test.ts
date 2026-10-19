import { createBlankDocument } from '@/lib/document'
import type { DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { NOTES_MAX_LENGTH } from '../../presenter/timing'
import { EditorEngine } from '../editor'

function setup(mode: 'guest' | 'shared-view' | 'shared-comment' = 'guest', pages = 3) {
  const doc: DoryDocument = createBlankDocument(800, 600)
  while (doc.pages.length < pages) doc.pages.push({ ...doc.pages[0], id: `p${doc.pages.length + 1}`, objects: [] })
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd1', title: 'Test', mode }, ephemeral: true })
  return { engine, ids: engine.state.doc.pages.map((p) => p.id) }
}

describe('pages.setNotes', () => {
  it('writes the notes of one page into the document and onto the undo stack', () => {
    const { engine, ids } = setup()
    engine.pages.setNotes(ids[1], 'Pause here')
    expect(engine.state.doc.pages[1].notes).toBe('Pause here')
    expect(engine.state.doc.pages[0].notes).toBeUndefined()
    expect(engine.state.history.undoLabel).toBe('Edit notes')
    void engine.undo()
    expect(engine.state.doc.pages[1].notes).toBeUndefined()
  })

  it('coalesces a typing burst into one undo step', () => {
    const { engine, ids } = setup()
    for (const text of ['H', 'He', 'Hel', 'Hell', 'Hello']) engine.pages.setNotes(ids[0], text)
    expect(engine.state.doc.pages[0].notes).toBe('Hello')
    void engine.undo()
    expect(engine.state.doc.pages[0].notes).toBeUndefined()
    expect(engine.state.history.canUndo).toBe(false)
  })

  it('removes the property when the text is emptied, and caps overlong text', () => {
    const { engine, ids } = setup()
    engine.pages.setNotes(ids[0], 'x'.repeat(NOTES_MAX_LENGTH + 100))
    expect(engine.state.doc.pages[0].notes).toHaveLength(NOTES_MAX_LENGTH)
    engine.pages.setNotes(ids[0], '')
    expect('notes' in engine.state.doc.pages[0]).toBe(false)
  })

  it('does nothing in view-only and comment-only editors', () => {
    for (const mode of ['shared-view', 'shared-comment'] as const) {
      const { engine, ids } = setup(mode)
      const before = engine.state.doc
      engine.pages.setNotes(ids[0], 'nope')
      engine.pages.setDuration(ids[0], 9)
      engine.pages.setDurationAll(9)
      expect(engine.state.doc).toBe(before)
    }
  })
})

describe('pages.setDuration and setDurationAll', () => {
  it('sets one page and clamps to 1-600', () => {
    const { engine, ids } = setup()
    engine.pages.setDuration(ids[1], 12)
    expect(engine.state.doc.pages.map((p) => p.durationSec)).toEqual([undefined, 12, undefined])
    engine.pages.setDuration(ids[1], 5000)
    expect(engine.state.doc.pages[1].durationSec).toBe(600)
    engine.pages.setDuration(ids[1], 0)
    expect(engine.state.doc.pages[1].durationSec).toBe(1)
  })

  it('removes the time with null and ignores NaN', () => {
    const { engine, ids } = setup()
    engine.pages.setDuration(ids[0], 8)
    engine.pages.setDuration(ids[0], Number.NaN)
    expect(engine.state.doc.pages[0].durationSec).toBe(8)
    engine.pages.setDuration(ids[0], null)
    expect('durationSec' in engine.state.doc.pages[0]).toBe(false)
  })

  it('stepping one page coalesces; applying to all pages is its own undo step', () => {
    const { engine, ids } = setup()
    engine.pages.setDuration(ids[0], 6)
    engine.pages.setDuration(ids[0], 7)
    engine.pages.setDuration(ids[0], 8)
    engine.pages.setDurationAll(8)
    expect(engine.state.doc.pages.map((p) => p.durationSec)).toEqual([8, 8, 8])
    void engine.undo()
    expect(engine.state.doc.pages.map((p) => p.durationSec)).toEqual([8, undefined, undefined])
    void engine.undo()
    expect(engine.state.doc.pages.map((p) => p.durationSec)).toEqual([undefined, undefined, undefined])
  })

  it('clears every page with setDurationAll(null)', () => {
    const { engine } = setup()
    engine.pages.setDurationAll(4)
    engine.pages.setDurationAll(null)
    expect(engine.state.doc.pages.some((p) => 'durationSec' in p)).toBe(false)
  })
})
