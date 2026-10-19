import { axisWeights, fitLongSide, fitPixels, resample } from './resample'

const close = (a: ArrayLike<number>, b: number[], digits = 5) => {
  expect(a.length).toBe(b.length)
  b.forEach((value, i) => expect(a[i]).toBeCloseTo(value, digits))
}

describe('axisWeights', () => {
  it.each([
    [10, 4],
    [7, 3],
    [1000, 320],
    [3, 5],
    [5, 5],
    [4, 40],
    [1, 6],
  ])('weights of %i -> %i sum to one for every output position', (source, target) => {
    const w = axisWeights(source, target)
    for (let d = 0; d < target; d++) {
      let sum = 0
      for (let t = 0; t < w.count[d]; t++) sum += w.weights[w.offset[d] + t]
      expect(sum).toBeCloseTo(1, 5)
      expect(w.start[d]).toBeGreaterThanOrEqual(0)
      expect(w.start[d] + w.count[d] - 1).toBeLessThanOrEqual(source - 1)
    }
  })

  it('shrinking by a whole factor averages exactly that many pixels', () => {
    const w = axisWeights(8, 2)
    expect(Array.from(w.count)).toEqual([4, 4])
    expect(Array.from(w.start)).toEqual([0, 4])
    expect(Array.from(w.weights)).toEqual([0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25])
  })

  it('shrinking by a fraction weights the shared pixel by its overlap', () => {
    const w = axisWeights(3, 2)
    expect(Array.from(w.count)).toEqual([2, 2])
    close(w.weights, [2 / 3, 1 / 3, 1 / 3, 2 / 3])
  })

  it('equal sizes are the identity and enlarging uses two taps', () => {
    const same = axisWeights(4, 4)
    expect(Array.from(same.count)).toEqual([1, 1, 1, 1])
    expect(Array.from(same.start)).toEqual([0, 1, 2, 3])
    const up = axisWeights(2, 4)
    expect(Array.from(up.count)).toEqual([1, 2, 2, 1])
  })
})

describe('resample', () => {
  it('averages 2x2 blocks of an RGB picture', () => {
    const data = Float32Array.from([
      // row 0
      0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0,
      // row 1
      1, 1, 1, 0, 0, 0, 0, 0, 0, 4, 4, 4,
    ])
    const out = resample({ data, width: 4, height: 2, stride: 3 }, 3, 2, 1)
    close(out, [0.5, 0.5, 0.5, 1, 1, 1])
  })

  it('reads RGBA bytes, drops alpha and scales to 0..1', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 7, 0, 255, 0, 7, 0, 0, 255, 7, 255, 255, 255, 7])
    const out = resample({ data, width: 2, height: 2, stride: 4 }, 3, 1, 1, 1 / 255)
    close(out, [0.5, 0.5, 0.5])
    expect(out.length).toBe(3)
  })

  it('keeps a constant picture constant at any size', () => {
    const data = new Float32Array(7 * 5 * 3).fill(0.37)
    for (const [w, h] of [[3, 2], [7, 5], [20, 13], [1, 1]] as const) {
      const out = resample({ data, width: 7, height: 5, stride: 3 }, 3, w, h)
      for (const v of out) expect(v).toBeCloseTo(0.37, 5)
    }
  })

  it('enlarges a ramp linearly and clamps at the borders', () => {
    const data = Float32Array.from([0, 1, 2, 3])
    const out = resample({ data, width: 4, height: 1, stride: 1 }, 1, 8, 1)
    close(out, [0, 0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3])
  })

  it('preserves the mean of a picture when shrinking', () => {
    const data = new Float32Array(30 * 20)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 101
    const mean = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0) / a.length
    const out = resample({ data, width: 30, height: 20, stride: 1 }, 1, 9, 7)
    expect(mean(out)).toBeCloseTo(mean(data), 3)
  })

  it('handles an axis that shrinks while the other grows', () => {
    const data = Float32Array.from([1, 3, 5, 7])
    const out = resample({ data, width: 4, height: 1, stride: 1 }, 1, 2, 3)
    close(out, [2, 6, 2, 6, 2, 6])
  })
})

describe('fitLongSide / fitPixels', () => {
  it('shrinks to the long side, keeps the aspect ratio and never enlarges', () => {
    expect(fitLongSide(4000, 3000, 1000)).toEqual({ width: 1000, height: 750 })
    expect(fitLongSide(3000, 4000, 1000)).toEqual({ width: 750, height: 1000 })
    expect(fitLongSide(800, 600, 1000)).toEqual({ width: 800, height: 600 })
    expect(fitLongSide(10000, 3, 1000)).toEqual({ width: 1000, height: 1 })
  })

  it('limits the pixel count and never enlarges', () => {
    const fitted = fitPixels(6000, 5000, 24_000_000)
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(24_000_000)
    expect(fitted.width / fitted.height).toBeCloseTo(1.2, 2)
    expect(fitPixels(4000, 3000, 24_000_000)).toEqual({ width: 4000, height: 3000 })
    expect(fitPixels(100000, 1, 100)).toEqual({ width: 100, height: 1 })
  })
})
