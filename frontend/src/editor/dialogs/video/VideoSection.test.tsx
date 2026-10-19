import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { DocPage, DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorProvider } from '../../EditorProvider'
import { EditorEngine } from '../../engine/editor'
import { downloadFiles } from '../../engine/export/exporter'
import { VideoExportError } from '../../engine/export/video/errors'
import { runVideoExport } from '../../engine/export/video/pipeline'
import type { VideoJob, VideoResult } from '../../engine/export/video/types'
import { t } from '../../strings'
import { DownloadDialog } from '../DownloadDialog'
import { saveVideoSettings } from './videoSettings'
import { defaultVideoOptions } from '../../engine/export/video/options'

vi.mock('../../engine/export/exporter', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../engine/export/exporter')>()), downloadFiles: vi.fn() }))
vi.mock('../../engine/export/video/pipeline', () => ({ runVideoExport: vi.fn() }))

const page = (id: string, over: Partial<DocPage> = {}): DocPage => ({ id, background: { type: 'solid', color: '#ffffff' }, objects: [], ...over })
const track = { id: 't1', kind: 'music', name: 'Song', src: '/media/audio/song.ogg', scope: { type: 'design' }, startMs: 0, trimStartMs: 0, trimEndMs: 8000, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false, muted: false }

function design(over: Partial<DoryDocument> = {}): DoryDocument {
  const base = createBlankDocument(1280, 720)
  return { ...base, pages: [page('a', { durationSec: 4 }), page('b', { durationSec: 6 }), page('c', { durationSec: 5 })], ...over }
}

/** A browser whose encoders accept what `can` lists. */
function browser(can: { h264?: boolean; vp9?: boolean; aac?: boolean; opus?: boolean } = { h264: true, aac: true, opus: true, vp9: true }): void {
  vi.stubGlobal('VideoFrame', class {})
  vi.stubGlobal(
    'VideoEncoder',
    class {
      static isConfigSupported = async (config: { codec: string }) => ({ supported: (config.codec.startsWith('avc1') && can.h264 === true) || (config.codec.startsWith('vp09') && can.vp9 === true) })
    },
  )
  vi.stubGlobal(
    'AudioEncoder',
    class {
      static isConfigSupported = async (config: { codec: string }) => ({ supported: (config.codec === 'opus' && can.opus === true) || (config.codec === 'mp4a.40.2' && can.aac === true) })
    },
  )
}

function setup(doc: DoryDocument = design(), id = 'design-1', props?: Record<string, unknown>) {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id, title: 'My Deck', mode: 'guest' }, ephemeral: true })
  const toast = vi.spyOn(engine, 'toast')
  const view = render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <DownloadDialog props={props} />
    </EditorProvider>,
  )
  return { engine, toast, view }
}

const dialog = () => screen.getByRole('dialog', { name: t.dialog.downloadTitle })
const pick = (name: RegExp | string) => userEvent.click(within(dialog()).getByRole('radio', { name }))
/** The section is a lazy chunk: the first look at it waits for the import, which is slow on a loaded machine. */
const section = () => screen.findByTestId('video-section', undefined, { timeout: 5000 })
const choose = (group: string, name: string | RegExp) => userEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name }))

function result(over: Partial<VideoResult> = {}): VideoResult {
  return { blob: new Blob([new Uint8Array(2_400_000)], { type: 'video/mp4' }), filename: 'My-Deck.mp4', mime: 'video/mp4', format: 'mp4', durationMs: 15_000, width: 1280, height: 720, fps: 30, frames: 450, video: 'H.264', audio: null, warnings: [], elapsedMs: 4000, ...over }
}

const mocked = vi.mocked(runVideoExport)

beforeEach(() => {
  localStorage.clear()
  mocked.mockReset()
  vi.mocked(downloadFiles).mockClear()
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  browser()
})
afterEach(() => vi.unstubAllGlobals())

describe('Download dialog: video formats', () => {
  it('lists MP4, WebM and GIF under their own heading, after the image and document formats', async () => {
    const { engine } = setup()
    expect(within(dialog()).getByText(t.video.group)).toBeInTheDocument()
    const groups = within(dialog()).getAllByRole('radiogroup')
    expect(within(groups[0]).getAllByRole('radio').map((r) => r.closest('label')?.querySelector('strong')?.textContent)).toEqual(['PNG', 'JPG', 'PDF', 'SVG'])
    expect(within(screen.getByRole('radiogroup', { name: t.video.group })).getAllByRole('radio').map((r) => r.closest('label')?.querySelector('strong')?.textContent)).toEqual(['MP4', 'WebM', 'GIF'])
    expect(screen.queryByTestId('video-section')).toBeNull()
    engine.dispose()
  })

  it('opens on the format it is asked for (the Download menu\'s Video or GIF), and on PNG when it is not asked or the format is not there', async () => {
    const asked = setup(design(), 'design-1', { format: 'gif' })
    expect(within(dialog()).getByRole('radio', { name: /^GIF/ })).toBeChecked()
    await section()
    asked.view.unmount()
    asked.engine.dispose()
    const unknown = setup(design(), 'design-1', { format: 'bmp' })
    expect(within(dialog()).getByRole('radio', { name: /^PNG/ })).toBeChecked()
    unknown.engine.dispose()
  })

  it('shows the settings once a video format is chosen, with the size the design gives, and no image controls', async () => {
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    expect(await screen.findByTestId('video-size')).toHaveTextContent('1280 × 720 px')
    expect(screen.queryByTestId('download-size')).toBeNull()
    expect(screen.queryByText(t.dialog.downloadZip)).toBeNull()
    expect(screen.getByRole('button', { name: t.video.makeVideo })).toBeEnabled()
    engine.dispose()
  })

  it('says how long the video is and roughly how large, and follows the choices', async () => {
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    const estimate = screen.getByTestId('video-estimate')
    // 4 s + 6 s + 5 s with no transitions: 15 s at 30 fps.
    expect(estimate).toHaveTextContent('0:15 · 450 frames · about')
    const before = Number(estimate.getAttribute('data-bytes'))
    await choose(t.video.fps, t.video.fpsOption(60))
    expect(estimate).toHaveTextContent('900 frames')
    expect(Number(estimate.getAttribute('data-bytes'))).toBeGreaterThan(before)
    await choose(t.video.size, t.video.sizeOptions[1080])
    expect(screen.getByTestId('video-size')).toHaveTextContent('1920 × 1080 px')
    await choose(t.video.pageTime, t.video.pageTimeOptions.same)
    await userEvent.clear(screen.getByRole('textbox', { name: t.video.pageSeconds }))
    await userEvent.type(screen.getByRole('textbox', { name: t.video.pageSeconds }), '2{Enter}')
    expect(estimate).toHaveTextContent('0:06')
    engine.dispose()
  })

  it('follows the chosen pages: the length is that of the pages selected', async () => {
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(within(dialog()).getByRole('radio', { name: t.dialog.downloadCurrentPage }))
    await waitFor(() => expect(screen.getByTestId('video-estimate')).toHaveTextContent('0:04 ·'))
    await userEvent.click(within(dialog()).getByRole('radio', { name: t.dialog.downloadRange }))
    await userEvent.type(screen.getByLabelText(t.dialog.downloadRange, { selector: 'input[type=text], input:not([type])' }), '2-3')
    await waitFor(() => expect(screen.getByTestId('video-estimate')).toHaveTextContent('0:11 ·'))
    engine.dispose()
  })

  it('cannot start for a page range it cannot read, and says so', async () => {
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(within(dialog()).getByRole('radio', { name: t.dialog.downloadRange }))
    await userEvent.type(screen.getByLabelText(t.dialog.downloadRange, { selector: 'input[type=text], input:not([type])' }), 'x')
    expect(screen.getByRole('button', { name: t.video.makeVideo })).toBeDisabled()
    expect(screen.getByTestId('video-estimate')).toHaveTextContent(t.video.warnings.noPages)
    engine.dispose()
  })

  it('warns when the video would be longer than a browser can make, and will not start', async () => {
    const { engine } = setup(design({ pages: [page('a', { durationSec: 600 }), page('b', { durationSec: 30 })] }))
    await pick(/^MP4/)
    await section()
    expect(screen.getByRole('alert')).toHaveTextContent(t.video.warnings.tooLong('10 minutes'))
    expect(screen.getByRole('button', { name: t.video.makeVideo })).toBeDisabled()
    engine.dispose()
  })

  it('offers the sound switch only when the design has sound, and says how to add some when it has none', async () => {
    const without = setup()
    await pick(/^MP4/)
    await section()
    expect(screen.getByTestId('video-no-sound')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: t.video.sound })).toBeNull()
    without.view.unmount()
    without.engine.dispose()
    setup(design({ audioTracks: [track] as DoryDocument['audioTracks'] }), 'design-2')
    await pick(/^MP4/)
    await section()
    expect(screen.getByRole('switch', { name: new RegExp(t.video.sound) })).toBeChecked()
  })

  it('shows the GIF\'s own choices (loops, smooth gradients) and none of the video\'s (quality, sound)', async () => {
    const { engine } = setup(design({ audioTracks: [track] as DoryDocument['audioTracks'] }))
    await pick(/^GIF/)
    await section()
    expect(screen.getByRole('radiogroup', { name: t.video.loop })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: new RegExp(t.video.dither) })).toBeChecked()
    expect(screen.queryByRole('radiogroup', { name: t.video.quality })).toBeNull()
    expect(screen.queryByRole('switch', { name: new RegExp(t.video.sound) })).toBeNull()
    expect(screen.getByTestId('video-size')).toHaveTextContent('852 × 480 px')
    expect(within(screen.getByRole('radiogroup', { name: t.video.fps })).getAllByRole('radio')).toHaveLength(4)
    engine.dispose()
  })

  it('asks how to treat pages of another shape only when there are some', async () => {
    const plain = setup()
    await pick(/^MP4/)
    await section()
    expect(screen.queryByRole('radiogroup', { name: t.video.fit })).toBeNull()
    plain.view.unmount()
    plain.engine.dispose()
    setup(design({ pages: [page('a'), page('b', { width: 500, height: 500 })] }), 'design-3')
    await pick(/^MP4/)
    await section()
    expect(screen.getByRole('radiogroup', { name: t.video.fit })).toBeInTheDocument()
  })

  it('remembers the choices for this design', async () => {
    const first = setup()
    await pick(/^MP4/)
    await section()
    await choose(t.video.fps, t.video.fpsOption(24))
    await choose(t.video.quality, t.video.qualityOptions.high)
    first.view.unmount()
    first.engine.dispose()
    setup()
    await pick(/^MP4/)
    await section()
    expect(within(screen.getByRole('radiogroup', { name: t.video.fps })).getByRole('radio', { name: t.video.fpsOption(24) })).toBeChecked()
    expect(within(screen.getByRole('radiogroup', { name: t.video.quality })).getByRole('radio', { name: t.video.qualityOptions.high })).toBeChecked()
  })

  it('starts from what was saved, field by field, when the saved choice is partly nonsense', async () => {
    saveVideoSettings('design-1', { ...defaultVideoOptions('mp4'), fps: 60 })
    localStorage.setItem('doory.editor.video.v1.design-1', JSON.stringify({ format: 'mp4', fps: 99, quality: 'high' }))
    setup()
    await pick(/^MP4/)
    await section()
    expect(within(screen.getByRole('radiogroup', { name: t.video.fps })).getByRole('radio', { name: t.video.fpsOption(30) })).toBeChecked()
    expect(within(screen.getByRole('radiogroup', { name: t.video.quality })).getByRole('radio', { name: t.video.qualityOptions.high })).toBeChecked()
  })
})

describe('Download dialog: what the browser can make', () => {
  it('says MP4 is H.264 with AAC when the browser has both', async () => {
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    expect(screen.getByTestId('video-notes')).toHaveTextContent(t.video.engine.webcodecs('H.264', 'AAC'))
    engine.dispose()
  })

  it('warns that the MP4 is VP9 when there is no H.264 encoder', async () => {
    vi.unstubAllGlobals()
    browser({ vp9: true, opus: true })
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    expect(screen.getByTestId('video-notes')).toHaveTextContent(t.video.engine.videoFallback('VP9'))
    expect(screen.getByTestId('video-notes')).toHaveTextContent(t.video.engine.audioFallback)
    expect(screen.getByRole('button', { name: t.video.makeVideo })).toBeEnabled()
    engine.dispose()
  })

  it('does not offer to make a video the browser cannot, and still makes a GIF', async () => {
    vi.unstubAllGlobals()
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    expect(screen.getByTestId('video-notes')).toHaveTextContent(t.video.engine.none)
    expect(screen.getByRole('button', { name: t.video.makeVideo })).toBeDisabled()
    await pick(/^GIF/)
    await waitFor(() => expect(screen.getByRole('button', { name: t.video.makeGif })).toBeEnabled())
    engine.dispose()
  })
})

describe('Download dialog: making a video', () => {
  const finish = (): void => {
    mocked.mockImplementation(async (job: VideoJob) => {
      job.onProgress?.({ stage: 'frames', fraction: 0.5, frame: 225, frames: 450, elapsedMs: 2000, etaMs: 12_000, bytes: null })
      return result()
    })
  }

  it('hands the pipeline the pages, the options and the title, and shows the finished file with a preview', async () => {
    finish()
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    const done = await screen.findByTestId('video-result')
    const job = mocked.mock.calls[0][0]
    expect(job.options).toMatchObject({ format: 'mp4', fps: 30, resolution: 'design' })
    expect(job.pages.map((p) => p.page.id)).toEqual(['a', 'b', 'c'])
    expect(job.title).toBe('My Deck')
    expect(done).toHaveAttribute('data-width', '1280')
    expect(screen.getByTestId('video-facts')).toHaveTextContent('1280 × 720 px · 0:15 · 2.3 MB · H.264 video, no sound')
    expect(screen.getByTestId('video-preview').tagName).toBe('VIDEO')
    expect(screen.getByTestId('video-preview')).toHaveAttribute('src', 'blob:preview')
    expect(screen.getByRole('heading', { name: t.video.readyVideo })).toBeInTheDocument()
    engine.dispose()
  })

  it('previews a GIF as a picture', async () => {
    mocked.mockResolvedValue(result({ format: 'gif', mime: 'image/gif', filename: 'My-Deck.gif', video: 'GIF' }))
    const { engine } = setup()
    await pick(/^GIF/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeGif }))
    await screen.findByTestId('video-result')
    expect(screen.getByTestId('video-preview').tagName).toBe('IMG')
    expect(screen.getByRole('heading', { name: t.video.readyGif })).toBeInTheDocument()
    engine.dispose()
  })

  it('downloads the file under the name the pipeline gave it, and moves focus to Download when it is ready', async () => {
    finish()
    const { engine, toast } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    const button = await screen.findByTestId('video-download')
    await waitFor(() => expect(button).toHaveFocus())
    await userEvent.click(button)
    const files = vi.mocked(downloadFiles).mock.calls[0][0]
    expect(files).toHaveLength(1)
    expect(files[0].filename).toBe('My-Deck.mp4')
    expect(toast).toHaveBeenCalledWith(t.video.downloadStarted, 'success')
    engine.dispose()
  })

  it('shows progress while it works: the frame, the time left, a progress bar a screen reader can read', async () => {
    let release: (value: VideoResult) => void = () => undefined
    mocked.mockImplementation(
      (job: VideoJob) =>
        new Promise<VideoResult>((resolve) => {
          job.onProgress?.({ stage: 'frames', fraction: 0.5, frame: 225, frames: 450, elapsedMs: 2000, etaMs: 12_000, bytes: null })
          release = resolve
        }),
    )
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    expect(await screen.findByTestId('video-stage')).toHaveTextContent('Frame 225 of 450')
    expect(screen.getByTestId('video-eta')).toHaveTextContent('12 s left')
    const bar = screen.getByRole('progressbar', { name: t.video.progressLabel })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByRole('status')).toHaveTextContent(t.video.announce(50))
    // The choices above are held still while it works.
    expect(within(dialog()).getByRole('radio', { name: /^PNG/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: t.dialog.downloadWorking })).toBeDisabled()
    await act(async () => release(result()))
    await screen.findByTestId('video-result')
    expect(within(dialog()).getByRole('radio', { name: /^PNG/ })).toBeDisabled()
    await userEvent.click(screen.getByTestId('video-again'))
    expect(within(dialog()).getByRole('radio', { name: /^PNG/ })).toBeEnabled()
    expect(await screen.findByTestId('video-section')).toBeInTheDocument()
    engine.dispose()
  })

  it('moves keyboard focus with the file: Cancel while it works, the main button when the settings come back', async () => {
    let release: (value: VideoResult) => void = () => undefined
    mocked.mockImplementation(() => new Promise<VideoResult>((resolve) => (release = resolve)))
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    await waitFor(() => expect(screen.getByTestId('video-cancel')).toHaveFocus())
    await act(async () => release(result()))
    await waitFor(() => expect(screen.getByTestId('video-download')).toHaveFocus())
    await userEvent.click(screen.getByTestId('video-again'))
    await waitFor(() => expect(screen.getByTestId('video-make')).toHaveFocus())
    engine.dispose()
  })

  it('Cancel stops the export, says nothing was saved, and gives the settings back', async () => {
    let signal: AbortSignal | undefined
    mocked.mockImplementation(
      (job: VideoJob) =>
        new Promise<VideoResult>((_resolve, reject) => {
          signal = job.signal
          job.signal.addEventListener('abort', () => reject(new DOMException('Export cancelled', 'AbortError')))
        }),
    )
    const { engine, toast } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    await userEvent.click(await screen.findByTestId('video-cancel'))
    expect(signal?.aborted).toBe(true)
    expect(await screen.findByTestId('video-section')).toBeInTheDocument()
    expect(toast).toHaveBeenCalledWith(t.video.cancelled)
    expect(screen.queryByTestId('video-result')).toBeNull()
    expect(vi.mocked(downloadFiles)).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('closing the dialog while it works cancels the export', async () => {
    let signal: AbortSignal | undefined
    mocked.mockImplementation((job: VideoJob) => {
      signal = job.signal
      return new Promise<VideoResult>(() => undefined)
    })
    const { engine, view } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    await screen.findByTestId('video-progress')
    // The dialog host removes the dialog when it is closed.
    view.unmount()
    expect(signal?.aborted).toBe(true)
    engine.dispose()
  })

  it('names what went wrong, keeps the settings, and offers Try again for a failure that can pass', async () => {
    mocked.mockRejectedValueOnce(new VideoExportError('encoder', 'stopped', 'The encoder broke'))
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    const problem = await screen.findByTestId('video-problem')
    expect(problem).toHaveAttribute('data-code', 'encoder')
    expect(problem).toHaveTextContent(t.video.problems.encoder)
    expect(problem).toHaveTextContent(t.video.problems['encoder-hint'])
    expect(problem).toHaveTextContent('The encoder broke')
    mocked.mockResolvedValueOnce(result())
    await userEvent.click(screen.getByRole('button', { name: t.video.problems.retry }))
    await screen.findByTestId('video-result')
    engine.dispose()
  })

  it('offers no retry for a failure that needs a change first', async () => {
    mocked.mockRejectedValueOnce(new VideoExportError('gif-too-large', 'big'))
    const { engine } = setup()
    await pick(/^GIF/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeGif }))
    expect(await screen.findByTestId('video-problem')).toHaveTextContent(t.video.problems['gif-too-large-hint'])
    expect(screen.queryByRole('button', { name: t.video.problems.retry })).toBeNull()
    expect(screen.getByRole('button', { name: t.video.makeGif })).toBeEnabled()
    engine.dispose()
  })

  it('tells what the file was made with when it is not what was asked for', async () => {
    mocked.mockResolvedValue(result({ video: 'VP9', warnings: ['video-fallback', 'no-audio'] }))
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    const notes = await screen.findByTestId('video-result-notes')
    expect(notes).toHaveTextContent(t.video.warned['video-fallback'])
    expect(notes).toHaveTextContent(t.video.warned['no-audio'])
    engine.dispose()
  })

  it('shows a message instead of a broken player when the browser cannot play the preview', async () => {
    finish()
    const { engine } = setup()
    await pick(/^MP4/)
    await section()
    await userEvent.click(screen.getByRole('button', { name: t.video.makeVideo }))
    const player = await screen.findByTestId('video-preview')
    await act(async () => {
      player.dispatchEvent(new Event('error'))
    })
    expect(await screen.findByTestId('video-preview-failed')).toHaveTextContent(t.video.previewFailed)
    expect(screen.getByTestId('video-download')).toBeEnabled()
    engine.dispose()
  })
})
