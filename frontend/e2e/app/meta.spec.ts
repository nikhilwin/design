import type { Page } from '@playwright/test'
import { expect, test, Api, createAccount, openContext } from './support/stack'
import { seedDesigns } from './support/seed'

interface Head {
  title: string
  description: string | null
  canonical: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null
  ogUrl: string | null
  twitterCard: string | null
  robots: string | null
}

async function head(page: Page): Promise<Head> {
  return page.evaluate(() => {
    const meta = (selector: string) => document.head.querySelector(selector)?.getAttribute('content') ?? null
    return {
      title: document.title,
      description: meta('meta[name="description"]'),
      canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      ogTitle: meta('meta[property="og:title"]'),
      ogDescription: meta('meta[property="og:description"]'),
      ogImage: meta('meta[property="og:image"]'),
      ogUrl: meta('meta[property="og:url"]'),
      twitterCard: meta('meta[name="twitter:card"]'),
      robots: meta('meta[name="robots"]'),
    }
  })
}

test('every route has its own title, and the public ones the tags a search engine or a link card needs', async ({ browser }) => {
  test.setTimeout(150_000)
  const owner = await createAccount('Meta Mia')
  const api = await Api.create(owner.state)
  const [design] = await seedDesigns(api, 1, { prefix: 'Meta design', thumbnails: false })
  const share = await api.call<{ token: string }>('post', `/designs/${design!.id}/share-links/`, { role: 'view' }, 201)
  const templates = await (await Api.create()).call<{ results: { slug: string; title: string }[] }>('get', '/templates/')
  const template = templates.results[0]!

  const titles = new Map<string, string>()
  const record = async (page: Page, route: string, expectTitle: RegExp, options: { canonical?: boolean; noindex?: boolean } = {}) => {
    await expect.poll(() => page.title(), { message: route }).toMatch(expectTitle)
    if (options.canonical) await page.locator('link[rel="canonical"]').waitFor({ state: 'attached' })
    if (options.noindex) await page.locator('meta[name="robots"]').waitFor({ state: 'attached' })
    titles.set(route, await page.title())
    return head(page)
  }

  const guest = await openContext(browser, null)
  const origin = new URL(guest.page.url() === 'about:blank' ? `http://localhost:${process.env.E2E_APP_WEB_PORT}` : guest.page.url()).origin

  await guest.page.goto('/')
  let landing = await record(guest.page, '/', /Doory/, { canonical: true })
  expect(landing.description).toMatch(/free, open-source design platform/)
  expect(landing.canonical).toBe(`${origin}/`)
  expect(landing.ogImage).toBe(`${origin}/og-image.png`)
  expect(landing.twitterCard).toBe('summary_large_image')
  expect(landing.robots).toBeNull()

  await guest.page.goto('/templates')
  const gallery = await record(guest.page, '/templates', /^Free design templates · Doory$/, { canonical: true })
  expect(gallery.canonical).toBe(`${origin}/templates`)
  expect(gallery.ogTitle).toBe('Free design templates · Doory')
  expect(gallery.description).toMatch(/templates/)
  expect(gallery.robots).toBeNull()

  await guest.page.goto(`/templates/${template.slug}`)
  const detail = await record(guest.page, `/templates/${template.slug}`, new RegExp(`^${template.title}`), { canonical: true })
  expect(detail.canonical).toBe(`${origin}/templates/${template.slug}`)
  expect(detail.ogUrl).toBe(detail.canonical)
  expect(detail.ogImage).toMatch(/^http.*\/media\/templates\/.*\.webp$/)
  expect(detail.ogDescription).toBe(detail.description)
  expect(detail.robots).toBeNull()

  // Back on the landing page the tags of the template page are gone.
  await guest.page.getByRole('link', { name: 'Doory home' }).click()
  await expect(guest.page).toHaveURL(`${origin}/`)
  await expect.poll(async () => (await head(guest.page)).canonical).toBe(`${origin}/`)
  landing = await head(guest.page)
  expect(landing.canonical).toBe(`${origin}/`)
  expect(landing.ogImage).toBe(`${origin}/og-image.png`)

  for (const [route, title, indexable] of [
    ['/login', /^Log in · Doory$/, false],
    ['/signup', /^Sign up · Doory$/, false],
    ['/forgot-password', /^Reset your password · Doory$/, false],
    ['/reset-password', /^Choose a new password · Doory$/, false],
    ['/verify-email', /^Verify your email · Doory$/, false],
    ['/no/such/page', /^Page not found · Doory$/, false],
    [`/s/${share.token}`, /^Meta design 1 · Doory$/, false],
  ] as const) {
    await guest.page.goto(route)
    const tags = await record(guest.page, route, title, { noindex: true })
    expect(tags.robots === 'noindex, nofollow', `${route} robots`).toBe(!indexable)
  }

  const signedIn = await openContext(browser, owner)
  for (const [route, title] of [
    ['/dashboard', /^Home · Doory$/],
    ['/dashboard/designs', /^Designs · Doory$/],
    ['/dashboard/templates', /^Start from a template · Doory$/],
    ['/dashboard/brand', /^Brand · Doory$/],
    ['/dashboard/uploads', /^Uploads · Doory$/],
    ['/dashboard/trash', /^Trash · Doory$/],
    ['/settings', /^Settings · Doory$/],
    [`/design/${design!.id}`, /^Meta design 1 · Doory$/],
  ] as const) {
    await signedIn.page.goto(route)
    const tags = await record(signedIn.page, route, title, { noindex: true })
    expect(tags.robots, `${route} robots`).toBe('noindex, nofollow')
  }

  // The second test of "unique": no two routes share a title (the share link and the editor are the same design on purpose).
  const seen = new Map<string, string>()
  for (const [route, title] of titles) {
    const other = seen.get(title)
    if (other && !(route.startsWith('/s/') || route.startsWith('/design/')) && !(other.startsWith('/s/') || other.startsWith('/design/'))) throw new Error(`${route} and ${other} share the title "${title}"`)
    seen.set(title, route)
  }
  guest.problems.allow(/WebSocket connection/)
  signedIn.problems.allow(/WebSocket connection/)
  guest.problems.assertNone()
  signedIn.problems.assertNone()
})
