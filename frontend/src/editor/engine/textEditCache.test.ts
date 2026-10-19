import type { IText } from 'fabric'
import { createBlankDocument } from '@/lib/document'
import type { DocObject } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from './editor'

/** A page of 60 rectangles and one text box, opened in a real engine on a jsdom canvas. */
async function crowdedPage() {
  const doc = createBlankDocument(800, 600)
  const rects: DocObject[] = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, type: 'rect', left: (i * 31) % 700, top: (i * 17) % 500, width: 40, height: 30, fill: '#c0392b' }))
  const text: DocObject = { id: 'text', type: 'textbox', left: 100, top: 100, width: 200, fontSize: 24, fontFamily: 'sans-serif', fill: '#111111', text: 'Hello' }
  doc.pages[0] = { ...doc.pages[0], objects: [...rects.slice(0, 30), text, ...rects.slice(30)] }
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd1', title: 'Test', mode: 'guest' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  const canvas = view.canvas
  const field = canvas.getObjects().find((o) => (o as { id?: string }).id === 'text') as IText
  return { engine, canvas, field }
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('typing on a crowded page', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('paints the other objects as two layers while the text is edited and goes back to normal painting afterwards', async () => {
    const { engine, canvas, field } = await crowdedPage()
    canvas.setActiveObject(field)
    field.enterEditing()
    await nextTick()
    // below the text, the text, above the text
    expect(canvas._objectsToRender).toHaveLength(3)
    expect(canvas._objectsToRender?.[1]).toBe(field)

    field.insertChars('!', undefined, field.selectionStart, field.selectionEnd)
    field.fire('changed')
    canvas.fire('text:changed', { target: field })
    expect(canvas._objectsToRender).toHaveLength(3)
    expect(field.text).toBe('!')

    field.exitEditing()
    expect(canvas._objectsToRender).toBeUndefined()
    engine.dispose()
  })

  it('shows what a collaborator changes meanwhile instead of the layers painted before', async () => {
    const { engine, canvas, field } = await crowdedPage()
    canvas.setActiveObject(field)
    field.enterEditing()
    await nextTick()
    expect(canvas._objectsToRender).toHaveLength(3)

    const page = engine.state.doc.pages[0]
    const moved = { ...page, objects: page.objects.map((o) => (o.id === 'r3' ? { ...o, left: 600 } : o)) }
    const view = engine.viewOf(page.id)
    await view?.syncRemote(moved)
    expect(canvas._objectsToRender).toBeUndefined()
    expect(canvas.getObjects().find((o) => (o as { id?: string }).id === 'r3')?.left).toBe(600)
    field.exitEditing()
    engine.dispose()
  })

  it('leaves small pages alone', async () => {
    const { engine, canvas, field } = await crowdedPage()
    for (const o of canvas.getObjects().filter((o) => o !== field)) canvas.remove(o)
    canvas.setActiveObject(field)
    field.enterEditing()
    await nextTick()
    // Fabric keeps its own list of what to paint; with no layers it is just the objects of the page.
    expect(canvas._objectsToRender?.length ?? canvas.getObjects().length).toBe(canvas.getObjects().length)
    field.exitEditing()
    engine.dispose()
  })
})
