import { expect, test, Api, createAccount, openContext, shot } from './support/stack'

interface TemplateRow {
  slug: string
  title: string
  use_count: number
  category: { slug: string; name: string } | null
  thumbnail_url: string
  orientation: string
}

async function catalogue(): Promise<TemplateRow[]> {
  return (await (await Api.create()).call<{ results: TemplateRow[] }>('get', '/templates/?page_size=100')).results
}

test.describe('templates against the starter content', () => {
  test('the gallery shows every template with a real preview, and the filters narrow it and live in the address', async ({ browser }) => {
    const templates = await catalogue()
    expect(templates.length).toBeGreaterThanOrEqual(10)
    const { page, problems } = await openContext(browser, null)
    await page.goto('/templates')
    const cards = page.getByRole('main').locator('ul li a[href^="/templates/"]')
    await expect(cards).toHaveCount(templates.length)
    await page.getByRole('main').locator('img').last().scrollIntoViewIfNeeded()
    await expect
      .poll(() => page.getByRole('main').locator('img[alt$="template preview"]').evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length))
      .toBe(templates.length)
    await shot(page, 'templates-gallery')

    const withCategory = templates.find((template) => template.category)
    if (!withCategory?.category) throw new Error('the starter templates have no category')
    await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: new RegExp(`^${withCategory.category.name}`) }).click()
    await expect(page).toHaveURL(new RegExp(`category=${withCategory.category.slug}`))
    const inCategory = templates.filter((template) => template.category?.slug === withCategory.category?.slug)
    await expect(cards).toHaveCount(inCategory.length)

    await page.getByRole('searchbox', { name: 'Search templates' }).fill('zzzz no such thing')
    await expect(page.getByRole('heading', { name: 'No templates match' })).toBeVisible()
    await shot(page, 'templates-no-match')
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(cards).toHaveCount(templates.length)
    await expect(page).toHaveURL(/\/templates$/)

    await page.getByRole('searchbox', { name: 'Search templates' }).fill(templates[0]!.title.split(' ')[0]!)
    await expect(page).toHaveURL(/q=/)
    await page.reload()
    await expect(page.getByRole('searchbox', { name: 'Search templates' })).toHaveValue(templates[0]!.title.split(' ')[0]!)
    problems.assertNone()
  })

  test('the featured templates come first, and the orientation filter keeps only that shape', async ({ browser }) => {
    const templates = await catalogue()
    const { page } = await openContext(browser, null)
    await page.goto('/templates')
    const first = await page.getByRole('main').locator('ul li a[href^="/templates/"]').first().getAttribute('href')
    const featured = (await (await Api.create()).call<{ results: TemplateRow[] }>('get', '/templates/?featured=true')).results
    if (featured.length > 0) expect(featured.map((template) => `/templates/${template.slug}`)).toContain(first)
    await page.getByRole('radio', { name: 'Portrait' }).click()
    await expect(page).toHaveURL(/orientation=portrait/)
    const portraits = templates.filter((template) => template.orientation === 'portrait')
    await expect(page.getByRole('main').locator('ul li a[href^="/templates/"]')).toHaveCount(portraits.length)
  })

  test('a guest who uses a template gets its content in the browser editor, with no account', async ({ browser }) => {
    const [template] = await catalogue()
    const { page } = await openContext(browser, null)
    await page.goto(`/templates/${template!.slug}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(template!.title)
    await expect(page.getByText('No account needed')).toBeVisible()
    await shot(page, 'template-detail')
    await page.getByRole('button', { name: 'Use this template' }).click()
    await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/)
    await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveTitle(new RegExp(template!.title))
  })

  test('a signed-in user gets a copy in their account, and the template counts the use', async ({ browser }) => {
    const [template] = await catalogue()
    const account = await createAccount('Template Tess')
    const { page, problems } = await openContext(browser, account)
    await page.goto(`/templates/${template!.slug}`)
    await expect(page.getByText('We’ll add a copy to your designs.')).toBeVisible()
    await page.getByRole('button', { name: 'Use this template' }).click()
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
    const api = await Api.create(account.state)
    const designs = await api.call<{ results: { title: string }[] }>('get', '/designs/')
    expect(designs.results.map((design) => design.title)).toEqual([template!.title])
    const after = (await catalogue()).find((row) => row.slug === template!.slug)
    expect(after!.use_count).toBe(template!.use_count + 1)
    problems.allow(/WebSocket connection/)
    problems.assertNone()
  })

  test('a template that does not exist says so, with a way back', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await page.goto('/templates/no-such-template')
    await expect(page.getByRole('heading', { name: 'We can’t find that template' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Browse templates' })).toHaveAttribute('href', '/templates')
    await page.goto('/create?template=no-such-template')
    await expect(page.getByText('We can’t find that design')).toBeVisible()
  })

  test('back and forward return to the gallery with its filters', async ({ browser }) => {
    const [template] = await catalogue()
    const { page } = await openContext(browser, null)
    await page.goto('/templates?orientation=landscape')
    await page.goto(`/templates/${template!.slug}`)
    await page.goBack()
    await expect(page).toHaveURL(/\/templates\?orientation=landscape$/)
    await expect(page.getByRole('radio', { name: 'Landscape' })).toBeChecked()
    await page.goForward()
    await expect(page).toHaveURL(new RegExp(`/templates/${template!.slug}$`))
  })
})
