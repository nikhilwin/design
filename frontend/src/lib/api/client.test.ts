import { http as mswHttp, HttpResponse } from 'msw'
import { server } from '@/test/msw'
import { ApiError, buildQuery, ensureCsrf, http, resetClientState, setUnauthorizedHandler } from './client'

function clearCookie() {
  document.cookie = 'csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
}

beforeEach(() => {
  clearCookie()
  resetClientState()
})

describe('buildQuery', () => {
  it('skips empty values and stringifies booleans and numbers', () => {
    expect(buildQuery({ q: 'cat', page: 2, starred: true, folder: undefined, empty: '', nothing: null })).toBe('?q=cat&page=2&starred=true')
    expect(buildQuery({})).toBe('')
    expect(buildQuery(undefined)).toBe('')
  })

  it('encodes special characters', () => {
    expect(buildQuery({ q: 'a b&c' })).toBe('?q=a+b%26c')
  })
})

describe('http client: requests', () => {
  it('sends GET requests with credentials, JSON accept header and query string', async () => {
    let seen: Request | null = null
    server.use(
      mswHttp.get('*/api/v1/designs/', ({ request }) => {
        seen = request
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] })
      }),
    )
    const page = await http.get<{ count: number }>('/designs/', { query: { q: 'logo', starred: true } })
    expect(page.count).toBe(0)
    expect(seen).not.toBeNull()
    const request = seen as unknown as Request
    expect(new URL(request.url).search).toBe('?q=logo&starred=true')
    expect(request.headers.get('accept')).toBe('application/json')
    expect(request.headers.has('x-csrftoken')).toBe(false)
  })

  it('returns undefined for 204 responses', async () => {
    server.use(mswHttp.delete('*/api/v1/designs/1/', () => new HttpResponse(null, { status: 204 })))
    document.cookie = 'csrftoken=abc; path=/'
    await expect(http.delete('/designs/1/')).resolves.toBeUndefined()
  })

  it('serialises JSON bodies with a content type', async () => {
    document.cookie = 'csrftoken=tok; path=/'
    let body: unknown
    let contentType: string | null = null
    server.use(
      mswHttp.post('*/api/v1/designs/', async ({ request }) => {
        body = await request.json()
        contentType = request.headers.get('content-type')
        return HttpResponse.json({ id: 'd1' }, { status: 201 })
      }),
    )
    await http.post('/designs/', { json: { title: 'Poster' } })
    expect(body).toEqual({ title: 'Poster' })
    expect(contentType).toBe('application/json')
  })

  it('lets the browser set the multipart boundary for FormData', async () => {
    document.cookie = 'csrftoken=tok; path=/'
    let contentType: string | null = null
    server.use(
      mswHttp.post('*/api/v1/assets/', ({ request }) => {
        contentType = request.headers.get('content-type')
        return HttpResponse.json({ id: 'a1' }, { status: 201 })
      }),
    )
    const form = new FormData()
    form.append('file', new Blob(['x']), 'x.png')
    await http.post('/assets/', { form })
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
  })
})

describe('http client: CSRF', () => {
  it('fetches the CSRF cookie lazily once, then sends X-CSRFToken on unsafe methods', async () => {
    let csrfCalls = 0
    const tokens: Array<string | null> = []
    server.use(
      mswHttp.get('*/api/v1/auth/csrf/', () => {
        csrfCalls += 1
        document.cookie = 'csrftoken=fresh-token; path=/'
        return new HttpResponse(null, { status: 204 })
      }),
      mswHttp.post('*/api/v1/designs/1/duplicate/', ({ request }) => {
        tokens.push(request.headers.get('x-csrftoken'))
        return HttpResponse.json({ id: 'd2' }, { status: 201 })
      }),
    )
    await http.post('/designs/1/duplicate/')
    await http.post('/designs/1/duplicate/')
    expect(csrfCalls).toBe(1)
    expect(tokens).toEqual(['fresh-token', 'fresh-token'])
  })

  it('does not hit the CSRF endpoint when the cookie already exists or for GETs', async () => {
    document.cookie = 'csrftoken=existing; path=/'
    server.use(mswHttp.get('*/api/v1/config/', () => HttpResponse.json({ ok: true })))
    await ensureCsrf()
    await http.get('/config/')
  })

  it('refreshes the token and retries once when the server rejects CSRF', async () => {
    document.cookie = 'csrftoken=stale; path=/'
    const used: Array<string | null> = []
    server.use(
      mswHttp.get('*/api/v1/auth/csrf/', () => {
        document.cookie = 'csrftoken=renewed; path=/'
        return new HttpResponse(null, { status: 204 })
      }),
      mswHttp.post('*/api/v1/auth/logout/', ({ request }) => {
        used.push(request.headers.get('x-csrftoken'))
        if (used.length === 1) return HttpResponse.json({ error: { code: 'permission_denied', message: 'CSRF Failed: token missing.' } }, { status: 403 })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await expect(http.post('/auth/logout/')).resolves.toBeUndefined()
    expect(used).toEqual(['stale', 'renewed'])
  })
})

describe('http client: errors', () => {
  beforeEach(() => {
    document.cookie = 'csrftoken=tok; path=/'
  })

  it('maps the error envelope, normalising field errors to arrays', async () => {
    server.use(
      mswHttp.post('*/api/v1/auth/register/', () =>
        HttpResponse.json({ error: { code: 'validation_error', message: 'Invalid input.', fields: { email: 'Already used', password: ['Too short', 'Too common'] } } }, { status: 400 }),
      ),
    )
    const error = await http.post('/auth/register/', { json: {} }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(400)
    expect(apiError.code).toBe('validation_error')
    expect(apiError.message).toBe('Invalid input.')
    expect(apiError.fieldError('email')).toBe('Already used')
    expect(apiError.fields.password).toEqual(['Too short', 'Too common'])
  })

  it('exposes conflict details from the body', async () => {
    server.use(mswHttp.patch('*/api/v1/designs/1/', () => HttpResponse.json({ error: { code: 'revision_conflict', message: 'Stale' }, current: { revision: 9 } }, { status: 409 })))
    const error = (await http.patch('/designs/1/', { json: {} }).catch((e: unknown) => e)) as ApiError
    expect(error.isConflict).toBe(true)
    expect((error.data as { current: { revision: number } }).current.revision).toBe(9)
  })

  it('turns fetch failures into network_error ApiErrors', async () => {
    server.use(mswHttp.get('*/api/v1/config/', () => HttpResponse.error()))
    const error = (await http.get('/config/').catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.isNetwork).toBe(true)
    expect(error.status).toBe(0)
  })

  it('handles non-JSON server errors with a friendly message', async () => {
    server.use(mswHttp.get('*/api/v1/config/', () => new HttpResponse('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })))
    const error = (await http.get('/config/').catch((e: unknown) => e)) as ApiError
    expect(error.status).toBe(502)
    expect(error.code).toBe('server_error')
    expect(error.message).not.toContain('<html>')
  })

  it('retries once on a csrf_failed code even when the message differs', async () => {
    const used: Array<string | null> = []
    server.use(
      mswHttp.get('*/api/v1/auth/csrf/', () => {
        document.cookie = 'csrftoken=renewed2; path=/'
        return new HttpResponse(null, { status: 204 })
      }),
      mswHttp.post('*/api/v1/designs/', ({ request }) => {
        used.push(request.headers.get('x-csrftoken'))
        if (used.length === 1) return HttpResponse.json({ error: { code: 'csrf_failed', message: 'Your session expired. Reload and try again.' } }, { status: 403 })
        return HttpResponse.json({ id: 'd' }, { status: 201 })
      }),
    )
    await expect(http.post('/designs/', { json: {} })).resolves.toEqual({ id: 'd' })
    expect(used).toEqual(['tok', 'renewed2'])
  })

  it('exposes field codes and retry_after from the envelope', async () => {
    server.use(
      mswHttp.post('*/api/v1/auth/login/', () =>
        HttpResponse.json({ error: { code: 'throttled', message: 'Slow down', retry_after: 42.2, field_codes: { password: 'password_too_common' } } }, { status: 429 }),
      ),
    )
    const error = (await http.post('/auth/login/', { json: {} }).catch((e: unknown) => e)) as ApiError
    expect(error.retryAfter).toBe(43)
    expect(error.fieldCodes.password).toEqual(['password_too_common'])
  })

  it('falls back to the Retry-After header', async () => {
    server.use(mswHttp.post('*/api/v1/auth/login/', () => HttpResponse.json({ error: { code: 'throttled', message: 'Slow down' } }, { status: 429, headers: { 'retry-after': '30' } })))
    const error = (await http.post('/auth/login/', { json: {} }).catch((e: unknown) => e)) as ApiError
    expect(error.retryAfter).toBe(30)
  })

  it('flags rate limits', async () => {
    server.use(mswHttp.post('*/api/v1/auth/login/', () => HttpResponse.json({ error: { code: 'throttled', message: 'Slow down' } }, { status: 429 })))
    const error = (await http.post('/auth/login/', { json: {} }).catch((e: unknown) => e)) as ApiError
    expect(error.isRateLimited).toBe(true)
  })

  it('calls the 401 handler unless silenced', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    server.use(mswHttp.get('*/api/v1/designs/', () => HttpResponse.json({ error: { code: 'not_authenticated', message: 'Sign in' } }, { status: 401 })))
    await expect(http.get('/designs/')).rejects.toMatchObject({ status: 401 })
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(http.get('/designs/', { silentUnauthorized: true })).rejects.toMatchObject({ status: 401 })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

class FakeXhr {
  static instances: FakeXhr[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  withCredentials = false
  responseType = ''
  status = 0
  response: ArrayBuffer | null = null
  sent: unknown = null
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  responseHeaders: Record<string, string> = { 'content-type': 'application/json' }

  constructor() {
    FakeXhr.instances.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key.toLowerCase()] = value
  }
  getResponseHeader(key: string) {
    return this.responseHeaders[key.toLowerCase()] ?? null
  }
  send(body: unknown) {
    this.sent = body
  }
  abort() {
    this.onabort?.()
  }
  respond(status: number, json: unknown) {
    this.status = status
    this.response = new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer
    this.onload?.()
  }
}

describe('http client: uploads with progress', () => {
  beforeEach(() => {
    FakeXhr.instances = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    document.cookie = 'csrftoken=tok; path=/'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function formWithFile() {
    const form = new FormData()
    form.append('file', new Blob(['hello']), 'hello.png')
    return form
  }

  it('uses XMLHttpRequest with credentials, CSRF header and reports progress', async () => {
    const progress = vi.fn()
    const pending = http.post<{ id: string }>('/assets/', { form: formWithFile(), onUploadProgress: progress })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    const xhr = FakeXhr.instances[0]
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/v1/assets/')
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.headers['x-csrftoken']).toBe('tok')
    expect(xhr.headers['content-type']).toBeUndefined()
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 })
    xhr.respond(201, { id: 'a1' })
    await expect(pending).resolves.toEqual({ id: 'a1' })
    expect(progress).toHaveBeenCalledWith(0.25)
  })

  it('maps error envelopes from XMLHttpRequest responses to ApiError', async () => {
    const pending = http.post('/assets/', { form: formWithFile(), onUploadProgress: () => undefined })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.instances[0].respond(400, { error: { code: 'invalid_image', message: 'Not an image' } })
    await expect(pending).rejects.toMatchObject({ code: 'invalid_image', status: 400 })
  })

  it('reports the end of the upload as complete even when no progress event said so', async () => {
    const progress = vi.fn()
    const pending = http.post('/exports/pdf/', { form: formWithFile(), onUploadProgress: progress })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.instances[0].upload.onload?.()
    expect(progress).toHaveBeenCalledWith(1)
    FakeXhr.instances[0].respond(201, {})
    await pending
  })

  it('keeps the Retry-After header of an error answer', async () => {
    const pending = http.post('/exports/pdf/', { form: formWithFile(), onUploadProgress: () => undefined })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.instances[0].responseHeaders['retry-after'] = '7'
    FakeXhr.instances[0].respond(503, { error: { code: 'export_busy', message: 'Busy' } })
    await expect(pending).rejects.toMatchObject({ code: 'export_busy', status: 503, retryAfter: 7 })
  })

  it('rejects with an AbortError when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = http.post('/assets/', { form: formWithFile(), onUploadProgress: () => undefined, signal: controller.signal })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
