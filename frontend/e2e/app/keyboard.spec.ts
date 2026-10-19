/** Keyboard-only use and reduced motion on the shell pages (the editor canvas has its own specs). */
import type { Page } from '@playwright/test'
import { expect, test, createAccount, openContext } from './support/stack'

interface Focused {
  tag: string
  name: string
  visibleIndicator: boolean
  inDialog: boolean
  id: string
}

async function focused(page: Page): Promise<Focused> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    if (!element || element === document.body) return { tag: 'body', name: '', visibleIndicator: false, inDialog: false, id: '' }
    const style = getComputedStyle(element)
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
    const ring = style.boxShadow !== 'none' && style.boxShadow !== ''
    // Inputs draw their ring on the wrapper that contains them.
    const wrapper = element.closest('[data-invalid], [class*="control"]')
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null
    const wrapperRing = wrapperStyle ? (wrapperStyle.boxShadow !== 'none' && wrapperStyle.boxShadow !== '') || (wrapperStyle.outlineStyle !== 'none' && parseFloat(wrapperStyle.outlineWidth) > 0) : false
    return {
      tag: element.tagName.toLowerCase(),
      name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40),
      visibleIndicator: outline || ring || wrapperRing,
      inDialog: element.closest('[role="dialog"], [role="alertdialog"]') !== null,
      id: element.id,
    }
  })
}

async function tabThrough(page: Page, stops: number): Promise<Focused[]> {
  const seen: Focused[] = []
  for (let index = 0; index < stops; index++) {
    await page.keyboard.press('Tab')
    seen.push(await focused(page))
  }
  return seen
}

test.describe('keyboard only', () => {
  for (const path of ['/', '/templates', '/login', '/signup']) {
    test(`${path}: the skip link comes first and works, and every stop shows where the focus is`, async ({ browser }) => {
      const { page } = await openContext(browser, null)
      await page.goto(path)
      await page.getByRole('heading').first().waitFor()
      // Content that arrives later replaces what it finds; a keyboard walk starts once the page has settled.
      await page.waitForLoadState('networkidle')
      if (path === '/login' || path === '/signup') {
        // The forms put the cursor in their first field on purpose; the skip link is the first stop going back from there.
        await expect(page.locator('form input').first()).toBeFocused()
        for (let back = 0; back < 12 && (await focused(page)).name !== 'Skip to content'; back++) await page.keyboard.press('Shift+Tab')
      } else {
        await page.keyboard.press('Tab')
      }
      const first = await focused(page)
      expect(first.name).toBe('Skip to content')
      await expect(page.getByRole('link', { name: 'Skip to content' })).toBeInViewport()
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await focused(page)).id).toBe('main')
      // On a short page the walk leaves the document after its last stop (focus on the body); that is the end, not a stop.
      const stops = (await tabThrough(page, 18)).filter((stop) => stop.tag !== 'body')
      expect(stops.length, 'the page has focus stops after the skip link').toBeGreaterThan(2)
      const hidden = stops.filter((stop) => !stop.visibleIndicator).map((stop) => `${stop.tag} "${stop.name}"`)
      expect(hidden, 'focus stops without a visible indicator').toEqual([])
    })
  }

  test('following a link moves the focus to the new page', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await page.goto('/')
    await page.getByRole('link', { name: 'Templates', exact: true }).first().focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/templates$/)
    await expect.poll(async () => (await focused(page)).id).toBe('main')
  })

  test('dialogs keep the focus inside, close with Escape and hand the focus back', async ({ browser }) => {
    const account = await createAccount('Keyboard Kim')
    const { page } = await openContext(browser, account)
    await page.goto('/dashboard')
    const trigger = page.getByRole('button', { name: 'Create a design' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.getByRole('menuitem', { name: 'More sizes…' }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    for (const stop of await tabThrough(page, 40)) expect(stop.inDialog, `focus escaped to ${stop.tag} "${stop.name}"`).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await focused(page)).tag).not.toBe('body')
  })

  test('the account menu opens from the keyboard, moves with the arrows and closes with Escape', async ({ browser }) => {
    const account = await createAccount('Menu Max')
    const { page } = await openContext(browser, account)
    await page.goto('/dashboard')
    const trigger = page.getByRole('button', { name: /Account menu for/ })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Dashboard' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/settings$/)
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})

test.describe('reduced motion', () => {
  for (const path of ['/', '/templates', '/login']) {
    test(`${path}: nothing keeps moving when the visitor asks for less motion`, async ({ browser }) => {
      const { page } = await openContext(browser, null, { reducedMotion: true })
      await page.goto(path)
      await page.getByRole('heading').first().waitFor()
      await page.waitForLoadState('networkidle')
      const endless = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === 'running' && (animation.effect?.getComputedTiming().iterations ?? 1) === Infinity)
          .map((animation) => (animation.effect as KeyframeEffect | null)?.target?.className ?? 'unknown'),
      )
      expect(endless).toEqual([])
    })
  }
})
