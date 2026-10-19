import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { RouteErrorPage } from './RouteErrorPage'

function Broken(): never {
  throw new Error('Failed to fetch dynamically imported module: /assets/Dashboard.js')
}

describe('RouteErrorPage', () => {
  it('explains failed route chunks and offers a reload', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const router = createMemoryRouter([{ path: '/', element: <Broken />, errorElement: <RouteErrorPage /> }])
    render(<RouterProvider router={router} />)
    expect(screen.getByRole('alert')).toHaveTextContent('A part of Doory couldn’t be loaded')
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument()
    spy.mockRestore()
  })

  it('always offers a way back home', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const router = createMemoryRouter([{ path: '/', element: <Broken />, errorElement: <RouteErrorPage /> }])
    render(<RouterProvider router={router} />)
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/')
    spy.mockRestore()
  })
})
