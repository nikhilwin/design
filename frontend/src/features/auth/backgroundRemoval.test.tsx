import { waitFor } from '@testing-library/react'
import { configureBackgroundRemoval } from '@/editor/engine/bgRemoval/install'
import { isBackgroundRemovalAvailable, registerBackgroundRemover } from '@/editor/engine/bgRemoval'
import { renderApp } from '@/test/app'
import { makeConfig } from '@/test/factories'
import type { AppConfig, BackgroundRemovalModel } from '@/types/api'

const model: BackgroundRemovalModel = {
  id: 'u2netp',
  name: 'U²-Net (small)',
  url: '/media/models/u2netp/u2netp-309c8469258d.onnx',
  bytes: 4574861,
  sha256: 'a'.repeat(64),
  input: { name: 'input.1', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], rescale: 'max' },
  output: '1959',
}

afterEach(() => {
  configureBackgroundRemoval({})
  registerBackgroundRemover(null)
})

describe('background removal from /config/', () => {
  // `/dashboard` sends an anonymous visitor to the sign-in page once the app has finished starting up, and the
  // config is applied before that: reaching it is the signal that nothing is left to arrive, and the sign-in page
  // asks the API for nothing, so no request outlives the test.
  async function startUp(config: AppConfig) {
    const { router } = renderApp('/dashboard', { config })
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  }

  it('registers the remover once the app config says a model is installed', async () => {
    const base = makeConfig()
    await startUp(makeConfig({ features: { ...base.features, background_removal: true }, assets: { background_removal_model: model } }))
    expect(isBackgroundRemovalAvailable()).toBe(true)
  })

  it('leaves the editor without the button when the server has no model', async () => {
    await startUp(makeConfig())
    expect(isBackgroundRemovalAvailable()).toBe(false)
  })

  it('takes the button away again when a later config no longer has the model', async () => {
    const base = makeConfig()
    configureBackgroundRemoval(makeConfig({ features: { ...base.features, background_removal: true }, assets: { background_removal_model: model } }))
    expect(isBackgroundRemovalAvailable()).toBe(true)
    await startUp(makeConfig())
    expect(isBackgroundRemovalAvailable()).toBe(false)
  })
})
