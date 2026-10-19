/**
 * [engine] One design with pages of different sizes: a poster, a flyer and a card. The size rules, the workspace
 * layout, zoom, reordering, the strip and the exports are engine behaviour; opening the size menu of a page header
 * and the Resize dialog are [layout] steps (see the helpers at the top).
 */
import { unzipSync } from 'fflate'
import { type Locator, type Page, expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { addShape, getDoc, openDownloadDialog, openEditor } from './helpers'

interface Size {
  width: number
  height: number
}

const POSTER: Size = { width: 1080, height: 1920 }
const FLYER: Size = { width: 794, height: 1123 }
const CARD: Size = { width: 336, height: 192 }

/** The document as the page holds it: page sizes are only present where they differ from the document's. */
interface SizedDoc {
  width: number
  height: number
  pages: { id: string; width?: number; height?: number; objects: { id: string; left?: number; top?: number }[] }[]
}

const docOf = async (page: Page): Promise<SizedDoc> => (await getDoc(page)) as unknown as SizedDoc

async function sizesOf(page: Page): Promise<Size[]> {
  const doc = await docOf(page)
  return doc.pages.map((p) => ({ width: p.width ?? doc.width, height: p.height ?? doc.height }))
}

/** [layout] Opens the size menu in the header of the n-th page and applies a custom size to that page only. */
async function setPageSize(page: Page, index: number, size: Size): Promise<void> {
  await page.getByTestId('ed-page-size').nth(index).click()
  const pop = page.getByTestId('ed-canvas-size-pop')
  await expect(pop).toBeVisible()
  await pop.getByTestId('ed-canvas-width').fill(String(size.width))
  await pop.getByTestId('ed-canvas-height').fill(String(size.height))
  await pop.getByTestId('ed-canvas-apply').click()
  await expect(pop).toBeHidden()
}

/** [layout] A poster, a flyer and a card, made the way a user would: add a page, then give it another size. */
async function openMixed(page: Page, query = ''): Promise<void> {
  await openEditor(page, `doc=blank&w=${POSTER.width}&h=${POSTER.height}${query ? `&${query}` : ''}`)
  await page.getByTestId('ed-pages-add').click()
  await expect(page.locator('[data-artboard]')).toHaveCount(2)
  await setPageSize(page, 1, FLYER)
  await page.getByTestId('ed-pages-add').click()
  await expect(page.locator('[data-artboard]')).toHaveCount(3)
  await setPageSize(page, 2, CARD)
  await expect.poll(() => sizesOf(page)).toEqual([POSTER, FLYER, CARD])
}

const centreX = async (el: Locator): Promise<number> => {
  const box = await el.boundingBox()
  if (!box) throw new Error('no box')
  return box.x + box.width / 2
}

test.describe('[engine] pages of different sizes', () => {
  test('pages added and resized one by one keep their own size; the document follows the first page', async ({ page }) => {
    await openMixed(page)
    const doc = await docOf(page)
    expect(doc.width).toBe(POSTER.width)
    expect(doc.height).toBe(POSTER.height)
    // Only the pages that differ from the document size carry an override, and then both sides.
    expect(doc.pages[0].width).toBeUndefined()
    expect(doc.pages[1]).toMatchObject({ width: FLYER.width, height: FLYER.height })
    expect(doc.pages[2]).toMatchObject({ width: CARD.width, height: CARD.height })
    // A page added after the card starts at the card's size.
    await page.getByTestId('ed-pages-add').click()
    await expect.poll(() => sizesOf(page)).toEqual([POSTER, FLYER, CARD, CARD])
  })

  test('every artboard keeps its proportions, shares one centre line and shows its size in the header', async ({ page }) => {
    await openMixed(page)
    const boards = page.locator('[data-artboard]')
    const sizes = [POSTER, FLYER, CARD]
    const zoomed: number[] = []
    for (let i = 0; i < 3; i++) {
      const box = await boards.nth(i).boundingBox()
      if (!box) throw new Error('no artboard')
      expect(box.width / box.height).toBeCloseTo(sizes[i].width / sizes[i].height, 1)
      zoomed.push(box.width / sizes[i].width)
    }
    // One zoom for the whole stack.
    expect(zoomed[1]).toBeCloseTo(zoomed[0], 2)
    expect(zoomed[2]).toBeCloseTo(zoomed[0], 2)
    const centres = await Promise.all([0, 1, 2].map((i) => centreX(boards.nth(i))))
    expect(Math.abs(centres[0] - centres[1])).toBeLessThan(1.5)
    expect(Math.abs(centres[0] - centres[2])).toBeLessThan(1.5)
    const chips = page.getByTestId('ed-page-size')
    await expect(chips).toHaveText(['1080 × 1920 px', '794 × 1123 px', '336 × 192 px'])
    // The same gap between a page and the next header, whatever the sizes.
    const rects = await Promise.all([0, 1, 2].map((i) => boards.nth(i).boundingBox()))
    const gaps = [rects[1]!.y - (rects[0]!.y + rects[0]!.height), rects[2]!.y - (rects[1]!.y + rects[1]!.height)]
    expect(Math.abs(gaps[0] - gaps[1])).toBeLessThan(1.5)
  })

  test('shapes added to a page land inside that page and "center" uses that page’s size', async ({ page }) => {
    await openMixed(page)
    await page.locator('[data-artboard]').nth(2).scrollIntoViewIfNeeded()
    await page.locator('[data-artboard]').nth(2).click({ position: { x: 4, y: 4 } })
    await expect(page.getByTestId('ed-pages-text')).toHaveText('Page 3 of 3')
    await addShape(page, 'rect')
    await expect.poll(async () => (await getDoc(page)).pages[2].objects.length).toBe(1)
    const rect = (await getDoc(page)).pages[2].objects[0]
    expect(rect.left as number).toBeGreaterThan(0)
    expect(rect.left as number).toBeLessThan(CARD.width)
    expect(rect.top as number).toBeLessThan(CARD.height)
    await page.getByRole('button', { name: 'Center horizontally' }).click()
    await page.getByRole('button', { name: 'Center vertically' }).click()
    await expect
      .poll(async () => {
        const o = (await getDoc(page)).pages[2].objects[0]
        return [Math.round(o.left as number), Math.round(o.top as number)]
      })
      .toEqual([CARD.width / 2, CARD.height / 2])
  })

  test('fit page fits the page in view, fit width fits the widest page', async ({ page }) => {
    await openMixed(page)
    const scroller = page.locator('[data-workspace-bg]').first()
    const view = await scroller.boundingBox()
    if (!view) throw new Error('no workspace')
    const zoomMenu = async (name: RegExp): Promise<void> => {
      await page.getByRole('button', { name: /^Zoom level: / }).click()
      await page.getByRole('menuitemcheckbox', { name }).click()
    }
    const widthOf = async (i: number): Promise<number> => (await page.locator('[data-artboard]').nth(i).boundingBox())!.width
    await zoomMenu(/^Fit width/)
    expect(await widthOf(0)).toBeLessThanOrEqual(view.width)
    expect(await widthOf(0)).toBeGreaterThan(view.width * 0.7)
    expect(await widthOf(2)).toBeLessThan(await widthOf(0))
    // Page in view = the card: fitting the page makes the card as large as 100 % allows, and it stays whole.
    await page.locator('[data-artboard]').nth(2).scrollIntoViewIfNeeded()
    await expect(page.getByTestId('ed-pages-text')).toHaveText('Page 3 of 3')
    await zoomMenu(/^Fit page/)
    const card = await page.locator('[data-artboard]').nth(2).boundingBox()
    expect(card!.height).toBeLessThanOrEqual(view.height)
    expect(card!.width).toBeLessThanOrEqual(view.width)
    expect(card!.width / CARD.width).toBeLessThanOrEqual(1.001)
    // Scrolling to the poster does not change the zoom by itself.
    const before = await widthOf(2)
    await page.locator('[data-artboard]').nth(0).scrollIntoViewIfNeeded()
    expect(Math.abs((await widthOf(2)) - before)).toBeLessThan(0.5)
  })

  test('rulers follow the page in view', async ({ page }) => {
    await openMixed(page)
    await page.keyboard.press('Shift+R')
    const ruler = page.locator('[data-ruler="horizontal"]')
    await expect(ruler).toBeVisible()
    /** The most common colour of a set of ruler pixels (ticks and labels are the odd ones out). */
    const modeColour = (xs: number[]): Promise<string> =>
      ruler.evaluate((canvas: HTMLCanvasElement, points: number[]) => {
        const ctx = canvas.getContext('2d')
        const box = canvas.getBoundingClientRect()
        if (!ctx) return ''
        const dpr = canvas.width / box.width
        const counts = new Map<string, number>()
        for (const x of points) {
          const d = ctx.getImageData(Math.round((x - box.left) * dpr), Math.round(10 * dpr), 1, 1).data
          const key = `${d[0]},${d[1]},${d[2]}`
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        return [...counts.entries()].sort((p, q) => q[1] - p[1])[0][0]
      }, xs)
    const spread = (from: number, to: number): number[] => Array.from({ length: 9 }, (_, i) => from + ((to - from) * (i + 0.5)) / 9)
    for (const [index, label] of [[2, 'Page 3 of 3'], [0, 'Page 1 of 3']] as const) {
      const board = page.locator('[data-artboard]').nth(index)
      await board.scrollIntoViewIfNeeded()
      await board.click({ position: { x: 3, y: 3 } })
      await expect(page.getByTestId('ed-pages-text')).toHaveText(label)
      const box = (await board.boundingBox())!
      // The accent band covers the artboard of the active page and nothing beside it.
      const inside = await modeColour(spread(box.x + 6, box.x + box.width - 6))
      const left = await modeColour(spread(box.x - 60, box.x - 6))
      const right = await modeColour(spread(box.x + box.width + 6, box.x + box.width + 60))
      expect(inside).not.toBe(left)
      expect(left).toBe(right)
    }
  })

  test('the page strip shows every page at its own proportions', async ({ page }) => {
    await openMixed(page)
    await page.getByTestId('ed-pages-toggle').click()
    const strip = page.getByRole('navigation', { name: 'Page strip' })
    await expect(strip).toBeVisible()
    const thumbs = strip.locator('li').locator('button[aria-current], button[aria-label^="Page"]')
    await expect(thumbs).toHaveCount(3)
    const ratios: number[] = []
    for (let i = 0; i < 3; i++) {
      const box = await thumbs.nth(i).boundingBox()
      ratios.push(box!.width / box!.height)
    }
    expect(ratios[0]).toBeCloseTo(POSTER.width / POSTER.height, 1)
    expect(ratios[1]).toBeCloseTo(FLYER.width / FLYER.height, 1)
    expect(ratios[2]).toBeCloseTo(CARD.width / CARD.height, 1)
  })

  test('reordering keeps every page’s size, the document size follows the new first page, and undo restores both', async ({ page }) => {
    await openMixed(page)
    const ids = (await getDoc(page)).pages.map((p) => p.id)
    await page.locator('section[data-page-id] header').nth(2).getByRole('button', { name: 'Move page up' }).click()
    await expect.poll(async () => (await getDoc(page)).pages.map((p) => p.id)).toEqual([ids[0], ids[2], ids[1]])
    await expect.poll(() => sizesOf(page)).toEqual([POSTER, CARD, FLYER])
    await page.locator('section[data-page-id] header').nth(1).getByRole('button', { name: 'Move page up' }).click()
    await expect.poll(() => sizesOf(page)).toEqual([CARD, POSTER, FLYER])
    const doc = await docOf(page)
    expect(doc.width).toBe(CARD.width)
    expect(doc.height).toBe(CARD.height)
    expect(doc.pages[0].width).toBeUndefined()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => sizesOf(page)).toEqual([POSTER, CARD, FLYER])
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => sizesOf(page)).toEqual([POSTER, FLYER, CARD])
    expect((await docOf(page)).width).toBe(POSTER.width)
  })

  test('resizing one page leaves the others alone; "all pages" makes them one size again', async ({ page }) => {
    await openMixed(page)
    await addShape(page, 'rect')
    await page.getByTestId('ed-page-size').nth(1).click()
    const pop = page.getByTestId('ed-canvas-size-pop')
    await expect(pop.getByTestId('ed-scope-page')).toHaveAttribute('aria-pressed', 'true')
    await pop.getByTestId('ed-preset-a5').click()
    await expect(pop).toBeHidden()
    const a5 = (await sizesOf(page))[1]
    expect(a5.width).toBeLessThan(FLYER.width)
    expect((await sizesOf(page))[0]).toEqual(POSTER)
    expect((await sizesOf(page))[2]).toEqual(CARD)
    // Apply to every page.
    await page.getByTestId('ed-page-size').nth(2).click()
    const second = page.getByTestId('ed-canvas-size-pop')
    await second.getByTestId('ed-scope-all').click()
    await second.getByTestId('ed-preset-instagram-post').click()
    await expect.poll(() => sizesOf(page)).toEqual([1, 2, 3].map(() => ({ width: 1080, height: 1080 })))
    const doc = await docOf(page)
    expect(doc.pages.every((p) => p.width === undefined)).toBe(true)
  })

  test('the Resize dialog offers this page or all pages and previews the result', async ({ page }) => {
    await openMixed(page)
    await page.getByTestId('ed-canvas-size').click()
    await page.getByTestId('ed-all-sizes').click()
    const dialog = page.getByRole('dialog', { name: 'Resize design' })
    await expect(dialog).toBeVisible()
    // The design already mixes sizes: the safe choice, this page, is selected.
    await expect(dialog.getByRole('radio', { name: 'This page only' })).toBeChecked()
    await expect(dialog.getByTestId('resize-preview')).toBeVisible()
    await dialog.getByRole('radio', { name: 'Rearrange to fit' }).check()
    await dialog.getByRole('textbox', { name: 'Width' }).fill('400')
    await dialog.getByRole('textbox', { name: 'Width' }).press('Tab')
    await expect(dialog.getByTestId('resize-preview-after').locator('img')).toBeVisible()
    await dialog.getByRole('button', { name: 'Resize design' }).click()
    await expect(dialog).toBeHidden()
    const sizes = await sizesOf(page)
    expect(sizes[0]).toEqual(POSTER)
    expect(sizes[1]).toEqual(FLYER)
    expect(sizes[2].width).toBe(400)
  })

  test('PNG of all pages is one ZIP with every page at its own size and scale', async ({ page }) => {
    await openMixed(page)
    await openDownloadDialog(page)
    const dialog = page.getByRole('dialog', { name: 'Download' })
    await dialog.getByRole('radio', { name: /^PNG/ }).check()
    await dialog.getByRole('radio', { name: '2×' }).check()
    await expect(dialog.getByTestId('download-size')).toHaveText('Each page is exported at its own size.')
    const pending = page.waitForEvent('download', { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()
    const file = await pending
    expect(file.suggestedFilename()).toMatch(/\.zip$/)
    const entries = unzipSync(new Uint8Array(await readFile(await file.path())))
    const names = Object.keys(entries)
    expect(names).toHaveLength(3)
    expect(names[0]).toMatch(/-01\.png$/)
    expect(names[2]).toMatch(/-03\.png$/)
    const dims = names.map((n) => {
      const view = new DataView(entries[n].buffer, entries[n].byteOffset)
      return { width: view.getUint32(16), height: view.getUint32(20) }
    })
    expect(dims).toEqual([2, 2, 2].map((k, i) => ({ width: [POSTER, FLYER, CARD][i].width * k, height: [POSTER, FLYER, CARD][i].height * k })))
  })

  test('PDF of all pages has one page box per page size', async ({ page }) => {
    await openMixed(page)
    await openDownloadDialog(page)
    const dialog = page.getByRole('dialog', { name: 'Download' })
    await dialog.getByRole('radio', { name: /^PDF/ }).check()
    const pending = page.waitForEvent('download', { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()
    const file = await pending
    const text = (await readFile(await file.path())).toString('latin1')
    expect(text.startsWith('%PDF-')).toBe(true)
    const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])])
    expect(boxes).toHaveLength(3)
    ;[POSTER, FLYER, CARD].forEach((size, i) => {
      expect(boxes[i][0]).toBeCloseTo(size.width * 0.75, 1)
      expect(boxes[i][1]).toBeCloseTo(size.height * 0.75, 1)
    })
  })

  test('a template added as a new page keeps its own size', async ({ page }) => {
    await openMixed(page)
    // A design with content is offered the choice; an empty one just takes the template.
    await page.locator('[data-artboard]').nth(2).scrollIntoViewIfNeeded()
    await page.locator('[data-artboard]').nth(2).click({ position: { x: 4, y: 4 } })
    await addShape(page, 'rect')
    await expect.poll(async () => (await docOf(page)).pages.some((p) => p.objects.length > 0)).toBe(true)
    await page.getByTestId('ed-add-entry-templates').click()
    await page.getByRole('button', { name: 'Use template Pitch deck' }).click()
    await page.getByRole('menuitem', { name: /Add as new page/ }).click()
    await expect.poll(async () => (await getDoc(page)).pages.length).toBe(4)
    expect((await sizesOf(page))[3]).toEqual({ width: 1920, height: 1080 })
    expect((await sizesOf(page)).slice(0, 3)).toEqual([POSTER, FLYER, CARD])
  })
})

test.describe('[layout] screenshots of a mixed design', () => {
  for (const theme of ['light'] as const) {
    test(`mixed pages, ${theme}`, async ({ page }) => {
      const dir = process.env.SIZES_SHOTS
      test.skip(!dir, 'set SIZES_SHOTS to a folder to write screenshots')
      await openMixed(page, `theme=${theme}`)
      await page.getByTestId('ed-pages-toggle').click()
      const zoomTo = async (label: string): Promise<void> => {
        await page.getByRole('button', { name: /^Zoom level: / }).click()
        await page.getByRole('menuitem', { name: label, exact: true }).click()
      }
      await zoomTo('25%')
      await page.locator('[data-artboard]').first().scrollIntoViewIfNeeded()
      await page.evaluate(() => document.querySelector('[data-workspace-bg]')?.scrollTo({ top: 0 }))
      await page.waitForTimeout(700)
      await page.screenshot({ path: `${dir}/stack-${theme}.png` })

      await page.getByTestId('ed-page-size').nth(1).click()
      await page.mouse.move(5, 5)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/size-menu-${theme}.png` })
      await page.keyboard.press('Escape')

      await page.getByTestId('ed-canvas-size').click()
      await page.getByTestId('ed-all-sizes').click()
      const dialog = page.getByRole('dialog', { name: 'Resize design' })
      await dialog.getByRole('radio', { name: 'Rearrange to fit' }).check()
      await dialog.getByRole('textbox', { name: 'Width' }).fill('1200')
      await dialog.getByRole('textbox', { name: 'Width' }).press('Tab')
      await expect(dialog.getByTestId('resize-preview-after').locator('img')).toBeVisible()
      await page.mouse.move(5, 5)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/resize-dialog-${theme}.png` })
    })
  }
})
