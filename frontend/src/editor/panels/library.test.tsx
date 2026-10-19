import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Select } from '../ui/Select'
import { type CategoryEntry, CategoryMenu, LibrarySearch } from './library'

const ENTRIES: CategoryEntry[] = [
  { kind: 'option', id: 'all', label: 'All' },
  { kind: 'group', id: 'g', label: 'By type' },
  { kind: 'option', id: 'icons', label: 'Icons', count: 12 },
  { kind: 'option', id: 'frames', label: 'Frames' },
]

describe('CategoryMenu', () => {
  it('opens a list, marks the active entry, selects with a click and closes', async () => {
    const onSelect = vi.fn()
    render(<CategoryMenu name="Category" label="All" entries={ENTRIES} activeId="all" onSelect={onSelect} testId="cat" />)
    const button = screen.getByRole('button', { name: 'Category: All' })
    expect(screen.queryByRole('listbox')).toBeNull()
    await userEvent.click(button)
    const list = screen.getByRole('listbox', { name: 'Category' })
    expect(screen.getByRole('option', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('By type')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: /Icons/ }))
    expect(onSelect).toHaveBeenCalledWith('icons')
    expect(list).not.toBeInTheDocument()
  })

  it('moves with the arrow keys and Escape closes only the list', async () => {
    render(<CategoryMenu name="Category" label="All" entries={ENTRIES} activeId="all" onSelect={() => undefined} testId="cat" />)
    await userEvent.click(screen.getByRole('button', { name: 'Category: All' }))
    expect(screen.getByRole('option', { name: 'All' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /Icons/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getByRole('option', { name: 'Frames' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on a click outside', async () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <CategoryMenu name="Category" label="All" entries={ENTRIES} activeId="all" onSelect={() => undefined} testId="cat" />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Category: All' }))
    fireEvent.pointerDown(screen.getByText('elsewhere'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('LibrarySearch', () => {
  it('shows a clear button only while there is text and empties the field with it', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<LibrarySearch value="" onChange={onChange} placeholder="Search" clearLabel="Clear" testId="s" />)
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'a')
    expect(onChange).toHaveBeenCalledWith('a')
    rerender(<LibrarySearch value="sun" onChange={onChange} placeholder="Search" clearLabel="Clear" testId="s" />)
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith('')
  })
})

describe('Select', () => {
  it('is a labelled native select', async () => {
    const onChange = vi.fn()
    render(
      <Select aria-label="Access" value="view" onChange={(e) => onChange(e.target.value)}>
        <option value="view">Can view</option>
        <option value="edit">Can edit</option>
      </Select>,
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Access' }), 'edit')
    expect(onChange).toHaveBeenCalledWith('edit')
  })
})
