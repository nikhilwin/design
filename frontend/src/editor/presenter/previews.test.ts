import { describe, expect, it } from 'vitest'
import type { DocPage, DoryDocument } from '@/types/document'
import { parseMessage } from './channel'
import { initialState } from './machine'
import { previewsOf } from './useViewHost'

const page = (id: string, extra: Partial<DocPage> = {}): DocPage => ({ id, background: { type: 'solid', color: '#ffffff' }, objects: [], ...extra })
const docOf = (...pages: DocPage[]): DoryDocument => ({ schemaVersion: 1, width: 1920, height: 1080, unit: 'px', pages })

describe('previewsOf', () => {
  it('describes each page by its own size, name, notes and resolved time', () => {
    const doc = docOf(page('a', { name: ' Intro ', notes: 'Hello' }), page('b', { width: 1080, height: 1080 }), page('c', { width: 1080, height: 1920 }))
    expect(previewsOf(doc, [3, null, 8])).toEqual([
      { id: 'a', name: 'Intro', notes: 'Hello', durationSec: 3, width: 1920, height: 1080 },
      { id: 'b', name: '', notes: '', durationSec: null, width: 1080, height: 1080 },
      { id: 'c', name: '', notes: '', durationSec: 8, width: 1080, height: 1920 },
    ])
  })

  it('cuts what a hand-made document holds to what the channel carries, so one odd page cannot stop the view', () => {
    const doc = docOf(page('a', { name: 'n'.repeat(500), notes: 'x'.repeat(9000), width: 99_999, height: 30_000 }), page('b'))
    const previews = previewsOf(doc, [null, null])
    expect(previews[0].name).toHaveLength(200)
    expect(previews[0].notes).toHaveLength(5000)
    expect(previews[0].width).toBe(20_000)
    expect(previews[0].height).toBe(20_000)
    const message = { v: 1, from: 'show', kind: 'init', title: 'T', theme: null, pages: previews, state: initialState({ count: 2, durations: [null, null] }) }
    expect(parseMessage(message, 'view')).not.toBeNull()
  })

  it('treats notes that are not text as no notes', () => {
    const doc = docOf(page('a', { notes: 5 as unknown as string }))
    expect(previewsOf(doc, [null])[0].notes).toBe('')
  })
})
