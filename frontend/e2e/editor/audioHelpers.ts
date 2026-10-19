/** Support for the audio specs: the bundled library served without Django, a spy on the Web Audio calls, and small sound files. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Page, expect } from '@playwright/test'

const DATA = fileURLToPath(new URL('../../../backend/data/', import.meta.url))

interface ManifestTrack {
  id: string
  kind: 'music' | 'sfx'
  file: string
  [key: string]: unknown
}

const manifest = (): { schema: number; release: string; license: unknown; tracks: ManifestTrack[]; packs: unknown[] } => JSON.parse(readFileSync(resolve(DATA, 'audio_library.json'), 'utf8'))

/** Serves `/media/audio/…` from the bundled library: the catalogue (what `sync_audio` writes next to the files) and the files. */
export async function serveLibrary(page: Page): Promise<void> {
  const library = manifest()
  const index = JSON.stringify({ schema: library.schema, release: library.release, license: library.license, tracks: library.tracks, packs: library.packs })
  await page.route('**/media/audio/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/media\/audio\//, '')
    if (path === 'index.json') return route.fulfill({ contentType: 'application/json', body: index })
    try {
      return await route.fulfill({ contentType: 'audio/ogg', body: readFileSync(resolve(DATA, 'audio', path)) })
    } catch {
      return route.fulfill({ status: 404, body: 'not found' })
    }
  })
}

export interface SourceCall {
  when: number
  offset: number
  duration: number | undefined
  loop: boolean
  loopStart: number
  loopEnd: number
  /** The context's clock when the call was made. */
  at: number
}

export interface AudioSpy {
  sources: SourceCall[]
  contexts: AudioContext[]
  elements: HTMLAudioElement[]
}

/** Records every buffer source that is started on a context and every `<audio>` element the page makes. */
export async function spyAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy = { sources: [] as unknown[], contexts: [] as AudioContext[], elements: [] as HTMLAudioElement[] }
    ;(window as unknown as { __audioSpy: typeof spy }).__audioSpy = spy
    const Native = window.AudioContext
    class Spy extends Native {
      constructor(options?: AudioContextOptions) {
        super(options)
        spy.contexts.push(this)
      }
      createBufferSource(): AudioBufferSourceNode {
        const node = super.createBufferSource()
        const start = node.start.bind(node)
        node.start = (when?: number, offset?: number, duration?: number): void => {
          spy.sources.push({ when: when ?? 0, offset: offset ?? 0, duration, loop: node.loop, loopStart: node.loopStart, loopEnd: node.loopEnd, at: this.currentTime })
          start(when, offset, duration)
        }
        return node
      }
    }
    window.AudioContext = Spy
    const NativeAudio = window.Audio
    window.Audio = function AudioSpy(src?: string): HTMLAudioElement {
      const element = new NativeAudio(src)
      spy.elements.push(element)
      return element
    } as unknown as typeof Audio
  })
}

export const sourcesOf = (page: Page): Promise<SourceCall[]> => page.evaluate(() => (window as unknown as { __audioSpy: { sources: SourceCall[] } }).__audioSpy.sources)
export const contextState = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as { __audioSpy: { contexts: AudioContext[] } }).__audioSpy.contexts.at(-1)?.state ?? 'none')

/** A mono 16-bit WAV of a sine wave. */
export function wavBytes(seconds: number, hz = 440, rate = 24000): Buffer {
  const frames = Math.round(seconds * rate)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 9000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Opens the Audio tool: its button in the top bar, or its entry in the "More" menu where the bar is too narrow for it. */
export async function openAudio(page: Page): Promise<void> {
  if (await page.getByTestId('audio-panel').isVisible()) return
  const button = page.locator('[data-testid="ed-add-entry-audio"]')
  if ((await button.count()) > 0) await button.click()
  else {
    await page.locator('[data-testid="ed-add-entry-more"]').click()
    await page.getByRole('menuitem', { name: 'Audio' }).click()
  }
  await expect(page.getByTestId('audio-panel')).toBeVisible()
}

/** The engine, reachable because the dev server runs with `VITE_E2E=true`. */
export interface TestEngine {
  audio: {
    tracks(): { id: string; name: string; kind: string; src: string; scope: { type: string; pageId?: string }; startMs: number; trimStartMs: number; trimEndMs: number; durationMs?: number; muted: boolean; volume: number; loop: boolean }[]
    mixdown(pageDurationsMs: number[], sampleRate: number): Promise<AudioBuffer>
    sources: { load(track: unknown): Promise<AudioBuffer> }
  }
  getDocument(): { pages: { id: string }[]; audioTracks?: unknown[] }
}

export const tracksOf = (page: Page): Promise<ReturnType<TestEngine['audio']['tracks']>> => page.evaluate(() => (window as unknown as { __doory_collab: { engine: TestEngine } }).__doory_collab.engine.audio.tracks())
