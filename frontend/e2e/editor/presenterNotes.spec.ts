/**
 * [layout] Speaker notes bar, page-time chip and the notes download. They click the current UI (the pages pill, the
 * page headers, the More menu); the engine behind them (`pages.setNotes`, `setDuration`) has unit tests.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { installMockApi } from '../support/mockApi'
import { getDoc, moreMenu, openEditor } from './helpers'

interface DeckPage {
  id: string
  name?: string
  notes?: string
  durationSec?: number
}
const deck = async (page: Page): Promise<DeckPage[]> => (await getDoc(page)).pages as unknown as DeckPage[]
const bar = (page: Page) => page.getByTestId('ed-notes')
const field = (page: Page) => page.getByTestId('ed-notes-text')

async function openDeck(page: Page, query = ''): Promise<void> {
  await openEditor(page, `doc=deck${query ? `&${query}` : ''}`)
}
async function showNotes(page: Page): Promise<void> {
  if (!(await bar(page).isVisible())) await page.getByTestId('ed-notes-toggle').click()
  await expect(bar(page)).toBeVisible()
}
test.describe('[layout] speaker notes', () => {
  test('the bar opens from the pill, from Shift+N and from the More menu', async ({ page }) => {
    await openDeck(page)
    await expect(bar(page)).toBeHidden()
    const pill = page.getByTestId('ed-notes-toggle')
    await pill.click()
    await expect(bar(page)).toBeVisible()
    await expect(pill).toHaveAttribute('aria-pressed', 'true')
    await expect(field(page)).toHaveValue('Welcome everyone.\nSay who you are and why this matters.')
    await pill.click()
    await expect(bar(page)).toBeHidden()
    await page.keyboard.press('Shift+N')
    await expect(bar(page)).toBeVisible()
    await page.getByTestId('ed-notes-close').click()
    await expect(bar(page)).toBeHidden()
    await moreMenu(page, /^Notes/)
    await expect(bar(page)).toBeVisible()
    await page.getByTestId('ed-more').click()
    await expect(page.getByRole('menuitemcheckbox', { name: /^Notes/ })).toHaveAttribute('aria-checked', 'true')
  })

  test('typing writes the notes of the active page into the document, with a counter and one undo step', async ({ page }) => {
    await openDeck(page)
    await showNotes(page)
    await page.getByTestId('ed-pages-text').waitFor()
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await expect(page.getByTestId('ed-notes-page')).toHaveText('Story')
    await expect(field(page)).toHaveValue('')
    await expect(field(page)).toHaveAttribute('placeholder', /Add speaker notes/)
    await expect(page.getByTestId('ed-notes-counter')).toHaveText('0 / 5000')
    await field(page).click()
    await field(page).pressSequentially('Close with the ask.', { delay: 15 })
    await expect(page.getByTestId('ed-notes-counter')).toHaveText('19 / 5000')
    await expect.poll(async () => (await deck(page))[2].notes).toBe('Close with the ask.')
    expect((await deck(page))[0].notes).toContain('Welcome everyone.')
    // The burst is one undo step; undo (from the top bar) takes the text back and the field follows.
    await page.getByTestId('ed-undo').click()
    await expect.poll(async () => (await deck(page))[2].notes).toBeUndefined()
    await expect(field(page)).toHaveValue('')
    await page.getByTestId('ed-redo').click()
    await expect(field(page)).toHaveValue('Close with the ask.')
  })

  test('each page has its own notes, and an empty page offers the placeholder', async ({ page }) => {
    await openDeck(page)
    await showNotes(page)
    await expect(field(page)).toHaveValue(/Welcome everyone/)
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await expect(page.getByTestId('ed-notes-page')).toHaveText('Square')
    await expect(field(page)).toHaveValue('Walk through the square layout.')
    await page.getByRole('button', { name: 'Previous page' }).first().click()
    await expect(field(page)).toHaveValue(/Welcome everyone/)
  })

  test('text typed just before switching pages is not lost', async ({ page }) => {
    await openDeck(page)
    await showNotes(page)
    await field(page).fill('Fresh first page notes')
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await expect.poll(async () => (await deck(page))[0].notes).toBe('Fresh first page notes')
  })

  test('notes longer than 5000 characters are cut, and the counter says so', async ({ page }) => {
    await openDeck(page)
    await showNotes(page)
    await field(page).fill('x'.repeat(5200))
    await expect.poll(async () => ((await deck(page))[0].notes ?? '').length).toBe(5000)
    await expect(page.getByTestId('ed-notes-counter')).toHaveText('5000 / 5000')
    await expect(page.getByTestId('ed-notes-counter')).toHaveAttribute('data-full', 'true')
    await expect(field(page)).toHaveAttribute('maxlength', '5000')
  })

  test('the notes are part of the saved document', async ({ page }) => {
    await openDeck(page)
    await showNotes(page)
    await field(page).fill('Saved with the design')
    await expect.poll(async () => (await deck(page))[0].notes).toBe('Saved with the design')
    await page.evaluate(() => window.__doory!.saveNow())
    const saved = await page.evaluate(() => (window.__doory!.saves.at(-1)?.document.pages[0] as { notes?: string }).notes)
    expect(saved).toBe('Saved with the design')
  })

  test('Escape leaves the field, and the field is reachable by keyboard', async ({ page }) => {
    await openDeck(page)
    await showNotes(page)
    await field(page).focus()
    await expect(field(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(field(page)).not.toBeFocused()
    await expect(bar(page)).toBeVisible()
  })

  test('view-only links show the notes read-only, and say so for a page without notes', async ({ page }) => {
    await openDeck(page, 'mode=shared-view')
    await showNotes(page)
    await expect(field(page)).toHaveValue(/Welcome everyone/)
    await expect(field(page)).toHaveAttribute('readonly', '')
    await expect(bar(page).getByText('View only')).toBeVisible()
    await field(page).click()
    await page.keyboard.type('nope')
    await expect(field(page)).toHaveValue(/^Welcome everyone/)
    expect((await deck(page))[0].notes).not.toContain('nope')
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await expect(page.getByTestId('ed-notes-empty')).toHaveText('No notes for this page.')
    await expect(field(page)).toHaveCount(0)
  })

  test('comment-only links read the notes too', async ({ page }) => {
    await openDeck(page, 'mode=shared-comment')
    await showNotes(page)
    await expect(field(page)).toHaveAttribute('readonly', '')
  })
})

test.describe('[layout] notes download', () => {
  test('Markdown: one section per page, in order, empty pages included', async ({ page }) => {
    await openDeck(page)
    await page.getByTestId('ed-more').click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download notes (Markdown)' }).click()])
    expect(download.suggestedFilename()).toBe('untitled-design-notes.md')
    const path = await download.path()
    const text = readFileSync(path, 'utf8')
    expect(text).toBe(
      [
        '# Speaker notes: Untitled design',
        '',
        '## Page 1: Intro',
        '',
        'Welcome everyone.',
        'Say who you are and why this matters.',
        '',
        '## Page 2: Square',
        '',
        'Walk through the square layout.',
        '',
        '## Page 3: Story',
        '',
        '(no notes)',
        '',
      ].join('\n'),
    )
  })

  test('plain text uses underlined headings', async ({ page }) => {
    await openDeck(page)
    await page.getByTestId('ed-more').click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download notes (plain text)' }).click()])
    expect(download.suggestedFilename()).toBe('untitled-design-notes.txt')
    const text = readFileSync(await download.path(), 'utf8')
    expect(text.startsWith('Speaker notes: Untitled design\n==============================\n\nPage 1: Intro\n-------------\n\nWelcome everyone.')).toBe(true)
  })

  test('a design without notes says so instead of downloading an empty file', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByTestId('ed-more').click()
    await page.getByRole('menuitem', { name: 'Download notes (Markdown)' }).click()
    await expect(page.getByText('No page has notes yet.')).toBeVisible()
  })

  test('view-only links can download the notes', async ({ page }) => {
    await openDeck(page, 'mode=shared-view')
    await page.getByTestId('ed-more').click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download notes (Markdown)' }).click()])
    expect(download.suggestedFilename()).toMatch(/-notes\.md$/)
  })
})

test.describe('[layout] page time', () => {
  const chip = (page: Page, index: number) => page.locator('section[data-page-id]').nth(index).getByTestId('ed-time-chip')

  test('a chip in every page header opens the stepper; the time lands in the document', async ({ page }) => {
    await openDeck(page)
    await chip(page, 1).click()
    const pop = page.getByTestId('ed-time-pop')
    await expect(pop).toBeVisible()
    await expect(pop.getByTestId('ed-time-input')).toHaveValue('5')
    await expect(page.getByTestId('ed-time-hint')).toHaveText('No page has a time yet: auto-advance uses 5 s for every page.')
    await pop.getByTestId('ed-time-plus').click()
    await expect.poll(async () => (await deck(page))[1].durationSec).toBe(6)
    await expect(chip(page, 1)).toHaveText('6 s')
    expect((await deck(page))[0].durationSec).toBeUndefined()
    await expect(page.getByTestId('ed-time-hint')).toHaveText('This page stays for 6 s while auto-advance is on.')
    for (let i = 0; i < 3; i++) await pop.getByTestId('ed-time-minus').click()
    await expect.poll(async () => (await deck(page))[1].durationSec).toBe(3)
    // Stepping is one undo step.
    await page.keyboard.press('Escape')
    await page.getByTestId('ed-undo').click()
    await expect.poll(async () => (await deck(page))[1].durationSec).toBeUndefined()
  })

  test('typed values are held to 1-600 seconds', async ({ page }) => {
    await openDeck(page)
    await chip(page, 0).click()
    const input = page.getByTestId('ed-time-input')
    await input.fill('700')
    await input.press('Enter')
    await expect.poll(async () => (await deck(page))[0].durationSec).toBe(600)
    await expect(page.getByTestId('ed-time-plus')).toBeDisabled()
    await page.getByTestId('ed-time-input').fill('0')
    await page.getByTestId('ed-time-input').press('Enter')
    await expect.poll(async () => (await deck(page))[0].durationSec).toBe(1)
    await expect(page.getByTestId('ed-time-minus')).toBeDisabled()
  })

  test('"Apply to all pages" gives every page the time; "No auto-advance" takes this page\'s time away', async ({ page }) => {
    await openDeck(page)
    await chip(page, 0).click()
    await page.getByTestId('ed-time-input').fill('8')
    await page.getByTestId('ed-time-input').press('Enter')
    await page.getByTestId('ed-time-all').click()
    await expect.poll(async () => (await deck(page)).map((p) => p.durationSec)).toEqual([8, 8, 8])
    await expect(chip(page, 2)).toHaveText('8 s')
    await page.keyboard.press('Escape')
    await chip(page, 1).click()
    await page.getByTestId('ed-time-none').click()
    await expect.poll(async () => (await deck(page)).map((p) => p.durationSec)).toEqual([8, undefined, 8])
    await chip(page, 1).click()
    await expect(page.getByTestId('ed-time-none')).toBeDisabled()
    await expect(page.getByTestId('ed-time-hint')).toHaveText('This page waits for the presenter to move on.')
    // One undo for the whole "apply to all".
    await page.keyboard.press('Escape')
    await page.getByTestId('ed-undo').click()
    await page.getByTestId('ed-undo').click()
    await expect.poll(async () => (await deck(page)).map((p) => p.durationSec)).toEqual([8, undefined, undefined])
  })

  test('the notes bar carries the chip of the active page too', async ({ page }) => {
    await openDeck(page)
    await showNotes(page)
    await bar(page).getByTestId('ed-time-chip').click()
    await page.getByTestId('ed-time-input').fill('12')
    await page.getByTestId('ed-time-input').press('Enter')
    await expect.poll(async () => (await deck(page))[0].durationSec).toBe(12)
    await expect(bar(page).getByTestId('ed-time-chip')).toHaveText('12 s')
  })

  test('view-only links show a time that is set, without a way to change it', async ({ page }) => {
    await openDeck(page, 'mode=shared-view')
    await expect(page.getByTestId('ed-time-chip')).toHaveCount(0)
  })
})

test.describe('[layout] notes survive a reload (guest design in this browser)', () => {
  test('the notes written in a guest design are there after reloading the page', async ({ page }) => {
    await installMockApi(page)
    await page.goto('/')
    const designId = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const id = crypto.randomUUID()
          const open = indexedDB.open('doory-local', 1)
          open.onupgradeneeded = () => {
            open.result.createObjectStore('designs', { keyPath: 'id' })
            open.result.createObjectStore('assets', { keyPath: 'id' })
          }
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const tx = open.result.transaction('designs', 'readwrite')
            const now = Date.now()
            const doc = { schemaVersion: 1, width: 800, height: 600, unit: 'px', pages: [{ id: crypto.randomUUID(), background: { type: 'solid', color: '#ffffff' }, objects: [] }] }
            tx.objectStore('designs').put({ id, title: 'Notes persist', createdAt: now, updatedAt: now, document: doc })
            tx.oncomplete = () => resolve(id)
            tx.onerror = () => reject(tx.error)
          }
        }),
    )
    await page.goto(`/local/${designId}`)
    await page.waitForSelector('[data-editor-root]')
    await page.getByTestId('ed-notes-toggle').click()
    await field(page).fill('Remember to breathe.')
    // A single page has no header chrome: the chip of the notes bar sets its time.
    await bar(page).getByTestId('ed-time-chip').click()
    await page.getByTestId('ed-time-plus').click()
    // Autosave writes the design to this browser's storage a moment after the last edit.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<{ notes?: string; durationSec?: number } | null>((resolve) => {
                const open = indexedDB.open('doory-local')
                open.onsuccess = () => {
                  const request = open.result.transaction('designs').objectStore('designs').getAll()
                  request.onsuccess = () => {
                    const design = (request.result as { document: { pages: { notes?: string; durationSec?: number }[] } }[])[0]
                    resolve(design ? design.document.pages[0] : null)
                  }
                }
              }),
          ),
        { timeout: 15_000 },
      )
      .toMatchObject({ notes: 'Remember to breathe.', durationSec: 6 })
    await page.reload()
    await page.waitForSelector('[data-editor-root]')
    // The bar was open when the page was left, so it is open again, with the saved text.
    await expect(field(page)).toHaveValue('Remember to breathe.')
    await expect(bar(page).getByTestId('ed-time-chip')).toHaveText('6 s')
  })
})
