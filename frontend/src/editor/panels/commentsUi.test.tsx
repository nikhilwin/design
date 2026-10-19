import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CommentsRig, createCommentsRig } from './commentsTesting'
import { buildThreads } from './commentOps'
import { commentsOf } from './commentsController'
import { setCommentMode, setCommentPins } from './commentsMode'
import { cancelDraft, ensureCommenter, openThread, revealThread, setDraftBody, startDraft } from './commentsUi'

let rig: CommentsRig | null = null
afterEach(() => {
  rig?.engine.dispose()
  rig = null
})
const make = (options: Parameters<typeof createCommentsRig>[0] = {}): CommentsRig => {
  rig = createCommentsRig(options)
  return rig
}

describe('the state of the pins in the editor store', () => {
  it('starts with nothing on', () => {
    const { engine } = make()
    expect(engine.state.comments).toEqual({ mode: false, pins: false, filter: 'all', activeThreadId: null, draft: null, reveal: null })
  })

  it('comment mode implies pins, announces itself and takes the comment being written with it when it ends', () => {
    const { engine } = make()
    setCommentMode(engine, true)
    expect(engine.state.comments).toMatchObject({ mode: true, pins: true })
    expect(engine.state.announcement).toMatch(/Comment mode on/)
    startDraft(engine, 'page-1', 10, 20)
    setCommentMode(engine, false)
    expect(engine.state.comments).toMatchObject({ mode: false, pins: true, draft: null })
    expect(engine.state.announcement).toBe('Comment mode off')
  })

  it('hiding the pins ends comment mode and closes what is open', () => {
    const { engine } = make()
    setCommentMode(engine, true)
    openThread(engine, 't1')
    setCommentPins(engine, false)
    expect(engine.state.comments).toMatchObject({ mode: false, pins: false, activeThreadId: null, draft: null })
  })

  it('opens one thread at a time, and opening one closes the comment being written', () => {
    const { engine } = make()
    startDraft(engine, 'page-1', 1, 2)
    openThread(engine, 't1')
    expect(engine.state.comments).toMatchObject({ activeThreadId: 't1', draft: null })
    startDraft(engine, 'page-1', 3, 4)
    expect(engine.state.comments).toMatchObject({ activeThreadId: null, draft: { x: 3, y: 4 } })
    openThread(engine, null)
    expect(engine.state.comments.activeThreadId).toBeNull()
  })

  it('keeps the text of a comment when its spot changes, and drops it with the comment', () => {
    const { engine } = make()
    startDraft(engine, 'page-1', 1, 2)
    setDraftBody(engine, 'half way')
    startDraft(engine, 'page-2', 30, 40)
    expect(engine.state.comments.draft).toEqual({ pageId: 'page-2', x: 30, y: 40, body: 'half way' })
    cancelDraft(engine)
    expect(engine.state.comments.draft).toBeNull()
    setDraftBody(engine, 'nothing to attach to')
    expect(engine.state.comments.draft).toBeNull()
  })

  it('reveals a pinned thread by opening it, asking for the scroll and counting the request; other threads are not revealed', () => {
    const { engine } = make()
    const scrolled: [string, ScrollBehavior | undefined][] = []
    engine.view.setController({ scrollToPage: (id, behavior) => scrolled.push([id, behavior]), viewportSize: () => ({ width: 1, height: 1 }), relayout: () => undefined, artboardRect: () => null })
    const [pinned, general] = buildThreads(
      [
        { id: 'a', author: { id: 'u', name: 'U', avatar_url: null }, body: 'x', page_id: 'page-2', x: 1, y: 2, parent: null, resolved: false, created_at: '2026-01-01T00:00:00Z' },
        { id: 'b', author: { id: 'u', name: 'U', avatar_url: null }, body: 'y', page_id: null, x: null, y: null, parent: null, resolved: false, created_at: '2026-01-02T00:00:00Z' },
      ],
      new Set(['page-1', 'page-2']),
    )
    revealThread(engine, pinned)
    revealThread(engine, pinned, true)
    expect(engine.state.comments.reveal).toEqual({ id: 'a', nonce: 2, focus: true })
    expect(engine.state.comments.activeThreadId).toBe('a')
    expect(scrolled).toEqual([['page-2', 'auto'], ['page-2', 'auto']])
    revealThread(engine, general)
    expect(engine.state.comments.activeThreadId).toBe('a')
  })
})

describe('being allowed to comment', () => {
  it('is a yes for the owner and for adapters that do not say who looks, without asking anybody', async () => {
    const r = make()
    const controller = commentsOf(r.engine)
    await controller.refresh()
    expect(await ensureCommenter(r.engine, controller)).toBe(true)
    expect(r.handle.accountRequests).toEqual([])
  })

  it('sends a visitor who is not signed in through the sign-up, and goes on once they are', async () => {
    const r = make({ role: 'anonymous', mode: 'shared-comment' })
    const controller = commentsOf(r.engine)
    await controller.refresh()
    expect(controller.getSnapshot().viewer).toBeNull()
    expect(await ensureCommenter(r.engine, controller)).toBe(true)
    expect(r.handle.accountRequests).toEqual(['comment'])
    expect(controller.getSnapshot().viewer).toMatchObject({ owner: false })
  })

  it('stops when the visitor does not come out signed in', async () => {
    const r = make({ role: 'anonymous', mode: 'shared-comment' })
    const controller = commentsOf(r.engine)
    await controller.refresh()
    vi.spyOn(r.engine.adapter, 'requireAccount').mockResolvedValue(false)
    expect(await ensureCommenter(r.engine, controller)).toBe(false)
  })
})

describe('the controller of an editor', () => {
  it('is one per editor, and follows the adapter when it is swapped', async () => {
    const r = make()
    const first = commentsOf(r.engine)
    expect(commentsOf(r.engine)).toBe(first)
    await first.refresh()
    expect(first.getSnapshot().status).toBe('ready')
    const other = createCommentsRig({ seed: null })
    r.engine.setAdapter(other.handle.adapter)
    expect(commentsOf(r.engine)).toBe(first)
    expect(first.getSnapshot().status).toBe('idle')
    await first.refresh()
    expect(first.getSnapshot().comments).toEqual([])
    other.engine.dispose()
  })

  it('does not exist for an adapter without comments', () => {
    const r = make()
    ;(r.engine.adapter.services as { comments: unknown }).comments = null
    expect(commentsOf(r.engine).available).toBe(false)
  })
})

describe('useDevicePixelRatio', () => {
  it('re-reads the ratio when the browser says it changed, and asks again for the new one', async () => {
    const { useDevicePixelRatio } = await import('../workspace/useDevicePixelRatio')
    const listeners: (() => void)[] = []
    const queries: string[] = []
    vi.stubGlobal('matchMedia', (query: string) => {
      queries.push(query)
      return {
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
      }
    })
    let ratio = 1
    vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => ratio)
    try {
      const { result, unmount } = renderHook(() => useDevicePixelRatio())
      expect(result.current).toBe(1)
      expect(queries).toEqual(['(resolution: 1dppx)'])
      ratio = 2
      act(() => listeners.forEach((fn) => fn()))
      expect(result.current).toBe(2)
      expect(queries).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)'])
      unmount()
      expect(listeners).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})
