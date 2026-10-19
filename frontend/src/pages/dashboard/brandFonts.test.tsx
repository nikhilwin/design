import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { asFile, buildSfnt } from '@/editor/test/fontBuilder'
import { renderApp } from '@/test/app'
import { makeUser, page } from '@/test/factories'
import type { FontFamily } from '@/types/api'

const family = (name: string, id: string, styles: Array<[number, 'normal' | 'italic']> = [[400, 'normal']]): FontFamily => ({
  id,
  family: name,
  category: 'sans-serif',
  scripts: ['latin'],
  is_variable: false,
  is_user_font: true,
  variants: styles.map(([weight, style]) => ({ weight, style, url: `/media/fonts/user/1/${id}-${weight}.ttf`, subsets: [] })),
  popularity: 9999,
})

const mine = (families: FontFamily[]) => http.get('*/api/v1/fonts/mine/', () => HttpResponse.json(page(families)))

/** Uploads with progress go through XMLHttpRequest, and MSW cannot read jsdom's FormData: the request is answered here. */
function stubUploads(respond: (file: string) => { status: number; body: unknown }): { files: string[]; families: (string | null)[] } {
  const seen: { files: string[]; families: (string | null)[] } = { files: [], families: [] }
  class FakeXhr {
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    status = 0
    response: ArrayBuffer | null = null
    responseType = ''
    withCredentials = false
    open(): void {}
    setRequestHeader(): void {}
    getResponseHeader(name: string): string | null {
      return name.toLowerCase() === 'content-type' ? 'application/json' : null
    }
    abort(): void {
      this.onabort?.()
    }
    send(form: FormData): void {
      const file = (form.get('files') as File).name
      seen.files.push(file)
      seen.families.push((form.get('family') as string | null) ?? null)
      const answer = respond(file)
      queueMicrotask(() => {
        this.status = answer.status
        this.response = new TextEncoder().encode(JSON.stringify(answer.body)).buffer as ArrayBuffer
        this.onload?.()
      })
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  return seen
}

// The route is loaded lazily: compile it once up front so no single test pays for it.
beforeAll(async () => {
  await import('./BrandPage')
}, 60_000)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('brand page: your fonts', () => {
  it('lists the uploaded families with their styles', async () => {
    renderApp('/dashboard/brand', { user: makeUser(), handlers: [mine([family('Brand Sans', 'f1', [[400, 'normal'], [700, 'italic']]), family('Zine Serif', 'f2')])] })
    const cards = await screen.findAllByTestId('your-font')
    expect(cards.map((c) => c.getAttribute('data-family'))).toEqual(['Brand Sans', 'Zine Serif'])
    expect(cards[0]).toHaveTextContent('2 styles: Regular · Bold Italic')
    expect(screen.getByRole('heading', { name: 'Your fonts' })).toBeInTheDocument()
  })

  it('invites new accounts to upload and shows a loading state first', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    renderApp('/dashboard/brand', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/fonts/mine/', async () => {
          await gate
          return HttpResponse.json(page([]))
        }),
      ],
    })
    expect(await screen.findByRole('list', { name: 'Loading your fonts' })).toBeInTheDocument()
    release()
    expect(await screen.findByText('Bring your own fonts')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Upload fonts' }))
    expect(await screen.findByRole('dialog', { name: 'Upload fonts' })).toBeInTheDocument()
  })

  it('shows the server message when the fonts cannot be loaded, and loads them on retry', async () => {
    let calls = 0
    renderApp('/dashboard/brand', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/fonts/mine/', () => {
          calls += 1
          return calls === 1 ? HttpResponse.json({ error: { code: 'server_error', message: 'The font library is resting.' } }, { status: 503 }) : HttpResponse.json(page([family('Brand Sans', 'f1')]))
        }),
      ],
    })
    expect(await screen.findByText('The font library is resting.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('your-font')).toHaveTextContent('Brand Sans')
  })

  it('asks before deleting and removes the family', async () => {
    const deleted: string[] = []
    renderApp('/dashboard/brand', {
      user: makeUser(),
      handlers: [
        mine([family('Brand Sans', 'f1'), family('Zine Serif', 'f2')]),
        http.delete('*/api/v1/fonts/mine/:id/', ({ params }) => {
          deleted.push(String(params.id))
          return new HttpResponse(null, { status: 204 })
        }),
      ],
    })
    await userEvent.click((await screen.findAllByRole('button', { name: 'Delete Brand Sans' }))[0])
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Brand Sans”?' })
    expect(dialog).toHaveTextContent('fallback font')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete font' }))
    await waitFor(() => expect(deleted).toEqual(['f1']))
    expect(await screen.findByText('Deleted Brand Sans')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByTestId('your-font').map((c) => c.getAttribute('data-family'))).toEqual(['Zine Serif']))
  })

  it('keeps the family and explains when the server refuses to delete it', async () => {
    renderApp('/dashboard/brand', {
      user: makeUser(),
      handlers: [mine([family('Brand Sans', 'f1')]), http.delete('*/api/v1/fonts/mine/:id/', () => HttpResponse.json({ error: { code: 'server_error', message: 'Not today.' } }, { status: 500 }))],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Brand Sans' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete font' }))
    expect(await screen.findByText('Could not delete Brand Sans.')).toBeInTheDocument()
    expect(screen.getByTestId('your-font')).toBeInTheDocument()
  })

  it('uploads files into the list and shows each file’s own error', async () => {
    const seen = stubUploads((file) => (file === 'Bold.ttf' ? { status: 409, body: { error: { code: 'variant_exists', message: 'exists' } } } : { status: 201, body: family('Brand Sans', 'f1', [[400, 'normal']]) }))
    renderApp('/dashboard/brand', { user: makeUser() })
    await userEvent.click(await screen.findByRole('button', { name: 'Upload fonts' }))
    const dialog = await screen.findByRole('dialog', { name: 'Upload fonts' })
    const input = within(dialog).getByTestId('font-file-input')
    await userEvent.upload(input, [asFile(buildSfnt({ family: 'Brand Sans', weightClass: 400 }), 'Regular.ttf'), asFile(buildSfnt({ family: 'Brand Sans', weightClass: 700 }), 'Bold.ttf')])
    const submit = await within(dialog).findByRole('button', { name: 'Upload 2 fonts' })
    await waitFor(() => expect(submit).toBeEnabled())
    expect(within(dialog).getByText(/licence/)).toBeInTheDocument()
    await userEvent.click(submit)
    await waitFor(() => expect(seen.files).toEqual(['Regular.ttf', 'Bold.ttf']))
    expect(await within(dialog).findByText(/already in your fonts/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Upload again' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upload fonts' })).toBeNull())
    expect(await screen.findByTestId('your-font')).toHaveTextContent('Brand Sans')
  })

  it('offers uploaded fonts in the brand kit form', async () => {
    renderApp('/dashboard/brand', { user: makeUser(), handlers: [mine([family('Brand Sans', 'f1')])] })
    await userEvent.click((await screen.findAllByRole('button', { name: 'New brand kit' }))[0])
    const dialog = await screen.findByRole('dialog', { name: 'New brand kit' })
    const select = await within(dialog).findByLabelText('Heading font')
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Brand Sans (uploaded)' })).toBeInTheDocument())
    await userEvent.selectOptions(select, 'Brand Sans')
    expect(select).toHaveValue('Brand Sans')
  })
})
