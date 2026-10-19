import { act, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw'
import { BUILTIN_CATALOGUE, getSizePresets, loadSizePresets, resetSizePresetsForTests, useSizePresets } from './store'

const remote = { version: 1, groups: [{ slug: 'ours', label: 'Ours', presets: [{ slug: 'banner', label: 'Banner', width: 1200, height: 300, unit: 'px', width_px: 1200, height_px: 300 }] }] }

beforeEach(() => resetSizePresetsForTests())

describe('loading the size preset catalogue', () => {
  it('uses the server’s catalogue once it has loaded, and asks only once', async () => {
    let requests = 0
    server.use(
      http.get('/api/v1/size-presets/', () => {
        requests += 1
        return HttpResponse.json(remote)
      }),
    )
    expect(getSizePresets()).toBe(BUILTIN_CATALOGUE)
    await loadSizePresets()
    await loadSizePresets()
    expect(getSizePresets().presets.map((p) => p.id)).toEqual(['banner'])
    expect(requests).toBe(1)
  })

  it.each([
    ['fails', () => HttpResponse.json({ error: { code: 'server_error', message: 'x' } }, { status: 500 })],
    ['is empty', () => HttpResponse.json({ version: 1, groups: [] })],
    ['is not a catalogue', () => HttpResponse.json({ hello: 'world' })],
  ])('keeps the built-in catalogue when the request %s', async (_, reply) => {
    server.use(http.get('/api/v1/size-presets/', reply))
    await expect(loadSizePresets()).resolves.toBe(BUILTIN_CATALOGUE)
  })

  it('re-renders components when the catalogue arrives', async () => {
    server.use(http.get('/api/v1/size-presets/', () => HttpResponse.json(remote)))
    function Names() {
      return <p>{useSizePresets().presets.length === 1 ? 'server' : 'built-in'}</p>
    }
    render(<Names />)
    expect(screen.getByText('built-in')).toBeInTheDocument()
    await act(() => loadSizePresets())
    expect(await screen.findByText('server')).toBeInTheDocument()
  })
})
