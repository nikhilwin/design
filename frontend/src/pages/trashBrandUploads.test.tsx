import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { renderApp } from '@/test/app'
import { makeDesign, makeUser, page } from '@/test/factories'
import type { Asset, BrandKit } from '@/types/api'

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

describe('trash page', () => {
  const trashed = [makeDesign('t1', { title: 'Old poster', trashed_at: daysAgo(5) }), makeDesign('t2', { title: 'Older logo', trashed_at: daysAgo(29) })]

  it('lists trashed designs with an auto-purge countdown', async () => {
    renderApp('/dashboard/trash', { user: makeUser(), handlers: [http.get('*/api/v1/designs/', ({ request }) => HttpResponse.json(page(new URL(request.url).searchParams.get('trashed') === 'true' ? trashed : [])))] })
    expect(await screen.findByText('Old poster')).toBeInTheDocument()
    expect(screen.getByText(/25 days left/)).toBeInTheDocument()
    expect(screen.getByText(/1 day left/)).toBeInTheDocument()
    expect(screen.getByText(/deleted automatically after 30 days/)).toBeInTheDocument()
  })

  it('restores a design', async () => {
    const calls: string[] = []
    renderApp('/dashboard/trash', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/designs/', () => HttpResponse.json(page(trashed))),
        http.post('*/api/v1/designs/:id/restore/', ({ params }) => {
          calls.push(String(params.id))
          return HttpResponse.json(makeDesign(String(params.id)))
        }),
      ],
    })
    const row = (await screen.findByText('Old poster')).closest('li') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(calls).toEqual(['t1']))
    expect(await screen.findByText('Design restored')).toBeInTheDocument()
  })

  it('asks before deleting forever, and then calls the permanent delete', async () => {
    const urls: string[] = []
    renderApp('/dashboard/trash', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/designs/', () => HttpResponse.json(page(trashed))),
        http.delete('*/api/v1/designs/:id/', ({ request }) => {
          urls.push(request.url)
          return new HttpResponse(null, { status: 204 })
        }),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Old poster forever' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(urls).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete forever' }))
    await waitFor(() => expect(urls[0]).toContain('permanent=true'))
  })

  it('empties the trash only after confirmation', async () => {
    let emptied = false
    renderApp('/dashboard/trash', {
      user: makeUser(),
      handlers: [http.get('*/api/v1/designs/', () => HttpResponse.json(page(emptied ? [] : trashed))), http.delete('*/api/v1/designs/trash/', () => { emptied = true; return new HttpResponse(null, { status: 204 }) })],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Empty trash' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Empty the trash?' })
    expect(emptied).toBe(false)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Empty trash' }))
    expect(await screen.findByText('The trash is empty')).toBeInTheDocument()
  })

  it('shows the empty state and disables Empty trash when there is nothing to remove', async () => {
    renderApp('/dashboard/trash', { user: makeUser() })
    expect(await screen.findByText('The trash is empty')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Empty trash' })).toBeDisabled()
  })
})

const asset = (id: string, name: string, overrides: Partial<Asset> = {}): Asset => ({ id, kind: 'image', name, url: `/media/${name}`, thumb_url: `/media/t-${name}`, width: 100, height: 50, size: 2048, mime: 'image/png', tags: [], attribution: null, created_at: '', ...overrides })

describe('uploads page', () => {
  it('shows the library, storage meter and tags', async () => {
    renderApp('/dashboard/uploads', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/assets/', () => HttpResponse.json(page([asset('a1', 'cat.png', { tags: ['pets', 'photo'] })]))),
        http.get('*/api/v1/assets/usage/', () => HttpResponse.json({ used_bytes: 5 * 1024 * 1024, quota_bytes: 100 * 1024 * 1024 })),
      ],
    })
    expect(await screen.findByText('cat.png')).toBeInTheDocument()
    expect(screen.getByText('pets')).toBeInTheDocument()
    expect(await screen.findByText(/of 100 MB used/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Storage used' })).toHaveAttribute('value', '5')
  })

  it('renames an upload and edits its tags', async () => {
    const patches: unknown[] = []
    renderApp('/dashboard/uploads', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/assets/', () => HttpResponse.json(page([asset('a1', 'cat.png')]))),
        http.patch('*/api/v1/assets/:id/', async ({ request }) => {
          patches.push(await request.json())
          return HttpResponse.json(asset('a1', 'kitten.png', { tags: ['pets'] }))
        }),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for cat.png' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit upload' })
    const name = within(dialog).getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'kitten.png')
    await userEvent.type(within(dialog).getByLabelText('Tags'), ' Pets, pets ')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patches).toEqual([{ name: 'kitten.png', tags: ['pets'] }]))
    expect(await screen.findByText('kitten.png')).toBeInTheDocument()
  })

  it('warns that designs lose a deleted image, then deletes it', async () => {
    const deleted: string[] = []
    renderApp('/dashboard/uploads', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/assets/', () => HttpResponse.json(page([asset('a1', 'cat.png')]))),
        http.delete('*/api/v1/assets/:id/', ({ params }) => {
          deleted.push(String(params.id))
          return new HttpResponse(null, { status: 204 })
        }),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for cat.png' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/will no longer show it/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete image' }))
    await waitFor(() => expect(deleted).toEqual(['a1']))
    await waitFor(() => expect(screen.queryByText('cat.png')).not.toBeInTheDocument())
  })

  it('validates dropped files and shows per-file errors without calling the API', async () => {
    let uploads = 0
    renderApp('/dashboard/uploads', { user: makeUser(), handlers: [http.post('*/api/v1/assets/', () => { uploads += 1; return HttpResponse.json({}, { status: 201 }) })] })
    const zone = (await screen.findByText('Drag and drop images here')).closest('div') as HTMLElement
    const bad = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })
    fireEvent.drop(zone, { dataTransfer: { files: [bad], types: ['Files'] } })
    const list = await screen.findByRole('list', { name: 'Uploads' })
    expect(within(list).getByText('doc.pdf')).toBeInTheDocument()
    expect(within(list).getByRole('alert')).toHaveTextContent('Only PNG, JPG, WebP, GIF, AVIF and SVG')
    expect(uploads).toBe(0)
  })

  it('shows an empty state for a new library', async () => {
    renderApp('/dashboard/uploads', { user: makeUser() })
    expect(await screen.findByText('No uploads yet')).toBeInTheDocument()
  })
})

const kit = (overrides: Partial<BrandKit> = {}): BrandKit => ({
  id: 'k1',
  name: 'Doory brand',
  is_default: true,
  colors: [
    { id: 'c1', name: 'Doory red', hex: '#e11d48' },
    { id: 'c2', name: '', hex: '#1c1517' },
  ],
  fonts: [{ role: 'heading', family: 'Playfair Display' }],
  logos: [],
  created_at: '',
  updated_at: '',
  ...overrides,
})

describe('brand kits page', () => {
  it('lists kits with colours, fonts and a default badge', async () => {
    renderApp('/dashboard/brand', { user: makeUser(), handlers: [http.get('*/api/v1/brand-kits/', () => HttpResponse.json([kit(), kit({ id: 'k2', name: 'Side', is_default: false })]))] })
    expect(await screen.findByRole('heading', { name: 'Doory brand' })).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: 'Doory red #e11d48' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Playfair Display/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Make default' })).toBeInTheDocument()
  })

  it('creates a kit with colours (hex normalised) and a font', async () => {
    const bodies: Array<Record<string, unknown>> = []
    renderApp('/dashboard/brand', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/fonts/', () => HttpResponse.json(page([{ id: 'f1', family: 'Inter', category: 'sans-serif', scripts: [], is_variable: true, is_user_font: false, variants: [], popularity: 1 }]))),
        http.post('*/api/v1/brand-kits/', async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>)
          return HttpResponse.json(kit({ id: 'new', name: 'Fresh' }), { status: 201 })
        }),
      ],
    })
    await userEvent.click((await screen.findAllByRole('button', { name: 'New brand kit' }))[0])
    const dialog = await screen.findByRole('dialog', { name: 'New brand kit' })
    await userEvent.type(within(dialog).getByLabelText('Kit name'), 'Fresh')
    const hex = within(dialog).getByLabelText('Colour 1 hex')
    await userEvent.clear(hex)
    await userEvent.type(hex, 'ABC')
    await userEvent.selectOptions(await within(dialog).findByLabelText('Heading font'), 'Inter')
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Use as my default kit' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create kit' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ name: 'Fresh', is_default: true, fonts: [{ role: 'heading', family: 'Inter' }], logo_ids: [] })
    expect((bodies[0].colors as Array<{ hex: string }>)[0].hex).toBe('#aabbcc')
  })

  it('offers every font of the catalogue, not only the first page', async () => {
    const family = (index: number) => ({ id: `f${index}`, family: `Family ${String(index).padStart(3, '0')}`, category: 'sans-serif', scripts: [], is_variable: false, is_user_font: false, variants: [], popularity: index })
    const requested: string[] = []
    renderApp('/dashboard/brand', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/fonts/', ({ request }) => {
          const url = new URL(request.url)
          requested.push(url.search)
          const pageNumber = Number(url.searchParams.get('page') ?? '1')
          const results = pageNumber === 1 ? Array.from({ length: 100 }, (_, i) => family(i + 1)) : Array.from({ length: 30 }, (_, i) => family(i + 101))
          return HttpResponse.json(page(results, { next: pageNumber === 1 ? 'http://x/?page=2' : null, count: 130 }))
        }),
      ],
    })
    await userEvent.click((await screen.findAllByRole('button', { name: 'New brand kit' }))[0])
    const dialog = await screen.findByRole('dialog', { name: 'New brand kit' })
    const select = await within(dialog).findByLabelText('Heading font')
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(131))
    expect(within(select).getByRole('option', { name: 'Family 130' })).toBeInTheDocument()
    expect(requested).toHaveLength(2)
  })

  it('blocks saving invalid hex values and empty names', async () => {
    renderApp('/dashboard/brand', { user: makeUser() })
    await userEvent.click((await screen.findAllByRole('button', { name: 'New brand kit' }))[0])
    const dialog = await screen.findByRole('dialog')
    const submit = within(dialog).getByRole('button', { name: 'Create kit' })
    expect(submit).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Kit name'), 'X')
    expect(submit).toBeEnabled()
    const hex = within(dialog).getByLabelText('Colour 1 hex')
    await userEvent.clear(hex)
    await userEvent.type(hex, 'zzz')
    expect(within(dialog).getByText('Use a hex colour like #7a64e0.')).toBeInTheDocument()
    expect(submit).toBeDisabled()
  })

  it('makes another kit the default and deletes with confirmation', async () => {
    const patches: unknown[] = []
    const deleted: string[] = []
    renderApp('/dashboard/brand', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/brand-kits/', () => HttpResponse.json([kit(), kit({ id: 'k2', name: 'Side', is_default: false })])),
        http.patch('*/api/v1/brand-kits/:id/', async ({ request }) => {
          patches.push(await request.json())
          return HttpResponse.json(kit({ id: 'k2' }))
        }),
        http.delete('*/api/v1/brand-kits/:id/', ({ params }) => {
          deleted.push(String(params.id))
          return new HttpResponse(null, { status: 204 })
        }),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Make default' }))
    await waitFor(() => expect(patches[0]).toMatchObject({ name: 'Side', is_default: true }))
    const card = screen.getByRole('heading', { name: 'Side' }).closest('div')?.parentElement as HTMLElement
    await userEvent.click(within(card).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Side”?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete kit' }))
    await waitFor(() => expect(deleted).toEqual(['k2']))
  })

  it('shows the empty state for new accounts', async () => {
    renderApp('/dashboard/brand', { user: makeUser() })
    expect(await screen.findByText('Create your first brand kit')).toBeInTheDocument()
  })
})
