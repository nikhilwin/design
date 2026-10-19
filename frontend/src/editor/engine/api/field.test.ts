import { IText } from 'fabric'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { DocObject } from '@/types/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorEngine } from '../editor'

async function setup() {
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: createBlankDocument(800, 600), meta: { id: 'd1', title: 'Test', mode: 'guest' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  return engine
}

const objects = (engine: EditorEngine): DocObject[] => engine.state.doc.pages[0].objects

describe('template field tags', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['thumb'], { type: 'image/webp' })))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('tags the selected object, ignores invalid keys and clears the tag', async () => {
    const engine = await setup()
    await engine.insert.shape('rect')
    engine.style.setField({ key: 'Bad Key', type: 'color' })
    expect(objects(engine)[0].field).toBeUndefined()
    engine.style.setField({ key: 'accent', type: 'color', label: 'Accent' })
    expect(objects(engine)[0].field).toEqual({ key: 'accent', type: 'color', label: 'Accent' })
    engine.style.setField(null)
    expect(objects(engine)[0].field).toBeUndefined()
    engine.dispose()
  })

  it('does not copy the tag to a duplicate', async () => {
    const engine = await setup()
    await engine.insert.shape('rect')
    engine.style.setField({ key: 'accent', type: 'color' })
    await engine.arrange.duplicate()
    expect(objects(engine)).toHaveLength(2)
    expect(objects(engine)[0].field).toEqual({ key: 'accent', type: 'color' })
    expect(objects(engine)[1].field).toBeUndefined()
    engine.dispose()
  })

  it('shrinks text to fit without growing the box and restores fontSize when turned off', async () => {
    const engine = await setup()
    await engine.insert.text('heading')
    engine.stopEditingText()
    const initial = objects(engine)[0]
    const boxHeight = Number(initial.height)
    const userSize = Number(initial.fontSize)
    engine.style.setTextFit({ mode: 'shrink', minFontSize: 18 })
    const live = engine.selectedObjects()[0] as IText
    live.set('text', 'Autumn Harvest Festival Tickets Available Online All Week Long')
    engine.style.text({ lineHeight: 1.16 })
    const fitted = objects(engine)[0]
    expect(fitted.height).toBeCloseTo(boxHeight, 3)
    expect(fitted.fontSize).toBe(userSize)
    expect(fitted.fit).toEqual({ mode: 'shrink', minFontSize: 18 })
    expect(Number(fitted.fitFontSize)).toBeLessThan(userSize)
    expect(Number(fitted.fitFontSize)).toBeGreaterThanOrEqual(18)
    expect(live.fontSize).toBe(fitted.fitFontSize)
    expect(live.height).toBeCloseTo(boxHeight, 3)

    engine.style.setTextFit(null)
    const unfitted = objects(engine)[0]
    expect(unfitted.fit).toBeUndefined()
    expect(unfitted.fitFontSize).toBeUndefined()
    expect(live.fontSize).toBe(userSize)
    expect(Number(unfitted.height)).toBeGreaterThan(boxHeight)
    engine.dispose()
  })
})
