import { afterEach, describe, expect, it } from 'vitest'
import { createCommentsRig, type CommentsRig } from '../panels/commentsTesting'
import { COMMENTS_UI_DEFAULT } from '../store/editorStore'
import { HOLD_MS, holdPlacement, takePlacement } from './commentPlacement'

let rig: CommentsRig | null = null
afterEach(() => {
  rig?.engine.dispose()
  rig = null
})

function editor(mode: boolean) {
  rig = createCommentsRig()
  rig.engine.store.setState({ comments: { ...COMMENTS_UI_DEFAULT, pins: true, mode } })
  return rig.engine
}

describe('a click held while the pins download', () => {
  it('goes to the page it was made on, once', () => {
    const e = editor(true)
    holdPlacement(e, 'page-2', { x: 12, y: 34 }, 1000)
    expect(takePlacement(e, 'page-1', 1000)).toBeNull()
    expect(takePlacement(e, 'page-2', 1000)).toMatchObject({ pageId: 'page-2', point: { x: 12, y: 34 } })
    expect(takePlacement(e, 'page-2', 1000)).toBeNull()
  })

  it('keeps a click made with the keyboard (no point: the middle of the page)', () => {
    const e = editor(true)
    holdPlacement(e, 'page-1', null, 1000)
    expect(takePlacement(e, 'page-1', 1000)).toMatchObject({ point: null })
  })

  it('is dropped when comment mode was left meanwhile, or when it is too old to be what the person meant', () => {
    const off = editor(false)
    holdPlacement(off, 'page-1', { x: 1, y: 2 }, 1000)
    expect(takePlacement(off, 'page-1', 1000)).toBeNull()

    const on = editor(true)
    holdPlacement(on, 'page-1', { x: 1, y: 2 }, 1000)
    expect(takePlacement(on, 'page-1', 1000 + HOLD_MS + 1)).toBeNull()
  })

  it('is per editor', () => {
    const first = editor(true)
    const firstRig = rig
    const second = createCommentsRig()
    second.engine.store.setState({ comments: { ...COMMENTS_UI_DEFAULT, pins: true, mode: true } })
    holdPlacement(first, 'page-1', { x: 5, y: 6 }, 1000)
    expect(takePlacement(second.engine, 'page-1', 1000)).toBeNull()
    expect(takePlacement(first, 'page-1', 1000)).not.toBeNull()
    second.engine.dispose()
    rig = firstRig
  })
})
