import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Input } from './Input'
import { Select } from './Select'
import { Textarea } from './Textarea'

describe('Input', () => {
  it('associates the label and wires hint + error to aria-describedby', () => {
    render(<Input label="Email" hint="We never share it" error="Enter a valid email" />)
    const input = screen.getByLabelText('Email')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const described = input.getAttribute('aria-describedby') ?? ''
    expect(described.split(' ')).toHaveLength(2)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email')
    expect(document.getElementById(described.split(' ')[1])).toHaveTextContent('We never share it')
  })

  it('marks required fields and forwards typing', async () => {
    const onChange = vi.fn()
    render(<Input label="Name" required onChange={onChange} />)
    const input = screen.getByLabelText(/Name/)
    expect(input).toBeRequired()
    await userEvent.type(input, 'Ada')
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('does not set aria-invalid without an error', () => {
    render(<Input label="City" />)
    expect(screen.getByLabelText('City')).not.toHaveAttribute('aria-invalid')
  })
})

describe('Textarea and Select', () => {
  it('Textarea carries its label and error state', () => {
    render(<Textarea label="Notes" error="Too long" />)
    expect(screen.getByLabelText('Notes')).toHaveAttribute('aria-invalid', 'true')
  })

  it('Select lists options and reports the chosen value', async () => {
    const onChange = vi.fn()
    render(
      <Select
        label="Sort"
        defaultValue="a"
        options={[
          { value: 'a', label: 'Newest' },
          { value: 'b', label: 'Oldest' },
        ]}
        onChange={(event) => onChange(event.target.value)}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'Oldest')
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
