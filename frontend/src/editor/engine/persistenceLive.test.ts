import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from './editor'
import { AUTOSAVE_DELAY_MS, isUseRealtime } from './persistence'

function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['thumb'], { type: 'image/webp' })))
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd1', title: 'Design', mode: 'account' }, ephemeral: true })
  engine.start()
  const states: string[] = []
  const callbacks = { onSaveStateChange: (s: { status: string }) => void states.push(s.status), onUseRealtime: vi.fn() }
  engine.persistence.start(callbacks)
  return { engine, handle, callbacks, states }
}

const delegate = () => ({ saveTitle: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) })

describe('persistence while a room holds the design', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not save the document, only a new title', async () => {
    const { engine, handle, states } = setup()
    const live = delegate()
    engine.persistence.setLive(live)
    engine.store.setState({ doc: { ...engine.state.doc, width: 900 } })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3)
    expect(handle.saves).toHaveLength(0)
    expect(states).toEqual([])
    expect(engine.persistence.isDirty()).toBe(false)
    engine.setTitle('Autumn')
    expect(engine.persistence.isDirty()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(live.saveTitle).toHaveBeenCalledWith('Autumn')
    expect(engine.persistence.isDirty()).toBe(false)
    engine.dispose()
  })

  it('does not send back a title that came from the server', async () => {
    const { engine } = setup()
    const live = delegate()
    engine.persistence.setLive(live)
    engine.persistence.adoptTitle('From elsewhere')
    engine.setTitle('From elsewhere')
    await vi.advanceTimersByTimeAsync(2000)
    expect(live.saveTitle).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('tells the user when the title could not be saved', async () => {
    const { engine } = setup()
    const live = { saveTitle: vi.fn(async () => Promise.reject(new Error('no'))), flush: vi.fn(async () => undefined) }
    engine.persistence.setLive(live)
    engine.setTitle('Nope')
    await vi.advanceTimersByTimeAsync(1000)
    expect(engine.state.toasts.some((x) => x.message.includes('title could not be saved'))).toBe(true)
    engine.dispose()
  })

  it('"Save now" asks the room to write the design', async () => {
    const { engine, handle } = setup()
    const live = delegate()
    engine.persistence.setLive(live)
    await engine.persistence.saveNow()
    expect(live.flush).toHaveBeenCalledTimes(1)
    expect(handle.saves).toHaveLength(0)
    engine.dispose()
  })

  it('saves normally again, with the changes made meanwhile, once the room is given up', async () => {
    const { engine, handle } = setup()
    engine.persistence.setLive(delegate())
    engine.store.setState({ doc: { ...engine.state.doc, width: 900 } })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(handle.saves).toHaveLength(0)
    engine.persistence.setLive(null)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 500)
    expect(handle.saves).toHaveLength(1)
    expect(handle.saves[0].document.width).toBe(900)
    engine.dispose()
  })

  it('joins the room when the server refuses a document save because it has one', async () => {
    const { engine, handle, callbacks } = setup()
    const refused = Object.assign(new Error('Use the live room.'), { code: 'use_realtime', status: 409 })
    vi.spyOn(handle.adapter, 'save').mockRejectedValueOnce(refused)
    engine.store.setState({ doc: { ...engine.state.doc, width: 900 } })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 500)
    expect(callbacks.onUseRealtime).toHaveBeenCalledTimes(1)
    expect(engine.state.save.status).toBe('dirty')
    engine.dispose()
  })

  it('keeps the thumbnail of the first page up to date for the owner, not too often, and never for others', async () => {
    const { engine } = setup()
    const saveThumbnail = vi.fn(async () => undefined)
    engine.persistence.setLive({ ...delegate(), saveThumbnail })
    const doc = engine.state.doc
    const second = { ...doc.pages[0], id: 'second' }
    engine.store.setState({ doc: { ...doc, pages: [doc.pages[0], second] } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saveThumbnail).not.toHaveBeenCalled()
    engine.store.setState({ doc: { ...engine.state.doc, pages: [{ ...engine.state.doc.pages[0], name: 'Cover' }, second] } })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(saveThumbnail).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(saveThumbnail).toHaveBeenCalledTimes(1)
    engine.store.setState({ doc: { ...engine.state.doc, pages: [{ ...engine.state.doc.pages[0], name: 'Cover 2' }, second] } })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(saveThumbnail).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saveThumbnail).toHaveBeenCalledTimes(2)
    engine.persistence.setLive(delegate())
    engine.store.setState({ doc: { ...engine.state.doc, pages: [{ ...engine.state.doc.pages[0], name: 'Cover 3' }, second] } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(saveThumbnail).toHaveBeenCalledTimes(2)
    engine.dispose()
  })

  it('recognises the refusal by its code', () => {
    expect(isUseRealtime(Object.assign(new Error('x'), { code: 'use_realtime' }))).toBe(true)
    expect(isUseRealtime(Object.assign(new Error('x'), { code: 'revision_conflict' }))).toBe(false)
    expect(isUseRealtime(null)).toBe(false)
    expect(isUseRealtime('use_realtime')).toBe(false)
  })
})
