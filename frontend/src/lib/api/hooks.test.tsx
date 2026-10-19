import { QueryClientProvider, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http as mswHttp, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { createTestQueryClient } from '@/test/utils'
import { server } from '@/test/msw'
import type { DesignSummary, Page } from '@/types/api'
import { resetClientState } from './client'
import { flattenPages, useBulkDesigns, useTrashDesign, useUpdateDesign } from './hooks'
import { qk } from './keys'

function design(id: string, overrides: Partial<DesignSummary> = {}): DesignSummary {
  return {
    id,
    title: `Design ${id}`,
    width: 100,
    height: 100,
    preset: '',
    page_count: 1,
    thumbnail_url: null,
    folder: null,
    starred: false,
    revision: 1,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    trashed_at: null,
    ...overrides,
  }
}

function setup() {
  const client = createTestQueryClient()
  const query = { ordering: '-updated_at' as const }
  const data: InfiniteData<Page<DesignSummary>, number> = {
    pageParams: [1],
    pages: [{ count: 2, next: null, previous: null, results: [design('a'), design('b')] }],
  }
  client.setQueryData(qk.designs.list(query), data)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const read = () => flattenPages(client.getQueryData<InfiniteData<Page<DesignSummary>, number>>(qk.designs.list(query)))
  return { client, wrapper, read }
}

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=tok; path=/'
})

describe('design list mutations', () => {
  it('optimistically stars a design and keeps it when the server agrees', async () => {
    const { wrapper, read } = setup()
    server.use(
      mswHttp.patch('*/api/v1/designs/a/', () => HttpResponse.json({ id: 'a' })),
      mswHttp.get('*/api/v1/designs/', () => HttpResponse.json({ count: 2, next: null, previous: null, results: [design('a', { starred: true }), design('b')] })),
    )
    const { result } = renderHook(() => useUpdateDesign(), { wrapper })
    act(() => result.current.mutate({ id: 'a', patch: { starred: true } }))
    await waitFor(() => expect(read()[0].starred).toBe(true))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(read()[0].starred).toBe(true)
  })

  it('rolls back a failed rename', async () => {
    const { wrapper, read } = setup()
    server.use(
      mswHttp.patch('*/api/v1/designs/a/', () => HttpResponse.json({ error: { code: 'validation_error', message: 'bad' } }, { status: 400 })),
      mswHttp.get('*/api/v1/designs/', () => HttpResponse.json({ count: 2, next: null, previous: null, results: [design('a'), design('b')] })),
    )
    const { result } = renderHook(() => useUpdateDesign(), { wrapper })
    act(() => result.current.mutate({ id: 'a', patch: { title: 'New name' } }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(read()[0].title).toBe('Design a')
  })

  it('removes a trashed design from cached lists immediately and adjusts the count', async () => {
    const { wrapper, client } = setup()
    server.use(
      mswHttp.delete('*/api/v1/designs/a/', () => new HttpResponse(null, { status: 204 })),
      mswHttp.get('*/api/v1/designs/', () => HttpResponse.json({ count: 1, next: null, previous: null, results: [design('b')] })),
    )
    const { result } = renderHook(() => useTrashDesign(), { wrapper })
    act(() => result.current.mutate('a'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const data = client.getQueryData<InfiniteData<Page<DesignSummary>, number>>(qk.designs.list({ ordering: '-updated_at' }))
    expect(flattenPages(data).map((d) => d.id)).toEqual(['b'])
  })

  it('applies bulk star/move optimistically', async () => {
    const { wrapper, read } = setup()
    server.use(
      mswHttp.post('*/api/v1/designs/bulk/', () => HttpResponse.json({ affected: 2 })),
      mswHttp.get('*/api/v1/designs/', () => HttpResponse.json({ count: 2, next: null, previous: null, results: [design('a', { folder: 'f1' }), design('b', { folder: 'f1' })] })),
      mswHttp.get('*/api/v1/folders/', () => HttpResponse.json([])),
    )
    const { result } = renderHook(() => useBulkDesigns(), { wrapper })
    act(() => result.current.mutate({ ids: ['a', 'b'], action: 'move', folder: 'f1' }))
    await waitFor(() => expect(read().every((d) => d.folder === 'f1')).toBe(true))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('exposes the query client to nested hooks (sanity)', () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useQueryClient(), { wrapper })
    expect(result.current).toBeDefined()
  })
})
