import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { createBlankDocument } from '@/lib/document'
import { renderApp } from '@/test/app'
import { makeConfig, makeDesign, makeUser } from '@/test/factories'
import type { EditorAppProps } from '@/types/adapter'

/** Stand-in for the editor: a save button that reports what the adapter did, and a `saveNow` the shell can call. */
vi.mock('@/editor', async () => {
  const react = await import('react')
  const EditorApp = react.forwardRef<unknown, EditorAppProps>(function FakeEditor(props, ref) {
    react.useImperativeHandle(ref, () => ({
      saveNow: async () => {
        window.dispatchEvent(new CustomEvent('fake-editor-save-now'))
      },
      getDocument: () => props.document,
      isDirty: () => false,
    }))
    return react.createElement('div', { 'data-testid': 'editor' }, react.createElement('button', { onClick: () => void props.adapter.save({ document: props.document, title: props.meta.title }).catch(() => undefined) }, 'fake save'))
  })
  return { EditorApp }
})

const json = (body: object, status = 200) => HttpResponse.json(body as Record<string, unknown>, { status })
const detail = () => ({ ...makeDesign('d1', { title: 'Server design', revision: 3 }), document: createBlankDocument(1080, 1080) })
const expired = () => json({ error: { code: 'not_authenticated', message: 'Authentication credentials were not provided.' } }, 401)

describe('the session ends while a design is open', () => {
  it('keeps the editor on screen and asks for the password of the same account', async () => {
    const owner = makeUser({ id: 'u-owner', email: 'owner@example.test' })
    const { router } = renderApp('/design/d1', {
      user: owner,
      config: makeConfig(),
      handlers: [http.get('*/api/v1/designs/d1/', () => json(detail())), http.patch('*/api/v1/designs/d1/', expired)],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'fake save' }))

    const dialog = await screen.findByRole('dialog', { name: 'Your session ended' })
    expect(router.state.location.pathname).toBe('/design/d1')
    expect(screen.getByTestId('editor')).toBeInTheDocument()
    const email = within(dialog).getByRole('textbox', { name: /Email/ })
    expect(email).toHaveValue('owner@example.test')
    expect(email).toHaveAttribute('readonly')
    expect(within(dialog).queryByRole('tab', { name: 'Sign up' })).not.toBeInTheDocument()
  })

  it('shows a bar over the editor once the dialog is dismissed, and brings the dialog back from it', async () => {
    renderApp('/design/d1', {
      user: makeUser(),
      config: makeConfig(),
      handlers: [http.get('*/api/v1/designs/d1/', () => json(detail())), http.patch('*/api/v1/designs/d1/', expired)],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'fake save' }))
    await screen.findByRole('dialog', { name: 'Your session ended' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const bar = screen.getByRole('alert')
    expect(bar).toHaveTextContent('Your session ended')
    expect(bar).toHaveTextContent('ada@example.com')
    await userEvent.click(within(bar).getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('dialog', { name: 'Your session ended' })).toBeInTheDocument()
  })

  it('refuses a sign-in as somebody else, and after the right one tells the editor to save', async () => {
    const owner = makeUser({ id: 'u-owner', email: 'owner@example.test' })
    const stranger = makeUser({ id: 'u-stranger', email: 'owner@example.test' })
    let logins = 0
    let loggedOut = 0
    const saves: Event[] = []
    window.addEventListener('fake-editor-save-now', (event) => saves.push(event))
    renderApp('/design/d1', {
      user: owner,
      handlers: [
        http.get('*/api/v1/designs/d1/', () => json(detail())),
        http.patch('*/api/v1/designs/d1/', expired),
        http.post('*/api/v1/auth/login/', () => {
          logins += 1
          return json({ user: logins === 1 ? stranger : owner })
        }),
        http.post('*/api/v1/auth/logout/', () => {
          loggedOut += 1
          return new HttpResponse(null, { status: 204 })
        }),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'fake save' }))
    const dialog = await screen.findByRole('dialog', { name: 'Your session ended' })
    const password = dialog.querySelector('input[name="password"]')
    if (!(password instanceof HTMLInputElement)) throw new Error('no password field')
    await userEvent.type(password, 'a long enough passphrase')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Log in' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not the account this design belongs to')
    expect(loggedOut).toBe(1)
    expect(saves).toHaveLength(0)

    await userEvent.click(within(dialog).getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(saves.length, 'save requests').toBe(1))
    expect(screen.getByTestId('editor')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a session that was never there still goes to the login page', async () => {
    const { router } = renderApp('/design/d1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.search).toBe('?next=%2Fdesign%2Fd1')
  })
})
