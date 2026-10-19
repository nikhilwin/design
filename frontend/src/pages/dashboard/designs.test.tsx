import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { renderApp } from '@/test/app'
import { server } from '@/test/msw'
import { makeDesign, makeUser, page } from '@/test/factories'
import type { DesignSummary, FolderT } from '@/types/api'

interface Call {
  method: string
  path: string
  body: unknown
}

function designsBackend(initial: DesignSummary[], folders: FolderT[] = []) {
  const state = { designs: [...initial], folders, calls: [] as Call[] }
  const record = async (request: Request, path: string) => {
    let body: unknown = null
    try {
      body = await request.clone().json()
    } catch {
      body = null
    }
    state.calls.push({ method: request.method, path, body })
  }
  const handlers = [
    http.get('*/api/v1/designs/', ({ request }) => {
      const url = new URL(request.url)
      const trashed = url.searchParams.get('trashed') === 'true'
      const q = url.searchParams.get('q')?.toLowerCase()
      const folder = url.searchParams.get('folder')
      let list = state.designs.filter((design) => Boolean(design.trashed_at) === trashed)
      if (q) list = list.filter((design) => design.title.toLowerCase().includes(q))
      if (folder === 'root') list = list.filter((design) => design.folder === null)
      else if (folder) list = list.filter((design) => design.folder === folder)
      return HttpResponse.json(page(list))
    }),
    http.get('*/api/v1/folders/', () => HttpResponse.json(page(state.folders))),
    http.patch('*/api/v1/designs/:id/', async ({ request, params }) => {
      await record(request, `/designs/${String(params.id)}/`)
      const body = (await request.clone().json()) as Partial<DesignSummary>
      state.designs = state.designs.map((design) => (design.id === params.id ? { ...design, ...body } : design))
      return HttpResponse.json(state.designs.find((design) => design.id === params.id))
    }),
    http.delete('*/api/v1/designs/trash/', async ({ request }) => {
      await record(request, '/designs/trash/')
      state.designs = state.designs.filter((design) => !design.trashed_at)
      return new HttpResponse(null, { status: 204 })
    }),
    http.delete('*/api/v1/designs/:id/', async ({ request, params }) => {
      await record(request, `/designs/${String(params.id)}/${new URL(request.url).search}`)
      if (new URL(request.url).searchParams.get('permanent')) state.designs = state.designs.filter((design) => design.id !== params.id)
      else state.designs = state.designs.map((design) => (design.id === params.id ? { ...design, trashed_at: '2025-06-01T00:00:00Z' } : design))
      return new HttpResponse(null, { status: 204 })
    }),
    http.post('*/api/v1/designs/:id/restore/', async ({ request, params }) => {
      await record(request, `/designs/${String(params.id)}/restore/`)
      state.designs = state.designs.map((design) => (design.id === params.id ? { ...design, trashed_at: null } : design))
      return HttpResponse.json(state.designs.find((design) => design.id === params.id))
    }),
    http.post('*/api/v1/designs/:id/duplicate/', async ({ request, params }) => {
      await record(request, `/designs/${String(params.id)}/duplicate/`)
      const copy = makeDesign('copy-1', { title: 'Copy of Alpha' })
      state.designs.unshift(copy)
      return HttpResponse.json(copy, { status: 201 })
    }),
    http.post('*/api/v1/designs/bulk/', async ({ request }) => {
      await record(request, '/designs/bulk/')
      const body = (await request.clone().json()) as { ids: string[]; action: string; folder?: string | null }
      state.designs = state.designs.map((design) => {
        if (!body.ids.includes(design.id)) return design
        if (body.action === 'trash') return { ...design, trashed_at: '2025-06-01T00:00:00Z' }
        if (body.action === 'restore') return { ...design, trashed_at: null }
        if (body.action === 'star') return { ...design, starred: true }
        if (body.action === 'move') return { ...design, folder: body.folder ?? null }
        return design
      })
      return HttpResponse.json({ affected: body.ids.length })
    }),
  ]
  return { state, handlers }
}

const alpha = makeDesign('1', { title: 'Alpha poster' })
const beta = makeDesign('2', { title: 'Beta deck' })
const gamma = makeDesign('3', { title: 'Gamma logo', starred: true })
const folder: FolderT = { id: 'f1', name: 'Client work', parent: null, design_count: 0, created_at: '' }

async function openDesigns(initial: DesignSummary[] = [alpha, beta, gamma], folders: FolderT[] = [], route = '/dashboard/designs') {
  const backend = designsBackend(initial, folders)
  const app = renderApp(route, { user: makeUser(), handlers: backend.handlers })
  await screen.findByRole('heading', { level: 1 })
  return { ...backend, ...app }
}

describe('designs page', () => {
  it('lists designs and folders', async () => {
    await openDesigns([alpha, beta], [folder])
    expect(await screen.findByRole('link', { name: 'Alpha poster' })).toHaveAttribute('href', '/design/1')
    expect(screen.getByRole('link', { name: 'Beta deck' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Client work' })).toHaveAttribute('href', '/dashboard/designs/folder/f1')
  })

  it('stars a design optimistically and persists it', async () => {
    const { state } = await openDesigns()
    await userEvent.click(await screen.findByRole('button', { name: 'Star Alpha poster' }))
    expect(await screen.findByRole('button', { name: 'Remove Alpha poster from starred' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(state.calls).toContainEqual({ method: 'PATCH', path: '/designs/1/', body: { starred: true } }))
  })

  it('renames inline: Enter commits, Escape cancels, blank names are ignored', async () => {
    const { state } = await openDesigns()
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for Alpha poster' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const input = await screen.findByRole('textbox', { name: 'Rename Alpha poster' })
    await userEvent.clear(input)
    await userEvent.type(input, 'Poster v2{Enter}')
    await waitFor(() => expect(state.calls).toContainEqual({ method: 'PATCH', path: '/designs/1/', body: { title: 'Poster v2' } }))
    expect(await screen.findByRole('link', { name: 'Poster v2' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'More actions for Beta deck' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const second = await screen.findByRole('textbox', { name: 'Rename Beta deck' })
    await userEvent.type(second, ' extra{Escape}')
    expect(screen.getByRole('link', { name: 'Beta deck' })).toBeInTheDocument()
    expect(state.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1)
  })

  it('moves a design to the trash and offers Undo that restores it', async () => {
    const { state } = await openDesigns()
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for Alpha poster' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to trash' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Alpha poster' })).not.toBeInTheDocument())
    const toast = await screen.findByText('Moved to trash')
    expect(toast).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(state.calls.map((call) => call.path)).toContain('/designs/1/restore/'))
    expect(await screen.findByRole('link', { name: 'Alpha poster' })).toBeInTheDocument()
  })

  it('rolls the card back and explains when trashing fails', async () => {
    const backend = designsBackend([alpha])
    renderApp('/dashboard/designs', {
      user: makeUser(),
      handlers: [http.delete('*/api/v1/designs/:id/', () => HttpResponse.json({ error: { code: 'server_error', message: 'Database offline' } }, { status: 500 })), ...backend.handlers],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for Alpha poster' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to trash' }))
    expect(await screen.findByText('Couldn’t move the design to the trash')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Alpha poster' })).toBeInTheDocument()
  })

  it('duplicates a design and offers to open the copy', async () => {
    const { state } = await openDesigns()
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for Alpha poster' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }))
    expect(await screen.findByText('Design duplicated')).toBeInTheDocument()
    expect(state.calls.map((call) => call.path)).toContain('/designs/1/duplicate/')
    expect(screen.getByRole('button', { name: 'Open copy' })).toBeInTheDocument()
  })

  it('selects several designs, shows the bulk bar and trashes them together', async () => {
    const { state } = await openDesigns()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Alpha poster' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Beta deck' }))
    const bar = screen.getByRole('region', { name: 'Selected designs' })
    expect(within(bar).getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(within(bar).getByRole('button', { name: 'Trash' }))
    await waitFor(() => expect(state.calls).toContainEqual({ method: 'POST', path: '/designs/bulk/', body: { ids: ['1', '2'], action: 'trash' } }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected designs' })).not.toBeInTheDocument())
    expect(await screen.findByText('2 designs moved to trash')).toBeInTheDocument()
  })

  it('Escape clears the selection', async () => {
    await openDesigns()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Alpha poster' }))
    expect(screen.getByRole('region', { name: 'Selected designs' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected designs' })).not.toBeInTheDocument())
  })

  it('moves selected designs into a folder from the move dialog', async () => {
    const { state } = await openDesigns([alpha, beta], [folder])
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Alpha poster' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move design' })
    await userEvent.click(await within(dialog).findByRole('button', { name: /Client work/ }))
    await waitFor(() => expect(state.calls).toContainEqual({ method: 'POST', path: '/designs/bulk/', body: { ids: ['1'], action: 'move', folder: 'f1' } }))
    expect(await screen.findByText('Moved to Client work')).toBeInTheDocument()
  })

  it('moves a design when it is dragged onto a folder', async () => {
    const { state } = await openDesigns([alpha, beta], [folder])
    const card = (await screen.findByRole('link', { name: 'Alpha poster' })).closest('article') as HTMLElement
    const folderTile = screen.getByRole('link', { name: 'Client work' }).parentElement?.parentElement as HTMLElement
    const store = new Map<string, string>()
    const dataTransfer = {
      get types() {
        return [...store.keys()]
      },
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
      dropEffect: 'none',
      effectAllowed: 'all',
    }
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.dragOver(folderTile, { dataTransfer })
    fireEvent.drop(folderTile, { dataTransfer })
    await waitFor(() => expect(state.calls).toContainEqual({ method: 'POST', path: '/designs/bulk/', body: { ids: ['1'], action: 'move', folder: 'f1' } }))
  })

  it('shows search results from the URL and a friendly empty state', async () => {
    await openDesigns([alpha, beta], [], '/dashboard/designs?q=zzz')
    expect(await screen.findByRole('heading', { name: 'Results for “zzz”' })).toBeInTheDocument()
    expect(await screen.findByText('No designs match “zzz”')).toBeInTheDocument()
  })

  it('welcomes people with no designs yet', async () => {
    await openDesigns([])
    expect(await screen.findByText('No designs yet')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Create a design' }).length).toBeGreaterThan(0)
  })

  it('remembers the grid/list choice', async () => {
    window.localStorage.removeItem('doory-designs-layout')
    await openDesigns()
    await userEvent.click(await screen.findByRole('radio', { name: 'List view' }))
    expect(window.localStorage.getItem('doory-designs-layout')).toBe('list')
    expect(document.querySelector('article[data-layout="list"]')).not.toBeNull()
  })

  it('offers retry when the list fails to load', async () => {
    let fail = true
    const backend = designsBackend([alpha])
    renderApp('/dashboard/designs', {
      user: makeUser(),
      handlers: [http.get('*/api/v1/designs/', () => (fail ? HttpResponse.json({ error: { code: 'server_error', message: 'Down' } }, { status: 500 }) : HttpResponse.json(page([alpha])))), ...backend.handlers],
    })
    expect(await screen.findByText('Your designs didn’t load')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Alpha poster' })).toBeInTheDocument()
  })

  it('loads more designs on demand', async () => {
    const first = Array.from({ length: 24 }, (_, i) => makeDesign(`p${i}`, { title: `Page one ${i}` }))
    const second = [makeDesign('late', { title: 'Late arrival' })]
    renderApp('/dashboard/designs', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/designs/', ({ request }) => {
          const index = Number(new URL(request.url).searchParams.get('page') ?? 1)
          return HttpResponse.json(index === 1 ? page(first, { next: 'http://x/?page=2', count: 25 }) : page(second, { count: 25 }))
        }),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('link', { name: 'Late arrival' })).toBeInTheDocument()
  })
})

describe('folders', () => {
  it('creates a folder in the current location', async () => {
    const { state } = await openDesigns([alpha])
    mockCreateFolder(state)
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    await userEvent.type(within(dialog).getByLabelText('Folder name'), 'Invoices')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
    expect(await screen.findByText('Folder created')).toBeInTheDocument()
    expect(state.calls).toContainEqual({ method: 'POST', path: '/folders/', body: { name: 'Invoices', parent: null } })
  })

  it('confirms before deleting a folder and explains that designs are kept', async () => {
    const { state } = await openDesigns([alpha], [folder])
    state.folders = [folder]
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for folder Client work' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete folder' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete folder “Client work”?' })
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeInTheDocument()
  })
})

function mockCreateFolder(state: { calls: Call[] }) {
  server.use(
    http.post('*/api/v1/folders/', async ({ request }) => {
      const body = (await request.json()) as { name: string; parent: string | null }
      state.calls.push({ method: 'POST', path: '/folders/', body })
      return HttpResponse.json({ id: 'new', name: body.name, parent: body.parent, design_count: 0, created_at: '' }, { status: 201 })
    }),
  )
}
