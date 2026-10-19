import { describe, expect, it } from 'vitest'
import { splitColumns } from './masonry'

describe('splitColumns', () => {
  it('puts each item into the shortest column', () => {
    expect(splitColumns([3, 1, 1, 1, 2], 2)).toEqual([[0, 4], [1, 2, 3]])
  })

  it('never moves placed items when more are appended', () => {
    const heights = [1.3, 0.8, 1.1, 0.6, 1.5]
    const before = splitColumns(heights, 2)
    const after = splitColumns([...heights, 1, 0.7], 2)
    for (const [c, indices] of before.entries()) expect(after[c].slice(0, indices.length)).toEqual(indices)
  })

  it('handles empty input and a single column', () => {
    expect(splitColumns([], 2)).toEqual([[], []])
    expect(splitColumns([1, 2, 3], 1)).toEqual([[0, 1, 2]])
    expect(splitColumns([1, 2], 0)).toEqual([[0, 1]])
  })
})
