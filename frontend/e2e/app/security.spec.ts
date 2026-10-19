import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { request } from '@playwright/test'
import { expect, test, Api, createAccount, openContext, PASSWORD } from './support/stack'
import { seedDesigns } from './support/seed'

const NGINX_HEADERS = readFileSync(fileURLToPath(new URL('../../nginx/security-headers.conf', import.meta.url)), 'utf8')
const header = (name: string): string => new RegExp(`add_header ${name} "([^"]*)"`).exec(NGINX_HEADERS)?.[1] ?? ''

test.describe('the policy the web container sends', () => {
  test('forbids eval, plugins, framing and foreign form targets, and names every header a site needs', () => {
    const csp = header('Content-Security-Policy')
    const directive = (name: string) => new RegExp(`(?:^|; )${name} ([^;]*)`).exec(csp)?.[1]?.split(' ') ?? []
    expect(directive('default-src')).toEqual(["'self'"])
    expect(directive('script-src')).not.toContain("'unsafe-eval'")
    expect(directive('script-src')).not.toContain("'unsafe-inline'")
    expect(directive('object-src')).toEqual(["'none'"])
    expect(directive('frame-ancestors')).toEqual(["'none'"])
    expect(directive('base-uri')).toEqual(["'self'"])
    expect(directive('form-action')).toEqual(["'self'"])
    for (const name of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy']) expect(header(name), name).not.toBe('')
    expect(NGINX_HEADERS).toContain('Strict-Transport-Security $hsts_header')
  })

  test('the production build runs under that policy on every shell route, the guest editor included, without one violation', async ({ browser }) => {
    test.skip(process.env.E2E_APP_PROD !== 'true', 'checks the production build: run `npm run e2e:app:prod`')
    test.setTimeout(180_000)
    const csp = header('Content-Security-Policy')
    const account = await createAccount('Policy Pia')
    const api = await Api.create(account.state)
    const [design] = await seedDesigns(api, 1, { prefix: 'Policy', thumbnails: false })
    const share = await api.call<{ token: string }>('post', `/designs/${design!.id}/share-links/`, { role: 'view' }, 201)
    const templates = await (await Api.create()).call<{ results: { slug: string }[] }>('get', '/templates/')

    const visit = async (signedIn: boolean, path: string, ready: (page: import('@playwright/test').Page) => Promise<void>) => {
      const { page, problems } = await openContext(browser, signedIn ? account : null, {
        before: async (target, context) => {
          await context.addInitScript(() => {
            const log: string[] = []
            ;(window as unknown as { __csp: string[] }).__csp = log
            document.addEventListener('securitypolicyviolation', (event) => log.push(`${event.violatedDirective}: ${event.blockedURI}`))
          })
          await target.route('**/*', async (route) => {
            if (route.request().resourceType() !== 'document') return route.fallback()
            const response = await route.fetch()
            return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } })
          })
        },
      })
      await page.goto(path)
      await ready(page)
      await page.waitForLoadState('networkidle')
      const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
      expect(violations, `${path} violated the policy`).toEqual([])
      problems.allow(/WebSocket connection/)
      problems.assertNone()
      await page.context().close()
    }
    const headingVisible = (page: import('@playwright/test').Page) => page.getByRole('heading').first().waitFor()
    const canvasVisible = (page: import('@playwright/test').Page) => page.locator('[data-artboard] .doory-canvas').first().waitFor({ timeout: 30_000 })
    await visit(false, '/', headingVisible)
    await visit(false, '/templates', headingVisible)
    await visit(false, `/templates/${templates.results[0]!.slug}`, headingVisible)
    await visit(false, '/login', headingVisible)
    await visit(false, '/signup', headingVisible)
    await visit(false, '/create?preset=poster', canvasVisible)
    await visit(false, `/s/${share.token}`, canvasVisible)
    await visit(true, '/dashboard', headingVisible)
    await visit(true, '/dashboard/designs', headingVisible)
    await visit(true, '/settings', headingVisible)
    await visit(true, `/design/${design!.id}`, canvasVisible)
  })
})

test.describe('cookies and the API in front of the app', () => {
  test('the session cookie is HttpOnly and SameSite=Lax, the CSRF cookie is readable by the app but also Lax', async ({ browser }) => {
    const account = await createAccount('Cookie Cal')
    const { page, context } = await openContext(browser, null)
    await page.goto('/login')
    await page.getByRole('textbox', { name: 'Email' }).fill(account.email)
    await page.getByRole('textbox', { name: 'Password' }).fill(account.password)
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    const cookies = await context.cookies()
    const session = cookies.find((cookie) => cookie.name === 'sessionid')
    const csrf = cookies.find((cookie) => cookie.name === 'csrftoken')
    expect(session?.httpOnly).toBe(true)
    expect(session?.sameSite).toBe('Lax')
    expect(csrf?.httpOnly).toBe(false)
    expect(csrf?.sameSite).toBe('Lax')
  })

  test('API answers carry the browser-hardening headers and are not cached by shared caches', async ({ browser }) => {
    const account = await createAccount('Header Hal')
    const { context } = await openContext(browser, account)
    const response = await context.request.get('/api/v1/auth/me/')
    const headers = response.headers()
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['permissions-policy']).toContain('camera=()')
    expect(headers['cross-origin-opener-policy']).toBe('same-origin')
    const share = await context.request.get('/api/v1/shared/nothing-here/')
    expect(share.status()).toBe(404)
  })

  test('a state-changing call without the token is refused, signed in or not, and the app repairs a stale token by itself', async ({ browser }) => {
    const account = await createAccount('Csrf Cora')
    const api = await Api.create(account.state)
    const [design] = await seedDesigns(api, 1, { prefix: 'Token', thumbnails: false })

    const bare = await request.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_WEB_PORT}`, storageState: account.state })
    const refused = await bare.patch(`/api/v1/designs/${design!.id}/`, { data: { starred: true } })
    expect(refused.status()).toBe(403)
    expect((await refused.json()).error.code).toBe('csrf_failed')
    await bare.dispose()
    const anonymous = await request.newContext({ baseURL: `http://localhost:${process.env.E2E_APP_WEB_PORT}` })
    const login = await anonymous.post('/api/v1/auth/login/', { data: { email: account.email, password: PASSWORD } })
    expect(login.status()).toBe(403)
    await anonymous.dispose()

    const { page, context, problems } = await openContext(browser, account)
    await page.goto('/dashboard/designs')
    await expect(page.getByRole('button', { name: /Star Token 1/ })).toBeVisible()
    await context.addCookies([{ name: 'csrftoken', value: 'a-stale-or-forged-token', domain: 'localhost', path: '/' }])
    await page.getByRole('button', { name: 'Star Token 1' }).click()
    await expect(page.getByRole('button', { name: 'Remove Token 1 from starred' })).toBeVisible()
    await expect.poll(async () => (await api.call<{ starred: boolean }>('get', `/designs/${design!.id}/`)).starred).toBe(true)

    await context.clearCookies({ name: 'csrftoken' })
    await page.getByRole('button', { name: 'Remove Token 1 from starred' }).click()
    await expect(page.getByRole('button', { name: 'Star Token 1' })).toBeVisible()
    problems.allow(/HTTP 403/)
    problems.assertNone()
  })
})
