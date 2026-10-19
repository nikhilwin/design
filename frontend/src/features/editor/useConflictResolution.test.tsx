import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { createRef, type ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { resetClientState } from '@/lib/api'
import { createBlankDocument } from '@/lib/document'
import { server } from '@/test/msw'
import { makeDesign } from '@/test/factories'
import type { EditorHandle } from '@/types/adapter'
import { ToastProvider } from '@/ui'
import { useConflictResolution } from './useConflictResolution'

const reload = vi.fn()

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <MemoryRouter initialEntries={['/design/original']}>
        <Routes>
          <Route path="*" element={children} />
        </Routes>
        <Where />
      </MemoryRouter>
    </ToastProvider>
  )
}

function handle(): EditorHandle {
  const document = createBlankDocument(800, 600, { presetId: 'a4' })
  return { saveNow: async () => undefined, getDocument: () => document, isDirty: () => true }
}

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=test-token; path=/'
  reload.mockReset()
  vi.stubGlobal('location', { ...window.location, reload })
})

afterEach(() => vi.unstubAllGlobals())

describe('useConflictResolution', () => {
  it('"Reload latest" reloads the page without asking to confirm leaving', () => {
    const ref = createRef<EditorHandle>()
    const { result } = renderHook(() => useConflictResolution(ref, 'Poster'), { wrapper })
    const leave = new Event('beforeunload', { cancelable: true })
    result.current('reload')
    expect(reload).toHaveBeenCalledTimes(1)
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(false)
  })

  it('"save as copy" stores the canvas as a new design of the user and opens it', async () => {
    const bodies: Array<Record<string, unknown>> = []
    server.use(
      http.post('*/api/v1/designs/', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ ...makeDesign('copy-1', { title: 'Copy of Poster' }), document: createBlankDocument(800, 600) }, { status: 201 })
      }),
    )
    const ref = { current: handle() }
    const { result } = renderHook(() => useConflictResolution(ref, 'Poster'), { wrapper })
    result.current('save-as-copy')
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ title: 'Copy of Poster', preset: 'a4' })
    expect(bodies[0]).not.toHaveProperty('width')
    expect((bodies[0]?.document as { pages: unknown[] }).pages).toHaveLength(1)
  })

  it('says so when the copy could not be stored, and stays on the page', async () => {
    server.use(http.post('*/api/v1/designs/', () => HttpResponse.json({ error: { code: 'limit_reached', message: 'You have reached the limit.' } }, { status: 409 })))
    const ref = { current: handle() }
    const { result } = renderHook(() => useConflictResolution(ref, ''), { wrapper })
    result.current('save-as-copy')
    await waitFor(() => expect(document.body).toHaveTextContent('Couldn’t save a copy'))
    expect(document.body).toHaveTextContent('You have reached the limit.')
    expect(document.querySelector('[data-testid="where"]')?.textContent).toBe('/design/original')
  })
})
