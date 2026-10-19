import 'fake-indexeddb/auto'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { createBlankDocument } from '@/lib/document'
import { createLocalDesign, getLocalDesign, listLocalDesigns, localRepository } from '@/lib/local'
import { renderApp } from '@/test/app'
import { makeConfig, makeDesign, makeTemplate, makeUser } from '@/test/factories'
import type { EditorAppProps } from '@/types/adapter'

/** Minimal stand-in for the real editor: renders the shell's slots and exposes the adapter. */
vi.mock('@/editor', async () => {
  const react = await import('react')
  const EditorApp = react.forwardRef<unknown, EditorAppProps>(function FakeEditor(props, ref) {
    react.useImperativeHandle(ref, () => ({ saveNow: async () => undefined, getDocument: () => props.document, isDirty: () => false }))
    return react.createElement(
      'div',
      { 'data-testid': 'editor', 'data-mode': props.meta.mode, 'data-revision': String(props.meta.revision ?? ''), 'data-room': props.adapter.realtime?.url ?? '' },
      props.topBarStart,
      react.createElement('h1', null, props.meta.title),
      props.topBarEnd,
      react.createElement('button', { onClick: () => void props.adapter.save({ document: props.document, title: props.meta.title }).catch((error: unknown) => window.dispatchEvent(new CustomEvent('fake-editor-error', { detail: error }))) }, 'fake save'),
    )
  })
  return { EditorApp }
})

const json = (body: object, status = 200) => HttpResponse.json(body as Record<string, unknown>, { status })
const err = (code: string, message: string, status: number, extra: Record<string, unknown> = {}) => json({ error: { code, message, ...extra } }, status)

function designDetail(id: string, overrides: Record<string, unknown> = {}) {
  return { ...makeDesign(id, { title: 'Server design', revision: 7 }), document: createBlankDocument(1080, 1080), ...overrides }
}

beforeEach(async () => {
  await localRepository.clear()
})

describe('/create', () => {
  it('guests get a local design from a preset and land in /local/:id', async () => {
    const { router } = renderApp('/create?preset=a4')
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/local\/[0-9a-f-]{36}$/))
    const saved = await listLocalDesigns()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ width: 794, height: 1123 })
    const stored = await getLocalDesign(saved[0].id)
    expect(stored?.document.meta?.presetId).toBe('a4')
    expect(stored?.document.unit).toBe('mm')
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-mode', 'guest')
  })

  it('defaults to the Instagram post size and honours custom sizes', async () => {
    const first = renderApp('/create')
    await waitFor(() => expect(first.router.state.location.pathname).toMatch(/^\/local\//))
    first.unmount()
    const second = renderApp('/create?w=30&h=20&unit=cm')
    await waitFor(() => expect(second.router.state.location.pathname).toMatch(/^\/local\//))
    const sizes = (await listLocalDesigns()).map((design) => `${design.width}x${design.height}`).sort()
    expect(sizes).toEqual(['1080x1080', '1134x756'])
  })

  it('guests starting from a template copy its document locally', async () => {
    const templateDoc = createBlankDocument(1920, 1080, { presetId: 'presentation' })
    templateDoc.pages[0].objects = [{ id: 'o1', type: 'textbox', text: 'Hello' }]
    const { router } = renderApp('/create?template=pitch-deck', {
      handlers: [http.get('*/api/v1/templates/pitch-deck/', () => json({ ...makeTemplate('pitch-deck', { title: 'Pitch deck', width: 1920, height: 1080 }), description: '', document: templateDoc }))],
    })
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/local\//))
    const [summary] = await listLocalDesigns()
    expect(summary.title).toBe('Pitch deck')
    expect((await getLocalDesign(summary.id))?.document.pages[0].objects).toHaveLength(1)
  })

  it('shows a friendly page for an unknown template', async () => {
    renderApp('/create?template=missing', { handlers: [http.get('*/api/v1/templates/missing/', () => err('not_found', 'Not found.', 404))] })
    expect(await screen.findByText('We can’t find that design')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Browse templates' })).toBeInTheDocument()
  })

  it('signed-in users get a real design and go to /design/:id', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { router } = renderApp('/create?preset=poster', {
      user: makeUser(),
      handlers: [
        http.post('*/api/v1/designs/', async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>)
          return json(designDetail('server-1'), 201)
        }),
        http.get('*/api/v1/designs/server-1/', () => json(designDetail('server-1'))),
      ],
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/design/server-1'))
    expect(bodies[0]).toMatchObject({ width: 1728, height: 2304, preset: 'poster' })
    expect(await listLocalDesigns()).toEqual([])
  })

  it('signed-in template use goes through POST /templates/:slug/use/', async () => {
    const { router } = renderApp('/create?template=pitch-deck', {
      user: makeUser(),
      handlers: [http.post('*/api/v1/templates/pitch-deck/use/', () => json(designDetail('from-template'), 201)), http.get('*/api/v1/designs/from-template/', () => json(designDetail('from-template')))],
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/design/from-template'))
  })
})

describe('/local/:localId', () => {
  it('mounts the editor in guest mode with the way to an account (the editor itself says where the design is saved)', async () => {
    const local = await createLocalDesign({ title: 'My poster', document: createBlankDocument(800, 600) })
    renderApp(`/local/${local.id}`)
    const editor = await screen.findByTestId('editor')
    expect(editor).toHaveAttribute('data-mode', 'guest')
    expect(within(editor).getByRole('heading', { name: 'My poster' })).toBeInTheDocument()
    expect(within(editor).getByRole('button', { name: 'Sign up' })).toBeInTheDocument()
    expect(within(editor).getByRole('link', { name: 'Doory home' })).toHaveAttribute('href', '/')
  })

  it('explains when the design is not in this browser', async () => {
    renderApp('/local/00000000-0000-4000-8000-000000000000')
    expect(await screen.findByText('This design isn’t in this browser')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Start a new design' })).toHaveAttribute('href', '/create')
  })

  it('autosave through the guest adapter writes to IndexedDB', async () => {
    const local = await createLocalDesign({ title: 'Draft', document: createBlankDocument(100, 100) })
    renderApp(`/local/${local.id}`)
    await userEvent.click(await screen.findByRole('button', { name: 'fake save' }))
    await waitFor(async () => expect((await localRepository.getDesign(local.id))?.updatedAt).toBeGreaterThanOrEqual(local.updatedAt))
  })

  it('guest → account: sign up from the banner migrates the design and switches to /design/:id', async () => {
    const doc = createBlankDocument(640, 480)
    const local = await createLocalDesign({ title: 'Keep me', document: doc })
    let created: Record<string, unknown> | null = null
    let signedUp = false
    const { router } = renderApp(`/local/${local.id}`, {
      handlers: [
        http.post('*/api/v1/auth/register/', () => {
          signedUp = true
          return json({ user: makeUser({ email: 'new@example.com' }) }, 201)
        }),
        http.post('*/api/v1/designs/', async ({ request }) => {
          created = (await request.json()) as Record<string, unknown>
          return json(designDetail('migrated-1', { title: 'Keep me' }), 201)
        }),
        http.get('*/api/v1/designs/migrated-1/', () => json(designDetail('migrated-1', { title: 'Keep me' }))),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Sign up' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a free account to keep this design' })
    await userEvent.type(within(dialog).getByLabelText(/Email/), 'new@example.com')
    await userEvent.type(within(dialog).getByLabelText(/^Password/, { selector: 'input' }), 'compilers-rule-1')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create free account' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/design/migrated-1'))
    expect(signedUp).toBe(true)
    expect(created).toMatchObject({ title: 'Keep me', width: 640, height: 480 })
    expect(await getLocalDesign(local.id)).toBeNull()
    expect(await screen.findByText('Saved to your account')).toBeInTheDocument()
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-mode', 'account')
  })

  it('guest → account: a failed migration keeps the local copy and offers a working retry', async () => {
    const local = await createLocalDesign({ title: 'Precious', document: createBlankDocument(640, 480) })
    let attempts = 0
    const { router } = renderApp(`/local/${local.id}`, {
      user: makeUser(),
      handlers: [
        http.post('*/api/v1/designs/', () => {
          attempts += 1
          return attempts <= 3 ? err('server_error', 'Database offline', 500) : json(designDetail('retry-ok', { title: 'Precious' }), 201)
        }),
        http.get('*/api/v1/designs/retry-ok/', () => json(designDetail('retry-ok'))),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Save to account' }))
    expect(await screen.findByText('We couldn’t save to your account', undefined, { timeout: 8000 })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/local/${local.id}`)
    expect(await getLocalDesign(local.id)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/design/retry-ok'), { timeout: 8000 })
    expect(await getLocalDesign(local.id)).toBeNull()
  }, 20_000)
})

describe('/design/:id', () => {
  it('loads the design and mounts the account editor at the right revision', async () => {
    renderApp('/design/abc', { user: makeUser(), handlers: [http.get('*/api/v1/designs/abc/', () => json(designDetail('abc')))] })
    const editor = await screen.findByTestId('editor')
    expect(editor).toHaveAttribute('data-mode', 'account')
    expect(editor).toHaveAttribute('data-revision', '7')
    expect(within(editor).getByRole('link', { name: 'Back to your dashboard' })).toHaveAttribute('href', '/dashboard')
  })

  it('saves with the loaded revision as base_revision', async () => {
    const bodies: Array<Record<string, unknown>> = []
    renderApp('/design/abc', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/designs/abc/', () => json(designDetail('abc'))),
        http.patch('*/api/v1/designs/abc/', async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>)
          return json(designDetail('abc', { revision: 8 }))
        }),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'fake save' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ base_revision: 7, title: 'Server design' })
    await userEvent.click(screen.getByRole('button', { name: 'fake save' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toMatchObject({ base_revision: 8 })
  })

  it.each([
    [404, 'We can’t find that design'],
    [403, 'You don’t have access to this design'],
    [500, 'This design didn’t load'],
  ])('shows a friendly page for a %i answer', async (status, title) => {
    renderApp('/design/abc', { user: makeUser(), handlers: [http.get('*/api/v1/designs/abc/', () => err('x', 'nope', status))] })
    expect(await screen.findByText(title)).toBeInTheDocument()
  })

  it('shows the offline page when the network is down, and retries', async () => {
    let down = true
    renderApp('/design/abc', { user: makeUser(), handlers: [http.get('*/api/v1/designs/abc/', () => (down ? HttpResponse.error() : json(designDetail('abc'))))] })
    expect(await screen.findByText('You’re offline')).toBeInTheDocument()
    down = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('editor')).toBeInTheDocument()
  })

  it('offers to restore a design that is in the trash instead of opening it', async () => {
    renderApp('/design/abc', { user: makeUser(), handlers: [http.get('*/api/v1/designs/abc/', () => json(designDetail('abc', { trashed_at: '2025-06-01T00:00:00Z' })))] })
    expect(await screen.findByText('This design is in the trash')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore design' })).toBeInTheDocument()
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument()
  })

  it('requires sign-in', async () => {
    const { router } = renderApp('/design/abc')
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.search).toContain(encodeURIComponent('/design/abc'))
  })
})

function shared(role: 'view' | 'comment' | 'edit', extra: Record<string, unknown> = {}) {
  return { design_id: '2b17df55-1a46-45dc-a6e7-71ac16776d1b', role, title: 'Shared poster', width: 800, height: 600, revision: 4, owner: { name: 'Grace Hopper', avatar_url: null }, document: createBlankDocument(800, 600), ...extra }
}

describe('/s/:token', () => {
  it.each([
    ['view', 'shared-view'],
    ['comment', 'shared-comment'],
  ] as const)('opens %s links in %s mode for anyone', async (role, mode) => {
    renderApp('/s/tok123', { handlers: [http.get('*/api/v1/shared/tok123/', () => json(shared(role)))] })
    const editor = await screen.findByTestId('editor')
    expect(editor).toHaveAttribute('data-mode', mode)
    expect(within(editor).getByText('Shared by Grace Hopper')).toBeInTheDocument()
    expect(within(editor).getByRole('link', { name: 'Design your own' })).toHaveAttribute('href', '/create')
  })

  it('view links never save', async () => {
    renderApp('/s/tok123', { handlers: [http.get('*/api/v1/shared/tok123/', () => json(shared('view')))] })
    const errors: unknown[] = []
    window.addEventListener('fake-editor-error', (event) => errors.push((event as CustomEvent).detail))
    await userEvent.click(await screen.findByRole('button', { name: 'fake save' }))
    await waitFor(() => expect(errors).toHaveLength(1))
    expect((errors[0] as Error).name).toBe('ReadOnlyDesignError')
  })

  it('asks for the password, sends it in X-Share-Password and shows the design', async () => {
    const seen: Array<string | null> = []
    renderApp('/s/locked', {
      handlers: [
        http.get('*/api/v1/shared/locked/', ({ request }) => {
          const password = request.headers.get('x-share-password')
          seen.push(password)
          if (!password) return err('password_required', 'A password is required.', 403)
          return password === 'open-sesame' ? json(shared('view')) : err('invalid_password', 'Wrong password.', 403)
        }),
      ],
    })
    expect(await screen.findByRole('heading', { name: 'This design is protected' })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Open design' }))
    expect(await screen.findByText('That password isn’t right. Try again.')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Password'))
    await userEvent.type(screen.getByLabelText('Password'), 'open-sesame')
    await userEvent.click(screen.getByRole('button', { name: 'Open design' }))
    expect(await screen.findByTestId('editor')).toBeInTheDocument()
    expect(seen).toEqual([null, 'wrong', 'open-sesame'])
  })

  it('explains revoked, expired or unknown links', async () => {
    renderApp('/s/gone', { handlers: [http.get('*/api/v1/shared/gone/', () => err('not_found', 'Not found.', 404))] })
    expect(await screen.findByText('This link doesn’t work')).toBeInTheDocument()
  })

  it('edit links need an account: guests see a sign-in prompt, signed-in users get shared-edit', async () => {
    const handlers = [http.get('*/api/v1/shared/edit1/', () => json(shared('edit')))]
    const guest = renderApp('/s/edit1', { handlers })
    expect(await screen.findByText('Sign in to edit “Shared poster”')).toBeInTheDocument()
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to edit' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    guest.unmount()

    renderApp('/s/edit1', { user: makeUser(), handlers })
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-mode', 'shared-edit')
  })
})

describe('live rooms', () => {
  beforeEach(() => {
    // The pages open the room's connection as soon as they mount; there is no server here to answer it.
    vi.stubGlobal(
      'WebSocket',
      class {
        binaryType = ''
        readyState = 0
        onopen = null
        onmessage = null
        onclose = null
        onerror = null
        send() {}
        close() {}
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const live = makeConfig({ features: { stock_photos: false, server_pdf: false, google_login: false, email_verification: false, realtime: true } })

  it('the account editor gets its design\'s room when the server has real-time editing, and none otherwise', async () => {
    const handlers = [http.get('*/api/v1/designs/abc/', () => json(designDetail('abc')))]
    const on = renderApp('/design/abc', { user: makeUser(), config: live, handlers })
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-room', expect.stringMatching(/^wss?:\/\/[^/]+\/ws\/designs\/abc\/$/))
    on.unmount()
    renderApp('/design/abc', { user: makeUser(), handlers })
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-room', '')
  })

  it('a signed-in visitor of a share link joins the design\'s room, an anonymous one keeps the static view', async () => {
    const handlers = [http.get('*/api/v1/shared/view1/', () => json(shared('view')))]
    const signedIn = renderApp('/s/view1', { user: makeUser(), config: live, handlers })
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-room', expect.stringMatching(/\/ws\/designs\/2b17df55-1a46-45dc-a6e7-71ac16776d1b\/$/))
    signedIn.unmount()
    renderApp('/s/view1', { config: live, handlers })
    const editor = await screen.findByTestId('editor')
    expect(editor).toHaveAttribute('data-mode', 'shared-view')
    expect(editor).toHaveAttribute('data-room', '')
  })

  it('edit links join the room with the visitor\'s account', async () => {
    renderApp('/s/edit1', { user: makeUser(), config: live, handlers: [http.get('*/api/v1/shared/edit1/', () => json(shared('edit')))] })
    const editor = await screen.findByTestId('editor')
    expect(editor).toHaveAttribute('data-mode', 'shared-edit')
    expect(editor).toHaveAttribute('data-room', expect.stringContaining('/ws/designs/'))
  })
})
