import type { ModelInput } from './model'
import { buildModelInput, normalizeMatte } from './tensor'

const spec = (patch: Partial<ModelInput> = {}): ModelInput => ({
  name: 'input',
  size: 2,
  mean: [0.5, 0.25, 0],
  std: [0.5, 0.25, 1],
  rescale: '255',
  ...patch,
})

describe('buildModelInput', () => {
  it('lays the tensor out as planar CHW and normalises every channel with its own mean and std', () => {
    // 2x2 picture, interleaved RGB in 0..1
    const rgb = Float32Array.from([1, 0.5, 0.2, 0, 0.5, 0.4, 0.5, 0.75, 0.6, 1, 1, 0.8])
    const t = buildModelInput(rgb, 2, 2, spec())
    expect(t.length).toBe(12)
    const expected = [
      // R plane: (v - 0.5) / 0.5
      1, -1, 0, 1,
      // G plane: (v - 0.25) / 0.25
      1, 1, 2, 3,
      // B plane: (v - 0) / 1
      0.2, 0.4, 0.6, 0.8,
    ]
    expected.forEach((v, i) => expect(t[i]).toBeCloseTo(v, 5))
  })

  it('divides by the largest value of the picture when the model asks for it', () => {
    const rgb = Float32Array.from([0.5, 0.25, 0.125, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.1, 0.1, 0.1])
    const t = buildModelInput(rgb, 2, 2, spec({ mean: [0, 0, 0], std: [1, 1, 1], rescale: 'max' }))
    expect(Math.max(...t)).toBeCloseTo(1, 6)
    expect(t[0]).toBeCloseTo(1, 6)
    expect(t[4]).toBeCloseTo(0.5, 6) // G of the first pixel: 0.25 / 0.5
  })

  it('does not divide by zero on a black picture', () => {
    const t = buildModelInput(new Float32Array(12), 2, 2, spec({ mean: [0, 0, 0], std: [1, 1, 1], rescale: 'max' }))
    expect(Array.from(t).every((v) => v === 0)).toBe(true)
  })

  it('resizes to the model size before normalising', () => {
    const rgb = new Float32Array(8 * 6 * 3).fill(0.5)
    const t = buildModelInput(rgb, 8, 6, spec({ size: 4, mean: [0.5, 0.5, 0.5], std: [1, 1, 1] }))
    expect(t.length).toBe(3 * 16)
    for (const v of t) expect(v).toBeCloseTo(0, 6)
  })
})

describe('normalizeMatte', () => {
  it('stretches the output to the full 0..1 range', () => {
    const m = normalizeMatte(Float32Array.from([0.2, 0.4, 0.6]))
    expect(Array.from(m).map((v) => Number(v.toFixed(4)))).toEqual([0, 0.5, 1])
  })

  it('leaves a flat output alone (clamped) instead of amplifying noise', () => {
    expect(Array.from(normalizeMatte(Float32Array.from([0.001, 0.0012, 0.0011])))).toEqual([
      expect.closeTo(0.001, 6),
      expect.closeTo(0.0012, 6),
      expect.closeTo(0.0011, 6),
    ])
    expect(Array.from(normalizeMatte(Float32Array.from([1.4, 1.4])))).toEqual([1, 1])
    expect(Array.from(normalizeMatte(Float32Array.from([-2, -2])))).toEqual([0, 0])
  })

  it('does not modify its input', () => {
    const output = Float32Array.from([0.1, 0.9])
    normalizeMatte(output)
    expect(Array.from(output)).toEqual([expect.closeTo(0.1, 6), expect.closeTo(0.9, 6)])
  })
})
