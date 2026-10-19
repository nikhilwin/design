import { BackgroundRemovalError, isBackgroundRemovalAvailable, registerBackgroundRemover, removeBackground } from '../bgRemoval'
import { configureBackgroundRemoval } from './install'

const created = vi.hoisted(() => ({ engines: [] as Array<{ remove: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>, fail: false }))

vi.mock('./bundled', () => ({
  createBundledRemover: vi.fn(() => {
    if (created.fail) throw new Error('the engine chunk is missing')
    const engine = { remove: vi.fn(async () => new Blob(['png'])), dispose: vi.fn() }
    created.engines.push(engine)
    return engine
  }),
}))

const description = (patch: Record<string, unknown> = {}) => ({
  id: 'u2netp',
  name: 'U²-Net (small)',
  url: '/media/models/u2netp/u2netp-309c8469258d.onnx',
  bytes: 4574861,
  sha256: 'a'.repeat(64),
  input: { name: 'input.1', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], rescale: 'max' },
  output: '1959',
  ...patch,
})

const on = (patch: Record<string, unknown> = {}) => ({ features: { background_removal: true }, assets: { background_removal_model: description(patch) } })

const image = new Blob(['x'])

afterEach(() => {
  created.fail = false
  configureBackgroundRemoval({})
  registerBackgroundRemover(null)
  created.engines.length = 0
})

describe('configureBackgroundRemoval', () => {
  it('registers a remover when the server offers a usable model', () => {
    expect(isBackgroundRemovalAvailable()).toBe(false)
    configureBackgroundRemoval(on())
    expect(isBackgroundRemovalAvailable()).toBe(true)
  })

  it.each([
    ['the feature flag is off', { features: { background_removal: false }, assets: { background_removal_model: description() } }],
    ['the flag is missing (an older server)', { features: {}, assets: { background_removal_model: description() } }],
    ['there is no model', { features: { background_removal: true }, assets: { background_removal_model: null } }],
    ['there are no assets', { features: { background_removal: true } }],
    ['the model description is malformed', on({ sha256: 'nope' })],
    ['the model lives on another origin', on({ url: 'https://cdn.example/m.onnx' })],
    ['nothing is configured', {}],
  ])('registers nothing when %s', (_label, config) => {
    configureBackgroundRemoval(config)
    expect(isBackgroundRemovalAvailable()).toBe(false)
  })

  it('does not touch a remover somebody else registered when it has nothing to say', () => {
    registerBackgroundRemover({ remove: async () => new Blob(['other']) })
    configureBackgroundRemoval({ features: { background_removal: false } })
    expect(isBackgroundRemovalAvailable()).toBe(true)
  })

  it('unregisters when the feature goes away', () => {
    configureBackgroundRemoval(on())
    configureBackgroundRemoval({ features: { background_removal: false }, assets: { background_removal_model: null } })
    expect(isBackgroundRemovalAvailable()).toBe(false)
  })

  it('loads the engine only when the first removal starts, and reuses it', async () => {
    configureBackgroundRemoval(on())
    expect(created.engines).toHaveLength(0)
    const progress = vi.fn()
    const controller = new AbortController()
    await removeBackground(image, progress, controller.signal)
    await removeBackground(image)
    expect(created.engines).toHaveLength(1)
    expect(created.engines[0].remove).toHaveBeenCalledTimes(2)
    expect(created.engines[0].remove).toHaveBeenNthCalledWith(1, image, progress, controller.signal)
  })

  it('keeps the engine when the same model is configured again', async () => {
    configureBackgroundRemoval(on())
    await removeBackground(image)
    configureBackgroundRemoval(on())
    await removeBackground(image)
    expect(created.engines).toHaveLength(1)
    expect(created.engines[0].dispose).not.toHaveBeenCalled()
  })

  it('replaces the engine, and frees the old one, when another model is configured', async () => {
    configureBackgroundRemoval(on())
    await removeBackground(image)
    configureBackgroundRemoval(on({ id: 'u2net', url: '/media/models/u2net/u2net-8d10d2f3bb75.onnx' }))
    await vi.waitFor(() => expect(created.engines[0].dispose).toHaveBeenCalled())
    await removeBackground(image)
    expect(created.engines).toHaveLength(2)
  })

  it('frees the engine when the feature is switched off', async () => {
    configureBackgroundRemoval(on())
    await removeBackground(image)
    configureBackgroundRemoval({ features: { background_removal: false } })
    await vi.waitFor(() => expect(created.engines[0].dispose).toHaveBeenCalled())
    await expect(removeBackground(image)).rejects.toBeInstanceOf(BackgroundRemovalError)
  })

  it('reports a failure to load the engine as an error and tries again on the next removal', async () => {
    configureBackgroundRemoval(on())
    created.fail = true
    await expect(removeBackground(image)).rejects.toThrow('the engine chunk is missing')
    created.fail = false
    await expect(removeBackground(image)).resolves.toBeInstanceOf(Blob)
    expect(created.engines).toHaveLength(1)
  })
})
