import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadable } from './loadable'

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>
}

describe('loadable', () => {
  afterEach(() => vi.restoreAllMocks())

  /** React reports the error its boundary caught; the tests that fail a download on purpose keep the log quiet. */
  const quiet = (): void => void vi.spyOn(console, 'error').mockImplementation(() => undefined)

  it('shows the fallback while the code downloads, then the component with its props', async () => {
    let arrive: (c: typeof Hello) => void = () => undefined
    const Lazy = loadable(() => new Promise<typeof Hello>((resolve) => (arrive = resolve)), { fallback: <p>on its way</p> })
    render(<Lazy name="Ana" />)
    expect(screen.getByText('on its way')).toBeInTheDocument()
    arrive(Hello)
    expect(await screen.findByText('Hello Ana')).toBeInTheDocument()
    expect(screen.queryByText('on its way')).toBeNull()
  })

  it('hands the props of the render to a fallback function', () => {
    const Lazy = loadable<{ name: string }>(() => new Promise<typeof Hello>(() => undefined), { fallback: (props) => <p>waiting for {props.name}</p> })
    render(<Lazy name="Eli" />)
    expect(screen.getByText('waiting for Eli')).toBeInTheDocument()
  })

  it('announces the default placeholder as busy', () => {
    const Lazy = loadable(() => new Promise<typeof Hello>(() => undefined))
    render(<Lazy name="Ana" />)
    expect(screen.getByRole('status', { name: 'Loading…' })).toHaveAttribute('aria-busy', 'true')
  })

  it('starts the download once on preload and reuses it when rendered', async () => {
    const load = vi.fn(() => Promise.resolve(Hello))
    const Lazy = loadable(load)
    Lazy.preload()
    Lazy.preload()
    expect(load).toHaveBeenCalledTimes(1)
    render(<Lazy name="Bo" />)
    expect(await screen.findByText('Hello Bo')).toBeInTheDocument()
  })

  it('says so when the download fails and tries again on request', async () => {
    quiet()
    const load = vi.fn<() => Promise<typeof Hello>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Hello)
    const Lazy = loadable(load)
    render(<Lazy name="Cy" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Hello Cy')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('lets the caller replace the failure message', async () => {
    quiet()
    const Lazy = loadable<{ name: string }>(() => Promise.reject(new Error('offline')), { failed: () => <b>glyph</b> })
    render(<Lazy name="Di" />)
    expect(await screen.findByText('glyph')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('settles the preload promise when the download has, whether it worked or not', async () => {
    const load = vi.fn<() => Promise<typeof Hello>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Hello)
    const Lazy = loadable(load)
    await expect(Lazy.preload()).resolves.toBeUndefined()
    await expect(Lazy.preload()).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a failed preload does not break a later render', async () => {
    const load = vi.fn<() => Promise<typeof Hello>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Hello)
    const Lazy = loadable(load)
    Lazy.preload()
    await Promise.resolve()
    await Promise.resolve()
    Lazy.preload()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
