import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GuestBanner, type GuestBannerProps } from './GuestBanner'

function setup(props: Partial<GuestBannerProps> = {}) {
  const onSave = vi.fn()
  render(<GuestBanner signedIn={false} memoryOnly={false} onSave={onSave} {...props} />)
  return { onSave }
}

describe('GuestBanner', () => {
  it('offers Sign up as a secondary button, so it never competes with the editor’s primary Share', async () => {
    const { onSave } = setup()
    const button = screen.getByRole('button', { name: 'Sign up' })
    expect(button).toHaveAttribute('data-variant', 'secondary')
    await userEvent.click(button)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a signed-in guest', { signedIn: true }, 'Save to account'],
    ['storage blocked by the browser', { memoryOnly: true }, 'Sign up'],
  ])('keeps the action secondary for %s', (_label, props, name) => {
    setup(props)
    expect(screen.getByRole('button', { name })).toHaveAttribute('data-variant', 'secondary')
  })

  it('leaves the save state to the editor’s own indicator: only the button, no second “saved” message', () => {
    setup()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/keep it forever/i)).not.toBeInTheDocument()
  })

  it('warns when the browser keeps nothing', () => {
    setup({ memoryOnly: true })
    expect(screen.getByRole('status')).toHaveTextContent('Won’t be kept')
  })

  it('shows the busy state without a second click going through', async () => {
    const { onSave } = setup({ busy: true })
    const button = screen.getByRole('button', { name: 'Sign up' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button)
    expect(onSave).not.toHaveBeenCalled()
  })
})
