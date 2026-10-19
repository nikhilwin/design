import { History } from './history'

function make(limit = 200) {
  let t = 1000
  const h = new History<number>(0, { limit, coalesceMs: 500, now: () => t })
  return { h, tick: (ms: number) => (t += ms) }
}

describe('History', () => {
  it('undoes and redoes in order', () => {
    const { h } = make()
    h.push(1, { label: 'a' })
    h.push(2, { label: 'b' })
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe(1)
    expect(h.redo()).toBe(2)
    expect(h.redo()).toBeNull()
  })

  it('drops the redo branch when pushing after an undo', () => {
    const { h } = make()
    h.push(1, { label: 'a' })
    h.push(2, { label: 'b' })
    h.undo()
    h.push(9, { label: 'c' })
    expect(h.canRedo).toBe(false)
    expect(h.current).toBe(9)
    expect(h.undo()).toBe(1)
  })

  it('coalesces pushes with the same key inside the window', () => {
    const { h, tick } = make()
    h.push(1, { label: 'move', coalesceKey: 'drag' })
    tick(100)
    h.push(2, { label: 'move', coalesceKey: 'drag' })
    tick(100)
    h.push(3, { label: 'move', coalesceKey: 'drag' })
    expect(h.depth).toBe(1)
    expect(h.undo()).toBe(0)
  })

  it('does not coalesce across the time window or different keys', () => {
    const { h, tick } = make()
    h.push(1, { label: 'a', coalesceKey: 'k' })
    tick(900)
    h.push(2, { label: 'a', coalesceKey: 'k' })
    h.push(3, { label: 'b', coalesceKey: 'other' })
    expect(h.depth).toBe(3)
  })

  it('seal() ends a coalescing run', () => {
    const { h } = make()
    h.push(1, { label: 'a', coalesceKey: 'k' })
    h.seal()
    h.push(2, { label: 'a', coalesceKey: 'k' })
    expect(h.depth).toBe(2)
  })

  it('never coalesces into the initial state', () => {
    const { h } = make()
    h.push(1, { label: 'a', coalesceKey: 'k' })
    expect(h.undo()).toBe(0)
  })

  it('keeps at least 100 steps by default and trims beyond the limit', () => {
    const { h } = make(150)
    for (let i = 1; i <= 300; i++) h.push(i, { label: `s${i}` })
    expect(h.depth).toBeGreaterThanOrEqual(100)
    expect(h.depth).toBe(149)
    let n = 0
    while (h.undo() !== null) n++
    expect(n).toBe(149)
  })

  it('exposes labels for the undo and redo steps', () => {
    const { h } = make()
    h.push(1, { label: 'Add text' })
    expect(h.undoLabel).toBe('Add text')
    h.undo()
    expect(h.redoLabel).toBe('Add text')
    expect(h.undoLabel).toBeNull()
  })

  it('sealed after undo so the next edit is a new step', () => {
    const { h } = make()
    h.push(1, { label: 'a', coalesceKey: 'k' })
    h.push(2, { label: 'b', coalesceKey: 'k2' })
    h.undo()
    h.push(5, { label: 'c', coalesceKey: 'k2' })
    expect(h.depth).toBe(2)
  })

  it('clear() resets to a single state', () => {
    const { h } = make()
    h.push(1, { label: 'a' })
    h.clear(7)
    expect(h.current).toBe(7)
    expect(h.canUndo).toBe(false)
  })
})
