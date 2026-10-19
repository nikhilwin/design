import { expect, test, Api, openContext } from './support/stack'

test('the real stack serves the starter content', async ({ browser }) => {
  const { page, problems } = await openContext(browser, null)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const api = await Api.create()
  const config = await api.call<{ features: Record<string, boolean> }>('get', '/config/')
  expect(config.features.email_verification).toBe(true)
  const categories = await api.call<unknown[]>('get', '/template-categories/')
  expect(categories.length).toBe(14)
  const templates = await api.call<{ count: number }>('get', '/templates/')
  expect(templates.count).toBe(10)
  problems.assertNone()
})
