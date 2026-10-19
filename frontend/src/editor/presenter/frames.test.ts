import { describe, expect, it, vi } from 'vitest'
import type { DocPage } from '@/types/document'
import { FrameCache, type RenderFrame } from './frames'

const page = (id: string): DocPage => ({ id, background: { type: 'solid', color: '#ffffff' }, objects: [] })
const canvas = (width: number, height: number): HTMLCanvasElement => Object.assign(document.createElement('canvas'), { width, height })

function setup(limits?: { entries: number; pixels: number }) {
  const calls: { id: string; multiplier: number }[] = []
  const resolvers: (() => void)[] = []
  const render: RenderFrame = (p, size, multiplier) => {
    calls.push({ id: p.id, multiplier })
    return new Promise((resolve) => resolvers.push(() => resolve(canvas(Math.round(size.width * multiplier), Math.round(size.height * multiplier)))))
  }
  const cache = new FrameCache(render, () => ({ width: 1000, height: 500 }), limits)
  const settle = async (): Promise<void> => {
    while (resolvers.length) resolvers.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { cache, calls, settle }
}

describe('FrameCache', () => {
  it('renders at the multiplier that gives the requested width', async () => {
    const { cache, calls, settle } = setup()
    const a = page('a')
    const p = cache.get(a, 2000)
    await settle()
    const c = await p
    expect(calls).toEqual([{ id: 'a', multiplier: 2 }])
    expect(c.width).toBe(2000)
    expect(c.height).toBe(1000)
  })

  it('shares one render between concurrent requests and serves later ones from memory', async () => {
    const { cache, calls, settle } = setup()
    const a = page('a')
    const first = cache.get(a, 800)
    const second = cache.get(a, 800)
    await settle()
    expect(await first).toBe(await second)
    expect(cache.peek(a, 800)).toBe(await first)
    await cache.get(a, 800)
    expect(calls).toHaveLength(1)
  })

  it('keeps a separate bitmap per size and re-renders a page that changed', async () => {
    const { cache, calls, settle } = setup()
    const a = page('a')
    void cache.get(a, 800)
    void cache.get(a, 1600)
    await settle()
    expect(calls).toHaveLength(2)
    const edited = { ...a }
    expect(cache.peek(edited, 800)).toBeNull()
    void cache.get(edited, 800)
    await settle()
    expect(calls).toHaveLength(3)
  })

  it('drops the least recently used bitmap beyond the entry limit', async () => {
    const { cache, settle } = setup({ entries: 2, pixels: Number.POSITIVE_INFINITY })
    const [a, b, c] = [page('a'), page('b'), page('c')]
    void cache.get(a, 100)
    void cache.get(b, 100)
    await settle()
    expect(cache.peek(a, 100)).not.toBeNull() // a is now more recent than b
    void cache.get(c, 100)
    await settle()
    expect(cache.peek(b, 100)).toBeNull()
    expect(cache.peek(a, 100)).not.toBeNull()
    expect(cache.peek(c, 100)).not.toBeNull()
  })

  it('drops bitmaps beyond the pixel budget but always keeps the newest', async () => {
    const { cache, settle } = setup({ entries: 10, pixels: 150_000 })
    const [a, b] = [page('a'), page('b')]
    void cache.get(a, 400) // 400 x 200 = 80,000
    await settle()
    void cache.get(b, 400)
    await settle()
    expect(cache.peek(a, 400)).toBeNull()
    expect(cache.peek(b, 400)).not.toBeNull()
    const tiny = setup({ entries: 10, pixels: 10 })
    void tiny.cache.get(a, 400)
    await tiny.settle()
    expect(tiny.cache.peek(a, 400)).not.toBeNull()
  })

  it('does not keep a render that finishes after clear()', async () => {
    const { cache, settle } = setup()
    const a = page('a')
    const p = cache.get(a, 500)
    cache.clear()
    await settle()
    await p
    expect(cache.peek(a, 500)).toBeNull()
  })

  it('forgets a failed render so the next request tries again', async () => {
    let fail = true
    const render = vi.fn<RenderFrame>(() => (fail ? Promise.reject(new Error('font')) : Promise.resolve(canvas(10, 10))))
    const cache = new FrameCache(render, () => ({ width: 10, height: 10 }))
    const a = page('a')
    await expect(cache.get(a, 10)).rejects.toThrow('font')
    fail = false
    await expect(cache.get(a, 10)).resolves.toBeTruthy()
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('prefetch swallows failures', async () => {
    const cache = new FrameCache(() => Promise.reject(new Error('x')), () => ({ width: 10, height: 10 }))
    cache.prefetch(page('a'), 10)
    cache.prefetch(undefined, 10)
    await Promise.resolve()
  })
})
