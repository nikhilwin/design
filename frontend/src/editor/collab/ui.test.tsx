import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PresenceStack } from '../chrome/PresenceStack'
import { EditorProvider } from '../EditorProvider'
import { SaveStatus } from '../SaveStatus'
import { PresenceLayer } from '../workspace/PresenceLayer'
import { installImageStub } from '../test/imageStub'
import { CollabBanner } from './CollabBanner'
import { type Peer, frames, open, owner, seedDocument } from './engineTesting'
import { FakeCollabServer } from './fakeServer'

async function room(): Promise<{ server: FakeCollabServer; me: Peer; bo: Peer; cy: Peer }> {
  const seed = await seedDocument()
  const server = new FakeCollabServer(seed)
  const me = await open(server, owner('u1', 'Ada Lovelace'), seed)
  const bo = await open(server, owner('u2', 'Bo Peep'), seed)
  const cy = await open(server, owner('u3', 'Cy'), seed)
  await frames()
  return { server, me, bo, cy }
}

function mount(peer: Peer, ui: React.ReactNode) {
  return render(
    <EditorProvider engine={peer.engine} portalRoot={document.body} collab={peer.session}>
      {ui}
    </EditorProvider>,
  )
}

// Two editors and a server in one test take a moment on a busy machine.
vi.setConfig({ testTimeout: 30_000 })

describe('presence in the editor', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub()
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['thumb'], { type: 'image/webp' })))
  })
  afterEach(() => {
    restore()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('lists the other people as avatars with accessible names, and follows one on click or Enter', async () => {
    const { me, bo, cy } = await room()
    mount(me, <PresenceStack />)
    const group = await screen.findByRole('group', { name: /People in this design: Bo Peep, Cy/ })
    const buttons = within(group).getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toHaveAccessibleName('Follow Bo Peep')
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false')
    expect(within(group).getByText('BP')).toBeInTheDocument()
    await userEvent.click(buttons[0])
    expect(buttons[0]).toHaveAccessibleName('Stop following Bo Peep')
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true')
    expect(me.session.presence.store.getState().following).toBe(bo.session.awareness.clientID)
    buttons[1].focus()
    await userEvent.keyboard('{Enter}')
    expect(me.session.presence.store.getState().following).toBe(cy.session.awareness.clientID)
    for (const peer of [me, bo, cy]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('shows nothing when nobody else is there, and nothing without a session', async () => {
    const seed = await seedDocument()
    const server = new FakeCollabServer(seed)
    const me = await open(server, owner('u1', 'Ada'), seed)
    await frames()
    const { container } = mount(me, <PresenceStack />)
    expect(container).toBeEmptyDOMElement()
    me.session.destroy()
    me.engine.dispose()
    const alone = render(
      <EditorProvider engine={me.engine} portalRoot={document.body}>
        <PresenceStack />
        <CollabBanner />
      </EditorProvider>,
    )
    expect(alone.container).toBeEmptyDOMElement()
  })

  it('draws the pointer and the selection of others on their page, and the lock badge for text being edited', async () => {
    const { me, bo, cy } = await room()
    const bobs = bo.session.presence
    bobs.setCursor({ pageId: 'page-1', x: 120, y: 80 })
    bo.engine.select(['rect-1'])
    await frames()
    await act(async () => {
      await frames()
    })
    mount(me, <PresenceLayer pageId="page-1" zoom={0.5} />)
    const cursor = await screen.findByTestId('remote-cursor')
    expect(cursor).toHaveAttribute('data-user', 'Bo Peep')
    expect(cursor.style.transform).toBe('translate(60px, 40px)')
    expect(screen.getByTestId('remote-selection')).toHaveAttribute('data-user', 'Bo Peep')
    expect(screen.queryByTestId('text-lock-badge')).not.toBeInTheDocument()
    expect(screen.getAllByText('Bo Peep', { selector: 'span' }).length).toBeGreaterThanOrEqual(2)
    for (const peer of [me, bo, cy]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('has nothing to draw on a page nobody is on', async () => {
    const { me, bo, cy } = await room()
    bo.session.presence.setCursor({ pageId: 'page-1', x: 1, y: 1 })
    await frames()
    const { container } = mount(me, <PresenceLayer pageId="another" zoom={1} />)
    expect(container).toBeEmptyDOMElement()
    for (const peer of [me, bo, cy]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })
})

describe('the save pill and the banner while live', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub()
  })
  afterEach(() => {
    restore()
    document.body.innerHTML = ''
  })

  async function lone() {
    const seed = await seedDocument()
    const server = new FakeCollabServer(seed)
    const me = await open(server, owner('u1', 'Ada'), seed)
    await frames()
    return me
  }

  it.each([
    [{ status: 'live' as const }, /^Live$/],
    [{ status: 'read-only' as const, canWrite: false }, /Watching live/],
    [{ status: 'connecting' as const, synced: false, canWrite: false }, /Connecting…/],
    [{ status: 'offline' as const, attempt: 1 }, /Reconnecting…/],
    [{ status: 'offline' as const, attempt: 4 }, /Offline. Changes will sync/],
    [{ status: 'busy' as const }, /Server busy/],
    [{ status: 'signed-out' as const }, /Signed out/],
    [{ status: 'forbidden' as const }, /No access/],
    [{ status: 'not-found' as const }, /Design not found/],
    [{ status: 'too-large' as const }, /Too large to sync/],
  ])('says %o', async (patch, text) => {
    const me = await lone()
    me.session.store.setState({ ...patch })
    mount(me, <SaveStatus />)
    expect(screen.getByTestId('collab-status')).toHaveTextContent(text)
    me.session.destroy()
    me.engine.dispose()
  })

  it('goes back to the ordinary pill once live editing has been given up', async () => {
    const me = await lone()
    me.session.store.setState({ status: 'fallback' })
    mount(me, <SaveStatus />)
    expect(screen.queryByTestId('collab-status')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    me.session.destroy()
    me.engine.dispose()
  })

  it('counts people, not connections', async () => {
    const { me, bo, cy } = await room()
    mount(me, <SaveStatus />)
    expect(await screen.findByText('Live · 3 people')).toBeInTheDocument()
    for (const peer of [me, bo, cy]) {
      peer.session.destroy()
      peer.engine.dispose()
    }
  })

  it('shows what happened and what to do about it', async () => {
    const me = await lone()
    mount(me, <CollabBanner />)
    expect(screen.queryByTestId('collab-banner')).not.toBeInTheDocument()
    act(() => me.session.store.setState({ notice: { tone: 'warning', title: 'Your session ended', body: 'Sign in again.', action: 'sign-in' } }))
    expect(screen.getByTestId('collab-banner')).toHaveTextContent('Your session ended')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('collab-banner')).not.toBeInTheDocument()
    act(() => me.session.store.setState({ notice: { tone: 'error', title: 'This design is too large to sync', body: 'Reload.', action: 'reload' } }))
    expect(screen.getByRole('alert')).toHaveTextContent('too large')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    me.session.destroy()
    me.engine.dispose()
  })
})
