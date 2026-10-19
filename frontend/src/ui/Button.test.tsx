import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Button, LinkButton } from './Button'
import { IconButton } from './IconButton'

describe('Button', () => {
  it('renders variant and size as data attributes and defaults to type=button', () => {
    render(
      <Button variant="danger" size="lg">
        Delete
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Delete' })
    expect(button).toHaveAttribute('data-variant', 'danger')
    expect(button).toHaveAttribute('data-size', 'lg')
    expect(button).toHaveAttribute('type', 'button')
  })

  it('does not fire onClick while loading and exposes aria-busy', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('does not fire onClick when disabled', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Nope' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('LinkButton renders a link', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/create">Start</LinkButton>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Start' })).toHaveAttribute('href', '/create')
  })
})

describe('IconButton', () => {
  it('uses the label as its accessible name and reports pressed state', async () => {
    const onClick = vi.fn()
    render(<IconButton label="Star design" icon={<svg />} pressed onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Star design' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
