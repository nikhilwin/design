import { BackgroundRemovalError } from '../bgRemoval'
import type { ModelInput } from './model'
import { cutOut, MIN_COVERAGE, type PipelineHooks } from './pipeline'
import { resample } from './resample'

const MODEL: ModelInput = { name: 'in', size: 64, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], rescale: '255' }

interface Scene {
  rgba: Uint8ClampedArray
  width: number
  height: number
  /** Whether the pixel (x, y) is inside the subject. */
  inside(x: number, y: number): boolean
  /** The subject's share of the picture. */
  area: number
}

/** A saturated ellipse (the subject) on a dull textured backdrop. */
function scene(width: number, height: number): Scene {
  const cx = width / 2
  const cy = height / 2
  const rx = width * 0.3
  const ry = height * 0.35
  const inside = (x: number, y: number): boolean => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      if (inside(x, y)) rgba.set([220, 40 + ((x * 3) % 30), 40], p)
      else rgba.set([90 + ((x + y) % 17), 100 + ((x * 5) % 11), 120], p)
      rgba[p + 3] = 255
    }
  }
  return { rgba, width, height, inside, area: (Math.PI * rx * ry) / (width * height) }
}

/** A model that "sees" the same ellipse, but blurred over about three grid cells and a quarter cell off. */
function softEllipseModel(size: number): PipelineHooks['infer'] {
  return async () => {
    const out = new Float32Array(size * size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.25 + 0.5 - size / 2) / (size * 0.3)
        const dy = (y + 0.5 - size / 2) / (size * 0.35)
        const distance = Math.sqrt(dx * dx + dy * dy)
        out[y * size + x] = 1 / (1 + Math.exp((distance - 1) * 40))
      }
    }
    return out
  }
}

const hooks = (infer: PipelineHooks['infer'], steps: number[] = []): PipelineHooks => ({
  infer,
  step: async (percent) => {
    steps.push(percent)
  },
})

const alphaAt = (s: Scene, x: number, y: number): number => s.rgba[(y * s.width + x) * 4 + 3]

describe('cutOut', () => {
  it('keeps the subject, clears the backdrop and follows the real edge of the picture', async () => {
    const s = scene(320, 240)
    const coverage = await cutOut(s.rgba, s.width, s.height, MODEL, hooks(softEllipseModel(MODEL.size)))
    expect(coverage).toBeGreaterThan(s.area * 0.9)
    expect(coverage).toBeLessThan(s.area * 1.1)
    let wrong = 0
    let deep = 0
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const alpha = alphaAt(s, x, y)
        // Count pixels that are clearly on the wrong side; the one-pixel band at the edge may be partly covered.
        if (s.inside(x, y) && alpha < 128) wrong++
        if (!s.inside(x, y) && alpha > 128) wrong++
        deep++
      }
    }
    expect(wrong / deep).toBeLessThan(0.01)
    // The edge is sharper than the model's own answer, enlarged to the picture's size.
    const coarse = resample({ data: await softEllipseModel(MODEL.size)(new Float32Array(0)), width: MODEL.size, height: MODEL.size, stride: 1 }, 1, s.width, s.height)
    const blurry = coarse.filter((v) => v > 0.04 && v < 0.96).length
    expect(s.rgba.filter((v, i) => i % 4 === 3 && v > 10 && v < 245).length).toBeLessThan(blurry * 0.7)
    expect(alphaAt(s, 160, 120)).toBe(255)
    expect(alphaAt(s, 2, 2)).toBe(0)
    expect(alphaAt(s, 317, 237)).toBe(0)
  })

  it('changes only the alpha channel', async () => {
    const s = scene(100, 80)
    const colours = s.rgba.filter((_, i) => i % 4 !== 3)
    await cutOut(s.rgba, s.width, s.height, MODEL, hooks(softEllipseModel(MODEL.size)))
    expect(s.rgba.filter((_, i) => i % 4 !== 3)).toEqual(colours)
  })

  it('reports growing progress between stages and calls the model once with a normalised tensor', async () => {
    const s = scene(120, 90)
    const steps: number[] = []
    const inputs: Float32Array[] = []
    await cutOut(s.rgba, s.width, s.height, MODEL, hooks(async (input) => (inputs.push(input), softEllipseModel(MODEL.size)(input)), steps))
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(steps[0]).toBeGreaterThan(0)
    expect(steps.at(-1)).toBeLessThan(100)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toHaveLength(3 * MODEL.size * MODEL.size)
    expect(Math.min(...inputs[0])).toBeGreaterThanOrEqual(-1.0001)
    expect(Math.max(...inputs[0])).toBeLessThanOrEqual(1.0001)
  })

  it('stops when a stage throws (cancellation) and never runs the later stages', async () => {
    const s = scene(100, 80)
    const infer = vi.fn(softEllipseModel(MODEL.size))
    const cancel = new Error('cancelled')
    await expect(
      cutOut(s.rgba, s.width, s.height, MODEL, {
        infer,
        step: async (percent) => {
          if (percent >= 30) throw cancel
        },
      }),
    ).rejects.toBe(cancel)
    expect(infer).not.toHaveBeenCalled()
    expect(s.rgba.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true)
  })

  it('fails with a clear error when the model returns the wrong number of values', async () => {
    const s = scene(60, 40)
    await expect(cutOut(s.rgba, s.width, s.height, MODEL, hooks(async () => new Float32Array(10)))).rejects.toThrow(BackgroundRemovalError)
  })

  it('reports "no subject" instead of returning an empty picture when the model sees nothing', async () => {
    const s = scene(60, 40)
    const error = await cutOut(s.rgba, s.width, s.height, MODEL, hooks(async () => new Float32Array(MODEL.size * MODEL.size))).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackgroundRemovalError)
    expect((error as BackgroundRemovalError).reason).toBe('no-subject')
    expect(MIN_COVERAGE).toBeGreaterThan(0)
  })

  it('keeps a picture that is all subject fully opaque', async () => {
    const s = scene(60, 40)
    const coverage = await cutOut(s.rgba, s.width, s.height, MODEL, hooks(async () => new Float32Array(MODEL.size * MODEL.size).fill(0.99)))
    expect(coverage).toBeGreaterThan(0.99)
    expect(alphaAt(s, 30, 20)).toBe(255)
  })

  it('feathers the edge when asked to', async () => {
    const hard = scene(200, 150)
    const soft = scene(200, 150)
    await cutOut(hard.rgba, hard.width, hard.height, MODEL, hooks(softEllipseModel(MODEL.size)))
    await cutOut(soft.rgba, soft.width, soft.height, MODEL, hooks(softEllipseModel(MODEL.size)), { feather: 6 })
    const steepest = (s: Scene): number => {
      let worst = 0
      for (let x = 1; x < s.width; x++) worst = Math.max(worst, Math.abs(alphaAt(s, x, 75) - alphaAt(s, x - 1, 75)))
      return worst
    }
    expect(steepest(hard)).toBeGreaterThan(100)
    expect(steepest(soft)).toBeLessThan(steepest(hard) / 2)
  })

  it('refines a picture smaller than the model input and one that is a single row', async () => {
    const tiny = scene(20, 16)
    await cutOut(tiny.rgba, tiny.width, tiny.height, MODEL, hooks(softEllipseModel(MODEL.size)))
    expect(alphaAt(tiny, 10, 8)).toBe(255)
    const strip = new Uint8ClampedArray(40 * 4).fill(200)
    await expect(cutOut(strip, 40, 1, MODEL, hooks(async () => new Float32Array(MODEL.size * MODEL.size).fill(0.9)))).resolves.toBeGreaterThan(0.9)
  })

  it('handles a 12-megapixel photo in bounded time, working on a reduced guide grid', async () => {
    const width = 4000
    const height = 3000
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) rgba.set([(i * 7) % 256, 90, 160, 255], i * 4)
    const seen: number[] = []
    const started = performance.now()
    const coverage = await cutOut(rgba, width, height, MODEL, hooks(async (input) => (seen.push(input.length), softEllipseModel(MODEL.size)(input))))
    const seconds = (performance.now() - started) / 1000
    expect(seen).toEqual([3 * MODEL.size * MODEL.size])
    expect(coverage).toBeGreaterThan(0.2)
    expect(rgba[(1500 * width + 2000) * 4 + 3]).toBe(255)
    expect(rgba[3]).toBe(0)
    expect(seconds).toBeLessThan(60)
  }, 90_000)
})
