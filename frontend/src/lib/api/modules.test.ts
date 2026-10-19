import { http as mswHttp, HttpResponse } from 'msw'
import { server } from '@/test/msw'
import { captureFetch } from '@/test/utils'
import { assetsApi } from './assets'
import { authApi } from './auth'
import { resetClientState } from './client'
import { designsApi } from './designs'
import { exportsApi } from './exports'
import { foldersApi } from './folders'
import { fontsApi } from './fonts'
import { shareApi } from './share'
import { templatesApi } from './templates'

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=tok; path=/'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('auth api', () => {
  it('treats an anonymous /auth/me/ as { user: null } without a 401 callback', async () => {
    server.use(mswHttp.get('*/api/v1/auth/me/', () => HttpResponse.json({ user: null })))
    await expect(authApi.me()).resolves.toEqual({ user: null })
  })

  it('posts login credentials and registration payloads as JSON', async () => {
    const bodies: unknown[] = []
    server.use(
      mswHttp.post('*/api/v1/auth/login/', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ user: { id: 'u1' } })
      }),
      mswHttp.post('*/api/v1/auth/register/', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ user: { id: 'u2' } }, { status: 201 })
      }),
    )
    await authApi.login({ email: 'a@b.co', password: 'pw' })
    await authApi.register({ email: 'c@d.co', password: 'pw2', display_name: 'C' })
    expect(bodies).toEqual([
      { email: 'a@b.co', password: 'pw' },
      { email: 'c@d.co', password: 'pw2', display_name: 'C' },
    ])
  })

  it('uploads the avatar as multipart under the "avatar" field', async () => {
    const calls = captureFetch(() => json({ user: { id: 'u1' } }))
    await authApi.uploadAvatar(new Blob(['x'], { type: 'image/png' }), 'me.png')
    expect(calls[0].method).toBe('PATCH')
    expect((calls[0].body as FormData).has('avatar')).toBe(true)
    expect(calls[0].headers.get('x-csrftoken')).toBe('tok')
  })
})

describe('designs api', () => {
  it('requests the trash listing and permanent deletion with the documented query flags', async () => {
    const urls: string[] = []
    server.use(
      mswHttp.get('*/api/v1/designs/', ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] })
      }),
      mswHttp.delete('*/api/v1/designs/d1/', ({ request }) => {
        urls.push(request.url)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await designsApi.list({ trashed: true, ordering: '-updated_at', page: 2 })
    await designsApi.deleteForever('d1')
    expect(urls[0]).toContain('trashed=true')
    expect(urls[0]).toContain('page=2')
    expect(urls[1]).toContain('permanent=true')
  })

  it('patches with base_revision and surfaces a revision conflict', async () => {
    server.use(
      mswHttp.patch('*/api/v1/designs/d1/', () => HttpResponse.json({ error: { code: 'revision_conflict', message: 'Stale' }, current: { revision: 5 } }, { status: 409 })),
    )
    await expect(designsApi.patch('d1', { title: 'x', base_revision: 2 })).rejects.toMatchObject({ status: 409, code: 'revision_conflict' })
  })

  it('uploads thumbnails as multipart "image" with PUT', async () => {
    const calls = captureFetch(() => json({ thumbnail_url: '/media/t.webp' }))
    await designsApi.uploadThumbnail('d1', new Blob(['x'], { type: 'image/webp' }))
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url.pathname).toBe('/api/v1/designs/d1/thumbnail/')
    expect((calls[0].body as FormData).has('image')).toBe(true)
  })

  it('sends bulk actions', async () => {
    let body: unknown
    server.use(
      mswHttp.post('*/api/v1/designs/bulk/', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ affected: 2 })
      }),
    )
    await expect(designsApi.bulk({ ids: ['a', 'b'], action: 'move', folder: 'f1' })).resolves.toEqual({ affected: 2 })
    expect(body).toEqual({ ids: ['a', 'b'], action: 'move', folder: 'f1' })
  })
})

describe('other resources', () => {
  it('accepts folders as a bare array or a paginated envelope', async () => {
    server.use(mswHttp.get('*/api/v1/folders/', () => HttpResponse.json([{ id: 'f1', name: 'Work', parent: null, design_count: 0, created_at: '' }])))
    await expect(foldersApi.list()).resolves.toHaveLength(1)
    server.use(mswHttp.get('*/api/v1/folders/', () => HttpResponse.json({ count: 1, next: null, previous: null, results: [{ id: 'f2' }] })))
    await expect(foldersApi.list()).resolves.toHaveLength(1)
  })

  it('uploads assets with name and tags', async () => {
    const calls = captureFetch(() => json({ id: 'a1' }, 201))
    await assetsApi.upload(new File(['x'], 'logo.png', { type: 'image/png' }), { name: 'Logo', tags: ['brand', 'dark'] })
    const form = calls[0].body as FormData
    expect(form.get('name')).toBe('Logo')
    expect(form.get('tags')).toBe('brand,dark')
    expect((form.get('file') as File).name).toBe('logo.png')
  })

  it('uploads user fonts as repeated "files" parts with optional family and category', async () => {
    const calls = captureFetch(() => json({ id: 'f1', family: 'Brand Sans' }, 201))
    await fontsApi.upload({ files: [new File(['a'], 'a.woff2'), new File(['b'], 'b.woff2')], family: 'Brand Sans', category: 'sans-serif' })
    const form = calls[0].body as FormData
    expect(form.getAll('files')).toHaveLength(2)
    expect(form.get('family')).toBe('Brand Sans')
    expect(form.get('category')).toBe('sans-serif')
    expect(calls[0].url.pathname).toBe('/api/v1/fonts/mine/')
  })

  it('encodes template slugs in the path', async () => {
    let path = ''
    server.use(
      mswHttp.get('*/api/v1/templates/*', ({ request }) => {
        path = new URL(request.url).pathname
        return HttpResponse.json({ slug: 'a b' })
      }),
    )
    await templatesApi.get('a b')
    expect(path).toBe('/api/v1/templates/a%20b/')
  })

  it('sends the share password in X-Share-Password', async () => {
    let header: string | null = null
    server.use(
      mswHttp.get('*/api/v1/shared/tok/', ({ request }) => {
        header = request.headers.get('x-share-password')
        return HttpResponse.json({ role: 'view' })
      }),
    )
    await shareApi.getShared('tok', 'hunter2')
    expect(header).toBe('hunter2')
  })

  it('posts pdf export pages as repeated SVG files and returns a Blob', async () => {
    const calls = captureFetch(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }))
    const pdf = await exportsApi.pdf({ pages: [new Blob(['<svg/>']), new Blob(['<svg/>'])], width: 800.4, height: 600, cropMarks: true })
    const form = calls[0].body as FormData
    expect(form.getAll('pages')).toHaveLength(2)
    expect(form.get('width')).toBe('800')
    expect(form.get('crop_marks')).toBe('true')
    expect(calls[0].headers.get('accept')).toBe('*/*')
    expect(pdf.size).toBe(4)
  })

  it('sends the size of every page as a JSON list next to the first page size, and nothing when none is given', async () => {
    const calls = captureFetch(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }))
    const sizes = [{ width: 1080.4, height: 1920 }, { width: 336, height: 192 }]
    await exportsApi.pdf({ pages: [new Blob(['<svg/>']), new Blob(['<svg/>'])], width: 1080, height: 1920, sizes })
    await exportsApi.pdf({ pages: [new Blob(['<svg/>'])], width: 100, height: 100 })
    const form = calls[0].body as FormData
    expect(JSON.parse(form.get('sizes') as string)).toEqual([{ width: 1080, height: 1920 }, { width: 336, height: 192 }])
    expect(form.get('width')).toBe('1080')
    expect(form.get('height')).toBe('1920')
    expect((calls[1].body as FormData).has('sizes')).toBe(false)
  })

  it('sends the font files to embed as a JSON list, and nothing when there are none', async () => {
    const calls = captureFetch(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }))
    const fonts = [{ family: 'Brand Sans', url: '/media/fonts/user/1/a.ttf', weight: 700, style: 'italic' as const }]
    await exportsApi.pdf({ pages: [new Blob(['<svg/>'])], width: 100, height: 100, fonts })
    await exportsApi.pdf({ pages: [new Blob(['<svg/>'])], width: 100, height: 100, fonts: [] })
    expect(JSON.parse((calls[0].body as FormData).get('fonts') as string)).toEqual(fonts)
    expect((calls[1].body as FormData).has('fonts')).toBe(false)
  })
})

describe('user fonts api', () => {
  it('lists every page of the uploaded families and deletes one by id', async () => {
    const pages: number[] = []
    const calls: string[] = []
    server.use(
      mswHttp.get('*/api/v1/fonts/mine/', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page'))
        pages.push(page)
        return HttpResponse.json({ count: 2, next: page === 1 ? 'next' : null, previous: null, results: [{ id: `f${page}`, family: `Family ${page}` }] })
      }),
      mswHttp.delete('*/api/v1/fonts/mine/:id/', ({ request }) => {
        calls.push(new URL(request.url).pathname)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    expect((await fontsApi.mine()).map((f) => f.id)).toEqual(['f1', 'f2'])
    expect(pages).toEqual([1, 2])
    await fontsApi.removeMine('f1')
    expect(calls).toEqual(['/api/v1/fonts/mine/f1/'])
  })
})
