import { test, type Page } from '@playwright/test'
import { e2eHook, seedLocalDesignWithImage } from './support/helpers'
import { installMockApi, makeUser } from './support/mockApi'

/**
 * Visual QA: renders the main screens in light and dark at desktop and phone widths and writes PNGs to
 * $SCREENSHOT_DIR. Skipped unless that variable is set (it is a review aid, not an assertion suite).
 *   SCREENSHOT_DIR=/tmp/shots npx playwright test visual
 */
const OUT = process.env.SCREENSHOT_DIR

const VIEWS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]
const THEMES = ['light'] as const

interface Shot {
  name: string
  path: string
  signedIn?: boolean
  full?: boolean
  prepare?: (page: Page) => Promise<void>
}

const SHOTS: Shot[] = [
  { name: 'landing', path: '/', full: true },
  { name: 'login', path: '/login' },
  { name: 'signup', path: '/signup' },
  { name: 'templates', path: '/templates', full: true },
  { name: 'template-detail', path: '/templates/bold-sale-announcement', full: true },
  { name: 'dashboard', path: '/dashboard', signedIn: true, full: true },
  { name: 'designs', path: '/dashboard/designs', signedIn: true, full: true },
  { name: 'trash', path: '/dashboard/trash', signedIn: true },
  { name: 'uploads', path: '/dashboard/uploads', signedIn: true },
  { name: 'brand', path: '/dashboard/brand', signedIn: true },
  { name: 'settings', path: '/settings', signedIn: true, full: true },
  {
    name: 'auth-modal',
    path: '/',
    prepare: async (page) => {
      const { designId } = await seedLocalDesignWithImage(page)
      await page.goto(`/local/${designId}`)
      await page.locator('[data-editor-root]').waitFor()
      await e2eHook(page, 'saveToAccount')
      await page.getByRole('dialog').waitFor()
    },
  },
  {
    name: 'local-strip',
    path: '/',
    full: true,
    prepare: async (page) => {
      await seedLocalDesignWithImage(page)
      await page.goto('/')
      await page.getByText('Pick up where you left off').waitFor()
    },
  },
  {
    name: 'create-dialog',
    path: '/',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Custom size…' }).click()
      await page.getByRole('dialog').waitFor()
      await page.getByRole('tab', { name: 'Popular sizes' }).click()
    },
  },
]

test.describe('screenshots', () => {
  test.skip(!OUT, 'set SCREENSHOT_DIR to capture screenshots')
  for (const view of VIEWS) {
    for (const theme of THEMES) {
      for (const shot of SHOTS) {
        test(`${shot.name} ${view.name} ${theme}`, async ({ browser }) => {
          const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: theme })
          const page = await context.newPage()
          const state = await installMockApi(page, { user: shot.signedIn ? makeUser() : null })
          state.folders = [
            { id: 'folder-1', name: 'Client work', parent: null, design_count: 3, created_at: new Date().toISOString() },
            { id: 'folder-2', name: 'Personal', parent: null, design_count: 0, created_at: new Date().toISOString() },
          ]
          for (const index of [2, 5, 7]) state.designs[index].folder = 'folder-1'
          if (shot.name === 'trash') {
            state.designs[4].trashed_at = new Date(Date.now() - 5 * 86_400_000).toISOString()
            state.designs[6].trashed_at = new Date(Date.now() - 27 * 86_400_000).toISOString()
          }
          if (shot.name === 'brand') {
            state.brandKits = [
              { id: 'k1', name: 'Doory brand', is_default: true, colors: ['#e11d48', '#be123c', '#fff1f3', '#1c1517', '#6b6165'].map((hex, i) => ({ id: `c${i}`, name: '', hex })), fonts: [{ role: 'heading', family: 'Playfair Display' }, { role: 'body', family: 'Inter' }], logos: [], created_at: '', updated_at: '' },
              { id: 'k2', name: 'Side project', is_default: false, colors: ['#1d4ed8', '#dbeafe'].map((hex, i) => ({ id: `d${i}`, name: '', hex })), fonts: [], logos: [], created_at: '', updated_at: '' },
            ]
          }
          await page.goto(shot.path, { waitUntil: 'networkidle' })
          await shot.prepare?.(page)
          // Lazy images only load once scrolled into view; walk the page so full-page captures are complete.
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += 600) {
              window.scrollTo({ top: y, behavior: 'instant' })
              await new Promise((resolve) => setTimeout(resolve, 60))
            }
            window.scrollTo({ top: 0, behavior: 'instant' })
          })
          await page.waitForTimeout(700)
          await page.screenshot({ path: `${OUT}/${shot.name}-${view.name}-${theme}.png`, fullPage: Boolean(shot.full) })
          await context.close()
        })
      }
    }
  }
})
