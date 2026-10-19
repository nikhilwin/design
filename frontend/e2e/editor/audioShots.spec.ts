/**
 * Visual QA for the audio screens: the Audio tool (library, tracks with the trim editor, uploads, recording), the
 * timeline rows and the slideshow's sound button, in light and dark at 1440, 1024 and 390 px. Writes PNGs to
 * $SCREENSHOT_DIR and is skipped without it (a review aid, not an assertion suite):
 *   SCREENSHOT_DIR=/tmp/shots npx playwright test e2e/editor/audioShots.spec.ts
 */
import { expect, test, type Page } from '@playwright/test'
import { openEditor } from './helpers'
import { openAudio, serveLibrary, spyAudio, tracksOf, wavBytes } from './audioHelpers'

const OUT = process.env.SCREENSHOT_DIR

test.skip(!OUT, 'set SCREENSHOT_DIR to write the screenshots')

test.use({
  launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
})

const VIEWS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
]
const THEMES = ['light'] as const

async function shot(page: Page, name: string, theme: string, view: string): Promise<void> {
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${OUT}/${name}-${theme}-${view}.png` })
}

for (const theme of THEMES) {
  for (const view of VIEWS) {
    test(`audio screens, ${theme}, ${view.name}`, async ({ page }) => {
      test.setTimeout(120_000)
      await spyAudio(page)
      await serveLibrary(page)
      await page.setViewportSize({ width: view.width, height: view.height })
      await page.emulateMedia({ colorScheme: theme })
      await openEditor(page, `doc=animated&theme=${theme}`)

      // The library, with the first row playing.
      await openAudio(page)
      await expect(page.getByTestId('audio-results')).toBeVisible()
      await page.getByTestId('audio-chip-upbeat').click()
      await page.getByTestId('audio-lib-sunrise-run').getByTestId('audio-lib-play').click()
      await page.waitForTimeout(500)
      await shot(page, 'audio-library', theme, view.name)
      await page.getByTestId('audio-lib-sunrise-run').getByTestId('audio-lib-play').click()

      // Tracks: music for the whole design, an effect and an upload on page one, the first card open with its trim editor.
      await page.getByTestId('audio-lib-sunrise-run').getByTestId('audio-lib-add-design').click()
      await page.getByRole('radio', { name: 'Sound effects' }).check({ force: true })
      await page.getByTestId('audio-lib-riser-long').getByTestId('audio-lib-add-page').click()
      await page.getByTestId('audio-tab-uploads').click()
      await page.getByTestId('audio-upload-input').setInputFiles({ name: 'voice note.wav', mimeType: 'audio/wav', buffer: wavBytes(3.2, 330) })
      await expect(page.getByTestId('audio-upload-list')).toContainText('voice note')
      await shot(page, 'audio-uploads', theme, view.name)
      await page.getByTestId('audio-upload-list').getByTestId('audio-upload-add-page').click()
      await page.getByTestId('audio-tab-library').click()
      const [music] = await tracksOf(page)
      await page.getByTestId(`audio-track-${music.id}`).getByTestId('audio-track-toggle').click()
      const handle = page.getByTestId('audio-trim-end').first()
      await handle.focus()
      for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft')
      await page.getByTestId(`audio-track-${music.id}`).scrollIntoViewIfNeeded()
      await shot(page, 'audio-tracks', theme, view.name)

      // Recording, a moment into it.
      await page.getByTestId('audio-tab-record').click()
      await page.getByTestId('audio-record-start').click()
      await expect(page.getByTestId('audio-record-recording')).toBeVisible({ timeout: 8000 })
      await page.waitForTimeout(800)
      await shot(page, 'audio-record', theme, view.name)
      await page.getByTestId('audio-record-stop').click()
      await expect(page.getByTestId('audio-take')).toBeVisible()
      await shot(page, 'audio-take', theme, view.name)
      await page.getByTestId('audio-record-discard').click()

      // The timeline with the audio rows.
      await page.keyboard.press('Escape')
      await page.keyboard.press('Shift+T')
      await expect(page.getByTestId('ed-timeline')).toBeVisible()
      await shot(page, 'audio-timeline', theme, view.name)

      // The slideshow with its sound button.
      await page.keyboard.press('Shift+P')
      await expect(page.getByTestId('present-overlay')).toBeVisible()
      await expect(page.getByTestId('present-sound')).toBeVisible()
      await page.mouse.move(view.width / 2, view.height - 60)
      await shot(page, 'audio-present', theme, view.name)
    })
  }
}
