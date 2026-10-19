import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type APIRequestContext, type Browser, type BrowserContext, type Page, expect, request, test as base } from '@playwright/test'

export { expect }

/** The browser contexts a test opened with `openContext`; they are closed when it ends. */
const opened = new Set<BrowserContext>()

/** `test` with every context the test opened closed afterwards, so a long run does not pile up live pages. */
export const test = base.extend<{ release: void }>({
  release: [
    async ({ browser }, use) => {
      await use()
      const contexts = [...opened]
      opened.clear()
      // A crashed browser has nothing left to close (and closing would throw over the real failure).
      if (browser.isConnected()) await Promise.all(contexts.map((context) => context.close()))
    },
    { auto: true },
  ],
})

/** The password every test account uses (accepted by the API's validators). */
export const PASSWORD = 'Correct-horse-battery-9'

const WEB = Number(process.env.E2E_APP_WEB_PORT)
export const BASE = `http://localhost:${WEB}`
const WORK = process.env.E2E_APP_WORK ?? ''

export interface Account {
  name: string
  email: string
  password: string
  state: Awaited<ReturnType<BrowserContext['storageState']>>
}

export type Theme = 'light' | 'dark'

let counter = 0

/** A unique e-mail address, so specs never collide in the shared database. */
export function uniqueEmail(label: string): string {
  counter += 1
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${Date.now().toString(36)}.${counter}@example.test`
}

async function csrfHeader(api: APIRequestContext): Promise<Record<string, string>> {
  const state = await api.storageState()
  const token = state.cookies.find((cookie) => cookie.name === 'csrftoken')?.value ?? ''
  return { 'X-CSRFToken': token }
}

/** A cookie-keeping API client for the real backend (CSRF handled), for seeding and for assertions outside the UI. */
export class Api {
  private constructor(readonly request: APIRequestContext) {}

  static async create(storageState?: Account['state']): Promise<Api> {
    const context = await request.newContext({ baseURL: BASE, storageState })
    await context.get('/api/v1/auth/csrf/')
    return new Api(context)
  }

  /** A client with a fresh session for an account that already exists (the stored state of `createAccount` may have ended). */
  static async signedIn(account: Pick<Account, 'email' | 'password'>): Promise<Api> {
    const api = await Api.create()
    await api.call('post', '/auth/login/', { email: account.email, password: account.password })
    return api
  }

  async call<T = unknown>(method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, data?: unknown, expected = 200): Promise<T> {
    const response = await this.request[method](`/api/v1${url}`, { data, headers: await csrfHeader(this.request) })
    expect(response.status(), `${method.toUpperCase()} ${url}: ${await response.text()}`).toBeLessThan(400)
    if (expected !== 200) expect(response.status()).toBe(expected)
    return (response.status() === 204 ? null : await response.json()) as T
  }

  /** A list endpoint's items, whether the API pages it or not. */
  async list<T>(url: string): Promise<T[]> {
    const body = await this.call<T[] | { results: T[] }>('get', url)
    return Array.isArray(body) ? body : body.results
  }

  /** Same as `call` but returns the response whatever its status. */
  async raw(method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, data?: unknown) {
    return this.request[method](`/api/v1${url}`, { data, headers: await csrfHeader(this.request) })
  }

  /** Sends one file as multipart form data (`field` is the form field the endpoint reads). */
  async upload(url: string, name: string, mimeType: string, buffer: Buffer, options: { field?: string; method?: 'post' | 'put' } = {}): Promise<unknown> {
    const response = await this.request[options.method ?? 'post'](`/api/v1${url}`, {
      multipart: { [options.field ?? 'file']: { name, mimeType, buffer } },
      headers: await csrfHeader(this.request),
    })
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }

  async state(): Promise<Account['state']> {
    return this.request.storageState()
  }

  async dispose(): Promise<void> {
    await this.request.dispose()
  }
}

/** Registers an account through the API and keeps its session, so a test can open a browser context signed in as it. */
export async function createAccount(name: string, options: { email?: string; password?: string } = {}): Promise<Account> {
  const email = options.email ?? uniqueEmail(name)
  const password = options.password ?? PASSWORD
  const api = await Api.create()
  await api.call('post', '/auth/register/', { email, password, display_name: name }, 201)
  const state = await api.state()
  await api.dispose()
  return { name, email, password, state }
}

export interface OpenOptions {
  theme?: Theme
  viewport?: { width: number; height: number }
  reducedMotion?: boolean
  /** Runs on the new page before the first navigation (routes, init scripts). */
  before?: (page: Page, context: BrowserContext) => Promise<void>
}

/** A fresh browser context (own cookies and IndexedDB), signed in as `account` when given. */
export async function openContext(browser: Browser, account: Account | null, options: OpenOptions = {}): Promise<{ context: BrowserContext; page: Page; problems: Problems }> {
  const theme = options.theme ?? 'light'
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: options.viewport ?? { width: 1440, height: 900 },
    storageState: account?.state,
    colorScheme: theme,
    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
  })
  opened.add(context)
  const page = await context.newPage()
  const problems = watchProblems(page)
  await options.before?.(page, context)
  return { context, page, problems }
}

/** Console errors and warnings, uncaught exceptions and unexpected failed requests on a page. */
export interface Problems {
  list: string[]
  /** Forget what was collected so far (for a step that is expected to fail loudly). */
  clear(): void
  /** Ignore problems whose text matches when asserting (for an error the step provokes on purpose). */
  allow(pattern: RegExp): void
  assertNone(): void
}

export function watchProblems(page: Page): Problems {
  const list: string[] = []
  const allowed: RegExp[] = []
  const add = (text: string) => {
    list.push(text)
  }
  page.on('console', (message) => {
    const type = message.type()
    // The browser logs every non-2xx answer; the API's 4xx are part of normal flows (wrong password, revoked link …) and
    // the response listener below reports the ones that are not (missing files, 5xx).
    if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(message.text())) return
    if (type === 'error' || type === 'warning') add(`console.${type}: ${message.text()} (${message.location().url})`)
  })
  page.on('pageerror', (error) => add(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    const status = response.status()
    const url = new URL(response.url())
    const isApi = url.pathname.startsWith('/api/')
    if (status >= 500 || (status >= 400 && !isApi && url.origin === BASE)) add(`HTTP ${status}: ${response.request().method()} ${url.pathname}`)
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || !url.pathname.startsWith('/api/')) return
    // Every state-changing call, signed in or not, carries the CSRF token.
    if (!request.headers()['x-csrftoken']) add(`missing X-CSRFToken: ${request.method()} ${url.pathname}`)
  })
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? ''
    if (failure.includes('ERR_ABORTED')) return
    add(`requestfailed: ${request.method()} ${request.url()} ${failure}`)
  })
  return {
    list,
    clear: () => {
      list.length = 0
    },
    allow: (pattern) => {
      allowed.push(pattern)
    },
    assertNone: () => {
      expect(
        list.filter((text) => !allowed.some((pattern) => pattern.test(text))),
        'console errors / failed requests',
      ).toEqual([])
    },
  }
}

/** Where screenshots are written (only when `SCREENSHOT_DIR` is set); a missing directory is created. */
export async function shot(page: Page, name: string, options: { fullPage?: boolean } = {}): Promise<void> {
  const dir = process.env.SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: options.fullPage ?? false })
}

/** The e-mails the API has sent so far, oldest first, decoded (quoted-printable) enough to read links in them. */
export function sentMail(): { to: string; subject: string; body: string }[] {
  const dir = join(WORK, 'mail')
  return readdirSync(dir)
    .sort()
    .map((file) => {
      const raw = readFileSync(join(dir, file), 'utf8')
      const [head = '', ...rest] = raw.split('\r\n\r\n')
      const decoded = rest
        .join('\n\n')
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      const header = (name: string) => new RegExp(`^${name}: (.*)$`, 'im').exec(head)?.[1]?.trim() ?? ''
      return { to: header('To'), subject: header('Subject'), body: decoded }
    })
}

/** Waits for the newest e-mail to `to` whose subject matches, and returns the first link in it that matches `link`. */
export async function mailLink(to: string, subject: RegExp, link: RegExp): Promise<string> {
  let found = ''
  await expect
    .poll(
      () => {
        const mail = sentMail().filter((entry) => entry.to.includes(to) && subject.test(entry.subject))
        const last = mail[mail.length - 1]
        found = last ? (link.exec(last.body)?.[0] ?? '') : ''
        return found
      },
      { message: `an e-mail to ${to} with a link`, timeout: 15_000 },
    )
    .not.toBe('')
  return found
}
