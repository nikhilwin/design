/**
 * Visual QA for the video and GIF export: the Download dialog on each video format, while a file is being made, and with
 * the finished file and its preview, in light and dark at 1440, 1024 and 390 px, plus a contact sheet of six frames decoded
 * from the exported video. Writes PNGs to $SCREENSHOT_DIR and is skipped without it (a review aid, not an assertion suite):
 *   SCREENSHOT_DIR=/tmp/shots npx playwright test e2e/editor/videoShots.spec.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { openEditor } from './helpers'
import { addTone, openVideoDialog } from './videoHelpers'

const OUT = process.env.SCREENSHOT_DIR

test.skip(!OUT, 'set SCREENSHOT_DIR to write the screenshots')

const VIEWS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
]
const THEMES = ['light'] as const

async function shot(page: Page, name: string, theme: string, view: string): Promise<void> {
  await page.waitForTimeout(300)
  mkdirSync(OUT!, { recursive: true })
  await page.screenshot({ path: `${OUT}/${name}-${theme}-${view}.png` })
}

async function choose(page: Page, group: string, name: string): Promise<void> {
  await page.getByRole('radiogroup', { name: group }).getByRole('radio', { name }).check({ force: true })
}

for (const theme of THEMES) {
  for (const view of VIEWS) {
    test(`video export screens, ${theme}, ${view.name}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width: view.width, height: view.height })
      await page.emulateMedia({ colorScheme: theme })
      await openEditor(page, `doc=animated&theme=${theme}`)
      await addTone(page, 6)
      // The audio tool is a drawer or a sidebar depending on the width: leave it before the dialog opens.
      await page.keyboard.press('Escape')

      await openVideoDialog(page, 'MP4')
      await shot(page, 'video-mp4-idle', theme, view.name)
      // The lower half of the settings: the dialog's body scrolls.
      await page.getByTestId('video-summary').scrollIntoViewIfNeeded()
      await shot(page, 'video-mp4-idle-scrolled', theme, view.name)

      await page.getByRole('radio', { name: /^GIF/ }).check({ force: true })
      await expect(page.getByTestId('video-section')).toHaveAttribute('data-format', 'gif')
      await shot(page, 'video-gif-idle', theme, view.name)

      // While it works: a large size is slow enough to be caught half way.
      await page.getByRole('radio', { name: /^WebM/ }).check({ force: true })
      await choose(page, 'Size', '1080p')
      await page.getByTestId('video-make').click()
      await expect(page.getByTestId('video-stage')).toContainText(/Frame \d+ of/, { timeout: 30_000 })
      await expect.poll(async () => Number(/Frame (\d+)/.exec((await page.getByTestId('video-stage').textContent()) ?? '')?.[1] ?? 0), { timeout: 30_000 }).toBeGreaterThan(40)
      await shot(page, 'video-working', theme, view.name)
      await page.getByTestId('video-cancel').click()
      await expect(page.getByTestId('video-section')).toBeVisible()

      // The finished file with its preview.
      await choose(page, 'Size', '480p')
      await page.getByTestId('video-make').click()
      await expect(page.getByTestId('video-result')).toBeVisible({ timeout: 90_000 })
      await page.waitForFunction(() => {
        const video = document.querySelector<HTMLVideoElement>('[data-testid="video-preview"]')
        return !!video && video.readyState >= 3 && !video.seeking
      })
      // Show a frame from the build-up of page 1 rather than the first one.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const video = document.querySelector<HTMLVideoElement>('[data-testid="video-preview"]')!
            video.addEventListener('seeked', () => resolve(), { once: true })
            video.currentTime = 1.2
          }),
      )
      await shot(page, 'video-result', theme, view.name)

      if (view.name === '1440' && theme === 'light') {
        // Six frames decoded from the file: the build-up of page 1, its rest, the push, page 2, its exit, the circle into page 3.
        const sheet = await page.evaluate(async () => {
          const video = document.querySelector<HTMLVideoElement>('[data-testid="video-preview"]')!
          const times = [0.5, 3.0, 7.95, 11.0, 14.9, 15.55]
          const labels = ['0.5 s: page 1 builds up', '3.0 s: page 1 at rest', '7.95 s: the push into page 2', '11.0 s: page 2', '14.9 s: page 2 ends', '15.55 s: the circle into page 3']
          const w = video.videoWidth
          const h = video.videoHeight
          const canvas = document.createElement('canvas')
          canvas.width = w * 3 + 16 * 4
          canvas.height = (h + 40) * 2 + 16
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#1c1517'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.font = '600 22px sans-serif'
          for (const [i, t] of times.entries()) {
            video.currentTime = t
            await new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }))
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const x = 16 + (i % 3) * (w + 16)
            const y = 16 + Math.floor(i / 3) * (h + 40 + 0)
            ctx.drawImage(video, x, y)
            ctx.fillStyle = '#ffffff'
            ctx.fillText(labels[i], x, y + h + 28)
          }
          return canvas.toDataURL('image/png')
        })
        mkdirSync(OUT!, { recursive: true })
        writeFileSync(`${OUT}/video-contact-sheet.png`, Buffer.from(sheet.split(',')[1], 'base64'))
      }
    })
  }
}
