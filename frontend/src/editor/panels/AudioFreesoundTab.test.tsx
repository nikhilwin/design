import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import type { EditorServices } from '@/types/adapter'
import type { AudioStockInfo, StockSound, StockSoundPage } from '@/types/api'
import type { AudioTrack } from '@/types/document'
import { setupEditor } from '../animation/testing'
import { catalogueStore } from '../audio/library'
import { readTracks } from '../audio/model'
import { EditorProvider } from '../EditorProvider'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { AudioPanel } from './AudioPanel'

type AudioStock = NonNullable<EditorServices['audioStock']>

const INFO: AudioStockInfo = {
  configured: true,
  provider: 'freesound',
  label: 'Freesound',
  url: 'https://freesound.org/',
  licenses: ['cc0', 'by'],
  types: { music: ['Solo instrument'], effects: ['Animals', 'Vehicles'], ambience: ['Nature'] },
  lengths: ['any', 'short'],
  sorts: ['relevance', 'rating'],
}

const sound = (id: string, over: Partial<StockSound> = {}): StockSound => ({
  id,
  provider: 'freesound',
  title: `Whoosh_${id}.wav`,
  author: 'foley_guy',
  author_url: 'https://freesound.org/people/foley_guy/',
  source_url: `https://freesound.org/people/foley_guy/sounds/${id}/`,
  duration_ms: 1500,
  type: 'effects',
  subcategory: 'Animals',
  license: 'CC0 1.0',
  license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  credit_required: false,
  tags: [],
  ...over,
})

const page = (results: StockSound[], next: number | null = null): StockSoundPage => ({ configured: true, total: 42, next_page: next, results })

function fakeService(over: Partial<AudioStock> = {}): AudioStock {
  return {
    info: vi.fn(async () => INFO),
    search: vi.fn(async () => page([sound('1'), sound('2', { credit_required: true, license: 'CC BY 4.0' })], 2)),
    previewUrl: (id: string) => `/api/v1/stock/audio/${id}/preview/`,
    importSound: vi.fn(async (id: string) => ({
      ref: { id: `asset-${id}`, url: `/media/assets/${id}.ogg`, thumbUrl: '', width: 0, height: 0, name: `Whoosh_${id}.wav`, kind: 'audio' as const },
      credit:
        id === '2'
          ? { source: 'freesound', id: '2', title: 'Whoosh_2.wav', author: 'foley_guy', url: 'https://freesound.org/people/foley_guy/sounds/2/', license: 'CC BY 4.0', required: true }
          : { source: 'freesound', id, title: `Whoosh_${id}.wav`, author: 'foley_guy', url: '', license: 'CC0 1.0', required: false },
      durationMs: 1500,
    })),
    ...over,
  }
}

async function open(service: AudioStock | null, tracks?: AudioTrack[]) {
  const doc = createBlankDocument(800, 600)
  if (tracks) doc.audioTracks = tracks
  const { engine } = await setupEditor({ doc })
  ;(engine.adapter.services as EditorServices).audioStock = service
  await act(async () => {
    render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <AudioPanel />
      </EditorProvider>,
    )
  })
  return engine
}

describe('Freesound tab', () => {
  let engine: EditorEngine | null = null

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 1, tracks: [], packs: [] }), { status: 200 })))
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('playing'))
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
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

  it('is hidden without the service or when the server is not configured', async () => {
    engine = await open(null)
    expect(screen.queryByRole('tab', { name: t.audio.tabs.freesound })).toBeNull()
    engine.dispose()
    document.body.innerHTML = ''
    engine = await open(fakeService({ info: vi.fn(async () => ({ configured: false }) as AudioStockInfo) }))
    expect(screen.queryByRole('tab', { name: t.audio.tabs.freesound })).toBeNull()
  })

  it('searches, shows clean titles and marks sounds that need credit', async () => {
    const service = fakeService()
    engine = await open(service)
    fireEvent.click(await screen.findByRole('tab', { name: t.audio.tabs.freesound }))
    const list = await screen.findByTestId('audio-fs-results')
    expect(within(list).getByText('Whoosh 1')).toBeInTheDocument()
    expect(within(screen.getByTestId('audio-fs-1')).queryByTestId('audio-fs-by')).toBeNull()
    expect(within(screen.getByTestId('audio-fs-2')).getByTestId('audio-fs-by')).toHaveAccessibleName(t.audio.freesound.creditHint('CC BY 4.0'))
    const link = within(screen.getByTestId('audio-fs-2')).getByRole('link')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    fireEvent.click(screen.getByText(t.audio.freesound.types.effects))
    fireEvent.click(await screen.findByRole('button', { name: 'Animals' }))
    await waitFor(() => expect(service.search).toHaveBeenLastCalledWith('', expect.objectContaining({ type: 'effects', subcategory: 'Animals', page: 1 })))

    fireEvent.click(screen.getByTestId('audio-fs-more'))
    await waitFor(() => expect(service.search).toHaveBeenLastCalledWith('', expect.objectContaining({ page: 2 })))
  })

  it('previews through the server', async () => {
    engine = await open(fakeService())
    fireEvent.click(await screen.findByRole('tab', { name: t.audio.tabs.freesound }))
    const row = await screen.findByTestId('audio-fs-1')
    fireEvent.click(within(row).getByTestId('audio-fs-play'))
    await waitFor(() => expect(within(row).getByTestId('audio-fs-play')).toHaveAttribute('aria-pressed', 'true'))
  })

  it('adds a CC BY sound with its credit, and the panel shows the credits to copy', async () => {
    const service = fakeService()
    engine = await open(service)
    fireEvent.click(await screen.findByRole('tab', { name: t.audio.tabs.freesound }))
    expect(screen.queryByTestId('audio-credits')).toBeNull()
    fireEvent.click(within(await screen.findByTestId('audio-fs-2')).getByTestId('audio-fs-add-design'))
    await waitFor(() => expect(readTracks(engine!.state.doc)).toHaveLength(1))
    const added = readTracks(engine.state.doc)[0]
    expect(added).toMatchObject({ kind: 'sfx', assetId: 'asset-2', credit: { license: 'CC BY 4.0', required: true } })
    const note = await screen.findByTestId('audio-credits')
    expect(within(note).getByTestId('audio-credits-text').textContent).toBe('Sound: "Whoosh_2.wav" by foley_guy (freesound.org/people/foley_guy/sounds/2), CC BY 4.0')
    expect(screen.getByTestId('audio-track-credit')).toHaveTextContent(t.audio.credits.needed)
  })

  it('adds a CC0 sound without any credit note', async () => {
    engine = await open(fakeService())
    fireEvent.click(await screen.findByRole('tab', { name: t.audio.tabs.freesound }))
    fireEvent.click(within(await screen.findByTestId('audio-fs-1')).getByTestId('audio-fs-add-design'))
    await waitFor(() => expect(readTracks(engine!.state.doc)).toHaveLength(1))
    expect(screen.queryByTestId('audio-credits')).toBeNull()
    expect(screen.queryByTestId('audio-track-credit')).toBeNull()
  })

  it('shows an error with a retry when the search fails', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(page([sound('1')]))
    engine = await open(fakeService({ search }))
    fireEvent.click(await screen.findByRole('tab', { name: t.audio.tabs.freesound }))
    const problem = await screen.findByTestId('audio-fs-error')
    fireEvent.click(within(problem).getByRole('button', { name: t.audio.freesound.retry }))
    expect(await screen.findByTestId('audio-fs-1')).toBeInTheDocument()
  })
})
