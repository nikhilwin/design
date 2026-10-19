/** Support for the video specs: opening the dialog on a format, making a file, and looking at what came out. */
import { readFileSync } from 'node:fs'
import { type Page, expect } from '@playwright/test'
import { openAudio, wavBytes } from './audioHelpers'

export type VideoFormatName = 'MP4' | 'WebM' | 'GIF'

/** Opens the Download dialog (by its shortcut where the top bar has no room for the button, as on a phone) and picks a format. */
export async function openVideoDialog(page: Page, format: VideoFormatName): Promise<void> {
  const button = page.locator('[data-testid="ed-download"]')
  if (await button.isVisible()) {
    await button.click()
    await page.getByRole('menuitem', { name: 'More options…' }).click()
  } else await page.keyboard.press('Control+Shift+D')
  await page.getByRole('radio', { name: new RegExp(`^${format}`) }).check({ force: true })
  await expect(page.getByTestId('video-section')).toBeVisible()
  await expect(page.getByTestId('video-make')).toBeEnabled()
}

/** A sine as a track for the whole design, added through the Audio tool the way a person does. */
export async function addTone(page: Page, seconds: number, hz = 440): Promise<void> {
  await openAudio(page)
  await page.getByTestId('audio-tab-uploads').click()
  await page.getByTestId('audio-upload-input').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wavBytes(seconds, hz) })
  await expect(page.getByTestId('audio-upload-list')).toContainText('tone')
  await page.getByTestId('audio-upload-list').getByTestId('audio-upload-add-design').click()
  await expect(page.getByTestId('audio-tracks')).toBeVisible()
}

export interface Made {
  /** The file as the browser saved it. */
  bytes: Uint8Array
  filename: string
  /** What the dialog says about it. */
  facts: { width: number; height: number; durationMs: number; frames: number; format: string }
}

/** Presses Make, waits for the finished file and saves it with the Download button. */
export async function makeAndDownload(page: Page, timeoutMs = 120_000): Promise<Made> {
  await page.getByTestId('video-make').click()
  const result = page.getByTestId('video-result')
  await expect(result).toBeVisible({ timeout: timeoutMs })
  const facts = {
    width: Number(await result.getAttribute('data-width')),
    height: Number(await result.getAttribute('data-height')),
    durationMs: Number(await result.getAttribute('data-duration')),
    frames: Number(await result.getAttribute('data-frames')),
    format: (await result.getAttribute('data-format')) ?? '',
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('video-download').click()])
  const path = await download.path()
  return { bytes: new Uint8Array(readFileSync(path)), filename: download.suggestedFilename(), facts }
}

export interface Look {
  /** Seconds the video was moved to. */
  t: number
  /** Colour of a pixel near the left edge, the middle of the picture and near the right edge, at mid height. */
  left: number[]
  middle: number[]
  right: number[]
}

export interface VideoProbe {
  duration: number
  width: number
  height: number
  looks: Look[]
}

/** Loads the preview's `<video>`, reads its length and size, and moves it to each time to read back the picture. */
export async function probeVideo(page: Page, times: number[]): Promise<VideoProbe> {
  return page.evaluate(async (at) => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="video-preview"]')
    if (!video) throw new Error('no preview')
    if (video.readyState < 1) await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      video.addEventListener('error', () => reject(new Error('The preview cannot be played')), { once: true })
    })
    // A recording whose length is not in the header reports Infinity until the end has been seen.
    if (!Number.isFinite(video.duration)) {
      video.currentTime = 1e9
      await new Promise<void>((resolve) => video.addEventListener('durationchange', () => resolve(), { once: true }))
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const looks: Look[] = []
    const colour = (x: number, y: number): number[] => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3)
    for (const t of at) {
      video.currentTime = t
      await new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }))
      await new Promise((resolve) => requestAnimationFrame(resolve))
      ctx.drawImage(video, 0, 0)
      const y = Math.round(canvas.height / 2)
      looks.push({ t, left: colour(6, y), middle: colour(Math.round(canvas.width / 2), y), right: colour(canvas.width - 7, y) })
    }
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, looks }
  }, times)
}

export interface SoundProbe {
  duration: number
  channels: number
  /** The loudest sample in each window, one per window given. */
  peaks: number[]
}

/** Decodes the sound of the preview file with the browser's own decoder and reports the peak of each window (seconds). */
export async function probeSound(page: Page, windows: [number, number][]): Promise<SoundProbe> {
  return page.evaluate(async (spans) => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="video-preview"]')
    if (!video) throw new Error('no preview')
    const data = await (await fetch(video.src)).arrayBuffer()
    const buffer = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(data)
    const left = buffer.getChannelData(0)
    const peaks = spans.map(([from, to]) => {
      let peak = 0
      for (let i = Math.floor(from * buffer.sampleRate); i < Math.min(left.length, Math.floor(to * buffer.sampleRate)); i++) peak = Math.max(peak, Math.abs(left[i]))
      return peak
    })
    return { duration: buffer.duration, channels: buffer.numberOfChannels, peaks }
  }, windows)
}

/** True when `a` and `b` are the same colour within `tolerance` per channel. */
export const sameColour = (a: number[], b: number[], tolerance = 14): boolean => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)
