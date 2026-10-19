/**
 * [layout] Video export, against the real editor: a three-page animated deck (a push and a circle transition, build-up
 * animations, a page whose emphasis loops) with a sound is made into WebM, MP4 and GIF files in the browser, and each
 * file is then looked at from outside: its bytes (boxes, elements, blocks), the browser's own player (length, size,
 * the picture at chosen moments, the decoded sound) and, for the GIF, an image element.
 *
 * Chromium builds differ in what they can encode. The suite's Chromium has VP9, VP8, AV1 and Opus but no H.264 or AAC
 * (open-source build): the MP4 specs then check the MP4 made with VP9, and the specs that need H.264 or AAC are skipped
 * with that reason. They run, unchanged, on a browser that has them.
 *
 * Timeline of the deck at 1280 x 720 (ms): page 1 0-7600 (build-up 1600, then 6 s); page 2 7600-15100 (a 700 ms push, a
 * 1800 ms build-up, 5 s); page 3 15100-21500 (a 900 ms circle, a 1500 ms build-up, 4 s). 21.5 s in all.
 */
import { expect, test, type Page } from '@playwright/test'
import { inspectGif, inspectMp4, inspectWebm } from '../../src/editor/engine/export/video/inspect'
import { openEditor } from './helpers'
import { addTone, makeAndDownload, openVideoDialog, probeSound, probeVideo, sameColour } from './videoHelpers'

const TOTAL_MS = 21_500
const PINK = [255, 225, 230]
const RED = [225, 29, 72]

async function chooseOption(page: Page, group: string, name: string | RegExp): Promise<void> {
  await page.getByRole('radiogroup', { name: group }).getByRole('radio', { name }).check({ force: true })
}

async function canEncode(page: Page, codec: string): Promise<boolean> {
  return page.evaluate(async (c) => {
    try {
      return (await VideoEncoder.isConfigSupported({ codec: c, width: 852, height: 480, bitrate: 1_000_000, framerate: 24 })).supported === true
    } catch {
      return false
    }
  }, codec)
}

test.describe('video export', () => {
  test('WebM: the deck with a sound becomes a video of the right length and size, with the push and the sound where they belong', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await addTone(page, 6)
    await openVideoDialog(page, 'WebM')
    // The dialog promises a length before anything is made.
    await expect(page.getByTestId('video-estimate')).toHaveAttribute('data-ms', String(TOTAL_MS))
    await chooseOption(page, 'Size', '480p')
    await chooseOption(page, 'Frame rate', '24 fps')
    await expect(page.getByTestId('video-size')).toHaveText('852 × 480 px')
    await expect(page.getByTestId('video-notes')).toContainText('Opus')

    const made = await makeAndDownload(page)
    expect(made.filename).toBe('Untitled-design.webm')
    expect(made.facts).toMatchObject({ width: 852, height: 480, format: 'webm', frames: 516 })
    expect(Math.abs(made.facts.durationMs - TOTAL_MS)).toBeLessThan(10)

    // The bytes: a WebM with a video track of 852 x 480 and an Opus track, indexed, with a duration in its header.
    const info = inspectWebm(made.bytes)
    expect(info).toMatchObject({ valid: true, docType: 'webm', hasCues: true })
    expect(info.tracks.map((t) => t.type)).toEqual(['video', 'audio'])
    expect(info.tracks[0]).toMatchObject({ width: 852, height: 480 })
    expect(info.tracks[1].codec).toBe('A_OPUS')
    expect(info.tracks[1].hasCodecPrivate).toBe(true)
    expect(info.durationMs).toBeGreaterThan(TOTAL_MS - 250)
    expect(info.durationMs).toBeLessThan(TOTAL_MS + 250)

    // The browser's own player: length, size, and the picture at chosen moments.
    const probe = await probeVideo(page, [7.2, 7.95, 8.8, 14.0])
    expect(Math.abs(probe.duration - TOTAL_MS / 1000)).toBeLessThan(0.25)
    expect({ w: probe.width, h: probe.height }).toEqual({ w: 852, h: 480 })
    const [beforePush, midPush, afterPush, onPageTwo] = probe.looks
    // Page 1 at rest is pink edge to edge; page 2 once it has come in is red; in the middle of the push both are on the screen,
    // and the frame is neither of the other two.
    expect(sameColour(beforePush.left, PINK) && sameColour(beforePush.right, PINK)).toBe(true)
    expect(sameColour(afterPush.left, RED) && sameColour(afterPush.right, RED)).toBe(true)
    expect(sameColour(midPush.left, midPush.right)).toBe(false)
    expect([midPush.left, midPush.right].some((c) => sameColour(c, PINK))).toBe(true)
    expect([midPush.left, midPush.right].some((c) => sameColour(c, RED))).toBe(true)
    expect(sameColour(onPageTwo.left, RED)).toBe(true)

    // The sound: a 6 s tone from the start, then silence, decoded by the browser from the file itself.
    const sound = await probeSound(page, [[0.5, 5.5], [8, 20]])
    expect(Math.abs(sound.duration - TOTAL_MS / 1000)).toBeLessThan(0.3)
    expect(sound.channels).toBe(2)
    expect(sound.peaks[0]).toBeGreaterThan(0.1)
    expect(sound.peaks[1]).toBeLessThan(0.02)
  })

  test('MP4: an MP4 with a video track and a sound track, the frame count and length exact, indexed for streaming', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await addTone(page, 6)
    await openVideoDialog(page, 'MP4')
    await chooseOption(page, 'Size', '480p')
    await chooseOption(page, 'Frame rate', '24 fps')
    const h264 = await canEncode(page, 'avc1.640028')
    if (!h264) await expect(page.getByTestId('video-notes')).toContainText('This browser has no H.264 encoder')

    const made = await makeAndDownload(page)
    expect(made.filename).toBe('Untitled-design.mp4')
    expect(made.facts).toMatchObject({ width: 852, height: 480, format: 'mp4', frames: 516 })
    const info = inspectMp4(made.bytes)
    expect(info.brands[0]).toBe('isom')
    expect(info.topLevel).toEqual(['ftyp', 'moov', 'mdat'])
    expect(info.fastStart).toBe(true)
    expect(info.tracks).toHaveLength(2)
    const [video, audio] = info.tracks
    expect(video).toMatchObject({ handler: 'vide', width: 852, height: 480, samples: 516 })
    expect(video.sampleEntry).toBe(h264 ? 'avc1' : 'vp09')
    expect(audio.handler).toBe('soun')
    expect(audio.sampleEntry).toBe(h264 ? 'mp4a' : 'Opus')
    expect(Math.abs(video.durationMs - TOTAL_MS)).toBeLessThan(5)
    expect(Math.abs(info.durationMs - TOTAL_MS)).toBeLessThan(60)

    // Played by the browser when it can play what is inside.
    const playable = await page.evaluate((entry) => document.createElement('video').canPlayType(entry === 'avc1' ? 'video/mp4; codecs="avc1.640028, mp4a.40.2"' : 'video/mp4; codecs="vp09.00.30.08, opus"') !== '', video.sampleEntry)
    test.info().annotations.push({ type: 'player', description: playable ? `the browser plays the ${video.sampleEntry} MP4` : `the browser cannot play ${video.sampleEntry} in MP4: checked by structure only` })
    if (playable) {
      const probe = await probeVideo(page, [7.2, 8.8])
      expect(Math.abs(probe.duration - TOTAL_MS / 1000)).toBeLessThan(0.25)
      expect({ w: probe.width, h: probe.height }).toEqual({ w: 852, h: 480 })
      expect(sameColour(probe.looks[0].left, PINK)).toBe(true)
      expect(sameColour(probe.looks[1].left, RED)).toBe(true)
      const sound = await probeSound(page, [[0.5, 5.5], [8, 20]])
      expect(sound.peaks[0]).toBeGreaterThan(0.1)
      expect(sound.peaks[1]).toBeLessThan(0.02)
    }
  })

  test('MP4 with H.264 and AAC', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    const h264 = await canEncode(page, 'avc1.640028')
    const aac = await page.evaluate(async () => {
      try {
        return (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported === true
      } catch {
        return false
      }
    })
    test.skip(!h264 || !aac, `this Chromium build cannot encode ${h264 ? '' : 'H.264'}${!h264 && !aac ? ' or ' : ''}${aac ? '' : 'AAC'} (open-source build, no proprietary codecs); the MP4 above is checked with the codecs it has`)
    await addTone(page, 6)
    await openVideoDialog(page, 'MP4')
    await chooseOption(page, 'Size', '480p')
    await chooseOption(page, 'Frame rate', '24 fps')
    const made = await makeAndDownload(page)
    const info = inspectMp4(made.bytes)
    expect(info.tracks.map((t) => t.sampleEntry)).toEqual(['avc1', 'mp4a'])
    const probe = await probeVideo(page, [7.2, 8.8])
    expect(Math.abs(probe.duration - TOTAL_MS / 1000)).toBeLessThan(0.25)
    expect(sameColour(probe.looks[1].left, RED)).toBe(true)
  })

  test('GIF: frames, delays and the loop block are what the timeline says, and the browser shows it as an image', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openVideoDialog(page, 'GIF')
    await expect(page.getByTestId('video-size')).toHaveText('852 × 480 px')
    await expect(page.getByRole('radiogroup', { name: 'Frame rate' }).getByRole('radio', { name: '15 fps' })).toBeChecked()
    const made = await makeAndDownload(page)
    expect(made.filename).toBe('Untitled-design.gif')
    const info = inspectGif(made.bytes)
    expect(info).toMatchObject({ version: 'GIF89a', width: 852, height: 480, loop: 0, trailer: true })
    // The delays add up to the length of the deck, to the hundredth of a second.
    expect(Math.abs(info.totalCs - TOTAL_MS / 10)).toBeLessThanOrEqual(2)
    expect(info.frames).toBe(made.facts.frames)
    // 323 frames at 15 fps; frames that repeat the one before are stored once. The loop on page 1 keeps it moving, so most stay.
    expect(info.frames).toBeLessThan(323)
    expect(info.frames).toBeGreaterThan(150)
    // Moving parts play at 15 fps (6 or 7 hundredths), a still page holds one long frame.
    expect(info.delaysCs.filter((d) => d === 6 || d === 7).length).toBeGreaterThan(100)
    expect(Math.max(...info.delaysCs)).toBeGreaterThan(100)
    expect(Math.min(...info.delaysCs)).toBeGreaterThanOrEqual(2)
    expect(info.localPalettes).toBe(info.frames - 1)

    // The preview is an image the browser has decoded at its real size.
    const image = page.getByTestId('video-preview')
    await expect(image).toHaveJSProperty('complete', true)
    expect(await image.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([852, 480])
  })

  test('GIF: plays once when asked, with no loop block', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openVideoDialog(page, 'GIF')
    await chooseOption(page, 'Size', '240p')
    await chooseOption(page, 'Frame rate', '10 fps')
    await chooseOption(page, 'Plays', 'Once')
    const made = await makeAndDownload(page)
    const info = inspectGif(made.bytes)
    expect(info).toMatchObject({ width: 426, height: 240, loop: null })
    expect(Math.abs(info.totalCs - TOTAL_MS / 10)).toBeLessThanOrEqual(2)
  })

  test('a still design: every page is held for its time, and the file still plays', async ({ page }) => {
    await openEditor(page, 'doc=deck')
    await openVideoDialog(page, 'WebM')
    await chooseOption(page, 'Size', '480p')
    await chooseOption(page, 'Frame rate', '24 fps')
    await chooseOption(page, 'Time per page', 'The same for all')
    await page.getByRole('textbox', { name: 'Seconds per page' }).fill('1')
    await page.keyboard.press('Enter')
    const pages = await page.evaluate(() => window.__doory!.getDocument().pages.length)
    await expect(page.getByTestId('video-estimate')).toHaveAttribute('data-ms', String(pages * 1000))
    const made = await makeAndDownload(page)
    expect(made.facts.durationMs).toBe(pages * 1000)
    const probe = await probeVideo(page, [0.5, pages - 0.5])
    expect(Math.abs(probe.duration - pages)).toBeLessThan(0.25)
  })

  test('exports only the pages chosen', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openVideoDialog(page, 'GIF')
    await chooseOption(page, 'Size', '240p')
    await chooseOption(page, 'Frame rate', '10 fps')
    await page.getByRole('dialog').getByRole('radio', { name: 'Select pages' }).check({ force: true })
    await page.getByRole('textbox', { name: 'Select pages' }).fill('2-3')
    // Page 2 keeps its push (it comes in after page 1, which is not chosen: the transition belongs to the page that comes in,
    // from the page chosen before it, so the first chosen page has none): 5000 + 1800 for page 2, 900 + 1500 + 4000 for page 3.
    await expect(page.getByTestId('video-estimate')).toHaveAttribute('data-ms', String(1800 + 5000 + 900 + 1500 + 4000))
    const made = await makeAndDownload(page)
    expect(made.facts.durationMs).toBe(13_200)
  })
})

test.describe('cancel', () => {
  test('stops in the middle, frees the encoder, downloads nothing and gives the settings back', async ({ page }) => {
    // Count the encoders the page opens and closes.
    await page.addInitScript(() => {
      const spy = { opened: 0, closed: 0 }
      ;(window as unknown as { __encoders: typeof spy }).__encoders = spy
      const Native = window.VideoEncoder
      if (!Native) return
      window.VideoEncoder = class extends Native {
        constructor(init: VideoEncoderInit) {
          super(init)
          spy.opened += 1
        }
        close(): void {
          if (this.state !== 'closed') spy.closed += 1
          super.close()
        }
      }
    })
    const downloads: string[] = []
    page.on('download', (d) => downloads.push(d.suggestedFilename()))
    await openEditor(page, 'doc=animated')
    await openVideoDialog(page, 'WebM')
    await chooseOption(page, 'Size', '1080p')
    await page.getByTestId('video-make').click()
    const stage = page.getByTestId('video-stage')
    await expect(stage).toContainText(/Frame \d+ of/, { timeout: 30_000 })
    // Let it get properly under way, then cancel.
    await expect.poll(async () => Number(/Frame (\d+)/.exec((await stage.textContent()) ?? '')?.[1] ?? 0), { timeout: 30_000 }).toBeGreaterThan(20)
    await page.getByTestId('video-cancel').click()
    await expect(page.getByTestId('video-section')).toBeVisible()
    await expect(page.getByTestId('video-result')).toHaveCount(0)
    await expect(page.getByTestId('video-progress')).toHaveCount(0)
    // The toast says nothing was saved.
    await expect(page.getByText('Cancelled, nothing was saved')).toBeVisible()
    const encoders = await page.evaluate(() => (window as unknown as { __encoders: { opened: number; closed: number } }).__encoders)
    expect(encoders.opened).toBeGreaterThan(0)
    expect(encoders.closed).toBe(encoders.opened)
    await page.waitForTimeout(500)
    expect(downloads).toEqual([])
    // Nothing is left running: the next export starts from scratch and works.
    await chooseOption(page, 'Size', '480p')
    await page.getByTestId('video-make').click()
    await expect(page.getByTestId('video-result')).toBeVisible({ timeout: 60_000 })
  })

  test('closing the dialog while it works stops the export too', async ({ page }) => {
    await page.addInitScript(() => {
      const spy = { opened: 0, closed: 0 }
      ;(window as unknown as { __encoders: typeof spy }).__encoders = spy
      const Native = window.VideoEncoder
      if (!Native) return
      window.VideoEncoder = class extends Native {
        constructor(init: VideoEncoderInit) {
          super(init)
          spy.opened += 1
        }
        close(): void {
          if (this.state !== 'closed') spy.closed += 1
          super.close()
        }
      }
    })
    await openEditor(page, 'doc=animated')
    await openVideoDialog(page, 'WebM')
    await chooseOption(page, 'Size', '1080p')
    await page.getByTestId('video-make').click()
    await expect(page.getByTestId('video-stage')).toContainText(/Frame \d+ of/, { timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __encoders: { opened: number; closed: number } }).__encoders.closed)).toBe(1)
  })
})

test.describe('a browser without WebCodecs', () => {
  test('records the video in real time with MediaRecorder, and the WebM it makes has a length', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as { VideoEncoder?: unknown }).VideoEncoder
      delete (window as unknown as { AudioEncoder?: unknown }).AudioEncoder
    })
    await openEditor(page, 'doc=blank')
    await openVideoDialog(page, 'WebM')
    await expect(page.getByTestId('video-notes')).toContainText('record the video as it plays')
    await chooseOption(page, 'Size', '480p')
    await chooseOption(page, 'Frame rate', '24 fps')
    await chooseOption(page, 'Time per page', 'The same for all')
    await page.getByRole('textbox', { name: 'Seconds per page' }).fill('2')
    await page.keyboard.press('Enter')
    const made = await makeAndDownload(page, 60_000)
    const info = inspectWebm(made.bytes)
    expect(info.valid).toBe(true)
    // Chromium writes no length; the export puts it in.
    expect(info.durationMs).toBeGreaterThan(1900)
    expect(info.durationMs).toBeLessThan(2100)
    const probe = await probeVideo(page, [0.5])
    expect(probe.duration).toBeGreaterThan(1.8)
    expect(probe.duration).toBeLessThan(2.4)
    await expect(page.getByTestId('video-result-notes')).toContainText('real time')
  })

  test('still makes a GIF, and says a video cannot be made when no recorder is there either', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as { VideoEncoder?: unknown }).VideoEncoder
      delete (window as unknown as { AudioEncoder?: unknown }).AudioEncoder
      delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder
    })
    await openEditor(page, 'doc=blank')
    await page.keyboard.press('Control+Shift+D')
    await page.getByRole('radio', { name: /^MP4/ }).check({ force: true })
    await expect(page.getByTestId('video-notes')).toContainText('cannot make MP4 or WebM')
    await expect(page.getByTestId('video-make')).toBeDisabled()
    await page.getByRole('radio', { name: /^GIF/ }).check({ force: true })
    await expect(page.getByTestId('video-make')).toBeEnabled()
    const made = await makeAndDownload(page)
    expect(inspectGif(made.bytes).frames).toBeGreaterThanOrEqual(1)
  })
})

test.describe('the dialog', () => {
  test('Download > Video or GIF opens the dialog on MP4', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await page.locator('[data-testid="ed-download"]').click()
    await page.getByRole('menuitem', { name: 'Video or GIF…' }).click()
    await expect(page.getByRole('radio', { name: /^MP4/ })).toBeChecked()
    await expect(page.getByTestId('video-section')).toHaveAttribute('data-format', 'mp4')
  })

  test('the choices are remembered for the design', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openVideoDialog(page, 'GIF')
    await chooseOption(page, 'Size', '720p')
    await chooseOption(page, 'Frame rate', '20 fps')
    await chooseOption(page, 'Time per page', 'The same for all')
    await page.getByRole('textbox', { name: 'Seconds per page' }).fill('3')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await openVideoDialog(page, 'GIF')
    await expect(page.getByRole('radiogroup', { name: 'Size' }).getByRole('radio', { name: '720p' })).toBeChecked()
    await expect(page.getByRole('radiogroup', { name: 'Frame rate' }).getByRole('radio', { name: '20 fps' })).toBeChecked()
    await expect(page.getByRole('textbox', { name: 'Seconds per page' })).toHaveValue('3')
  })

  test('refuses a video longer than the format allows, and says why', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openVideoDialog(page, 'GIF')
    await chooseOption(page, 'Time per page', 'The same for all')
    await page.getByRole('textbox', { name: 'Seconds per page' }).fill('60')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('video-notes').getByRole('alert')).toContainText('longer than the 2 minutes')
    await expect(page.getByTestId('video-make')).toBeDisabled()
  })

  test('is operable with the keyboard from the format to the finished file', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.keyboard.press('Control+Shift+D')
    const gif = page.getByRole('radio', { name: /^GIF/ })
    await gif.focus()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('video-section')).toBeVisible()
    const make = page.getByTestId('video-make')
    await expect(make).toBeEnabled()
    await make.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('video-result')).toBeVisible({ timeout: 60_000 })
    // Focus is on Download when the file is ready.
    await expect(page.getByTestId('video-download')).toBeFocused()
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')])
    expect(download.suggestedFilename()).toBe('Untitled-design.gif')
  })
})

