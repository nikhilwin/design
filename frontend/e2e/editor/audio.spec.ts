/**
 * [layout] Audio: the library, the tracks of a design, uploads, a voiceover from the (fake) microphone, the timeline
 * rows, the mixdown and the sound of a slideshow. The Chromium of the suite runs with a fake microphone
 * (`--use-fake-device-for-media-stream`) and no sound card, so what is checked is what the page asks the browser to
 * do (the buffer sources it starts, the state of its audio context, the `<audio>` elements it plays), never what is heard.
 */
import { expect, test, type Page } from '@playwright/test'
import { openEditor } from './helpers'
import { contextState, openAudio, serveLibrary, sourcesOf, spyAudio, tracksOf, wavBytes, type TestEngine } from './audioHelpers'

test.use({
  launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
})

test.beforeEach(async ({ page }) => {
  await spyAudio(page)
  await serveLibrary(page)
})

async function addFromLibrary(page: Page, id: string, where: 'design' | 'page'): Promise<void> {
  await page.getByTestId(`audio-lib-${id}`).getByTestId(where === 'design' ? 'audio-lib-add-design' : 'audio-lib-add-page').click()
}

test.describe('the library', () => {
  test('lists the music, narrows it by mood and by words, and shows the sound effects', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openAudio(page)
    await expect(page.getByTestId('audio-results')).toBeVisible()
    await expect(page.getByTestId('audio-count')).toHaveText('24 sounds')
    await page.getByTestId('audio-chip-calm').click()
    await expect(page.getByTestId('audio-count')).toHaveText('3 sounds')
    await page.getByTestId('audio-clear').click()
    await page.getByTestId('audio-search').fill('rainy')
    await expect(page.getByTestId('audio-count')).toHaveText('1 sound')
    await expect(page.getByTestId('audio-lib-rainy-window')).toBeVisible()
    await page.getByTestId('audio-search').fill('zzzzqq')
    await expect(page.getByTestId('audio-none')).toBeVisible()
    await page.getByTestId('audio-clear').click()
    await page.getByRole('radio', { name: 'Sound effects' }).check({ force: true })
    await expect(page.getByTestId('audio-count')).toHaveText('88 sounds')
    await page.getByTestId('audio-chip-whoosh').click()
    await expect(page.getByTestId('audio-lib-whoosh-soft')).toBeVisible()
  })

  test('plays a row in place and pauses it again', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openAudio(page)
    const play = page.getByTestId('audio-lib-sunrise-run').getByTestId('audio-lib-play')
    await play.click()
    await expect(play).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __audioSpy: { elements: HTMLAudioElement[] } }).__audioSpy.elements[0]?.currentTime ?? 0)).toBeGreaterThan(0.3)
    await play.click()
    await expect(play).toHaveAttribute('aria-pressed', 'false')
    expect(await page.evaluate(() => (window as unknown as { __audioSpy: { elements: HTMLAudioElement[] } }).__audioSpy.elements[0].paused)).toBe(true)
  })

  test('says so when the library is not installed, and a second look finds it', async ({ page }) => {
    await page.unroute('**/media/audio/**')
    await page.route('**/media/audio/index.json', (route) => route.fulfill({ status: 404, body: '' }))
    await openEditor(page, 'doc=blank')
    await openAudio(page)
    await expect(page.getByTestId('audio-error')).toHaveAttribute('data-code', 'not-installed')
    await page.unroute('**/media/audio/index.json')
    await serveLibrary(page)
    await page.getByTestId('audio-retry').click()
    await expect(page.getByTestId('audio-results')).toBeVisible()
  })
})

test.describe('the tracks of a design', () => {
  test('adds music and an effect, trims with the keyboard and the pointer, and keeps them across a reload', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openAudio(page)
    await addFromLibrary(page, 'sunrise-run', 'design')
    await expect(page.getByTestId('audio-tracks')).toBeVisible()
    await page.getByRole('radio', { name: 'Sound effects' }).check({ force: true })
    await addFromLibrary(page, 'pop-small', 'page')
    const tracks = await tracksOf(page)
    expect(tracks.map((t) => [t.name, t.kind, t.scope.type])).toEqual([
      ['Sunrise Run', 'music', 'design'],
      ['Small Pop', 'sfx', 'page'],
    ])
    expect(tracks[0].loop).toBe(true)

    const card = page.getByTestId(`audio-track-${tracks[0].id}`)
    await card.getByTestId('audio-track-toggle').click()
    const end = card.getByTestId('audio-trim-end')
    await end.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
    // Each press moves the handle a tenth of a second and the result is kept on a 10 ms grid.
    await expect.poll(async () => Math.abs((await tracksOf(page))[0].trimEndMs - (tracks[0].trimEndMs - 500))).toBeLessThanOrEqual(10)
    const keyed = (await tracksOf(page))[0].trimEndMs

    const start = card.getByTestId('audio-trim-start')
    const box = (await start.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    const trimmed = (await tracksOf(page))[0]
    expect(trimmed.trimStartMs).toBeGreaterThan(1000)
    expect(trimmed.trimEndMs).toBe(keyed)

    // Saved with the design; opened again, it is all still there.
    const saved = await page.evaluate(async () => {
      await window.__doory!.saveNow()
      return window.__doory!.saves.at(-1)!.document
    })
    expect(saved.audioTracks).toHaveLength(2)
    await page.evaluate((doc) => localStorage.setItem('doory.harness.doc', JSON.stringify(doc)), saved)
    await openEditor(page, 'doc=stored')
    await openAudio(page)
    const again = await tracksOf(page)
    expect(again.map((t) => t.name)).toEqual(['Sunrise Run', 'Small Pop'])
    expect(again[0]).toMatchObject({ trimStartMs: trimmed.trimStartMs, trimEndMs: trimmed.trimEndMs, scope: { type: 'design' } })
    await expect(page.getByTestId(`audio-track-${tracks[0].id}`)).toContainText('Sunrise Run')
    await page.evaluate(() => localStorage.removeItem('doory.harness.doc'))
  })

  test('mutes, changes the volume, removes and brings a track back with undo', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openAudio(page)
    await addFromLibrary(page, 'still-water', 'design')
    const [track] = await tracksOf(page)
    const card = page.getByTestId(`audio-track-${track.id}`)
    await card.getByTestId('audio-track-mute').click()
    expect((await tracksOf(page))[0].muted).toBe(true)
    await card.getByTestId('audio-track-toggle').click()
    await card.getByRole('slider', { name: 'Volume' }).fill('90')
    await expect.poll(async () => (await tracksOf(page))[0].volume).toBeCloseTo(0.9, 2)
    await card.getByTestId('audio-track-delete').click()
    await expect(page.getByTestId('audio-tracks-empty')).toBeVisible()
    await page.keyboard.press('Control+z')
    await expect(page.getByTestId(`audio-track-${track.id}`)).toBeVisible()
  })
})

test.describe('uploads and recording', () => {
  test('uploads a file, plays it, adds it to the design, and turns a text file away', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openAudio(page)
    await page.getByTestId('audio-tab-uploads').click()
    await expect(page.getByTestId('audio-upload-empty')).toBeVisible()
    await page.getByTestId('audio-upload-input').setInputFiles({ name: 'interview.wav', mimeType: 'audio/wav', buffer: wavBytes(1.5) })
    const list = page.getByTestId('audio-upload-list')
    await expect(list).toContainText('interview')
    await expect(list).toContainText('1.5 s')
    await list.getByTestId('audio-upload-play').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __audioSpy: { elements: HTMLAudioElement[] } }).__audioSpy.elements.at(-1)?.currentTime ?? 0)).toBeGreaterThan(0.2)
    await list.getByTestId('audio-upload-add-design').click()
    await expect.poll(async () => (await tracksOf(page)).length).toBe(1)
    const [track] = await tracksOf(page)
    expect(track).toMatchObject({ kind: 'upload', name: 'interview', scope: { type: 'design' } })
    expect(track.src).toMatch(/^idb:\/\//)
    expect(Math.abs((track.durationMs ?? 0) - 1500)).toBeLessThan(60)

    await page.getByTestId('audio-upload-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not sound') })
    await expect(page.getByTestId('audio-upload-error')).toBeVisible()
    expect(await tracksOf(page)).toHaveLength(1)
  })

  test('records a voiceover from the fake microphone: countdown, level, listen back, retake, keep', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openAudio(page)
    await page.getByTestId('audio-tab-record').click()
    await page.getByTestId('audio-record-start').click()
    await expect(page.getByTestId('audio-record-countdown')).toBeVisible()
    await expect(page.getByTestId('audio-meter')).toBeVisible()
    await expect(page.getByTestId('audio-record-recording')).toBeVisible({ timeout: 8000 })
    await page.waitForTimeout(1200)
    await page.getByTestId('audio-record-stop').click()
    await expect(page.getByTestId('audio-take')).toBeVisible()
    // Discard and record again, then keep the second take.
    await page.getByTestId('audio-record-discard').click()
    await expect(page.getByTestId('audio-record-start')).toBeVisible()
    await page.getByTestId('audio-record-start').click()
    await expect(page.getByTestId('audio-record-recording')).toBeVisible({ timeout: 8000 })
    await page.waitForTimeout(1500)
    await page.getByTestId('audio-record-stop').click()
    await page.getByTestId('audio-take-play').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __audioSpy: { elements: HTMLAudioElement[] } }).__audioSpy.elements.at(-1)?.currentTime ?? 0)).toBeGreaterThan(0.2)
    await page.getByTestId('audio-record-save-design').click()
    await expect.poll(async () => (await tracksOf(page)).length, { timeout: 10_000 }).toBe(1)
    const [track] = await tracksOf(page)
    expect(track).toMatchObject({ kind: 'voiceover', name: 'Voiceover 1', scope: { type: 'design' } })
    expect(track.durationMs ?? 0).toBeGreaterThan(900)
    await expect(page.getByTestId('audio-record-start')).toBeVisible()
  })
})

test.describe('the sound of the design', () => {
  test('mixes the design down to exactly the length of its pages, and the browser and the reference renderer agree', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openAudio(page)
    await addFromLibrary(page, 'sunrise-run', 'design')
    await page.getByRole('radio', { name: 'Sound effects' }).check({ force: true })
    await addFromLibrary(page, 'riser-long', 'page')
    const result = await page.evaluate(async () => {
      const engine = (window as unknown as { __doory_collab: { engine: TestEngine } }).__doory_collab.engine
      const buffer = await engine.audio.mixdown([4000, 3000, 2000], 48000)
      const left = buffer.getChannelData(0)
      let peak = 0
      let finite = true
      for (let i = 0; i < left.length; i++) {
        const v = Math.abs(left[i])
        if (!Number.isFinite(v)) finite = false
        if (v > peak) peak = v
      }
      return { length: buffer.length, rate: buffer.sampleRate, channels: buffer.numberOfChannels, seconds: buffer.duration, peak, finite }
    })
    expect(result).toMatchObject({ length: 9 * 48000, rate: 48000, channels: 2, finite: true })
    expect(result.peak).toBeGreaterThan(0.02)
    expect(result.peak).toBeLessThanOrEqual(1)

    const agreement = await page.evaluate(async () => {
      const base = '/src/editor/audio/'
      const mixer = await import(/* @vite-ignore */ `${base}mixer.ts`)
      const planner = await import(/* @vite-ignore */ `${base}plan.ts`)
      const clockModule = await import(/* @vite-ignore */ `${base}clock.ts`)
      const engine = (window as unknown as { __doory_collab: { engine: TestEngine } }).__doory_collab.engine
      const doc = engine.getDocument()
      const clock = clockModule.buildClock(doc.pages.map((p: { id: string }) => p.id), [4000, 3000, 2000])
      const plan = planner.planMix(engine.audio.tracks(), clock)
      const sources = new Map<string, AudioBuffer>()
      for (const voice of plan.voices) sources.set(voice.track.id, await engine.audio.sources.load(voice.track))
      const offline: AudioBuffer = await mixer.renderMixOffline(plan, sources, 48000)
      const pure = mixer.renderMixPure(plan, sources, 48000)
      let worst = 0
      let sumSquares = 0
      for (let c = 0; c < 2; c++) {
        const a = offline.getChannelData(c)
        const b: Float32Array = pure.channels[c]
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i])
          if (d > worst) worst = d
          sumSquares += d * d
        }
      }
      return { length: offline.length, pureLength: pure.length, worst, rms: Math.sqrt(sumSquares / (2 * offline.length)) }
    })
    expect(agreement.length).toBe(agreement.pureLength)
    // Both read the same plan; they differ only by float rounding and by how the browser interpolates a loop seam.
    expect(agreement.worst).toBeLessThan(0.01)
    expect(agreement.rms).toBeLessThan(0.0005)
  })

  test('plays the page from the Audio tool: the context runs and the sources are scheduled', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openAudio(page)
    await addFromLibrary(page, 'good-morning-energy', 'design')
    await page.getByTestId('audio-play-all').click()
    await expect.poll(async () => (await sourcesOf(page)).length).toBe(1)
    expect(await contextState(page)).toBe('running')
    const [source] = await sourcesOf(page)
    expect(source.loop).toBe(true)
    await expect(page.getByTestId('audio-transport')).toHaveAttribute('data-state', 'playing')
    await page.getByTestId('audio-play-all').click()
    await expect(page.getByTestId('audio-transport')).toHaveAttribute('data-state', 'paused')
    await expect.poll(() => contextState(page)).toBe('suspended')
    await page.getByTestId('audio-stop').click()
    await expect(page.getByTestId('audio-transport')).toHaveAttribute('data-state', 'idle')
  })
})

test.describe('the timeline', () => {
  test('shows a row for the track of the page, moves it by dragging, and plays it with the page', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openAudio(page)
    await page.getByRole('radio', { name: 'Sound effects' }).check({ force: true })
    await addFromLibrary(page, 'riser-long', 'page')
    await page.keyboard.press('Shift+T')
    const [track] = await tracksOf(page)
    const bar = page.getByTestId(`tl-audio-bar-${track.id}`)
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('data-scope', 'page')
    const box = (await bar.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
    const moved = (await tracksOf(page))[0]
    expect(moved.startMs).toBeGreaterThan(300)
    expect(moved.startMs % 100).toBe(0)

    // The row's switches come out when the pointer is on it.
    await page.getByTestId(`tl-audio-${track.id}`).hover()
    await page.getByTestId(`tl-audio-mute-${track.id}`).click()
    expect((await tracksOf(page))[0].muted).toBe(true)
    await page.getByTestId(`tl-audio-mute-${track.id}`).click()

    await page.getByTestId('tl-play').click()
    await expect.poll(async () => (await sourcesOf(page)).length).toBeGreaterThan(0)
    expect(await contextState(page)).toBe('running')
    await page.getByTestId('tl-play').click()
    await expect.poll(() => contextState(page)).toBe('suspended')
  })
})

test.describe('the slideshow', () => {
  test('plays the music across the pages, starts a page effect with its page, switches off with M, and fades at the end', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openAudio(page)
    await addFromLibrary(page, 'still-water', 'design')
    await page.getByRole('radio', { name: 'Sound effects' }).check({ force: true })
    await addFromLibrary(page, 'chime-high', 'page')
    // Move the effect to page 2 so that it is not heard on the first page.
    const [, effect] = await tracksOf(page)
    await page.getByTestId(`audio-track-${effect.id}`).getByTestId('audio-track-toggle').click()
    const pages = await page.evaluate(() => window.__doory!.getDocument().pages.map((p) => p.id))
    await page.getByTestId('audio-track-scope').selectOption(pages[1])
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    const before = (await sourcesOf(page)).length
    await page.keyboard.press('Shift+P')
    await expect(page.getByTestId('present-overlay')).toBeVisible()
    await expect.poll(async () => (await sourcesOf(page)).length - before).toBe(1)
    expect(await contextState(page)).toBe('running')
    const music = (await sourcesOf(page)).at(-1)!
    expect(music.loop).toBe(true)
    await expect(page.getByTestId('present-sound')).toHaveAttribute('aria-pressed', 'true')

    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('present-counter')).toHaveText('2 / 3')
    await expect.poll(async () => (await sourcesOf(page)).length - before).toBe(2)
    expect((await sourcesOf(page)).at(-1)!.loop).toBe(false)

    await page.keyboard.press('m')
    await expect(page.getByTestId('present-sound')).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('m')
    await expect(page.getByTestId('present-sound')).toHaveAttribute('aria-pressed', 'true')

    // The music went on through the page change: it was not started again.
    expect((await sourcesOf(page)).length - before).toBe(2)
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('present-end')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('present-overlay')).toBeHidden()
  })

  test('offers no sound control for a design without sound', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await page.keyboard.press('Shift+P')
    await expect(page.getByTestId('present-overlay')).toBeVisible()
    await expect(page.getByTestId('present-sound')).toHaveCount(0)
    expect(await sourcesOf(page)).toHaveLength(0)
  })
})

test.describe('a design shared to view', () => {
  test('lists the tracks and plays them, with nothing to edit', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openAudio(page)
    await addFromLibrary(page, 'bright-side', 'design')
    const doc = await page.evaluate(() => window.__doory!.getDocument())
    await page.evaluate((d) => localStorage.setItem('doory.harness.doc', JSON.stringify(d)), doc)
    await openEditor(page, 'doc=stored&mode=shared-view')
    await openAudio(page)
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(page.getByTestId('audio-tracks')).toContainText('Bright Side')
    await page.getByTestId('audio-play-all').click()
    await expect.poll(async () => (await sourcesOf(page)).length).toBe(1)
    await page.evaluate(() => localStorage.removeItem('doory.harness.doc'))
  })
})
