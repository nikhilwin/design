import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Checkbox } from './Checkbox'
import { RadioGroup } from './RadioGroup'
import { SegmentedControl } from './SegmentedControl'
import { Slider } from './Slider'
import { Switch } from './Switch'

describe('Checkbox', () => {
  it('toggles and supports the indeterminate state', async () => {
    const onChange = vi.fn()
    render(<Checkbox label="Select all" indeterminate onChange={onChange} />)
    const box = screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement
    expect(box.indeterminate).toBe(true)
    await userEvent.click(box)
    expect(onChange).toHaveBeenCalled()
  })
})

describe('Switch', () => {
  it('exposes role=switch and flips with Space', async () => {
    render(<Switch label="Dark mode" />)
    const toggle = screen.getByRole('switch', { name: 'Dark mode' })
    expect(toggle).not.toBeChecked()
    toggle.focus()
    await userEvent.keyboard(' ')
    expect(toggle).toBeChecked()
  })
})

describe('RadioGroup', () => {
  it('groups radios under a legend and moves with arrow keys', async () => {
    const onChange = vi.fn()
    render(
      <RadioGroup
        legend="Share role"
        defaultValue="view"
        onChange={onChange}
        options={[
          { value: 'view', label: 'Can view' },
          { value: 'comment', label: 'Can comment' },
        ]}
      />,
    )
    expect(screen.getByRole('group', { name: 'Share role' })).toBeInTheDocument()
    screen.getByRole('radio', { name: 'Can view' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenCalledWith('comment')
    expect(screen.getByRole('radio', { name: 'Can comment' })).toBeChecked()
  })
})

describe('SegmentedControl', () => {
  it('behaves as a labelled radiogroup', async () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        label="Layout"
        defaultValue="grid"
        onChange={onChange}
        options={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List' },
        ]}
      />,
    )
    expect(screen.getByRole('radiogroup', { name: 'Layout' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'List' }))
    expect(onChange).toHaveBeenCalledWith('list')
  })
})

describe('Slider', () => {
  it('reports numeric changes and formats the readout', () => {
    function Harness() {
      const [value, setValue] = useState(50)
      return <Slider label="Opacity" value={value} onValueChange={setValue} format={(v) => `${v}%`} />
    }
    render(<Harness />)
    const slider = screen.getByRole('slider', { name: 'Opacity' })
    expect(slider).toHaveAttribute('aria-valuetext', '50%')
    fireEvent.change(slider, { target: { value: '60' } })
    expect(screen.getByRole('slider', { name: 'Opacity' })).toHaveAttribute('aria-valuetext', '60%')
  })
})
