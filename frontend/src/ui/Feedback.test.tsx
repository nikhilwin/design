import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Avatar } from './Avatar'
import { initialsOf } from './initials'
import { Badge } from './Badge'
import { Card } from './Card'
import { EmptyState } from './EmptyState'
import { Kbd } from './Kbd'
import { Logo } from './Logo'
import { Skeleton } from './Skeleton'
import { Spinner } from './Spinner'
import { ToastProvider, useToast } from './ToastProvider'
import { Tooltip } from './Tooltip'
import { VisuallyHidden } from './VisuallyHidden'

function ToastTrigger({ options }: { options: Parameters<ReturnType<typeof useToast>['toast']>[0] }) {
  const { toast } = useToast()
  return <button onClick={() => toast(options)}>fire</button>
}

describe('Toast', () => {
  it('announces a toast and dismisses it manually', async () => {
    render(
      <ToastProvider>
        <ToastTrigger options={{ title: 'Saved', variant: 'success' }} />
      </ToastProvider>,
    )
    await userEvent.click(screen.getByText('fire'))
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('uses an assertive alert for errors and auto-dismisses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(
        <ToastProvider>
          <ToastTrigger options={{ title: 'Upload failed', variant: 'error', duration: 1000 }} />
        </ToastProvider>,
      )
      await userEvent.click(screen.getByText('fire'))
      expect(screen.getByRole('alert')).toHaveTextContent('Upload failed')
      act(() => {
        vi.advanceTimersByTime(1200)
      })
      expect(screen.queryByText('Upload failed')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the action (undo) and closes', async () => {
    const onUndo = vi.fn()
    render(
      <ToastProvider>
        <ToastTrigger options={{ title: 'Moved to trash', action: { label: 'Undo', onClick: onUndo } }} />
      </ToastProvider>,
    )
    await userEvent.click(screen.getByText('fire'))
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Moved to trash')).not.toBeInTheDocument()
  })
})

describe('Tooltip', () => {
  it('shows on focus, describes the trigger, and hides on Escape', async () => {
    render(
      <Tooltip content="Duplicate">
        <button>Dup</button>
      </Tooltip>,
    )
    await userEvent.tab()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Duplicate')
    expect(screen.getByRole('button', { name: 'Dup' })).toHaveAccessibleDescription('Duplicate')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('Display primitives', () => {
  it('Avatar derives initials and falls back when the image fails', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL')
    expect(initialsOf('  grace ')).toBe('G')
    expect(initialsOf('')).toBe('?')
    render(<Avatar name="Ada Lovelace" src="/broken.png" />)
    const img = document.querySelector('img')
    expect(img).not.toBeNull()
    act(() => {
      img?.dispatchEvent(new Event('error'))
    })
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL')
  })

  it('Skeleton is hidden from assistive tech; Spinner can be labelled', () => {
    const { container } = render(<Skeleton width={40} height={10} />)
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true')
    render(<Spinner label="Loading designs" />)
    expect(screen.getByRole('status', { name: 'Loading designs' })).toBeInTheDocument()
  })

  it('EmptyState renders title, description and action', () => {
    render(<EmptyState title="No designs yet" description="Create your first one." action={<button>Create</button>} />)
    expect(screen.getByRole('heading', { name: 'No designs yet' })).toBeInTheDocument()
    expect(screen.getByText('Create your first one.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('Badge, Card, Kbd, VisuallyHidden and Logo render accessible content', () => {
    render(
      <div>
        <Badge tone="brand">New</Badge>
        <Card data-testid="card" interactive>
          Body
        </Card>
        <Kbd>Ctrl</Kbd>
        <VisuallyHidden>Hidden text</VisuallyHidden>
        <Logo />
      </div>,
    )
    expect(screen.getByText('New')).toHaveAttribute('data-tone', 'brand')
    expect(screen.getByTestId('card')).toHaveAttribute('data-interactive', 'true')
    expect(screen.getByText('Ctrl').tagName).toBe('KBD')
    expect(screen.getByText('Hidden text')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Doory' })).toBeInTheDocument()
  })
})
