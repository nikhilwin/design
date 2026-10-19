import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import type { ReactNode } from 'react'
import { createBlankDocument } from '@/lib/document'
import { resetClientState } from '@/lib/api/client'
import { server } from '@/test/msw'
import type { EditorAdapter } from '@/types/adapter'
import type { FontFamily } from '@/types/api'
import type { DocObject } from '@/types/document'
import { createUserFontsService } from '@/features/editor/adapters/services'
import { EditorProvider } from '../EditorProvider'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { DialogHost } from '../dialogs/DialogHost'
import { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { asFile, buildSfnt } from '../test/fontBuilder'
import { FontPicker } from '../toolbar/FontPicker'
import { MissingFontsNotice } from './MissingFontsNotice'
import { YourFonts } from './YourFonts'

const family = (name: string, id = name, styles: [number, 'normal' | 'italic'][] = [[400, 'normal']]): FontFamily => ({
  id,
  family: name,
  category: 'sans-serif',
  scripts: ['latin'],
  is_variable: false,
  is_user_font: true,
  variants: styles.map(([weight, style]) => ({ weight, style, url: `/media/fonts/user/1/${id}-${weight}${style}.ttf`, subsets: [] })),
  popularity: 9999,
})

const page = (results: FontFamily[]) => HttpResponse.json({ count: results.length, next: null, previous: null, results })
const LIBRARY = [family('Brand Sans', 'f1', [[400, 'normal'], [700, 'normal']]), family('Zine Serif', 'f2')]

interface SetupOptions {
  mode?: 'guest' | 'account' | 'shared-edit'
  document?: ReturnType<typeof createBlankDocument>
  provided?: FontFamily[]
  withService?: boolean
}

function setup(options: SetupOptions = {}) {
  const mode = options.mode ?? 'account'
  const handle = createMemoryAdapter()
  const fonts = handle.adapter.services.fonts
  if (mode === 'account' && options.withService !== false) fonts.mine = createUserFontsService()
  if (options.provided) fonts.provided = options.provided
  const adapter: EditorAdapter = handle.adapter
  const engine = new EditorEngine({ adapter, document: options.document ?? createBlankDocument(800, 600), meta: { id: 'd1', title: 'Test', mode }, ephemeral: true })
  engine.start()
  const wrap = (children: ReactNode) => (
    <EditorProvider engine={engine} portalRoot={document.body}>
      {children}
      <DialogHost onTitle={() => undefined} />
    </EditorProvider>
  )
  return { engine, handle, wrap }
}

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=tok; path=/'
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('font picker with uploaded fonts', () => {
  it('lists "Your fonts" first, filters both groups with the search and picks an uploaded font', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page(LIBRARY)))
    const { engine, wrap } = setup()
    const onPick = vi.fn()
    render(wrap(<FontPicker current="Plus Jakarta Sans" onPreview={() => undefined} onPick={onPick} onClose={() => undefined} />))

    const mine = await screen.findByRole('option', { name: 'Brand Sans' })
    expect(mine).toHaveAttribute('data-group', 'mine')
    const rows = screen.getAllByRole('option')
    expect(rows[0]).toHaveTextContent('Brand Sans')
    expect(rows[1]).toHaveTextContent('Zine Serif')
    expect(screen.getByText(t.userFonts.group)).toBeInTheDocument()
    expect(rows[2]).toHaveAttribute('data-group', 'catalog')

    await userEvent.type(screen.getByTestId('font-search'), 'serif')
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Brand Sans' })).toBeNull())
    expect(screen.getByRole('option', { name: 'Zine Serif' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'DejaVu Serif' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('option', { name: 'Zine Serif' }))
    expect(onPick).toHaveBeenCalledWith('"Zine Serif", sans-serif', 'Zine Serif')
    engine.dispose()
  })

  it('filters the uploaded fonts by category too', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([{ ...family('Slab One', 's1'), category: 'serif' }, family('Brand Sans', 'f1')])))
    const { engine, wrap } = setup()
    render(wrap(<FontPicker current="" onPreview={() => undefined} onPick={() => undefined} onClose={() => undefined} />))
    await screen.findByRole('option', { name: 'Slab One' })
    await userEvent.click(screen.getByRole('button', { name: t.fonts.serif }))
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Brand Sans' })).toBeNull())
    expect(screen.getByRole('option', { name: 'Slab One' })).toBeInTheDocument()
    engine.dispose()
  })

  it('previews an uploaded font while hovering', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page(LIBRARY)))
    const { engine, wrap } = setup()
    const onPreview = vi.fn()
    render(wrap(<FontPicker current="" onPreview={onPreview} onPick={() => undefined} onClose={() => undefined} />))
    await userEvent.hover(await screen.findByRole('option', { name: 'Brand Sans' }))
    expect(onPreview).toHaveBeenCalledWith('"Brand Sans", sans-serif', 'Brand Sans')
    engine.dispose()
  })

  it('shows the server message when the library cannot be loaded and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('*/api/v1/fonts/mine/', () => {
        calls += 1
        return calls === 1 ? HttpResponse.json({ error: { code: 'server_error', message: 'The font library is resting.' } }, { status: 503 }) : page(LIBRARY)
      }),
    )
    const { engine, wrap } = setup()
    render(wrap(<FontPicker current="" onPreview={() => undefined} onPick={() => undefined} onClose={() => undefined} />))
    const alert = await screen.findByTestId('font-mine-error')
    expect(alert).toHaveTextContent('The font library is resting.')
    expect(screen.getByRole('option', { name: 'DejaVu Sans' })).toBeInTheDocument()
    await userEvent.click(within(alert).getByRole('button', { name: t.userFonts.retry }))
    expect(await screen.findByRole('option', { name: 'Brand Sans' })).toBeInTheDocument()
    expect(screen.queryByTestId('font-mine-error')).toBeNull()
    engine.dispose()
  })

  it('shows a loading state while the library is on its way', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(http.get('*/api/v1/fonts/mine/', async () => (await gate, page(LIBRARY))))
    const { engine, wrap } = setup()
    render(wrap(<FontPicker current="" onPreview={() => undefined} onPick={() => undefined} onClose={() => undefined} />))
    expect(await screen.findByTestId('font-mine-loading')).toBeInTheDocument()
    release()
    await screen.findByRole('option', { name: 'Brand Sans' })
    expect(screen.queryByTestId('font-mine-loading')).toBeNull()
    engine.dispose()
  })

  it('has an upload row that closes the picker and opens the upload dialog', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    const { engine, wrap } = setup()
    const onClose = vi.fn()
    render(wrap(<FontPicker current="" onPreview={() => undefined} onPick={() => undefined} onClose={onClose} />))
    await userEvent.click(await screen.findByTestId('font-upload-row'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog', { name: t.userFonts.dialog.title })).toBeInTheDocument()
    expect(engine.state.ui.dialog?.id).toBe('upload-font')
    engine.dispose()
  })

  it('offers the same row to guests, who are sent to sign up instead of to the dialog', async () => {
    const { engine, handle, wrap } = setup({ mode: 'guest' })
    render(wrap(<FontPicker current="" onPreview={() => undefined} onPick={() => undefined} onClose={() => undefined} />))
    await userEvent.click(await screen.findByTestId('font-upload-row'))
    await waitFor(() => expect(handle.accountRequests).toEqual(['brand-kit']))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(t.userFonts.group)).toBeNull()
    engine.dispose()
  })

  it('shows the fonts that came with a shared design and no upload row to visitors', async () => {
    const { engine, wrap } = setup({ mode: 'shared-edit', provided: [family('Owner Script', 'o1')] })
    render(wrap(<FontPicker current="" onPreview={() => undefined} onPick={() => undefined} onClose={() => undefined} />))
    expect(await screen.findByRole('option', { name: 'Owner Script' })).toHaveAttribute('data-group', 'shared')
    expect(screen.getByText(t.userFonts.groupShared)).toBeInTheDocument()
    expect(screen.queryByTestId('font-upload-row')).toBeNull()
    engine.dispose()
  })
})

describe('upload dialog', () => {
  const regular = () => asFile(buildSfnt({ family: 'Brand Sans', weightClass: 400 }), 'BrandSans-Regular.ttf')
  const bold = () => asFile(buildSfnt({ family: 'Brand Sans', weightClass: 700 }), 'BrandSans-Bold.ttf')

  async function openDialog(options: SetupOptions = {}) {
    const ctx = setup(options)
    render(ctx.wrap(<span />))
    act(() => ctx.engine.openDialog('upload-font'))
    const input = (await screen.findByTestId('font-file-input')) as HTMLInputElement
    return { ...ctx, input }
  }

  interface Stored {
    files: string[]
    family: string | null
    csrf: string | undefined
  }
  const stored: Stored[] = []

  /**
   * Uploads with a progress callback go through XMLHttpRequest, and MSW cannot read jsdom's FormData: the request is
   * recorded here and answered by `respond` (a family by default), so the real client code still builds the form,
   * sends the CSRF header, reports progress and parses the error envelope.
   */
  function stubUploads(respond: (file: string) => { status: number; body: unknown } | null = () => null): void {
    class FakeXhr {
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      status = 0
      response: ArrayBuffer | null = null
      responseType = ''
      withCredentials = false
      private readonly headers: Record<string, string> = {}
      open(): void {}
      setRequestHeader(name: string, value: string): void {
        this.headers[name.toLowerCase()] = value
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null
      }
      abort(): void {
        this.onabort?.()
      }
      send(form: FormData): void {
        const files = form.getAll('files').map((f) => (f as File).name)
        stored.push({ files, family: (form.get('family') as string | null) ?? null, csrf: this.headers['x-csrftoken'] })
        const answer = respond(files[0]) ?? { status: 201, body: family('Brand Sans', 'f1', [[400, 'normal'], [700, 'normal']]) }
        queueMicrotask(() => {
          this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
          this.status = answer.status
          this.response = new TextEncoder().encode(JSON.stringify(answer.body)).buffer as ArrayBuffer
          this.onload?.()
        })
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  }
  const failure = (status: number, code: string, message = code, fields?: Record<string, string[]>) => ({ status, body: { error: { code, message, ...(fields ? { fields } : {}) } } })
  beforeEach(() => {
    stored.length = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows what was detected in each file, uploads them one by one and puts the family into Your fonts', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads()
    const { engine, input } = await openDialog()
    await userEvent.upload(input, [regular(), bold()])
    const rows = await screen.findAllByTestId('font-upload-item')
    await waitFor(() => expect(rows[0]).toHaveAttribute('data-status', 'ready'))
    expect(rows[0]).toHaveTextContent('Brand Sans')
    expect(rows[0]).toHaveTextContent('Regular')
    expect(rows[1]).toHaveTextContent('Bold')
    expect(screen.getByTestId('font-family-input')).toHaveAttribute('placeholder', 'Brand Sans')
    expect(screen.getByTestId('font-licence')).toHaveTextContent(/licence/)

    await userEvent.click(screen.getByTestId('font-upload-submit'))
    expect(await screen.findByTestId('font-upload-success')).toHaveTextContent('2 fonts uploaded')
    expect(stored.map((s) => s.files)).toEqual([['BrandSans-Regular.ttf'], ['BrandSans-Bold.ttf']])
    expect(stored.every((s) => s.family === null && s.csrf === 'tok')).toBe(true)
    expect(engine.userFonts.getSnapshot().families.map((f) => f.family)).toEqual(['Brand Sans'])
    await userEvent.click(screen.getByTestId('font-upload-close'))
    expect(engine.state.ui.dialog).toBeNull()
    engine.dispose()
  })

  it('sends the family name that was typed with every file', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads()
    const { engine, input } = await openDialog()
    await userEvent.upload(input, [regular()])
    await waitFor(() => expect(screen.getByTestId('font-upload-submit')).toBeEnabled())
    await userEvent.type(screen.getByTestId('font-family-input'), 'My Brand')
    await userEvent.click(screen.getByTestId('font-upload-submit'))
    await screen.findByTestId('font-upload-success')
    expect(stored[0].family).toBe('My Brand')
    engine.dispose()
  })

  it('names a refused file, keeps the good ones and retries only what failed', async () => {
    let attempts = 0
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads((file) => {
      if (file !== 'BrandSans-Bold.ttf') return null
      attempts += 1
      return attempts === 1 ? failure(409, 'variant_exists') : null
    })
    const { engine, input } = await openDialog()
    await userEvent.upload(input, [regular(), bold()])
    await waitFor(() => expect(screen.getByTestId('font-upload-submit')).toBeEnabled())
    await userEvent.click(screen.getByTestId('font-upload-submit'))
    const rows = await screen.findAllByTestId('font-upload-item')
    await waitFor(() => expect(rows[1]).toHaveAttribute('data-status', 'error'))
    expect(rows[0]).toHaveAttribute('data-status', 'done')
    expect(within(rows[1]).getByRole('alert')).toHaveTextContent(t.userFonts.errors.variantExists)
    expect(screen.getByTestId('font-upload-submit')).toHaveTextContent(t.userFonts.dialog.retry)

    await userEvent.click(screen.getByTestId('font-upload-submit'))
    await screen.findByTestId('font-upload-success')
    expect(stored.map((s) => s.files[0])).toEqual(['BrandSans-Regular.ttf', 'BrandSans-Bold.ttf', 'BrandSans-Bold.ttf'])
    engine.dispose()
  })

  it('asks for another family name when a built-in font has the name', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads(() => failure(409, 'font_name_taken'))
    const { engine, input } = await openDialog()
    await userEvent.upload(input, [regular()])
    await waitFor(() => expect(screen.getByTestId('font-upload-submit')).toBeEnabled())
    await userEvent.click(screen.getByTestId('font-upload-submit'))
    const row = await screen.findByTestId('font-upload-item')
    await waitFor(() => expect(within(row).getByRole('alert')).toHaveTextContent(t.userFonts.errors.nameTaken))
    expect(screen.getByTestId('font-family-input')).toHaveFocus()
    expect(screen.getByTestId('font-family-input')).toHaveAttribute('aria-invalid', 'true')
    engine.dispose()
  })

  it('stops after a limit error and leaves the other files for later', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads(() => failure(403, 'font_limit_reached'))
    const { engine, input } = await openDialog()
    await userEvent.upload(input, [regular(), bold()])
    await waitFor(() => expect(screen.getByTestId('font-upload-submit')).toBeEnabled())
    await userEvent.click(screen.getByTestId('font-upload-submit'))
    const rows = await screen.findAllByTestId('font-upload-item')
    await waitFor(() => expect(rows[0]).toHaveAttribute('data-status', 'error'))
    expect(within(rows[0]).getByRole('alert')).toHaveTextContent(t.userFonts.errors.limit)
    expect(rows[1]).toHaveAttribute('data-status', 'ready')
    expect(stored).toHaveLength(1)
    expect(screen.getByText(t.userFonts.dialog.stopped)).toBeInTheDocument()
    engine.dispose()
  })

  it('shows the server message of a rejected file', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads(() => failure(400, 'validation_error', 'Invalid input.', { files: ['BrandSans-Regular.ttf: the font has no vector outlines.'] }))
    const { engine, input } = await openDialog()
    await userEvent.upload(input, [regular()])
    await waitFor(() => expect(screen.getByTestId('font-upload-submit')).toBeEnabled())
    await userEvent.click(screen.getByTestId('font-upload-submit'))
    const row = await screen.findByTestId('font-upload-item')
    await waitFor(() => expect(within(row).getByRole('alert')).toHaveTextContent('The font has no vector outlines.'))
    engine.dispose()
  })

  it('refuses files that are not fonts, too large or empty before sending anything', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads()
    const { engine, input } = await openDialog()
    const pdf = new File(['%PDF-1.7 hello'], 'brand.ttf', { type: 'application/pdf' })
    const huge = new File(['x'], 'huge.ttf')
    Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 })
    const empty = new File([], 'empty.otf')
    await userEvent.upload(input, [pdf, huge, empty])
    const rows = await screen.findAllByTestId('font-upload-item')
    await waitFor(() => expect(rows.every((r) => r.getAttribute('data-status') === 'error')).toBe(true))
    expect(within(rows[0]).getByRole('alert')).toHaveTextContent(t.userFonts.problems.unsupported)
    expect(within(rows[1]).getByRole('alert')).toHaveTextContent(t.userFonts.problems.tooLarge)
    expect(within(rows[2]).getByRole('alert')).toHaveTextContent(t.userFonts.problems.empty)
    expect(screen.getByTestId('font-upload-submit')).toBeDisabled()
    expect(stored).toHaveLength(0)
    await userEvent.click(within(rows[0]).getByTestId('font-upload-remove'))
    expect(screen.getAllByTestId('font-upload-item')).toHaveLength(2)
    engine.dispose()
  })

  it('takes at most five files at a time and ignores a file that is already in the list', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    const { engine, input } = await openDialog()
    const files = Array.from({ length: 6 }, (_, i) => asFile(buildSfnt({ family: 'Brand Sans', weightClass: 100 * (i + 1) }), `f${i}.ttf`))
    await userEvent.upload(input, files)
    await waitFor(() => expect(screen.getAllByTestId('font-upload-item')).toHaveLength(5))
    expect(screen.getByText(t.userFonts.dialog.tooMany(5))).toBeInTheDocument()
    await userEvent.upload(input, [files[0]])
    expect(screen.getByText(t.userFonts.dialog.duplicate)).toBeInTheDocument()
    expect(screen.getAllByTestId('font-upload-item')).toHaveLength(5)
    engine.dispose()
  })

  it('warns when the files belong to different families', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    const { engine, input } = await openDialog()
    await userEvent.upload(input, [regular(), asFile(buildSfnt({ family: 'Other Face' }), 'other.ttf')])
    await waitFor(() => expect(screen.getByTestId('font-upload-submit')).toBeEnabled())
    expect(screen.getByText(/different families \(Brand Sans, Other Face\)/)).toBeInTheDocument()
    expect(screen.getByTestId('font-family-input')).toHaveAttribute('placeholder', '')
    engine.dispose()
  })

  it('offers to use the new font on the selected text', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    stubUploads()
    const ctx = setup()
    render(ctx.wrap(<span />))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const pageId = ctx.engine.state.doc.pages[0].id
    ctx.engine.mountPage(pageId, host)
    const view = await ctx.engine.whenView(pageId)
    view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
    await ctx.engine.insert.text('heading')
    act(() => ctx.engine.openDialog('upload-font'))
    await userEvent.upload(await screen.findByTestId('font-file-input'), [regular()])
    await waitFor(() => expect(screen.getByTestId('font-upload-submit')).toBeEnabled())
    await userEvent.click(screen.getByTestId('font-upload-submit'))
    await userEvent.click(await screen.findByTestId('font-upload-use'))
    expect(ctx.engine.state.ui.dialog).toBeNull()
    await waitFor(() => expect(ctx.engine.state.selection.objects[0]?.fontFamily).toBe('"Brand Sans", sans-serif'))
    ctx.engine.dispose()
  })
})

describe('your fonts (Brand panel)', () => {
  const textLayer = (id: string, fontFamily: string): DocObject => ({ id, type: 'textbox', text: 'Hi', fontFamily, fontSize: 24, left: 100, top: 100, width: 200 })

  function docUsing(...families: string[]) {
    const doc = createBlankDocument(800, 600)
    return { ...doc, pages: [{ ...doc.pages[0], objects: families.map((f, i) => textLayer(`t${i}`, `"${f}", sans-serif`)) }] }
  }

  it('lists the families with their styles', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page(LIBRARY)))
    const { engine, wrap } = setup()
    render(wrap(<YourFonts />))
    const cards = await screen.findAllByTestId('your-font')
    expect(cards.map((c) => c.getAttribute('data-family'))).toEqual(['Brand Sans', 'Zine Serif'])
    expect(cards[0]).toHaveTextContent('Regular · Bold')
    engine.dispose()
  })

  it('invites the user to upload when there is nothing yet', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    const { engine, wrap } = setup()
    render(wrap(<YourFonts />))
    expect(await screen.findByText(t.userFonts.manageEmpty)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('your-fonts-upload'))
    expect(await screen.findByRole('dialog', { name: t.userFonts.dialog.title })).toBeInTheDocument()
    engine.dispose()
  })

  it('asks before deleting and says how many text layers of the design use the font', async () => {
    const deleted: string[] = []
    server.use(
      http.get('*/api/v1/fonts/mine/', () => page(LIBRARY)),
      http.delete('*/api/v1/fonts/mine/:id/', ({ params }) => {
        deleted.push(String(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { engine, wrap } = setup({ document: docUsing('Brand Sans', 'Brand Sans', 'Zine Serif') })
    render(wrap(<YourFonts />))
    const [first] = await screen.findAllByTestId('font-delete')
    await userEvent.click(first)
    const confirm = screen.getByTestId('font-delete-confirm')
    expect(confirm).toHaveTextContent(t.userFonts.deleteTitle('Brand Sans'))
    expect(confirm).toHaveTextContent(t.userFonts.deleteUsed(2))
    await userEvent.click(within(confirm).getByRole('button', { name: t.userFonts.deleteCancel }))
    expect(deleted).toEqual([])
    await userEvent.click(screen.getAllByTestId('font-delete')[0])
    await userEvent.click(screen.getByTestId('font-delete-confirm-button'))
    await waitFor(() => expect(screen.queryByText('Brand Sans')).toBeNull())
    expect(deleted).toEqual(['f1'])
    expect(engine.userFonts.getSnapshot().families.map((f) => f.family)).toEqual(['Zine Serif'])
    expect(engine.state.toasts.at(-1)?.message).toBe(t.userFonts.deleted('Brand Sans'))
    engine.dispose()
  })

  it('does not claim a font is used when the design does not use it, and keeps the card when the server refuses', async () => {
    server.use(
      http.get('*/api/v1/fonts/mine/', () => page(LIBRARY)),
      http.delete('*/api/v1/fonts/mine/:id/', () => HttpResponse.json({ error: { code: 'server_error', message: 'nope' } }, { status: 500 })),
    )
    const { engine, wrap } = setup()
    render(wrap(<YourFonts />))
    await userEvent.click((await screen.findAllByTestId('font-delete'))[0])
    expect(screen.getByTestId('font-delete-confirm')).not.toHaveTextContent('text layer')
    await userEvent.click(screen.getByTestId('font-delete-confirm-button'))
    expect(await screen.findByText(t.userFonts.deleteFailed('Brand Sans'))).toBeInTheDocument()
    expect(engine.userFonts.getSnapshot().families).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: t.userFonts.deleteCancel }))
    expect(screen.getByTestId('your-fonts')).toHaveTextContent('Brand Sans')
    engine.dispose()
  })

  it('only lists the fonts of a shared design, without delete or upload', async () => {
    const { engine, wrap } = setup({ mode: 'shared-edit', provided: [family('Owner Script', 'o1')] })
    render(wrap(<YourFonts />))
    expect(await screen.findByText('Owner Script')).toBeInTheDocument()
    expect(screen.queryByTestId('font-delete')).toBeNull()
    expect(screen.queryByTestId('your-fonts-upload')).toBeNull()
    expect(screen.getByText(t.userFonts.sharedNote)).toBeInTheDocument()
    engine.dispose()
  })

  it('shows the server message when the library cannot be loaded', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => HttpResponse.json({ error: { code: 'server_error', message: 'Library is down.' } }, { status: 500 })))
    const { engine, wrap } = setup()
    render(wrap(<YourFonts />))
    expect(await screen.findByRole('alert')).toHaveTextContent('Library is down.')
    engine.dispose()
  })
})

describe('missing fonts notice', () => {
  const doc = (family: string) => {
    const base = createBlankDocument(800, 600)
    return { ...base, pages: [{ ...base.pages[0], objects: [{ id: 't', type: 'textbox', text: 'Hi', fontFamily: `"${family}", sans-serif`, fontSize: 24, left: 100, top: 100, width: 200 }] }] }
  }

  it('warns, once the fonts have settled, about a font that no catalog has, and can be dismissed', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page([])))
    const { engine, wrap } = setup({ document: doc('Ghost Serif') })
    render(wrap(<MissingFontsNotice />))
    const notice = await screen.findByTestId('missing-fonts', undefined, { timeout: 3000 })
    expect(notice).toHaveTextContent(t.userFonts.missing.title(1))
    expect(notice).toHaveTextContent('Ghost Serif')
    expect(screen.getByTestId('missing-fonts-upload')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('missing-fonts-dismiss'))
    expect(screen.queryByTestId('missing-fonts')).toBeNull()
    engine.dispose()
  })

  it('stays quiet for catalog fonts, installed fonts, the app fonts and uploaded fonts the user has', async () => {
    server.use(http.get('*/api/v1/fonts/mine/', () => page(LIBRARY)))
    const base = createBlankDocument(800, 600)
    const objects = ['DejaVu Sans', 'Arial', 'Plus Jakarta Sans', 'Inter', 'Brand Sans'].map((f, i) => ({ id: `t${i}`, type: 'textbox', text: 'Hi', fontFamily: `"${f}", sans-serif`, fontSize: 20, left: 10, top: 10 + i * 40, width: 200 }))
    const { engine, wrap } = setup({ document: { ...base, pages: [{ ...base.pages[0], objects }] } })
    render(wrap(<MissingFontsNotice />))
    await waitFor(() => expect(engine.userFonts.getSnapshot().status).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(screen.queryByTestId('missing-fonts')).toBeNull()
    engine.dispose()
  })

  it('tells a visitor only that a fallback is shown, without offering an upload', async () => {
    const { engine, wrap } = setup({ mode: 'shared-edit', document: doc('Ghost Serif') })
    render(wrap(<MissingFontsNotice />))
    const notice = await screen.findByTestId('missing-fonts', undefined, { timeout: 3000 })
    expect(notice).not.toHaveTextContent('Upload the font again')
    expect(screen.queryByTestId('missing-fonts-upload')).toBeNull()
    engine.dispose()
  })
})
