import { BackgroundRemovalError, isBackgroundRemovalAvailable, registerBackgroundRemover, removeBackground, type BackgroundRemover } from '../bgRemoval'

const image = new Blob(['x'])

afterEach(() => registerBackgroundRemover(null))

describe('removeBackground (the seam)', () => {
  it('fails clearly while no engine is registered, and the button stays hidden', async () => {
    expect(isBackgroundRemovalAvailable()).toBe(false)
    await expect(removeBackground(image)).rejects.toThrow(BackgroundRemovalError)
  })

  it('forwards the image, the progress callback and the abort signal to the engine', async () => {
    const remove = vi.fn<BackgroundRemover['remove']>(async () => new Blob(['png']))
    registerBackgroundRemover({ remove })
    const progress = vi.fn()
    const signal = new AbortController().signal
    await removeBackground(image, progress, signal)
    expect(remove).toHaveBeenCalledWith(image, progress, signal)
    expect(isBackgroundRemovalAvailable()).toBe(true)
  })

  it('does not turn a cancellation into an engine failure', async () => {
    const controller = new AbortController()
    registerBackgroundRemover({
      remove: async () => {
        controller.abort()
        throw new DOMException('Aborted', 'AbortError')
      },
    })
    const result = removeBackground(image, undefined, controller.signal)
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await expect(result).rejects.not.toBeInstanceOf(BackgroundRemovalError)
  })

  it('keeps the reason of an engine failure', async () => {
    registerBackgroundRemover({ remove: async () => Promise.reject(new BackgroundRemovalError('empty', 'no-subject')) })
    await expect(removeBackground(image)).rejects.toMatchObject({ reason: 'no-subject', message: 'empty' })
  })

  it('reports a code-generation block as "blocked" and wraps anything else', async () => {
    registerBackgroundRemover({ remove: async () => Promise.reject(new EvalError('unsafe-eval')) })
    await expect(removeBackground(image)).rejects.toMatchObject({ reason: 'blocked' })
    registerBackgroundRemover({ remove: async () => Promise.reject(new Error('boom')) })
    await expect(removeBackground(image)).rejects.toMatchObject({ reason: 'unavailable', message: 'boom' })
    registerBackgroundRemover({ remove: async () => Promise.reject('plain string') })
    await expect(removeBackground(image)).rejects.toMatchObject({ reason: 'unavailable', message: 'Background removal failed.' })
  })
})
