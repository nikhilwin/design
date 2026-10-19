import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'
import { Menu, MenuItem, MenuSeparator } from './Menu'
import { Popover } from './Popover'
import { computePosition } from './position'

function Example({ onRename = vi.fn(), onDelete = vi.fn() }: { onRename?: () => void; onDelete?: () => void }) {
  return (
    <Menu trigger={<Button>Actions</Button>} label="Design actions">
      <MenuItem onSelect={onRename}>Rename</MenuItem>
      <MenuItem disabled>Duplicate</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={onDelete} danger>
        Delete
      </MenuItem>
    </Menu>
  )
}

describe('Menu', () => {
  it('opens from the trigger and focuses the first item', async () => {
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(trigger)
    expect(await screen.findByRole('menu', { name: 'Design actions' })).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus())
  })

  it('navigates with arrow keys skipping disabled items and wraps', async () => {
    render(<Example />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  })

  it('supports typeahead', async () => {
    render(<Example />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus())
    await userEvent.keyboard('d')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  })

  it('selects with Enter, closes, and returns focus to the trigger', async () => {
    const onDelete = vi.fn()
    render(<Example onDelete={onDelete} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    await userEvent.click(trigger)
    await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on Escape and does not select disabled items', async () => {
    const onRename = vi.fn()
    render(<Example onRename={onRename} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    await userEvent.click(trigger)
    await screen.findByRole('menu')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onRename).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
  })

  it('opens with ArrowDown on the trigger', async () => {
    render(<Example />)
    screen.getByRole('button', { name: 'Actions' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })
})

describe('Popover', () => {
  it('toggles, labels itself, and closes on outside press', async () => {
    render(
      <div>
        <Popover trigger={<Button>Colour</Button>} label="Pick a colour">
          <input aria-label="Hex" />
        </Popover>
        <p>outside</p>
      </div>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Colour' }))
    expect(await screen.findByRole('dialog', { name: 'Pick a colour' })).toBeInTheDocument()
    await userEvent.click(screen.getByText('outside'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('computePosition', () => {
  const viewport = { width: 800, height: 600 }
  const rect = (top: number, left: number, w = 100, h = 40) => ({ top, left, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect

  it('places below the anchor when there is room', () => {
    const pos = computePosition(rect(100, 100), { width: 200, height: 120 }, 'bottom-start', viewport)
    expect(pos.top).toBe(146)
    expect(pos.left).toBe(100)
  })

  it('flips above when there is no room below', () => {
    const pos = computePosition(rect(540, 100), { width: 200, height: 120 }, 'bottom-start', viewport)
    expect(pos.placement.startsWith('top')).toBe(true)
    expect(pos.top).toBeLessThan(540)
  })

  it('clamps horizontally to the viewport', () => {
    const pos = computePosition(rect(100, 760, 30), { width: 200, height: 50 }, 'bottom-start', viewport)
    expect(pos.left + 200).toBeLessThanOrEqual(800)
  })
})
