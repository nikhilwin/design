import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse, type RequestHandler } from 'msw'
import { MemoryRouter } from 'react-router-dom'
import { AppProviders } from '@/app/AppProviders'
import { renderApp } from '@/test/app'
import { makeConfig, makeUser } from '@/test/factories'
import { server } from '@/test/msw'
import { createTestQueryClient } from '@/test/utils'
import { AuthModalProvider, useAuthModal } from './AuthModalProvider'
import { useAuth } from './AuthProvider'

const err = (code: string, message: string, status: number, extra: Record<string, unknown> = {}) => HttpResponse.json({ error: { code, message, ...extra } }, { status })

describe('session bootstrap and route guard', () => {
  it('sends anonymous visitors from a protected page to /login and remembers where they were going', async () => {
    const { router } = renderApp('/dashboard/designs?q=logo')
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent('/dashboard/designs?q=logo')}`)
  })

  it('renders protected pages for signed-in users', async () => {
    renderApp('/dashboard', { user: makeUser() })
    expect(await screen.findByRole('heading', { name: /Ada/ })).toBeInTheDocument()
  })

  it('redirects signed-in users away from /login to their intended page', async () => {
    const { router } = renderApp('/login?next=%2Fdashboard%2Ftrash', { user: makeUser() })
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard/trash'))
  })

  it('ignores an unsafe next parameter', async () => {
    const { router } = renderApp('/login?next=https%3A%2F%2Fevil.test', { user: makeUser() })
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
  })

  it('shows a retryable "can’t reach Doory" state when the session check fails on a protected page', async () => {
    let calls = 0
    const { router } = renderApp('/dashboard', {
      handlers: [
        http.get('*/api/v1/auth/me/', () => {
          calls += 1
          return calls === 1 ? HttpResponse.error() : HttpResponse.json({ user: makeUser() })
        }),
      ],
    })
    expect(await screen.findByText('We can’t reach Doory')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/dashboard')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: /Ada/ })).toBeInTheDocument()
  })

  it('drops to the login page when the session expires mid-use (401)', async () => {
    const { router } = renderApp('/dashboard', {
      user: makeUser(),
      handlers: [http.get('*/api/v1/designs/', () => err('not_authenticated', 'Sign in', 401))],
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.search).toContain('next=%2Fdashboard')
  })
})

describe('login', () => {
  it('validates before calling the API', async () => {
    renderApp('/login')
    await userEvent.click(await screen.findByRole('button', { name: 'Log in' }))
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
  })

  it('logs in and returns to the page the user wanted', async () => {
    const bodies: unknown[] = []
    const { router } = renderApp('/login?next=%2Fdashboard%2Fbrand', {
      handlers: [
        http.post('*/api/v1/auth/login/', async ({ request }) => {
          bodies.push(await request.json())
          return HttpResponse.json({ user: makeUser() })
        }),
      ],
    })
    await userEvent.type(await screen.findByLabelText(/Email/), '  ada@example.com ')
    await userEvent.type(screen.getByLabelText(/Password/), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard/brand'))
    expect(bodies).toEqual([{ email: 'ada@example.com', password: 'correct-horse' }])
  })

  it('shows the server message for wrong credentials without clearing the form', async () => {
    renderApp('/login', { handlers: [http.post('*/api/v1/auth/login/', () => err('invalid_credentials', 'That email and password don’t match.', 400))] })
    await userEvent.type(await screen.findByLabelText(/Email/), 'ada@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password don’t match.')
    expect(screen.getByLabelText(/Email/)).toHaveValue('ada@example.com')
  })

  it('tells the user when they are rate limited', async () => {
    renderApp('/login', { handlers: [http.post('*/api/v1/auth/login/', () => err('throttled', 'Request was throttled.', 429, { retry_after: 45 }))] })
    await userEvent.type(await screen.findByLabelText(/Email/), 'ada@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Please try again in 45 seconds.')
  })

  it('has correct autocomplete attributes and a working show/hide password toggle', async () => {
    renderApp('/login')
    const email = await screen.findByLabelText(/Email/)
    const password = screen.getByLabelText(/Password/)
    expect(email).toHaveAttribute('autocomplete', 'email')
    expect(email).toHaveAttribute('type', 'email')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
    expect(password).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('does not render any Google UI when no client id is configured', async () => {
    renderApp('/login')
    await screen.findByRole('heading', { name: 'Welcome back' })
    expect(screen.queryByText(/Google/)).not.toBeInTheDocument()
  })
})

describe('signup', () => {
  it('shows the strength meter and blocks weak passwords before submitting', async () => {
    let posted = false
    renderApp('/signup', { handlers: [http.post('*/api/v1/auth/register/', () => { posted = true; return HttpResponse.json({}) })] })
    await userEvent.type(await screen.findByLabelText(/Email/), 'new@example.com')
    const password = screen.getByLabelText(/^Password/, { selector: 'input' })
    await userEvent.type(password, '1234')
    expect(screen.getByRole('meter', { name: 'Password strength' })).toHaveAttribute('aria-valuenow', '1')
    await userEvent.click(screen.getByRole('button', { name: 'Create free account' }))
    expect(screen.getByText('Use at least 8 characters, and not only numbers.')).toBeInTheDocument()
    expect(posted).toBe(false)
  })

  it('creates the account and lands on the dashboard', async () => {
    const bodies: unknown[] = []
    const { router } = renderApp('/signup', {
      handlers: [
        http.post('*/api/v1/auth/register/', async ({ request }) => {
          bodies.push(await request.json())
          return HttpResponse.json({ user: makeUser({ email: 'new@example.com', is_email_verified: false }) }, { status: 201 })
        }),
      ],
    })
    await userEvent.type(await screen.findByLabelText('Name'), 'Grace Hopper')
    await userEvent.type(screen.getByLabelText(/Email/), 'new@example.com')
    await userEvent.type(screen.getByLabelText(/^Password/, { selector: 'input' }), 'compilers-rule-1')
    await userEvent.click(screen.getByRole('button', { name: 'Create free account' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
    expect(bodies).toEqual([{ email: 'new@example.com', password: 'compilers-rule-1', display_name: 'Grace Hopper' }])
  })

  it('shows field-level server errors next to the field', async () => {
    renderApp('/signup', { handlers: [http.post('*/api/v1/auth/register/', () => err('validation_error', 'Invalid input.', 400, { fields: { email: ['An account with this email already exists.'] } }))] })
    await userEvent.type(await screen.findByLabelText(/Email/), 'taken@example.com')
    await userEvent.type(screen.getByLabelText(/^Password/, { selector: 'input' }), 'compilers-rule-1')
    await userEvent.click(screen.getByRole('button', { name: 'Create free account' }))
    const email = await screen.findByLabelText(/Email/)
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('An account with this email already exists.')).toBeInTheDocument()
    expect(email).toHaveAttribute('autocomplete', 'email')
    expect(screen.getByLabelText(/^Password/, { selector: 'input' })).toHaveAttribute('autocomplete', 'new-password')
  })
})

describe('password reset and email verification', () => {
  it('forgot password always shows the same confirmation (no account enumeration)', async () => {
    const calls: unknown[] = []
    renderApp('/forgot-password', { handlers: [http.post('*/api/v1/auth/password/reset/', async ({ request }) => { calls.push(await request.json()); return new HttpResponse(null, { status: 204 }) })] })
    await userEvent.type(await screen.findByLabelText(/Email/), 'nobody@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument()
    expect(screen.getByText(/If an account exists/)).toBeInTheDocument()
    expect(calls).toEqual([{ email: 'nobody@example.com' }])
  })

  it('reset-password rejects links without uid/token', async () => {
    renderApp('/reset-password')
    expect(await screen.findByRole('heading', { name: 'This link isn’t valid' })).toBeInTheDocument()
  })

  it('reset-password submits uid, token and the new password then returns to login', async () => {
    const bodies: unknown[] = []
    const { router } = renderApp('/reset-password?uid=abc&token=t-123', {
      handlers: [http.post('*/api/v1/auth/password/reset/confirm/', async ({ request }) => { bodies.push(await request.json()); return new HttpResponse(null, { status: 204 }) })],
    })
    await userEvent.type(await screen.findByLabelText(/New password/, { selector: 'input' }), 'a-brand-new-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(bodies).toEqual([{ uid: 'abc', token: 't-123', new_password: 'a-brand-new-pass' }])
    expect(await screen.findByText('Password updated')).toBeInTheDocument()
  })

  it('reset-password explains an expired link', async () => {
    renderApp('/reset-password?uid=abc&token=old', { handlers: [http.post('*/api/v1/auth/password/reset/confirm/', () => err('invalid_token', 'This link has expired.', 400))] })
    await userEvent.type(await screen.findByLabelText(/New password/, { selector: 'input' }), 'a-brand-new-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired.')
  })

  it('verify-email confirms once and reflects success', async () => {
    let calls = 0
    renderApp('/verify-email?uid=u&token=t', { handlers: [http.post('*/api/v1/auth/email/verify/', () => { calls += 1; return new HttpResponse(null, { status: 204 }) })] })
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument()
    expect(calls).toBe(1)
  })

  it('verify-email shows a helpful failure for bad tokens', async () => {
    renderApp('/verify-email?uid=u&token=bad', { handlers: [http.post('*/api/v1/auth/email/verify/', () => err('invalid_token', 'Link expired.', 400))] })
    expect(await screen.findByRole('heading', { name: 'We couldn’t verify that link' })).toBeInTheDocument()
    expect(screen.getByText(/Link expired\./)).toBeInTheDocument()
  })
})

describe('logout', () => {
  it('signs out from the account menu and goes home', async () => {
    let loggedOut = false
    const { router, setUser } = renderApp('/dashboard', {
      user: makeUser(),
      handlers: [http.post('*/api/v1/auth/logout/', () => { loggedOut = true; setUser(null); return new HttpResponse(null, { status: 204 }) })],
    })
    await userEvent.click(await screen.findByRole('button', { name: /Account menu for Ada Lovelace/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(loggedOut).toBe(true)
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })
})

function ModalProbe({ onResult }: { onResult(value: boolean): void }) {
  const { openAuthModal } = useAuthModal()
  const { status } = useAuth()
  return (
    <div>
      <p>status: {status}</p>
      <button onClick={() => void openAuthModal({ reason: 'save' }).then(onResult)}>ask</button>
    </div>
  )
}

describe('AuthModal', () => {
  function renderProbe(user: ReturnType<typeof makeUser> | null = null, handlers: RequestHandler[] = []) {
    const onResult = vi.fn()
    server.use(
      ...handlers,
      http.get('*/api/v1/auth/me/', () => HttpResponse.json({ user })),
      http.get('*/api/v1/config/', () => HttpResponse.json(makeConfig())),
    )
    document.cookie = 'csrftoken=test-token; path=/'
    render(
      <AppProviders client={createTestQueryClient()}>
        <MemoryRouter>
          <AuthModalProvider>
            <ModalProbe onResult={onResult} />
          </AuthModalProvider>
        </MemoryRouter>
      </AppProviders>,
    )
    return { onResult }
  }

  it('opens with context-specific copy, signs up and resolves true', async () => {
    const { onResult } = renderProbe(null, [http.post('*/api/v1/auth/register/', () => HttpResponse.json({ user: makeUser({ email: 'new@example.com' }) }, { status: 201 }))])
    await userEvent.click(await screen.findByRole('button', { name: 'ask' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a free account to keep this design' })
    expect(within(dialog).getByRole('tab', { name: 'Sign up', selected: true })).toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText(/Email/), 'new@example.com')
    await userEvent.type(within(dialog).getByLabelText(/^Password/, { selector: 'input' }), 'compilers-rule-1')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create free account' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('switches to Log in and resolves true after signing in', async () => {
    const { onResult } = renderProbe(null, [http.post('*/api/v1/auth/login/', () => HttpResponse.json({ user: makeUser() }))])
    await userEvent.click(await screen.findByRole('button', { name: 'ask' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Log in' }))
    await userEvent.type(within(dialog).getByLabelText(/Email/), 'ada@example.com')
    await userEvent.type(within(dialog).getByLabelText(/Password/, { selector: 'input' }), 'correct-horse')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
  })

  it('resolves false when dismissed', async () => {
    const { onResult } = renderProbe()
    await userEvent.click(await screen.findByRole('button', { name: 'ask' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resolves true immediately for signed-in users without showing a dialog', async () => {
    const { onResult } = renderProbe(makeUser())
    await screen.findByText('status: authenticated')
    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
