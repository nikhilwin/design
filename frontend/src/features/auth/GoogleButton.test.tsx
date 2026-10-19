import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router-dom'
import { AppProviders } from '@/app/AppProviders'
import { makeConfig } from '@/test/factories'
import { server } from '@/test/msw'
import { createTestQueryClient } from '@/test/utils'
import { GoogleButton } from './GoogleButton'

const google = vi.hoisted(() => ({
  load: vi.fn(),
}))

vi.mock('@/lib/googleIdentity', () => ({ loadGoogleIdentity: google.load }))

function renderButton(clientId: string, onCredential = vi.fn()) {
  server.use(
    http.get('*/api/v1/auth/me/', () => HttpResponse.json({ user: null })),
    http.get('*/api/v1/config/', () => HttpResponse.json(makeConfig({ google_client_id: clientId }))),
  )
  render(
    <AppProviders client={createTestQueryClient()}>
      <MemoryRouter>
        <GoogleButton onCredential={onCredential} />
      </MemoryRouter>
    </AppProviders>,
  )
  return onCredential
}

beforeEach(() => {
  google.load.mockReset()
})

describe('GoogleButton', () => {
  it('loads Google Identity lazily, renders the official button and forwards credentials', async () => {
    const render_ = vi.fn()
    let callback: ((response: { credential: string }) => void) | undefined
    google.load.mockResolvedValue({
      initialize: (config: { client_id: string; callback: (response: { credential: string }) => void }) => {
        expect(config.client_id).toBe('client-123')
        callback = config.callback
      },
      renderButton: render_,
    })
    const onCredential = renderButton('client-123')
    await waitFor(() => expect(render_).toHaveBeenCalled())
    expect(render_.mock.calls[0][1]).toMatchObject({ text: 'continue_with', shape: 'pill' })
    callback?.({ credential: 'id-token' })
    expect(onCredential).toHaveBeenCalledWith('id-token')
  })

  it('renders nothing and never loads the script without a configured client id', async () => {
    const onCredential = renderButton('')
    await waitFor(() => expect(onCredential).not.toHaveBeenCalled())
    expect(google.load).not.toHaveBeenCalled()
    expect(screen.queryByText(/Google/)).not.toBeInTheDocument()
  })

  it('degrades to a quiet message when the script cannot load', async () => {
    google.load.mockRejectedValue(new Error('blocked'))
    renderButton('client-123')
    expect(await screen.findByText(/Google sign-in is unavailable/)).toBeInTheDocument()
  })
})
