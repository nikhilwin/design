import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { renderApp } from '@/test/app'
import { makeDesign, makeTemplate, makeUser, page } from '@/test/factories'

describe('home template rows', () => {
  it('ask for the first templates of the catalogue, not only the featured ones, so a small site still fills the row', async () => {
    const queries: string[] = []
    renderApp('/dashboard', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/templates/', ({ request }) => {
          queries.push(new URL(request.url).search)
          return HttpResponse.json(page([makeTemplate('plain-two', { title: 'Plain two' })]))
        }),
      ],
    })
    expect(await screen.findByRole('link', { name: /Plain two/ })).toBeInTheDocument()
    expect(queries[0]).not.toContain('featured')
  })
})

describe('new folder dialog', () => {
  it('starts empty every time it opens', async () => {
    renderApp('/dashboard/designs', {
      user: makeUser(),
      handlers: [
        http.get('*/api/v1/designs/', () => HttpResponse.json(page([makeDesign('d1', { title: 'One' })]))),
        http.post('*/api/v1/folders/', () => HttpResponse.json({ id: 'f1', name: 'Clients', parent: null, design_count: 0, created_at: '2025-01-01T00:00:00Z' }, { status: 201 })),
      ],
    })
    await userEvent.click(await screen.findByRole('button', { name: 'New folder' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder name' }), 'Clients')
    await userEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }))
    expect(await screen.findByRole('textbox', { name: 'Folder name' })).toHaveValue('')
  })
})

describe('the dashboard search field', () => {
  it('has a placeholder short enough for a phone', async () => {
    renderApp('/dashboard', { user: makeUser() })
    expect((await screen.findByRole('searchbox', { name: 'Search your designs' })).getAttribute('placeholder')?.length).toBeLessThanOrEqual(15)
  })
})
