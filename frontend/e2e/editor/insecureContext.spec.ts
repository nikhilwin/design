/**
 * [engine] The editor on a plain-http address that is not localhost (for example http://192.168.1.20:8080).
 * Browsers hide `crypto.randomUUID`, `crypto.subtle`, `navigator.clipboard` and `navigator.mediaDevices` there;
 * the editor must still open, create pages and objects, and save.
 */
import { expect, test } from '@playwright/test'
import { addShape, getDoc, openEditor, waitForObjectCount } from './helpers'

test.describe('[engine] insecure context', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const hide = (target: object, name: string) => Object.defineProperty(target, name, { configurable: true, value: undefined })
      hide(Crypto.prototype, 'randomUUID')
      hide(Crypto.prototype, 'subtle')
      hide(Navigator.prototype, 'clipboard')
      hide(Navigator.prototype, 'mediaDevices')
    })
  })

  test('opens, adds objects and pages and keeps working without secure-context APIs', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openEditor(page, 'doc=blank')
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await page.getByTestId('ed-pages-add').click()
    await expect(page.locator('[data-artboard]')).toHaveCount(2)
    await addShape(page, 'ellipse')
    await waitForObjectCount(page, 1, 1)
    const doc = await getDoc(page)
    const ids = [...doc.pages.map((p) => p.id), ...doc.pages.flatMap((p) => p.objects.map((o) => String((o as { id?: string }).id)))]
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Set(ids).size).toBe(ids.length)
    expect(errors).toEqual([])
  })
})
