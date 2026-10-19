/**
 * An in-memory fake of the Doory HTTP API for Playwright (`page.route`), so shell flows can be tested and
 * screenshotted without Django. It implements just enough of the HTTP API for the app shell.
 */
import type { Page, Route } from '@playwright/test'

interface MockUser {
  id: string
  email: string
  display_name: string
  name: string
  avatar_url: string | null
  is_email_verified: boolean
  has_password: boolean
  google_linked: boolean
  created_at: string
}

export interface MockDesign {
  id: string
  title: string
  width: number
  height: number
  preset: string
  page_count: number
  thumbnail_url: string | null
  folder: string | null
  starred: boolean
  revision: number
  created_at: string
  updated_at: string
  trashed_at: string | null
  document: Record<string, unknown>
}

interface MockFolder {
  id: string
  name: string
  parent: string | null
  design_count: number
  created_at: string
}

interface MockTemplate {
  id: string
  slug: string
  title: string
  category: { id: string; slug: string; name: string }
  tags: string[]
  width: number
  height: number
  orientation: 'landscape' | 'portrait' | 'square'
  preset: string
  page_count: number
  thumbnail_url: string | null
  is_featured: boolean
  use_count: number
  created_at: string
  description: string
  document: Record<string, unknown>
}

export interface MockState {
  user: MockUser | null
  designs: MockDesign[]
  folders: MockFolder[]
  templates: MockTemplate[]
  assets: Array<Record<string, unknown>>
  brandKits: Array<Record<string, unknown>>
  /** Share links keyed by token. */
  shared: Record<string, { password?: string; role: 'view' | 'comment' | 'edit'; title: string }>
  requests: Array<{ method: string; path: string; body: unknown }>
  config: Record<string, unknown>
  counter: number
}

const PALETTES: Array<[string, string, string]> = [
  ['#ffe1e6', '#e11d48', '#480519'],
  ['#fff1f3', '#be123c', '#7f1034'],
  ['#ffc8d2', '#f23a63', '#9f1239'],
  ['#fff1f3', '#fb6485', '#480519'],
]

/** A tiny poster-like SVG used as a stand-in thumbnail. */
export function thumbnail(seed: number, width = 400, height = 300): string {
  const [bg, accent, ink] = PALETTES[seed % PALETTES.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${bg}"/><circle cx="${width * 0.78}" cy="${height * 0.28}" r="${Math.min(width, height) * 0.16}" fill="${accent}"/><rect x="${width * 0.08}" y="${height * 0.52}" width="${width * 0.5}" height="${height * 0.09}" rx="6" fill="${ink}"/><rect x="${width * 0.08}" y="${height * 0.68}" width="${width * 0.32}" height="${height * 0.05}" rx="4" fill="${accent}" opacity=".7"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const now = () => new Date().toISOString()
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString()

function blankDocument(width: number, height: number) {
  return { schemaVersion: 1, width, height, unit: 'px', pages: [{ id: crypto.randomUUID(), background: { type: 'solid', color: '#ffffff' }, objects: [] }] }
}

export function makeUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    display_name: 'Ada Lovelace',
    name: 'Ada Lovelace',
    avatar_url: null,
    is_email_verified: true,
    has_password: true,
    google_linked: false,
    created_at: ago(24 * 90),
    ...overrides,
  }
}

export function seedDesigns(): MockDesign[] {
  const titles = ['Summer launch post', 'Team offsite slides', 'Spring sale poster', 'Podcast cover', 'Birthday invitation', 'Quarterly report', 'Logo concepts', 'Newsletter header', 'Conference badge', 'Menu — brunch']
  const sizes: Array<[number, number, string]> = [[1080, 1080, 'instagram-post'], [1920, 1080, 'presentation'], [1728, 2304, 'poster'], [1080, 1080, 'instagram-post'], [480, 672, 'invitation'], [794, 1123, 'a4'], [500, 500, 'logo'], [1500, 500, 'x-header'], [336, 192, 'business-card'], [816, 1056, 'letter']]
  return titles.map((title, index) => {
    const [width, height, preset] = sizes[index]
    return {
      id: `design-${index + 1}`,
      title,
      width,
      height,
      preset,
      page_count: index === 1 ? 12 : 1,
      thumbnail_url: thumbnail(index, width > height ? 400 : 300, width > height ? 240 : 400),
      folder: null,
      starred: index === 0 || index === 3,
      revision: 3,
      created_at: ago(24 * (index + 3)),
      updated_at: ago(index * 7 + 1),
      trashed_at: null,
      document: blankDocument(width, height),
    }
  })
}

export function seedTemplates(): MockTemplate[] {
  const categories = [
    { id: 'c1', slug: 'social', name: 'Social media' },
    { id: 'c2', slug: 'presentations', name: 'Presentations' },
    { id: 'c3', slug: 'print', name: 'Print' },
  ]
  const entries: Array<[string, number, number, number, 'landscape' | 'portrait' | 'square']> = [
    ['Bold sale announcement', 0, 1080, 1080, 'square'],
    ['Minimal product launch', 0, 1080, 1080, 'square'],
    ['Pitch deck cover', 1, 1920, 1080, 'landscape'],
    ['Quarterly review', 1, 1920, 1080, 'landscape'],
    ['Event poster', 2, 1728, 2304, 'portrait'],
    ['Wedding invitation', 2, 480, 672, 'portrait'],
    ['Story — new arrival', 0, 1080, 1920, 'portrait'],
    ['Podcast episode', 0, 1080, 1080, 'square'],
  ]
  return entries.map(([title, cat, width, height, orientation], index) => ({
    id: `t${index + 1}`,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    title,
    category: categories[cat],
    tags: ['trending', categories[cat].slug],
    width,
    height,
    orientation,
    preset: '',
    page_count: 1,
    thumbnail_url: thumbnail(index + 1, width > height ? 400 : 300, width > height ? 225 : height / width > 1.5 ? 530 : 380),
    is_featured: index < 6,
    use_count: 100 - index,
    created_at: ago(index * 24),
    description: 'A fully editable layout. Swap the words, colours and photos to make it yours.',
    document: blankDocument(width, height),
  }))
}

export function createMockState(overrides: Partial<MockState> = {}): MockState {
  return {
    user: null,
    designs: seedDesigns(),
    folders: [],
    templates: seedTemplates(),
    assets: [],
    brandKits: [],
    shared: {},
    requests: [],
    config: {
      google_client_id: '',
      features: { stock_photos: false, server_pdf: false, google_login: false, email_verification: true },
      limits: { max_upload_bytes: 10 * 1024 * 1024, max_pages: 100, max_document_bytes: 12 * 1024 * 1024 },
    },
    counter: 100,
    ...overrides,
  }
}

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
const noContent = (route: Route, headers: Record<string, string> = {}) => route.fulfill({ status: 204, headers })
const error = (route: Route, status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(route, { error: { code, message, ...extra } }, status)

function page<T>(items: T[], url: URL) {
  const size = Number(url.searchParams.get('page_size') ?? 24)
  const index = Number(url.searchParams.get('page') ?? 1)
  const slice = items.slice((index - 1) * size, index * size)
  const base = `${url.origin}${url.pathname}`
  return { count: items.length, next: index * size < items.length ? `${base}?page=${index + 1}` : null, previous: index > 1 ? `${base}?page=${index - 1}` : null, results: slice }
}

function summary(design: MockDesign) {
  const { document: _document, ...rest } = design
  void _document
  return rest
}

function applyDesignFilters(state: MockState, url: URL): MockDesign[] {
  const trashed = url.searchParams.get('trashed') === 'true'
  const q = url.searchParams.get('q')?.toLowerCase()
  const folder = url.searchParams.get('folder')
  const starred = url.searchParams.get('starred') === 'true'
  const ordering = url.searchParams.get('ordering') ?? '-updated_at'
  let list = state.designs.filter((design) => Boolean(design.trashed_at) === trashed)
  if (q) list = list.filter((design) => design.title.toLowerCase().includes(q))
  if (starred) list = list.filter((design) => design.starred)
  if (folder === 'root') list = list.filter((design) => design.folder === null)
  else if (folder) list = list.filter((design) => design.folder === folder)
  const desc = ordering.startsWith('-')
  const key = ordering.replace('-', '') as 'updated_at' | 'created_at' | 'title'
  list = [...list].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (desc ? -1 : 1))
  return list
}

function syncFolderCounts(state: MockState) {
  for (const folder of state.folders) folder.design_count = state.designs.filter((design) => design.folder === folder.id && !design.trashed_at).length
}

/** Installs the fake API on a Playwright page. Returns the live state so tests can inspect/seed it. */
export async function installMockApi(pageHandle: Page, initial: Partial<MockState> = {}): Promise<MockState> {
  const state = createMockState(initial)

  await pageHandle.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const method = request.method()
    let body: unknown = null
    try {
      body = request.postDataJSON()
    } catch {
      body = request.postData() ? '[multipart]' : null
    }
    state.requests.push({ method, path, body })
    const unsafe = method !== 'GET'

    if (path === '/config/') return json(route, state.config)
    if (path === '/auth/csrf/') return noContent(route, { 'set-cookie': 'csrftoken=test-token; Path=/' })
    if (path === '/auth/me/' && method === 'GET') return json(route, { user: state.user })

    if (path === '/auth/login/') {
      const input = body as { email: string; password: string }
      if (input.password !== 'correct-horse-battery') return error(route, 400, 'invalid_credentials', 'That email and password don’t match.')
      state.user = makeUser({ email: input.email })
      return json(route, { user: state.user })
    }
    if (path === '/auth/register/') {
      const input = body as { email: string; password: string; display_name?: string }
      if (state.user?.email === input.email || input.email === 'taken@example.com') return error(route, 400, 'validation_error', 'Invalid input.', { fields: { email: ['An account with this email already exists.'] } })
      state.user = makeUser({ email: input.email, display_name: input.display_name ?? '', name: input.display_name || input.email.split('@')[0], is_email_verified: false })
      return json(route, { user: state.user }, 201)
    }
    if (path === '/auth/logout/') {
      state.user = null
      return noContent(route)
    }
    if (path === '/auth/me/' && method === 'PATCH' && state.user) {
      const input = body as { display_name?: string }
      if (input && typeof input === 'object' && input.display_name) {
        state.user = { ...state.user, display_name: input.display_name, name: input.display_name }
      }
      return json(route, { user: state.user })
    }
    if (path === '/auth/email/resend/') return noContent(route)
    if (path === '/auth/password/reset/') return noContent(route)

    if (path === '/template-categories/') {
      const seen = new Map<string, { id: string; slug: string; name: string; icon: string; template_count: number; sort_order: number }>()
      for (const template of state.templates) {
        const existing = seen.get(template.category.slug)
        if (existing) existing.template_count += 1
        else seen.set(template.category.slug, { ...template.category, icon: 'layout', template_count: 1, sort_order: seen.size })
      }
      return json(route, [...seen.values()])
    }
    if (path === '/templates/' && method === 'GET') {
      let list = [...state.templates]
      const category = url.searchParams.get('category')
      const q = url.searchParams.get('q')?.toLowerCase()
      const orientation = url.searchParams.get('orientation')
      if (category) list = list.filter((template) => template.category.slug === category)
      if (q) list = list.filter((template) => template.title.toLowerCase().includes(q) || template.tags.some((tag) => tag.includes(q)))
      if (orientation) list = list.filter((template) => template.orientation === orientation)
      if (url.searchParams.get('featured') === 'true') list = list.filter((template) => template.is_featured)
      return json(route, page(list.map(({ document: _d, description: _s, ...rest }) => (void _d, void _s, rest)), url))
    }
    const templateMatch = /^\/templates\/([^/]+)\/(use\/)?$/.exec(path)
    if (templateMatch) {
      const template = state.templates.find((item) => item.slug === decodeURIComponent(templateMatch[1]))
      if (!template) return error(route, 404, 'not_found', 'Not found.')
      if (templateMatch[2]) {
        if (!state.user) return error(route, 401, 'not_authenticated', 'Sign in required.')
        state.counter += 1
        const design: MockDesign = { id: `design-${state.counter}`, title: template.title, width: template.width, height: template.height, preset: template.preset, page_count: 1, thumbnail_url: template.thumbnail_url, folder: null, starred: false, revision: 1, created_at: now(), updated_at: now(), trashed_at: null, document: template.document }
        state.designs.unshift(design)
        return json(route, design, 201)
      }
      return json(route, template)
    }
    const sharedMatch = /^\/shared\/([^/]+)\/$/.exec(path)
    if (sharedMatch && method === 'GET') {
      const link = state.shared[decodeURIComponent(sharedMatch[1])]
      if (!link) return error(route, 404, 'not_found', 'Not found.')
      const supplied = request.headers()['x-share-password']
      if (link.password && !supplied) return error(route, 403, 'password_required', 'A password is required.')
      if (link.password && supplied !== link.password) return error(route, 403, 'invalid_password', 'Wrong password.')
      return json(route, { role: link.role, title: link.title, width: 800, height: 600, revision: 1, owner: { name: 'Grace Hopper', avatar_url: null }, document: blankDocument(800, 600) })
    }
    if (path === '/fonts/') return json(route, { count: 3, next: null, previous: null, results: [{ id: 'f1', family: 'Inter', category: 'sans-serif', scripts: ['latin'], is_variable: true, is_user_font: false, variants: [], popularity: 99 }, { id: 'f2', family: 'Playfair Display', category: 'serif', scripts: ['latin'], is_variable: true, is_user_font: false, variants: [], popularity: 80 }, { id: 'f3', family: 'Caveat', category: 'handwriting', scripts: ['latin'], is_variable: true, is_user_font: false, variants: [], popularity: 60 }] })

    // Everything below requires a session.
    if (!state.user) return error(route, 401, 'not_authenticated', 'Authentication credentials were not provided.')

    if (path === '/designs/' && method === 'GET') return json(route, page(applyDesignFilters(state, url).map(summary), url))
    if (path === '/designs/' && method === 'POST') {
      const input = body as { title?: string; width?: number; height?: number; preset?: string; document?: Record<string, unknown>; template?: string }
      state.counter += 1
      const design: MockDesign = { id: `design-${state.counter}`, title: input.title ?? 'Untitled design', width: input.width ?? 1080, height: input.height ?? 1080, preset: input.preset ?? '', page_count: 1, thumbnail_url: null, folder: null, starred: false, revision: 1, created_at: now(), updated_at: now(), trashed_at: null, document: input.document ?? blankDocument(input.width ?? 1080, input.height ?? 1080) }
      state.designs.unshift(design)
      return json(route, design, 201)
    }
    if (path === '/designs/bulk/') {
      const input = body as { ids: string[]; action: string; folder?: string | null }
      for (const design of state.designs.filter((item) => input.ids.includes(item.id))) {
        if (input.action === 'trash') design.trashed_at = now()
        if (input.action === 'restore') design.trashed_at = null
        if (input.action === 'star') design.starred = true
        if (input.action === 'unstar') design.starred = false
        if (input.action === 'move') design.folder = input.folder ?? null
      }
      if (input.action === 'delete') state.designs = state.designs.filter((item) => !input.ids.includes(item.id))
      syncFolderCounts(state)
      return json(route, { affected: input.ids.length })
    }
    if (path === '/designs/trash/' && method === 'DELETE') {
      state.designs = state.designs.filter((design) => !design.trashed_at)
      return noContent(route)
    }
    const designMatch = /^\/designs\/([^/]+)\/(restore\/|duplicate\/|thumbnail\/)?$/.exec(path)
    if (designMatch) {
      const design = state.designs.find((item) => item.id === designMatch[1])
      if (!design) return error(route, 404, 'not_found', 'Not found.')
      const action = designMatch[2]
      if (action === 'restore/') {
        design.trashed_at = null
        return json(route, design)
      }
      if (action === 'duplicate/') {
        state.counter += 1
        const copy = { ...design, id: `design-${state.counter}`, title: `Copy of ${design.title}`, updated_at: now() }
        state.designs.unshift(copy)
        return json(route, copy, 201)
      }
      if (action === 'thumbnail/') return json(route, { thumbnail_url: design.thumbnail_url })
      if (method === 'GET') return json(route, design)
      if (method === 'PATCH') {
        const input = body as Partial<MockDesign> & { base_revision?: number }
        if (input.document && input.base_revision !== design.revision) return error(route, 409, 'revision_conflict', 'Stale.', { current: { revision: design.revision, updated_at: design.updated_at } })
        if (input.title !== undefined) design.title = input.title
        if (input.starred !== undefined) design.starred = input.starred
        if (input.folder !== undefined) design.folder = input.folder
        if (input.document) {
          design.document = input.document
          design.revision += 1
        }
        design.updated_at = now()
        syncFolderCounts(state)
        return json(route, design)
      }
      if (method === 'DELETE') {
        if (url.searchParams.get('permanent') === 'true') state.designs = state.designs.filter((item) => item.id !== design.id)
        else design.trashed_at = now()
        syncFolderCounts(state)
        return noContent(route)
      }
    }
    if (path === '/folders/' && method === 'GET') return json(route, { count: state.folders.length, next: null, previous: null, results: state.folders })
    if (path === '/folders/' && method === 'POST') {
      const input = body as { name: string; parent?: string | null }
      state.counter += 1
      const folder: MockFolder = { id: `folder-${state.counter}`, name: input.name, parent: input.parent ?? null, design_count: 0, created_at: now() }
      state.folders.push(folder)
      return json(route, folder, 201)
    }
    const folderMatch = /^\/folders\/([^/]+)\/$/.exec(path)
    if (folderMatch) {
      const folder = state.folders.find((item) => item.id === folderMatch[1])
      if (!folder) return error(route, 404, 'not_found', 'Not found.')
      if (method === 'PATCH') {
        Object.assign(folder, body)
        return json(route, folder)
      }
      if (method === 'DELETE') {
        for (const design of state.designs) if (design.folder === folder.id) design.folder = folder.parent
        state.folders = state.folders.filter((item) => item.id !== folder.id)
        syncFolderCounts(state)
        return noContent(route)
      }
    }
    if (path === '/assets/usage/') return json(route, { used_bytes: state.assets.length * 120_000, quota_bytes: 500 * 1024 * 1024 })
    if (path === '/assets/' && method === 'GET') return json(route, page(state.assets, url))
    if (path === '/assets/' && method === 'POST') {
      const raw = request.postData() ?? ''
      const filename = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload.png'
      state.counter += 1
      const asset = { id: `asset-${state.counter}`, kind: 'image', name: filename, url: thumbnail(state.counter, 400, 400), thumb_url: thumbnail(state.counter, 400, 400), width: 400, height: 400, size: 120_000, mime: 'image/png', tags: [], attribution: null, created_at: now() }
      state.assets.unshift(asset)
      return json(route, asset, 201)
    }
    const assetMatch = /^\/assets\/([^/]+)\/$/.exec(path)
    if (assetMatch) {
      const asset = state.assets.find((item) => item.id === assetMatch[1])
      if (!asset) return error(route, 404, 'not_found', 'Not found.')
      if (method === 'PATCH') {
        Object.assign(asset, body)
        return json(route, asset)
      }
      if (method === 'DELETE') {
        state.assets = state.assets.filter((item) => item.id !== asset.id)
        return noContent(route)
      }
    }
    if (path === '/brand-kits/' && method === 'GET') return json(route, state.brandKits)
    if (path === '/brand-kits/' && method === 'POST') {
      const input = body as { name: string; is_default?: boolean; colors: unknown[]; fonts: unknown[]; logo_ids: string[] }
      state.counter += 1
      const kit = { id: `kit-${state.counter}`, name: input.name, is_default: Boolean(input.is_default), colors: input.colors, fonts: input.fonts, logos: [], created_at: now(), updated_at: now() }
      if (kit.is_default) for (const other of state.brandKits) other.is_default = false
      state.brandKits.push(kit)
      return json(route, kit, 201)
    }
    const kitMatch = /^\/brand-kits\/([^/]+)\/$/.exec(path)
    if (kitMatch) {
      const kit = state.brandKits.find((item) => item.id === kitMatch[1])
      if (!kit) return error(route, 404, 'not_found', 'Not found.')
      if (method === 'PATCH') {
        Object.assign(kit, body)
        if (kit.is_default) for (const other of state.brandKits) if (other !== kit) other.is_default = false
        return json(route, kit)
      }
      if (method === 'DELETE') {
        state.brandKits = state.brandKits.filter((item) => item.id !== kit.id)
        return noContent(route)
      }
    }
    void unsafe
    return error(route, 404, 'not_found', `No mock for ${method} ${path}`)
  })

  return state
}
