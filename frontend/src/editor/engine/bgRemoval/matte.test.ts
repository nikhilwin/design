import { boxMean, DEFAULT_SHAPE, featherAlpha, fitGuidedFilter, shapeAlpha, writeAlpha } from './matte'

/** Brute-force window mean for comparison. */
function naiveBoxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) {
        for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
          sum += src[j * w + i]
          n++
        }
      }
      out[y * w + x] = sum / n
    }
  }
  return out
}

function seeded(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = s / 2 ** 32
  }
  return out
}

describe('boxMean', () => {
  it.each([
    [7, 5, 1],
    [7, 5, 2],
    [12, 9, 3],
    [3, 3, 5],
    [1, 8, 2],
    [9, 1, 2],
    [6, 6, 0],
  ])('matches a brute-force window mean on a %ix%i plane with radius %i', (w, h, r) => {
    const src = seeded(w * h, w * 31 + h)
    const fast = boxMean(src, w, h, r)
    const slow = naiveBoxMean(src, w, h, r)
    for (let i = 0; i < src.length; i++) expect(fast[i]).toBeCloseTo(slow[i], 5)
  })

  it('does not modify its input and keeps a constant plane constant', () => {
    const src = new Float32Array(20).fill(0.3)
    const out = boxMean(src, 5, 4, 2)
    for (const v of out) expect(v).toBeCloseTo(0.3, 6)
    expect(Array.from(src).every((v) => Math.abs(v - 0.3) < 1e-7)).toBe(true)
  })
})

/** A `w` x `h` photo: dark on the left of column `edge`, bright on the right. Interleaved RGB 0..1. */
function stepPhoto(w: number, h: number, edge: number): Float32Array {
  const rgb = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < edge ? 0.15 : 0.85
      rgb.set([v, v * 0.9, v * 0.8], (y * w + x) * 3)
    }
  }
  return rgb
}

/** A matte that rises from 0 to 1 around `centre` over `width` pixels. */
function softStep(w: number, h: number, centre: number, width: number): Float32Array {
  const m = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) m[y * w + x] = Math.min(1, Math.max(0, (x - centre) / width + 0.5))
  }
  return m
}

function evaluate(rgb: Float32Array, fit: ReturnType<typeof fitGuidedFilter>): Float32Array {
  const { width, height } = fit
  const out = new Float32Array(width * height)
  for (let i = 0; i < out.length; i++) {
    out[i] = fit.a[0][i] * rgb[i * 3] + fit.a[1][i] * rgb[i * 3 + 1] + fit.a[2][i] * rgb[i * 3 + 2] + fit.b[i]
  }
  return out
}

describe('fitGuidedFilter', () => {
  const W = 48
  const H = 12

  it('leaves a constant matte constant whatever the photo looks like', () => {
    const rgb = seeded(W * H * 3, 7)
    const fit = fitGuidedFilter(rgb, new Float32Array(W * H).fill(0.6), W, H, { radius: 3, epsilon: 1e-3 })
    for (const v of evaluate(rgb, fit)) expect(v).toBeCloseTo(0.6, 3)
  })

  it('snaps a soft, slightly misplaced edge onto the edge of the photo', () => {
    const rgb = stepPhoto(W, H, 20)
    const coarse = softStep(W, H, 22, 8) // eight pixels wide and two pixels off
    const refined = evaluate(rgb, fitGuidedFilter(rgb, coarse, W, H, { radius: 4, epsilon: 1e-3 }))
    const row = 6 * W
    // Far from the edge nothing changes ...
    expect(refined[row + 2]).toBeCloseTo(0, 1)
    expect(refined[row + W - 3]).toBeCloseTo(1, 1)
    // ... and the transition now happens across the photo's edge (between x = 19 and x = 20), sharply.
    const at = (x: number) => refined[row + x]
    expect(at(19)).toBeLessThan(0.3)
    expect(at(20)).toBeGreaterThan(0.45)
    const steepest = (read: (x: number) => number) => Math.max(...[...Array(W - 1).keys()].map((x) => read(x + 1) - read(x)))
    expect(steepest(at)).toBeGreaterThan(0.35) // a jump at the photo's edge ...
    expect(steepest((x) => coarse[row + x])).toBeLessThan(0.13) // ... where the coarse matte only ramped
  })

  it('reproduces a matte that is a linear function of the photo', () => {
    const rgb = seeded(W * H * 3, 11)
    const matte = new Float32Array(W * H)
    for (let i = 0; i < matte.length; i++) matte[i] = 0.2 + 0.5 * rgb[i * 3] + 0.2 * rgb[i * 3 + 1]
    const fit = fitGuidedFilter(rgb, matte, W, H, { radius: 3, epsilon: 1e-6 })
    const out = evaluate(rgb, fit)
    let worst = 0
    for (let i = 0; i < matte.length; i++) worst = Math.max(worst, Math.abs(out[i] - matte[i]))
    expect(worst).toBeLessThan(0.02)
  })

  it('smooths more as epsilon grows', () => {
    const rgb = seeded(W * H * 3, 3)
    const matte = softStep(W, H, 24, 2)
    const spread = (epsilon: number) => {
      const out = evaluate(rgb, fitGuidedFilter(rgb, matte, W, H, { radius: 3, epsilon }))
      let sum = 0
      for (let i = 0; i < out.length; i++) sum += Math.abs(out[i] - matte[i])
      return sum / out.length
    }
    expect(spread(1)).toBeGreaterThan(spread(1e-4) * 0.5)
    expect(spread(1e-4)).toBeLessThan(0.2)
  })

  it('returns finite coefficients on a flat, single-colour photo (singular covariance)', () => {
    const rgb = new Float32Array(W * H * 3).fill(0.5)
    const fit = fitGuidedFilter(rgb, softStep(W, H, 24, 6), W, H, { radius: 3, epsilon: 1e-3 })
    for (const plane of [...fit.a, fit.b]) for (const v of plane) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('shapeAlpha', () => {
  it('clears haze at both ends and keeps the middle', () => {
    expect(shapeAlpha(-0.3, DEFAULT_SHAPE)).toBe(0)
    expect(shapeAlpha(DEFAULT_SHAPE.low, DEFAULT_SHAPE)).toBe(0)
    expect(shapeAlpha(0.5, DEFAULT_SHAPE)).toBeCloseTo(0.5, 6)
    expect(shapeAlpha(DEFAULT_SHAPE.high, DEFAULT_SHAPE)).toBe(1)
    expect(shapeAlpha(1.4, DEFAULT_SHAPE)).toBe(1)
  })

  it('is monotonic', () => {
    let previous = -1
    for (let v = -0.2; v <= 1.2; v += 0.01) {
      const a = shapeAlpha(v, DEFAULT_SHAPE)
      expect(a).toBeGreaterThanOrEqual(previous)
      previous = a
    }
  })
})

describe('writeAlpha', () => {
  /** Coefficients that make alpha equal to the red channel (a = (1, 0, 0), b = 0) on a `w` x `h` grid. */
  function redIsAlpha(w: number, h: number) {
    return {
      width: w,
      height: h,
      a: [new Float32Array(w * h).fill(1), new Float32Array(w * h), new Float32Array(w * h)] as const,
      b: new Float32Array(w * h),
    }
  }

  it('applies the fit at full resolution and returns the foreground share', () => {
    const w = 8
    const h = 4
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([i % w < 4 ? 255 : 0, 10, 20, 7], i * 4)
    const coverage = writeAlpha(rgba, w, h, redIsAlpha(4, 2), { low: 0, high: 1 })
    for (let i = 0; i < w * h; i++) {
      expect(rgba[i * 4 + 3]).toBe(i % w < 4 ? 255 : 0)
      expect(rgba[i * 4]).toBe(i % w < 4 ? 255 : 0) // colours are untouched
      expect(rgba[i * 4 + 1]).toBe(10)
    }
    expect(coverage).toBeCloseTo(0.5, 6)
  })

  it('interpolates the coefficients between grid cells', () => {
    const w = 4
    const h = 1
    const rgba = new Uint8ClampedArray(w * 4).fill(255)
    const fit = redIsAlpha(2, 1)
    fit.a[0].fill(0)
    fit.b.set([0, 1]) // alpha ramps from 0 to 1 across the picture
    writeAlpha(rgba, w, h, fit, { low: 0, high: 1 })
    const alphas = [0, 1, 2, 3].map((x) => rgba[x * 4 + 3])
    // the 2 -> 4 enlargement interpolates 0, 0.25, 0.75, 1
    expect(alphas[0]).toBe(0)
    expect(alphas[3]).toBe(255)
    expect(alphas[1]).toBeGreaterThan(alphas[0])
    expect(alphas[2]).toBeGreaterThan(alphas[1])
    expect(alphas[2]).toBeLessThan(alphas[3])
  })

  it('writes only the alpha channel and rounds it to a byte', () => {
    const rgba = Uint8ClampedArray.from([200, 100, 50, 0])
    const fit = redIsAlpha(1, 1)
    fit.a[0].fill(0)
    fit.b.fill(0.5)
    writeAlpha(rgba, 1, 1, fit, { low: 0, high: 1 })
    expect(Array.from(rgba)).toEqual([200, 100, 50, 128])
  })

  it('refuses a fit grid larger than the picture', () => {
    expect(() => writeAlpha(new Uint8ClampedArray(4), 1, 1, redIsAlpha(2, 2))).toThrow(RangeError)
  })
})

describe('featherAlpha', () => {
  function stripe(w: number, h: number): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([1, 2, 3, i % w < w / 2 ? 255 : 0], i * 4)
    return rgba
  }

  it('does nothing for a radius below one', () => {
    const rgba = stripe(20, 4)
    const copy = rgba.slice()
    featherAlpha(rgba, 20, 4, 0)
    featherAlpha(rgba, 20, 4, 0.4)
    expect(rgba).toEqual(copy)
  })

  it('softens a hard edge, stays within 0..255 and leaves the colours alone', () => {
    const rgba = stripe(40, 4)
    featherAlpha(rgba, 40, 4, 6)
    const alphaRow = [...Array(40).keys()].map((x) => rgba[x * 4 + 3])
    const between = alphaRow.filter((a) => a > 10 && a < 245).length
    expect(between).toBeGreaterThan(4)
    expect(alphaRow[0]).toBe(255)
    expect(alphaRow[39]).toBe(0)
    for (let x = 1; x < 40; x++) expect(alphaRow[x]).toBeLessThanOrEqual(alphaRow[x - 1])
    expect(Array.from(rgba.slice(0, 3))).toEqual([1, 2, 3])
  })

  it('keeps a uniform alpha uniform', () => {
    const rgba = new Uint8ClampedArray(10 * 10 * 4)
    for (let i = 0; i < 100; i++) rgba[i * 4 + 3] = 200
    featherAlpha(rgba, 10, 10, 3)
    for (let i = 0; i < 100; i++) expect(rgba[i * 4 + 3]).toBe(200)
  })
})
