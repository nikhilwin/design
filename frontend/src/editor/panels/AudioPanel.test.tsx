import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { AudioTrack } from '@/types/document'
import { setupEditor } from '../animation/testing'
import { catalogueStore } from '../audio/library'
import { AudioFileError } from '../audio/files'
import { EditorProvider } from '../EditorProvider'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { AudioPanel } from './AudioPanel'

const COPY = t.audio

const music = (id: string, title: string, mood: string, genre: string, durationMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'music',
  title,
  mood,
  genre,
  tags: [genre, mood],
  bpm: 100,
  key: 'C major',
  loop: true,
  channels: 2,
  durationMs,
  lufs: -16,
  bytes: 200_000,
  peaks: [10, 60, 100, 40, 20],
  file: `music/${id}-aaaaaaaaaaaa.ogg`,
  license: 'CC0-1.0',
  source: 'doory',
  ...extra,
})
const effect = (id: string, title: string, category: string, durationMs: number) => ({
  id,
  kind: 'sfx',
  title,
  category,
  tags: [category],
  loop: false,
  channels: 1,
  durationMs,
  lufs: -17,
  bytes: 5000,
  peaks: [100, 30],
  file: `sfx/${id}-bbbbbbbbbbbb.ogg`,
  license: 'CC0-1.0',
  source: 'doory',
})

const TRACKS = [
  music('sunrise-run', 'Sunrise Run', 'upbeat', 'pop', 31_000),
  music('good-morning', 'Good Morning', 'upbeat', 'acoustic', 38_000),
  music('still-water', 'Still Water', 'calm', 'ambient', 42_000),
  music('epic-journey', 'Epic Journey', 'cinematic', 'orchestral', 48_000),
  effect('pop-small', 'Small Pop', 'ui', 120),
  effect('whoosh-soft', 'Soft Whoosh', 'whoosh', 900),
  effect('riser-long', 'Long Riser', 'riser', 3500),
]

const CATALOGUE = JSON.stringify({ schema: 1, release: '2026.10.1', license: { spdx: 'CC0-1.0' }, tracks: TRACKS, packs: [] })

function answer(status: number, body = CATALOGUE): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

async function open(options: { mode?: 'guest' | 'shared-view'; tracks?: AudioTrack[] } = {}) {
  const doc = createBlankDocument(800, 600)
  doc.pages.push({ ...doc.pages[0], id: 'p2', objects: [] })
  if (options.tracks) doc.audioTracks = options.tracks
  const { engine } = await setupEditor({ doc, mode: options.mode })
  await act(async () => {
    render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <AudioPanel />
      </EditorProvider>,
    )
  })
  return engine
}

const track = (over: Partial<AudioTrack> = {}): AudioTrack => ({
  id: 't1',
  kind: 'music',
  name: 'Theme',
  src: '/media/audio/music/theme-aaaaaaaaaaaa.ogg',
  scope: { type: 'design' },
  startMs: 0,
  durationMs: 30_000,
  trimStartMs: 0,
  trimEndMs: 30_000,
  volume: 0.5,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: true,
  muted: false,
  ...over,
})

describe('AudioPanel', () => {
  let engine: EditorEngine | null = null
  let play: ReturnType<typeof vi.spyOn>
  let pause: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubGlobal('fetch', answer(200))
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:http://localhost/audio', revokeObjectURL: () => undefined }))
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('playing'))
    })
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('pause'))
    })
    catalogueStore.reload()
  })

  afterEach(() => {
    engine?.dispose()
    engine = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  describe('library', () => {
    it('loads the catalogue, lists the music and counts it', async () => {
      engine = await open()
      expect(screen.getByRole('tab', { name: COPY.tabs.library })).toHaveAttribute('aria-selected', 'true')
      await screen.findByTestId('audio-results')
      expect(screen.getByTestId('audio-count')).toHaveTextContent(COPY.library.count(4))
      expect(screen.getByTestId('audio-lib-sunrise-run')).toHaveTextContent('Sunrise Run')
      expect(screen.queryByTestId('audio-lib-pop-small')).toBeNull()
      expect(screen.getByText(/CC0/)).toBeInTheDocument()
    })

    it('narrows by mood chip, by search words and by length, and clears everything', async () => {
      engine = await open()
      await screen.findByTestId('audio-results')
      await userEvent.click(screen.getByTestId('audio-chip-upbeat'))
      expect(screen.getByTestId('audio-count')).toHaveTextContent(COPY.library.count(2))
      expect(screen.getByTestId('audio-chip-upbeat')).toHaveAttribute('aria-pressed', 'true')
      await userEvent.type(screen.getByTestId('audio-search'), 'acoustic')
      await waitFor(() => expect(screen.getByTestId('audio-count')).toHaveTextContent(COPY.library.count(1)))
      expect(screen.getByTestId('audio-lib-good-morning')).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('audio-clear'))
      expect(screen.getByTestId('audio-count')).toHaveTextContent(COPY.library.count(4))
      await userEvent.selectOptions(screen.getByTestId('audio-duration'), 'long')
      expect(screen.getByTestId('audio-count')).toHaveTextContent(COPY.library.count(1))
      expect(screen.getByTestId('audio-lib-epic-journey')).toBeInTheDocument()
    })

    it('says so when nothing matches', async () => {
      engine = await open()
      await screen.findByTestId('audio-results')
      await userEvent.type(screen.getByTestId('audio-search'), 'zzzzqq')
      expect(await screen.findByTestId('audio-none')).toHaveTextContent(COPY.library.none)
    })

    it('lists sound effects with category chips', async () => {
      engine = await open()
      await screen.findByTestId('audio-results')
      await userEvent.click(screen.getByRole('radio', { name: COPY.library.effects }))
      expect(screen.getByTestId('audio-count')).toHaveTextContent(COPY.library.count(3))
      await userEvent.click(screen.getByTestId('audio-chip-whoosh'))
      expect(screen.getByTestId('audio-count')).toHaveTextContent(COPY.library.count(1))
      expect(screen.getByTestId('audio-lib-whoosh-soft')).toBeInTheDocument()
    })

    it('previews a row with an audio element and pauses it again', async () => {
      engine = await open()
      await screen.findByTestId('audio-results')
      const row = screen.getByTestId('audio-lib-sunrise-run')
      const button = within(row).getByTestId('audio-lib-play')
      await userEvent.click(button)
      await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
      expect(play).toHaveBeenCalledTimes(1)
      expect(button).toHaveAccessibleName(COPY.library.pause('Sunrise Run'))
      await userEvent.click(button)
      await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'))
      expect(pause).toHaveBeenCalled()
    })

    it('adds a track to the design, or to the page in view, from a row', async () => {
      engine = await open()
      await screen.findByTestId('audio-results')
      const row = screen.getByTestId('audio-lib-sunrise-run')
      await userEvent.click(within(row).getByTestId('audio-lib-add-design'))
      expect(engine.audio.tracks()).toHaveLength(1)
      expect(engine.audio.tracks()[0]).toMatchObject({ name: 'Sunrise Run', kind: 'music', libraryId: 'sunrise-run', scope: { type: 'design' }, loop: true })
      await userEvent.click(within(row).getByTestId('audio-lib-add-page'))
      expect(engine.audio.tracks()[1].scope).toEqual({ type: 'page', pageId: engine.state.activePageId })
      expect(await screen.findByTestId('audio-tracks')).toHaveTextContent(COPY.tracks.count(2))
    })

    it('shows how to fix a catalogue that is not installed, and retries', async () => {
      vi.stubGlobal('fetch', answer(404, ''))
      catalogueStore.reload()
      engine = await open()
      const problem = await screen.findByTestId('audio-error')
      expect(problem).toHaveAttribute('data-code', 'not-installed')
      expect(problem).toHaveTextContent(COPY.library.notInstalled)
      vi.stubGlobal('fetch', answer(200))
      await userEvent.click(screen.getByTestId('audio-retry'))
      expect(await screen.findByTestId('audio-results')).toBeInTheDocument()
    })

    it('says the library cannot be reached when the network fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
      catalogueStore.reload()
      engine = await open()
      const problem = await screen.findByTestId('audio-error')
      expect(problem).toHaveAttribute('data-code', 'unreachable')
      expect(problem).toHaveTextContent(COPY.library.unreachable)
    })
  })

  describe('tabs', () => {
    it('moves between the tabs with the arrow keys and keeps the last one', async () => {
      engine = await open()
      const library = screen.getByRole('tab', { name: COPY.tabs.library })
      library.focus()
      await userEvent.keyboard('{ArrowRight}')
      expect(screen.getByRole('tab', { name: COPY.tabs.uploads })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: COPY.tabs.uploads })).toHaveFocus()
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: COPY.tabs.uploads }).id)
      await userEvent.keyboard('{End}')
      expect(screen.getByRole('tab', { name: COPY.tabs.record })).toHaveAttribute('aria-selected', 'true')
      await userEvent.keyboard('{ArrowRight}')
      expect(screen.getByRole('tab', { name: COPY.tabs.library })).toHaveAttribute('aria-selected', 'true')
      await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
      expect(screen.getByRole('tab', { name: COPY.tabs.uploads })).toHaveAttribute('aria-selected', 'true')
      // Reopening the tool lands on the same tab.
      document.body.innerHTML = ''
      engine.dispose()
      engine = await open()
      expect(screen.getByRole('tab', { name: COPY.tabs.uploads })).toHaveAttribute('aria-selected', 'true')
      await userEvent.click(screen.getByRole('tab', { name: COPY.tabs.library }))
    })
  })

  describe('uploads', () => {
    async function goUploads() {
      const e = await open()
      await userEvent.click(screen.getByRole('tab', { name: COPY.tabs.uploads }))
      return e
    }

    it('starts with an empty state and a drop zone', async () => {
      engine = await goUploads()
      expect(await screen.findByTestId('audio-upload-empty')).toHaveTextContent(COPY.uploads.none)
      expect(screen.getByTestId('audio-upload-zone')).toHaveTextContent(COPY.uploads.drop)
      expect(screen.getByTestId('audio-upload-input')).toHaveAttribute('accept', expect.stringContaining('.mp3'))
    })

    it('uploads a file, lists it, and adds it to the design', async () => {
      engine = await goUploads()
      vi.spyOn(engine.audio, 'measure').mockResolvedValue(4200)
      const file = new File([new Uint8Array(2048)], 'interview.wav', { type: 'audio/wav' })
      await userEvent.upload(screen.getByTestId('audio-upload-input'), file)
      const row = (await within(await screen.findByTestId('audio-upload-list')).findAllByRole('listitem'))[0]
      expect(row).toHaveTextContent('interview')
      expect(row).toHaveTextContent('4.2 s')
      await userEvent.click(within(row).getByTestId('audio-upload-add-design'))
      expect(engine.audio.tracks()).toHaveLength(1)
      expect(engine.audio.tracks()[0]).toMatchObject({ kind: 'upload', durationMs: 4200, scope: { type: 'design' } })
      await waitFor(() => expect(within(screen.getByTestId('audio-upload-list')).getByText(new RegExp(COPY.uploads.inUse))).toBeInTheDocument())
      expect(within(row).getByTestId('audio-upload-delete')).toBeDisabled()
    })

    it('explains a file the editor will not take', async () => {
      engine = await goUploads()
      const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
      await userEvent.upload(screen.getByTestId('audio-upload-input'), file, { applyAccept: false })
      const problem = await screen.findByTestId('audio-upload-error')
      expect(problem.textContent).toBeTruthy()
      expect(engine.audio.tracks()).toHaveLength(0)
    })

    it('shows the message of a failed upload and keeps the design untouched', async () => {
      engine = await goUploads()
      vi.spyOn(engine.audio, 'upload').mockRejectedValue(new AudioFileError('That file is too large.', 'size'))
      await userEvent.upload(screen.getByTestId('audio-upload-input'), new File(['x'], 'big.mp3', { type: 'audio/mpeg' }))
      expect(await screen.findByTestId('audio-upload-error')).toHaveTextContent('That file is too large.')
    })

    it('opens the file picker from the drop zone with the keyboard', async () => {
      engine = await goUploads()
      const input = screen.getByTestId('audio-upload-input')
      const click = vi.spyOn(input, 'click').mockImplementation(() => undefined)
      screen.getByTestId('audio-upload-zone').focus()
      await userEvent.keyboard('{Enter}')
      expect(click).toHaveBeenCalled()
    })

    it('takes a dropped audio file', async () => {
      engine = await goUploads()
      const spy = vi.spyOn(engine.audio, 'upload').mockResolvedValue({ ref: { id: 'x1', url: 'idb://x1', thumbUrl: '', width: 0, height: 0, name: 'voice', kind: 'audio' }, durationMs: 1500 })
      const file = new File(['x'], 'voice.ogg', { type: 'audio/ogg' })
      const zone = screen.getByTestId('audio-upload-zone')
      fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files: [file] } })
      expect(zone).toHaveAttribute('data-over', 'true')
      await act(async () => {
        fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', type: 'audio/ogg', getAsFile: () => file }] } })
      })
      await waitFor(() => expect(spy).toHaveBeenCalledWith(file))
      expect(await screen.findByTestId('audio-upload-x1')).toHaveTextContent('voice')
    })
  })

  describe('record', () => {
    async function goRecord() {
      const e = await open()
      await userEvent.click(screen.getByRole('tab', { name: COPY.tabs.record }))
      return e
    }

    afterEach(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
      Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true })
    })

    it('says the browser cannot record when there is no microphone support', async () => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
      engine = await goRecord()
      expect(screen.getByRole('heading', { name: COPY.record.title })).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('audio-record-start'))
      const problem = await screen.findByTestId('audio-record-error')
      expect(problem).toHaveAttribute('data-reason', 'unsupported')
      expect(screen.getByTestId('audio-record-retry')).toBeInTheDocument()
    })

    it('explains a refused permission and offers another try', async () => {
      const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => Promise.reject(denied)) }, configurable: true })
      vi.stubGlobal('MediaRecorder', class {
        static isTypeSupported = () => true
      })
      engine = await goRecord()
      await userEvent.click(screen.getByTestId('audio-record-start'))
      const problem = await screen.findByTestId('audio-record-error')
      expect(problem).toHaveAttribute('data-reason', 'denied')
      expect(problem.textContent ?? '').toMatch(/microphone/i)
      await userEvent.click(screen.getByTestId('audio-record-retry'))
      expect(await screen.findByTestId('audio-record-error')).toBeInTheDocument()
    })

    it('warns before the first press when the browser has already blocked the microphone', async () => {
      Object.defineProperty(navigator, 'permissions', { value: { query: vi.fn(async () => ({ state: 'denied' })) }, configurable: true })
      engine = await goRecord()
      expect(await screen.findByTestId('audio-record-denied')).toHaveTextContent(COPY.record.blocked)
      expect(screen.getByTestId('audio-record-start')).toBeEnabled()
    })
  })

  describe('tracks', () => {
    it('shows an empty state with the three ways to add sound', async () => {
      engine = await open()
      expect(screen.getByTestId('audio-tracks-empty')).toHaveTextContent(COPY.tracks.empty)
      expect(screen.getByTestId('audio-play-page')).toBeDisabled()
      expect(screen.getByTestId('audio-play-all')).toBeDisabled()
    })

    it('lists the tracks with their scope and length, and enables playing', async () => {
      engine = await open({ tracks: [track(), track({ id: 't2', kind: 'sfx', name: 'Pop', scope: { type: 'page', pageId: 'p2' }, durationMs: 120, trimEndMs: 120, loop: false })] })
      const first = screen.getByTestId('audio-track-t1')
      expect(first).toHaveTextContent('Theme')
      expect(first).toHaveTextContent(COPY.tracks.scopes.design)
      expect(first).toHaveTextContent('30 s')
      expect(screen.getByTestId('audio-track-t2')).toHaveTextContent(COPY.tracks.scopes.page(2))
      expect(screen.getByTestId('audio-tracks')).toHaveTextContent(COPY.tracks.count(2))
      expect(screen.getByTestId('audio-play-all')).toBeEnabled()
    })

    it('mutes, renames, changes the volume and deletes, each as an undoable command', async () => {
      engine = await open({ tracks: [track()] })
      const card = screen.getByTestId('audio-track-t1')
      await userEvent.click(within(card).getByTestId('audio-track-mute'))
      expect(engine.audio.get('t1')?.muted).toBe(true)
      expect(card).toHaveAttribute('data-muted', 'true')
      await userEvent.click(within(card).getByTestId('audio-track-toggle'))
      const body = within(card).getByTestId('audio-track-body')
      const name = within(body).getByTestId('audio-track-name')
      await userEvent.clear(name)
      await userEvent.type(name, 'Opening{Enter}')
      expect(engine.audio.get('t1')?.name).toBe('Opening')
      const volume = within(body).getByRole('slider', { name: COPY.tracks.volume })
      fireEvent.change(volume, { target: { value: '80' } })
      expect(engine.audio.get('t1')?.volume).toBeCloseTo(0.8)
      await userEvent.click(within(body).getByTestId('audio-track-delete'))
      expect(engine.audio.tracks()).toHaveLength(0)
      expect(await screen.findByTestId('audio-tracks-empty')).toBeInTheDocument()
      await act(async () => {
        await engine?.undo()
      })
      expect(engine.audio.tracks()).toHaveLength(1)
    })

    it('trims with the keyboard on the handles, a tenth of a second at a time', async () => {
      engine = await open({ tracks: [track()] })
      await userEvent.click(screen.getByTestId('audio-track-toggle'))
      const start = screen.getByTestId('audio-trim-start')
      const end = screen.getByTestId('audio-trim-end')
      expect(start).toHaveAttribute('role', 'slider')
      expect(end).toHaveAttribute('aria-valuenow', '30000')
      start.focus()
      await userEvent.keyboard('{ArrowRight}{ArrowRight}')
      expect(engine.audio.get('t1')?.trimStartMs).toBe(200)
      await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}')
      expect(engine.audio.get('t1')?.trimStartMs).toBe(1200)
      end.focus()
      await userEvent.keyboard('{ArrowLeft}')
      expect(engine.audio.get('t1')?.trimEndMs).toBe(29_900)
      await userEvent.keyboard('{Home}')
      expect(engine.audio.get('t1')?.trimEndMs).toBeGreaterThan(1200)
      expect(engine.audio.get('t1')?.trimEndMs).toBeLessThan(1500)
      expect(screen.getByTestId('audio-trim-readout')).toHaveTextContent(/long|s/)
    })

    it('moves a track to a page and warns about a track whose page is gone', async () => {
      engine = await open({ tracks: [track({ scope: { type: 'page', pageId: 'gone' } })] })
      const card = screen.getByTestId('audio-track-t1')
      expect(card).toHaveTextContent(COPY.tracks.scopes.gone)
      await userEvent.click(within(card).getByTestId('audio-track-toggle'))
      expect(screen.getByText(COPY.tracks.pageGoneHint)).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('audio-track-to-design'))
      expect(engine.audio.get('t1')?.scope).toEqual({ type: 'design' })
      await userEvent.selectOptions(screen.getByTestId('audio-track-scope'), 'p2')
      expect(engine.audio.get('t1')?.scope).toEqual({ type: 'page', pageId: 'p2' })
    })

    it('offers to remove the tracks of deleted pages', async () => {
      engine = await open({ tracks: [track({ scope: { type: 'page', pageId: 'gone' } }), track({ id: 't2', name: 'Keep' })] })
      await userEvent.click(screen.getByTestId('audio-clean'))
      expect(engine.audio.tracks().map((x) => x.id)).toEqual(['t2'])
    })

    it('duplicates a track', async () => {
      engine = await open({ tracks: [track()] })
      await userEvent.click(screen.getByTestId('audio-track-toggle'))
      await userEvent.click(screen.getByTestId('audio-track-duplicate'))
      expect(engine.audio.tracks()).toHaveLength(2)
    })

    it('previews one track with its trim as the range of an audio element', async () => {
      engine = await open({ tracks: [track({ trimStartMs: 2000 })] })
      const button = within(screen.getByTestId('audio-track-t1')).getByTestId('audio-track-play')
      await userEvent.click(button)
      await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
    })
  })

  describe('view only', () => {
    it('shows the transport and the tracks, and nothing that edits', async () => {
      engine = await open({ mode: 'shared-view', tracks: [track()] })
      expect(screen.queryByRole('tablist')).toBeNull()
      expect(screen.getByTestId('audio-transport')).toBeInTheDocument()
      const card = screen.getByTestId('audio-track-t1')
      expect(within(card).queryByTestId('audio-track-mute')).toBeNull()
      await userEvent.click(within(card).getByTestId('audio-track-toggle'))
      expect(screen.getByTestId('audio-track-name')).toHaveAttribute('readonly')
      expect(screen.queryByTestId('audio-track-delete')).toBeNull()
      expect(screen.getByTestId('audio-trim-start')).toHaveAttribute('aria-readonly', 'true')
    })

    it('says there is no audio in a view-only design without any', async () => {
      engine = await open({ mode: 'shared-view' })
      expect(screen.getByTestId('audio-tracks-empty')).toHaveTextContent(COPY.tracks.emptyReadOnly)
    })
  })
})
