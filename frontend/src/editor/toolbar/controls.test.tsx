import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
import { EMPTY_SELECTION } from '../store/editorStore'
import { LimitedNumber, RotateTool, Stepper } from './controls'
import { CORNER_RADIUS, FONT_SIZE, LETTER_SPACING, LINE_HEIGHT, STROKE_WIDTH, capLimit, type Limit } from './limits'

async function typeInto(input: HTMLElement, text: string): Promise<void> {
  await userEvent.clear(input)
  await userEvent.type(input, text)
}

describe('Stepper (font size, 8-200)', () => {
  function setup(value = 36) {
    const onChange = vi.fn()
    render(<Stepper label="Font size" value={value} limit={FONT_SIZE} testId="fs" onChange={onChange} />)
    return { onChange, input: screen.getByRole('spinbutton', { name: 'Font size' }) }
  }

  it('shows the range as its tooltip and in the input’s native bounds', () => {
    const { input } = setup()
    expect(input).toHaveAttribute('title', 'Between 8 and 200')
    expect(input).toHaveAttribute('min', '8')
    expect(input).toHaveAttribute('max', '200')
  })

  it('applies a value inside the range as it is typed', async () => {
    const { input, onChange } = setup()
    await typeInto(input, '48')
    expect(onChange).toHaveBeenLastCalledWith(48, 'typing')
  })

  it.each([
    ['500', 200],
    ['3', 8],
    ['0', 8],
    ['-20', 8],
  ])('clamps %s to %i when the field is left', async (typed, expected) => {
    const { input, onChange } = setup()
    await typeInto(input, typed)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await userEvent.tab()
    expect(onChange).toHaveBeenLastCalledWith(expected)
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('clamps on Enter as well, and ignores an empty field', async () => {
    const { input, onChange } = setup()
    await typeInto(input, '9999{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(200)
    onChange.mockClear()
    await userEvent.clear(input)
    await userEvent.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stops the − and + buttons at the ends and the arrow keys never leave the range', async () => {
    const low = setup(8)
    expect(screen.getByRole('button', { name: 'Decrease size' })).toBeDisabled()
    await userEvent.type(low.input, '{ArrowDown}')
    expect(low.onChange).toHaveBeenLastCalledWith(8, 'step')
  })

  it('stops + at the top', async () => {
    const { onChange } = setup(200)
    expect(screen.getByRole('button', { name: 'Increase size' })).toBeDisabled()
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Font size' }), '{Shift>}{ArrowUp}{/Shift}')
    expect(onChange).toHaveBeenLastCalledWith(200, 'step')
  })
})

/** Keeps the value the way the strip does: every applied value comes back as the `value` prop. */
function Harness({ label, limit, initial, onChange }: { label: string; limit: Limit; initial: number; onChange: (value: number) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <LimitedNumber
      label={label}
      value={value}
      limit={limit}
      testId="n"
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
    />
  )
}

const FIELDS = [
  { name: 'Line height', limit: LINE_HEIGHT, hint: 'Between 0.5 and 3', below: '0.2', above: '9', initial: 1.2 },
  { name: 'Letter spacing', limit: LETTER_SPACING, hint: 'Between -200 and 800', below: '-900', above: '5000', initial: 0 },
  { name: 'Stroke width', limit: STROKE_WIDTH, hint: 'Between 0 and 20', below: '-4', above: '99', initial: 4 },
  { name: 'Corner radius', limit: CORNER_RADIUS, hint: 'Between 0 and 100', below: '-1', above: '250', initial: 10 },
]

describe.each(FIELDS)('$name', ({ name, limit, hint, below, above, initial }) => {
  function setup() {
    const onChange = vi.fn()
    render(<Harness label={name} limit={limit} initial={initial} onChange={onChange} />)
    return { onChange, input: screen.getByRole('spinbutton', { name }) }
  }

  it('shows its range as the tooltip and as the native bounds', () => {
    const { input } = setup()
    expect(input).toHaveAttribute('title', hint)
    expect(input).toHaveAttribute('min', String(limit.min))
    expect(input).toHaveAttribute('max', String(limit.max))
    expect(screen.getByText(name)).toBeInTheDocument()
  })

  it.each([
    ['below', below, limit.min],
    ['above', above, limit.max],
  ])('never applies a value %s the range, and clamps it when the field is left', async (_where, typed, expected) => {
    const { input, onChange } = setup()
    await typeInto(input, typed)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onChange.mock.calls.flat()).not.toContain(Number(typed))
    await userEvent.tab()
    expect(onChange).toHaveBeenLastCalledWith(expected)
    expect(input).toHaveValue(expected)
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('clamps on Enter too', async () => {
    const { input, onChange } = setup()
    await typeInto(input, `${above}{Enter}`)
    expect(onChange).toHaveBeenLastCalledWith(limit.max)
  })

  it('puts the previous value back when an empty entry is abandoned', async () => {
    const { input, onChange } = setup()
    await userEvent.clear(input)
    await userEvent.tab()
    expect(input).toHaveValue(initial)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('drops an out-of-range draft on Escape and keeps the last value that was applied', async () => {
    const { input, onChange } = setup()
    await typeInto(input, above)
    await userEvent.keyboard('{Escape}')
    const lastApplied = onChange.mock.lastCall?.[0] ?? initial
    expect(input).toHaveValue(lastApplied)
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(onChange.mock.calls.flat()).not.toContain(limit.max)
  })
})

describe('LimitedNumber details', () => {
  it('applies a value inside the range while it is typed, so "0.8" is not turned into 0.5 on the way', async () => {
    const onChange = vi.fn()
    render(<Harness label="Line height" limit={LINE_HEIGHT} initial={1.2} onChange={onChange} />)
    await typeInto(screen.getByRole('spinbutton', { name: 'Line height' }), '0.8')
    expect(onChange).toHaveBeenLastCalledWith(0.8)
    expect(onChange.mock.calls.flat()).not.toContain(0.5)
  })

  it('rounds to the limit’s digits', async () => {
    const onChange = vi.fn()
    render(<Harness label="Line height" limit={LINE_HEIGHT} initial={1.2} onChange={onChange} />)
    await typeInto(screen.getByRole('spinbutton', { name: 'Line height' }), '1.26{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(1.3)
  })

  it('caps the radius at the shape’s own half side', async () => {
    const onChange = vi.fn()
    render(<Harness label="Corner radius" limit={capLimit(CORNER_RADIUS, 30)} initial={10} onChange={onChange} />)
    const input = screen.getByRole('spinbutton', { name: 'Corner radius' })
    expect(input).toHaveAttribute('title', 'Between 0 and 30')
    await typeInto(input, '80')
    await userEvent.tab()
    expect(onChange).toHaveBeenLastCalledWith(30)
  })
})

describe('RotateTool', () => {
  function mount(locked: boolean) {
    const handle = createMemoryAdapter()
    const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
    const select = (isLocked: boolean): void =>
      engine.store.setState({ selection: { ...EMPTY_SELECTION, pageId: engine.state.doc.pages[0].id, ids: ['o'], kinds: ['shape'], bounds: { x: 0, y: 0, width: 10, height: 10, angle: 30 }, locked: isLocked, version: 1 } })
    select(locked)
    const rotateBy = vi.spyOn(engine.arrange, 'rotateBy').mockImplementation(() => undefined)
    render(
      <EditorProvider engine={engine} portalRoot={document.body}>
        <RotateTool />
      </EditorProvider>,
    )
    return { engine, select, rotateBy }
  }

  it('opens a menu of turns for an unlocked selection', async () => {
    const { engine, rotateBy } = mount(false)
    await userEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Rotate right 90°/ }))
    expect(rotateBy).toHaveBeenCalledExactlyOnceWith(90)
    engine.dispose()
  })

  it('stays in place for a locked selection, disabled and explaining why, so the buttons beside it do not move', async () => {
    const { engine, rotateBy } = mount(true)
    const button = screen.getByRole('button', { name: 'Rotation locked' })
    expect(button).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull()
    await userEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(rotateBy).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('closes an open menu when the selection gets locked, and does not reopen it after the unlock', async () => {
    const { engine, select } = mount(false)
    await userEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    act(() => select(true))
    expect(screen.getByRole('button', { name: 'Rotation locked' })).toBeDisabled()
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => select(false))
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()
    engine.dispose()
  })
})
