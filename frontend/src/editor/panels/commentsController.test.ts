import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommentViewer } from '@/types/adapter'
import type { CommentInput, CommentMove, CommentT } from '@/types/api'
import { type CommentsService, CommentsController } from './commentsController'

const author = { id: 'u1', name: 'Alex Rivera', avatar_url: null }
const made = (id: string, over: Partial<CommentT> = {}): CommentT => ({ id, author, body: `body ${id}`, page_id: 'p1', x: 10, y: 20, parent: null, resolved: false, created_at: `2026-01-0${id.length}T00:00:0${id.length}Z`, ...over })

interface Fake {
  service: CommentsService
  list: ReturnType<typeof vi.fn<() => Promise<CommentT[]>>>
  create: ReturnType<typeof vi.fn<(input: CommentInput) => Promise<CommentT>>>
  resolve: ReturnType<typeof vi.fn<(id: string, resolved: boolean) => Promise<CommentT>>>
  remove: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
  move: ReturnType<typeof vi.fn<(id: string, to: CommentMove) => Promise<CommentT>>>
  viewer: ReturnType<typeof vi.fn<() => Promise<CommentViewer | null>>>
}

function fake(initial: CommentT[] = []): Fake {
  let rows = initial
  const list = vi.fn(async () => rows)
  const create = vi.fn(async (input: CommentInput) => {
    const row = made(`c${rows.length + 1}x`, { body: input.body, page_id: input.page_id ?? null, x: input.x ?? null, y: input.y ?? null, parent: input.parent ?? null })
    rows = [...rows, row]
    return row
  })
  const resolve = vi.fn(async (id: string, resolved: boolean) => {
    rows = rows.map((c) => (c.id === id ? { ...c, resolved } : c))
    return rows.find((c) => c.id === id) as CommentT
  })
  const remove = vi.fn(async (id: string) => {
    rows = rows.filter((c) => c.id !== id && c.parent !== id)
  })
  const move = vi.fn(async (id: string, to: CommentMove) => {
    rows = rows.map((c) => (c.id === id || c.parent === id ? { ...c, ...to } : c))
    return rows.find((c) => c.id === id) as CommentT
  })
  const viewer = vi.fn(async () => ({ id: 'u1', owner: true }) as CommentViewer | null)
  return { service: { list, create, resolve, remove, move, viewer }, list, create, resolve, remove, move, viewer }
}

const ready = async (rows: CommentT[] = [made('a', { created_at: '2026-01-01T00:00:00Z' }), made('b', { created_at: '2026-01-02T00:00:00Z' })]) => {
  const f = fake(rows)
  const controller = new CommentsController({ pollMs: 1000, isVisible: () => visible })
  controller.bind(f.service)
  await controller.refresh()
  return { f, controller }
}

let visible = true
beforeEach(() => {
  visible = true
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('loading', () => {
  it('goes idle → loading → ready with the list and who is looking', async () => {
    const f = fake([made('a')])
    const c = new CommentsController()
    c.bind(f.service)
    expect(c.getSnapshot().status).toBe('idle')
    const states: string[] = []
    c.subscribe(() => states.push(c.getSnapshot().status))
    await c.refresh()
    expect(states).toEqual(['loading', 'ready'])
    expect(c.getSnapshot().comments.map((x) => x.id)).toEqual(['a'])
    expect(c.getSnapshot().viewer).toEqual({ id: 'u1', owner: true })
  })

  it('reports a failed first load, and a later refresh recovers', async () => {
    const f = fake([made('a')])
    f.list.mockRejectedValueOnce(new Error('down'))
    const c = new CommentsController()
    c.bind(f.service)
    await c.refresh()
    expect(c.getSnapshot().status).toBe('error')
    await c.refresh()
    expect(c.getSnapshot().status).toBe('ready')
  })

  it('keeps what it has when a later refresh fails', async () => {
    const { f, controller } = await ready()
    f.list.mockRejectedValueOnce(new Error('down'))
    await controller.refresh()
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().comments).toHaveLength(2)
  })

  it('shares one request between concurrent refreshes', async () => {
    const f = fake([made('a')])
    const c = new CommentsController()
    c.bind(f.service)
    await Promise.all([c.refresh(), c.refresh(), c.refresh()])
    expect(f.list).toHaveBeenCalledTimes(1)
  })

  it('does not notify when a refresh found nothing new', async () => {
    const { controller } = await ready()
    const listener = vi.fn()
    controller.subscribe(listener)
    const before = controller.getSnapshot()
    await controller.refresh()
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toBe(before)
  })

  it('treats a failed viewer lookup as nobody (no rights beyond reading) and an adapter without one as unknown', async () => {
    const f = fake([made('a')])
    f.viewer.mockRejectedValueOnce(new Error('down'))
    const c = new CommentsController()
    c.bind(f.service)
    await c.refresh()
    expect(c.getSnapshot().viewer).toBeNull()

    const d = new CommentsController()
    d.bind({ list: async () => [], create: async () => made('x') })
    await d.refresh()
    expect(d.getSnapshot().viewer).toBeUndefined()
  })

  it('starts over when the adapter swaps the service', async () => {
    const { controller } = await ready()
    const other = fake([made('z')])
    controller.bind(other.service)
    expect(controller.getSnapshot().status).toBe('idle')
    await controller.refresh()
    expect(controller.getSnapshot().comments.map((x) => x.id)).toEqual(['z'])
  })

  it('is unavailable without a service', async () => {
    const c = new CommentsController()
    c.bind(null)
    expect(c.available).toBe(false)
    await expect(c.refresh()).resolves.toBeUndefined()
    await expect(c.create({ body: 'x' })).rejects.toThrow()
  })
})

describe('polling', () => {
  it('fetches at once, then every interval, only while watched', async () => {
    const f = fake([made('a')])
    const c = new CommentsController({ pollMs: 1000, isVisible: () => visible })
    c.bind(f.service)
    const stop = c.watch()
    await tick(0)
    expect(f.list).toHaveBeenCalledTimes(1)
    await tick(1000)
    expect(f.list).toHaveBeenCalledTimes(2)
    await tick(1000)
    expect(f.list).toHaveBeenCalledTimes(3)
    stop()
    await tick(5000)
    expect(f.list).toHaveBeenCalledTimes(3)
  })

  it('does not fetch twice for two watchers and stops when the last one leaves', async () => {
    const f = fake([made('a')])
    const c = new CommentsController({ pollMs: 1000, isVisible: () => visible })
    c.bind(f.service)
    const one = c.watch()
    const two = c.watch()
    await tick(0)
    expect(f.list).toHaveBeenCalledTimes(1)
    one()
    one()
    await tick(1000)
    expect(f.list).toHaveBeenCalledTimes(2)
    two()
    await tick(3000)
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('skips polls while the tab is hidden and catches up when it shows again', async () => {
    const f = fake([made('a')])
    const c = new CommentsController({ pollMs: 1000, isVisible: () => visible })
    c.bind(f.service)
    c.watch()
    await tick(0)
    visible = false
    await tick(3000)
    expect(f.list).toHaveBeenCalledTimes(1)
    visible = true
    document.dispatchEvent(new Event('visibilitychange'))
    await tick(0)
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('backs off after failures and goes back to the normal pace after a success', async () => {
    const f = fake([made('a')])
    const c = new CommentsController({ pollMs: 1000, isVisible: () => visible })
    c.bind(f.service)
    f.list.mockRejectedValue(new Error('down'))
    c.watch()
    await tick(0) // first attempt fails
    expect(f.list).toHaveBeenCalledTimes(1)
    await tick(1999) // next attempt after 2 s
    expect(f.list).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(f.list).toHaveBeenCalledTimes(2)
    f.list.mockResolvedValue([made('a')])
    await tick(4000) // third attempt after 4 s succeeds
    expect(f.list).toHaveBeenCalledTimes(3)
    await tick(1000) // back to 1 s
    expect(f.list).toHaveBeenCalledTimes(4)
  })

  it('picks up changes other people made', async () => {
    const f = fake([made('a')])
    const c = new CommentsController({ pollMs: 1000, isVisible: () => visible })
    c.bind(f.service)
    c.watch()
    await tick(0)
    f.list.mockResolvedValue([made('a'), made('b', { created_at: '2026-01-03T00:00:00Z' })])
    await tick(1000)
    expect(c.getSnapshot().comments.map((x) => x.id)).toEqual(['a', 'b'])
  })
})

describe('creating', () => {
  it('shows the comment at once, dimmed, and swaps in the server copy', async () => {
    const { f, controller } = await ready([])
    let release: (c: CommentT) => void = () => undefined
    f.create.mockImplementationOnce(() => new Promise<CommentT>((resolve) => (release = resolve)))
    const pending = controller.create({ body: 'Hello', page_id: 'p1', x: 5, y: 6 })
    const during = controller.getSnapshot()
    expect(during.comments).toHaveLength(1)
    expect(during.comments[0]).toMatchObject({ body: 'Hello', page_id: 'p1', x: 5, y: 6, resolved: false })
    expect(during.pending.has(during.comments[0].id)).toBe(true)
    release(made('real', { body: 'Hello', page_id: 'p1', x: 5, y: 6 }))
    await pending
    const after = controller.getSnapshot()
    expect(after.comments.map((x) => x.id)).toEqual(['real'])
    expect(after.pending.size).toBe(0)
  })

  it('takes the comment back when the server refuses, and tells the caller why', async () => {
    const { f, controller } = await ready([])
    const boom = new Error('429')
    f.create.mockRejectedValueOnce(boom)
    await expect(controller.create({ body: 'Hello' })).rejects.toBe(boom)
    expect(controller.getSnapshot().comments).toEqual([])
    expect(controller.getSnapshot().pending.size).toBe(0)
  })

  it('gives a reply the anchor of its thread', async () => {
    const { f, controller } = await ready([made('a', { page_id: 'p2', x: 7, y: 8 })])
    let release: (c: CommentT) => void = () => undefined
    f.create.mockImplementationOnce(() => new Promise<CommentT>((resolve) => (release = resolve)))
    const pending = controller.create({ body: 'Reply', parent: 'a' })
    expect(controller.getSnapshot().comments[1]).toMatchObject({ parent: 'a', page_id: 'p2', x: 7, y: 8 })
    release(made('r', { parent: 'a' }))
    await pending
  })
})

describe('resolving', () => {
  it('flips at once and keeps the server copy', async () => {
    const { f, controller } = await ready()
    const pending = controller.setResolved('a', true)
    expect(controller.find('a')?.resolved).toBe(true)
    await pending
    expect(f.resolve).toHaveBeenCalledWith('a', true)
    expect(controller.find('a')?.resolved).toBe(true)
  })

  it('rolls back when it fails', async () => {
    const { f, controller } = await ready()
    f.resolve.mockRejectedValueOnce(new Error('403'))
    await expect(controller.setResolved('a', true)).rejects.toThrow('403')
    expect(controller.find('a')?.resolved).toBe(false)
  })

  it('does nothing without a resolve service or for an unconfirmed comment', async () => {
    const c = new CommentsController()
    c.bind({ list: async () => [made('a')], create: async () => made('x') })
    await c.refresh()
    await c.setResolved('a', true)
    expect(c.find('a')?.resolved).toBe(false)
  })
})

describe('deleting', () => {
  it('removes a thread with its replies at once', async () => {
    const { f, controller } = await ready([made('a', { created_at: '2026-01-01T00:00:00Z' }), made('r', { parent: 'a', created_at: '2026-01-02T00:00:00Z' }), made('b', { created_at: '2026-01-03T00:00:00Z' })])
    const pending = controller.remove('a')
    expect(controller.getSnapshot().comments.map((x) => x.id)).toEqual(['b'])
    await pending
    expect(f.remove).toHaveBeenCalledWith('a')
  })

  it('puts the thread back in order when it fails', async () => {
    const { f, controller } = await ready([made('a', { created_at: '2026-01-01T00:00:00Z' }), made('r', { parent: 'a', created_at: '2026-01-02T00:00:00Z' }), made('b', { created_at: '2026-01-03T00:00:00Z' })])
    f.remove.mockRejectedValueOnce(new Error('500'))
    await expect(controller.remove('a')).rejects.toThrow('500')
    expect(controller.getSnapshot().comments.map((x) => x.id)).toEqual(['a', 'r', 'b'])
  })
})

describe('moving', () => {
  it('moves the thread and its replies, and keeps them there', async () => {
    const { f, controller } = await ready([made('a'), made('r', { parent: 'a' })])
    const to = { page_id: 'p2', x: 100, y: 200 }
    const pending = controller.move('a', to)
    expect(controller.getSnapshot().comments.map((c) => [c.page_id, c.x, c.y])).toEqual([['p2', 100, 200], ['p2', 100, 200]])
    await pending
    expect(f.move).toHaveBeenCalledWith('a', to)
  })

  it('puts the pin back when the move fails', async () => {
    const { f, controller } = await ready([made('a'), made('r', { parent: 'a' })])
    f.move.mockRejectedValueOnce(new Error('404'))
    await expect(controller.move('a', { page_id: 'p2', x: 1, y: 2 })).rejects.toThrow('404')
    expect(controller.getSnapshot().comments.map((c) => [c.page_id, c.x, c.y])).toEqual([['p1', 10, 20], ['p1', 10, 20]])
  })

  it('ignores replies', async () => {
    const { f, controller } = await ready([made('a'), made('r', { parent: 'a' })])
    await controller.move('r', { page_id: 'p2', x: 1, y: 2 })
    expect(f.move).not.toHaveBeenCalled()
  })
})

describe('a refresh that races with our own changes', () => {
  it('is dropped and fetched again, so a change in flight is not undone by an older list', async () => {
    const { f, controller } = await ready([made('a')])
    let release: () => void = () => undefined
    f.resolve.mockImplementationOnce(
      (id, resolved) =>
        new Promise<CommentT>((resolve) => {
          release = () => resolve(made(id, { resolved }))
        }),
    )
    const change = controller.setResolved('a', true)
    // The server has not applied our change yet: this list still says "open".
    await controller.refresh()
    expect(controller.find('a')?.resolved).toBe(true)
    f.list.mockResolvedValue([made('a', { resolved: true })])
    release()
    await change
    await tick(0)
    expect(controller.find('a')?.resolved).toBe(true)
    expect(f.list.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
