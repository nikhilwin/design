import { createBlankDocument } from '@/lib/document'
import { LocalRepository, createMemoryStore } from '@/lib/local'
import { resetClientState } from '@/lib/api'
import { captureFetch, type CapturedRequest } from '@/test/utils'
import type { SaveInput } from '@/types/adapter'
import { MigrationError } from './errors'
import { migrateLocalDesign, removeMissingAssetReferences } from './migrateLocalDesign'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`)

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const errorBody = (code: string, message: string, status: number) => json({ error: { code, message } }, status)

interface World {
  repo: LocalRepository
  snapshot: SaveInput
  assetIds: string[]
}

async function createWorld(assetCount: number, opts: { background?: boolean } = {}): Promise<World> {
  const repo = new LocalRepository(async () => ({ store: createMemoryStore(), mode: 'memory' }))
  const assetIds = ids(assetCount)
  for (const [index, id] of assetIds.entries()) {
    await repo.putAsset({ id, blob: new Blob([`image-${index}`], { type: 'image/png' }), name: `photo-${index}.png`, width: 100, height: 50 })
  }
  const document = createBlankDocument(800, 600, { presetId: 'poster' })
  document.pages[0].objects = assetIds.map((id, index) => ({ id: `obj-${index}`, type: 'image', src: `idb://${id}` }))
  if (opts.background && assetIds.length > 0) document.pages[0].background = { type: 'image', src: `idb://${assetIds[0]}`, fit: 'cover' }
  const snapshot: SaveInput = { document, title: 'My poster', thumbnail: new Blob(['thumb'], { type: 'image/png' }) }
  await repo.saveDesign({ id: 'local-1', title: snapshot.title, document })
  return { repo, snapshot, assetIds }
}

/** Stands for a request the server handled although the answer never arrived: the design is created, then the connection drops. */
const LOST_ANSWER = Symbol('lost answer')

interface ServerOptions {
  uploadFails?: (call: number, request: CapturedRequest) => Response | null
  designFails?: (call: number) => Response | typeof LOST_ANSWER | null
  /** The design list cannot be read (the account cannot be asked what exists). */
  listFails?: () => boolean
  thumbnailFails?: boolean
  onUpload?: (request: CapturedRequest) => Promise<void> | void
}

function fakeApi(options: ServerOptions = {}) {
  const state = { uploads: 0, designs: 0, created: [] as Array<Record<string, unknown>>, deletes: [] as string[], designBody: null as unknown, thumbnails: 0, maxInFlight: 0, inFlight: 0 }
  const calls = captureFetch(async (request) => {
    const path = request.url.pathname
    if (request.method === 'POST' && path === '/api/v1/assets/') {
      state.uploads += 1
      state.inFlight += 1
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      try {
        await options.onUpload?.(request)
        const failure = options.uploadFails?.(state.uploads, request)
        if (failure) return failure
        const form = request.body as FormData
        const name = String(form.get('name'))
        return json({ id: `srv-${name}`, kind: 'image', name, url: `/media/assets/${name}`, thumb_url: `/media/assets/t-${name}`, width: 100, height: 50, size: 10, mime: 'image/png', tags: [], created_at: '' }, 201)
      } finally {
        state.inFlight -= 1
      }
    }
    if (request.method === 'DELETE' && path.startsWith('/api/v1/assets/')) {
      state.deletes.push(path.split('/')[4])
      return new Response(null, { status: 204 })
    }
    if (request.method === 'GET' && path === '/api/v1/designs/') {
      if (options.listFails?.()) throw new TypeError('Failed to fetch')
      return json({ count: state.created.length, next: null, previous: null, results: [...state.created].reverse() })
    }
    if (request.method === 'POST' && path === '/api/v1/designs/') {
      state.designs += 1
      const failure = options.designFails?.(state.designs)
      if (failure && failure !== LOST_ANSWER) return failure
      state.designBody = JSON.parse(String(request.body))
      const body = state.designBody as { title: string; width: number; height: number; document: { pages: unknown[] } }
      state.created.push({ id: `design-${state.created.length + 1}`, title: body.title, width: body.width, height: body.height, page_count: body.document.pages.length })
      if (failure === LOST_ANSWER) throw new TypeError('Failed to fetch')
      return json({ id: `design-${state.created.length}` }, 201)
    }
    if (request.method === 'PUT' && path === '/api/v1/designs/design-1/thumbnail/') {
      state.thumbnails += 1
      return options.thumbnailFails ? errorBody('server_error', 'nope', 500) : json({ thumbnail_url: '/media/t.webp' })
    }
    return errorBody('not_found', `Unexpected ${request.method} ${path}`, 404)
  })
  return { state, calls }
}

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=tok; path=/'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const fast = { retryDelayMs: 0 }

describe('migrateLocalDesign: success', () => {
  it('uploads every referenced image, rewrites sources, creates the design and removes local data', async () => {
    const { repo, snapshot, assetIds } = await createWorld(2, { background: true })
    const { state } = fakeApi()
    const progress = vi.fn()

    const designId = await migrateLocalDesign('local-1', snapshot, { repository: repo, onProgress: progress, ...fast })

    expect(designId).toBe('design-1')
    expect(state.uploads).toBe(2)
    const body = state.designBody as { title: string; width: number; height: number; preset: string; document: { pages: Array<{ background: { src?: string }; objects: Array<{ src: string; assetId?: string }> }> } }
    expect(body.title).toBe('My poster')
    expect(body.width).toBe(800)
    expect(body.preset).toBe('poster')
    expect(JSON.stringify(body.document)).not.toContain('idb://')
    expect(body.document.pages[0].objects[0]).toMatchObject({ src: '/media/assets/photo-0.png', assetId: 'srv-photo-0.png' })
    expect(body.document.pages[0].background.src).toBe('/media/assets/photo-0.png')
    expect(state.thumbnails).toBe(1)
    expect(await repo.getDesign('local-1')).toBeNull()
    for (const id of assetIds) expect(await repo.getAsset(id)).toBeNull()
    const phases = progress.mock.calls.map(([p]) => p.phase)
    expect(phases[0]).toBe('prepare')
    expect(phases).toContain('assets')
    expect(phases.at(-1)).toBe('finish')
    const assetDone = progress.mock.calls.filter(([p]) => p.phase === 'assets').map(([p]) => p.done)
    expect(assetDone).toEqual([...assetDone].sort((a, b) => a - b))
    expect(assetDone.at(-1)).toBe(2)
  })

  it('works for designs without images', async () => {
    const { repo, snapshot } = await createWorld(0)
    const { state } = fakeApi()
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(state.uploads).toBe(0)
    expect(await repo.getDesign('local-1')).toBeNull()
  })

  it('uploads with bounded concurrency (3 by default)', async () => {
    const { repo, snapshot } = await createWorld(8)
    const { state } = fakeApi({ onUpload: () => new Promise((resolve) => setTimeout(resolve, 15)) })
    await migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })
    expect(state.uploads).toBe(8)
    expect(state.maxInFlight).toBe(3)
  })

  it('retries transient upload failures and still succeeds', async () => {
    const { repo, snapshot } = await createWorld(1)
    const { state } = fakeApi({ uploadFails: (call) => (call === 1 ? errorBody('server_error', 'Try later', 503) : null) })
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(state.uploads).toBe(2)
  })

  it('treats a failed thumbnail upload as non-fatal', async () => {
    const { repo, snapshot } = await createWorld(0)
    fakeApi({ thumbnailFails: true })
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(await repo.getDesign('local-1')).toBeNull()
  })

  it('shares one run between concurrent calls for the same local design', async () => {
    const { repo, snapshot } = await createWorld(1)
    const { state } = fakeApi({ onUpload: () => new Promise((resolve) => setTimeout(resolve, 10)) })
    const [a, b] = await Promise.all([migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast }), migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })])
    expect(a).toBe(b)
    expect(state.designs).toBe(1)
    expect(state.uploads).toBe(1)
  })
})

describe('migrateLocalDesign: failures never lose guest work', () => {
  it('aborts on the first hard upload failure, rolls back uploaded assets and keeps the local copy', async () => {
    const { repo, snapshot, assetIds } = await createWorld(6)
    const { state } = fakeApi({
      uploadFails: (_call, request) => ((request.body as FormData).get('name') === 'photo-1.png' ? errorBody('invalid_image', 'This file is not a valid image.', 400) : null),
      onUpload: () => new Promise((resolve) => setTimeout(resolve, 5)),
    })
    const error = await migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MigrationError)
    expect((error as MigrationError).phase).toBe('assets')
    expect((error as MigrationError).assetName).toBe('photo-1.png')
    expect((error as MigrationError).message).toContain('not a valid image')
    expect(state.designs).toBe(0)
    expect(state.uploads).toBeLessThan(6)
    expect(state.deletes.length).toBeGreaterThan(0)
    expect(await repo.getDesign('local-1')).not.toBeNull()
    for (const id of assetIds) expect(await repo.getAsset(id)).not.toBeNull()
  })

  it('keeps everything locally when design creation fails, then succeeds on retry', async () => {
    const { repo, snapshot, assetIds } = await createWorld(2)
    let failing = true
    const { state } = fakeApi({ designFails: () => (failing ? errorBody('server_error', 'Database down', 500) : null) })
    const error = await migrateLocalDesign('local-1', snapshot, { repository: repo, retries: 1, ...fast }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MigrationError)
    expect((error as MigrationError).phase).toBe('design')
    expect(state.designs).toBe(2)
    expect(state.deletes.sort()).toEqual(['srv-photo-0.png', 'srv-photo-1.png'])
    expect(await repo.getDesign('local-1')).not.toBeNull()
    for (const id of assetIds) expect(await repo.getAsset(id)).not.toBeNull()

    failing = false
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(await repo.getDesign('local-1')).toBeNull()
  })

  it('does not create the design twice when the answer to the first request is lost', async () => {
    const { repo, snapshot } = await createWorld(1)
    const { state } = fakeApi({ designFails: (call) => (call === 1 ? LOST_ANSWER : null) })
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(state.designs).toBe(1)
    expect(state.created).toHaveLength(1)
    expect(state.deletes).toEqual([])
    expect(state.thumbnails).toBe(1)
    expect(await repo.getDesign('local-1')).toBeNull()
  })

  it('still retries when the design list shows nothing was created', async () => {
    const { repo, snapshot } = await createWorld(0)
    const { state } = fakeApi({ designFails: (call) => (call === 1 ? errorBody('server_error', 'Database down', 500) : null) })
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(state.designs).toBe(2)
    expect(state.created).toHaveLength(1)
  })

  it('when the account cannot be asked, stops instead of sending the request again, keeps the uploads, and finds the design on the next try', async () => {
    const { repo, snapshot } = await createWorld(2)
    let listDown = true
    const { state } = fakeApi({ designFails: (call) => (call === 1 ? LOST_ANSWER : null), listFails: () => listDown && state.designs > 0 })
    const error = await migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MigrationError)
    expect((error as MigrationError).phase).toBe('design')
    expect(state.designs).toBe(1)
    expect(state.deletes).toEqual([])
    expect(await repo.getDesign('local-1')).not.toBeNull()

    listDown = false
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(state.designs).toBe(1)
    expect(state.created).toHaveLength(1)
    expect(state.uploads).toBe(2)
    expect(state.deletes).toEqual([])
    expect(await repo.getDesign('local-1')).toBeNull()
  })

  it('removes the kept uploads before starting over when the next try shows the design was never created', async () => {
    const { repo, snapshot } = await createWorld(1)
    let listDown = true
    const { state } = fakeApi({
      designFails: (call) => (call === 1 ? errorBody('server_error', 'down', 500) : null),
      listFails: () => listDown && state.designs > 0,
    })
    const first = await migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast }).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(MigrationError)
    expect(state.deletes).toEqual([])
    listDown = false
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).resolves.toBe('design-1')
    expect(state.uploads).toBe(2)
    expect(state.deletes).toEqual(['srv-photo-0.png'])
    expect(state.created).toHaveLength(1)
  })

  it('does not retry client errors', async () => {
    const { repo, snapshot } = await createWorld(0)
    const { state } = fakeApi({ designFails: () => errorBody('inline_asset_not_allowed', 'Inline assets are not allowed.', 400) })
    await expect(migrateLocalDesign('local-1', snapshot, { repository: repo, ...fast })).rejects.toBeInstanceOf(MigrationError)
    expect(state.designs).toBe(1)
  })

  it('stops when the caller aborts and leaves local data in place', async () => {
    const { repo, snapshot } = await createWorld(4)
    const controller = new AbortController()
    const { state } = fakeApi({ onUpload: () => new Promise((resolve) => setTimeout(resolve, 10)) })
    const run = migrateLocalDesign('local-1', snapshot, { repository: repo, signal: controller.signal, ...fast })
    setTimeout(() => controller.abort(), 5)
    await expect(run).rejects.toBeTruthy()
    expect(state.designs).toBe(0)
    expect(await repo.getDesign('local-1')).not.toBeNull()
  })

  it('saves the freshest snapshot locally before uploading anything', async () => {
    const { repo, snapshot } = await createWorld(0)
    snapshot.document.pages[0].name = 'edited just now'
    fakeApi({ designFails: () => errorBody('server_error', 'down', 500) })
    await migrateLocalDesign('local-1', snapshot, { repository: repo, retries: 0, ...fast }).catch(() => undefined)
    expect((await repo.getDesign('local-1'))?.document.pages[0].name).toBe('edited just now')
  })
})

describe('migrateLocalDesign: images missing from local storage', () => {
  it('leaves out missing images, warns, and migrates the rest', async () => {
    const { repo, snapshot, assetIds } = await createWorld(2)
    await repo.deleteAsset(assetIds[1])
    const { state } = fakeApi()
    const warning = vi.fn()
    await migrateLocalDesign('local-1', snapshot, { repository: repo, onWarning: warning, ...fast })
    expect(state.uploads).toBe(1)
    const body = state.designBody as { document: { pages: Array<{ objects: unknown[] }> } }
    expect(body.document.pages[0].objects).toHaveLength(1)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('1 image was'))
  })

  it('removeMissingAssetReferences prunes nested objects and replaces image backgrounds', () => {
    const [missingId, keepId] = ids(2)
    const doc = createBlankDocument(10, 10)
    doc.pages[0].background = { type: 'image', src: `idb://${missingId}`, fit: 'cover' }
    doc.pages[0].objects = [
      { id: 'a', type: 'image', src: `idb://${missingId}` },
      { id: 'g', type: 'group', objects: [{ id: 'b', type: 'image', src: `idb://${missingId}` }, { id: 'c', type: 'image', src: `idb://${keepId}` }] },
    ]
    const result = removeMissingAssetReferences(doc, new Set([missingId]))
    expect(result.pages[0].background.type).toBe('solid')
    expect(result.pages[0].objects).toHaveLength(1)
    expect((result.pages[0].objects[0].objects as unknown[]).length).toBe(1)
    expect(JSON.stringify(result)).toContain(keepId)
  })
})
