import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { createBlankDocument } from '@/lib/document'
import type { AiService } from '@/types/adapter'
import type { AiOption } from '@/types/api'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { registerBackgroundRemover, type BgRemovalPhase } from '../engine/bgRemoval'
import { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { BackgroundRemovalDialog } from './BackgroundRemovalDialog'

const DEVICE: AiOption = { id: 'device', label: 'On this device', task: 'background-removal', kind: 'device', provider_name: '', owner: 'device', sends_offsite: false }
const FAST: AiOption = { id: 'env-1:fast', label: 'Fast (server)', task: 'background-removal', kind: 'server', provider_name: 'Model server', owner: 'operator', sends_offsite: false }
const BEST: AiOption = { id: 'env-1:best', label: 'Best (server)', task: 'background-removal', kind: 'server', provider_name: 'Model server', owner: 'operator', sends_offsite: false }
const EXTERNAL: AiOption = { id: 'p1:', label: 'External API', task: 'background-removal', kind: 'server', provider_name: 'Provider Y', owner: 'user', sends_offsite: true }

type Run = (onProgress: ((phase: BgRemovalPhase, percent: number) => void) | undefined, signal: AbortSignal | undefined, option: string | undefined) => Promise<boolean>

function fakeAi(models: AiOption[], { remembered = null, defaultId = null, notice = '' }: { remembered?: string | null; defaultId?: string | null; notice?: string } = {}) {
  const ai: AiService & { remember: ReturnType<typeof vi.fn> } = {
    options: vi.fn(async () => ({ default: defaultId, models })),
    run: vi.fn(),
    remembered: vi.fn(() => remembered),
    remember: vi.fn<(task: string, option: string) => void>(),
    offsiteNotice: notice,
  }
  return ai
}

function setup(ai: AiService | null, run: Run = () => new Promise<boolean>(() => undefined)) {
  const handle = createMemoryAdapter()
  handle.adapter.services.ai = ai
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'account' }, ephemeral: true })
  const removeBackground = vi.spyOn(engine.style, 'removeBackground').mockImplementation(run)
  const closeDialog = vi.spyOn(engine, 'closeDialog').mockImplementation(() => undefined)
  const toast = vi.spyOn(engine, 'toast').mockImplementation(() => undefined)
  render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <BackgroundRemovalDialog />
    </EditorProvider>,
  )
  return { engine, removeBackground, closeDialog, toast }
}

const optionUsed = (spy: ReturnType<typeof setup>['removeBackground'], call = 0): unknown => spy.mock.calls[call]?.[2]

describe('BackgroundRemovalDialog: options', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => {
    engine = null
    registerBackgroundRemover({ remove: async (image) => image })
  })
  afterEach(() => {
    engine?.dispose()
    registerBackgroundRemover(null)
  })

  it('offers every option with the remembered one picked, runs the chosen one and remembers it', async () => {
    const ai = fakeAi([DEVICE, FAST, BEST], { remembered: 'env-1:best', defaultId: 'device' })
    const ctx = setup(ai)
    engine = ctx.engine
    const group = await screen.findByRole('radiogroup', { name: t.bgRemoval.choose })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((radio) => radio.closest('label')?.querySelector('strong')?.textContent)).toEqual([t.bgRemoval.device, 'Fast (server)', 'Best (server)'])
    expect(within(group).getByRole('radio', { name: /Best \(server\)/ })).toBeChecked()
    expect(ctx.removeBackground).not.toHaveBeenCalled()

    await userEvent.click(within(group).getByRole('radio', { name: /Fast \(server\)/ }))
    await userEvent.click(screen.getByRole('button', { name: t.bgRemoval.start }))
    expect(optionUsed(ctx.removeBackground)).toBe('env-1:fast')
    expect(ai.remember).toHaveBeenCalledWith('background-removal', 'env-1:fast')
    expect(screen.getByRole('status')).toHaveTextContent(t.bgRemoval.serverProcessing)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })

  it("starts with the server's default when nothing is remembered, and with the first option when the default is gone", async () => {
    const ctx = setup(fakeAi([DEVICE, FAST, BEST], { defaultId: 'env-1:fast' }))
    engine = ctx.engine
    expect(await screen.findByRole('radio', { name: /Fast \(server\)/ })).toBeChecked()
    cleanup()
    ctx.engine.dispose()

    const again = setup(fakeAi([DEVICE, BEST], { remembered: 'p-deleted:', defaultId: 'env-9:gone' }))
    engine = again.engine
    expect(await screen.findByRole('radio', { name: new RegExp(t.bgRemoval.device) })).toBeChecked()
  })

  it('runs a single option that keeps the image here at once, without a picker', async () => {
    registerBackgroundRemover(null) // no in-browser model: the server option is the only one
    const ctx = setup(fakeAi([DEVICE, BEST]))
    engine = ctx.engine
    await waitFor(() => expect(ctx.removeBackground).toHaveBeenCalledTimes(1))
    expect(optionUsed(ctx.removeBackground)).toBe('env-1:best')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('shows the privacy notice for an option that sends the image away, in the operator’s words when set', async () => {
    const ctx = setup(fakeAi([DEVICE, EXTERNAL], { notice: 'Images go to our partner in the EU.' }))
    engine = ctx.engine
    await screen.findByRole('radiogroup')
    expect(screen.queryByTestId('bg-removal-offsite')).toBeNull() // the device option is picked first
    expect(screen.getByText('Your server: Provider Y')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /External API/ }))
    expect(screen.getByTestId('bg-removal-offsite')).toHaveTextContent('Images go to our partner in the EU.')
    await userEvent.click(screen.getByRole('button', { name: t.bgRemoval.start }))
    expect(screen.getByTestId('bg-removal-offsite')).toBeInTheDocument() // still said while it runs
  })

  it('asks before sending the image away even when that is the only option, with the default wording', async () => {
    registerBackgroundRemover(null)
    const ctx = setup(fakeAi([EXTERNAL]))
    engine = ctx.engine
    expect(await screen.findByTestId('bg-removal-offsite')).toHaveTextContent(t.bgRemoval.offsite)
    expect(ctx.removeBackground).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: t.bgRemoval.start }))
    expect(optionUsed(ctx.removeBackground)).toBe('p1:')
    expect(ctx.engine.adapter.services.ai?.remember).not.toHaveBeenCalled() // nothing was chosen
  })

  it('lists no in-browser option when this browser has no model, and says so when nothing is left', async () => {
    registerBackgroundRemover(null)
    const ctx = setup(fakeAi([DEVICE]))
    engine = ctx.engine
    expect(await screen.findByRole('alert')).toHaveTextContent(t.bgRemoval.unavailable)
    expect(ctx.removeBackground).not.toHaveBeenCalled()
  })

  it('says what went wrong on the server and offers to retry on this device', async () => {
    const run = vi.fn<Run>().mockRejectedValueOnce(new ApiError({ status: 429, code: 'ai_quota', message: 'used up', retryAfter: 7200 })).mockReturnValue(new Promise<boolean>(() => undefined))
    const ctx = setup(fakeAi([DEVICE, BEST], { remembered: 'env-1:best' }), run)
    engine = ctx.engine
    await userEvent.click(await screen.findByRole('button', { name: t.bgRemoval.start }))
    expect(await screen.findByRole('alert')).toHaveTextContent(t.bgRemoval.errors.quota('in 2 hours'))
    expect(screen.queryByRole('button', { name: t.panels.retry })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: t.bgRemoval.retryOnDevice }))
    expect(optionUsed(run, 1)).toBe('device')
    expect(screen.getByRole('status')).toHaveTextContent(t.errors.bgRemovalDownloading)
  })

  it('goes back to the options after a server failure', async () => {
    const run = vi.fn<Run>().mockRejectedValueOnce(new ApiError({ status: 504, code: 'ai_timeout', message: 'slow' })).mockReturnValue(new Promise<boolean>(() => undefined))
    const ctx = setup(fakeAi([DEVICE, FAST, BEST], { remembered: 'env-1:best' }), run)
    engine = ctx.engine
    await userEvent.click(await screen.findByRole('button', { name: t.bgRemoval.start }))
    expect(await screen.findByRole('alert')).toHaveTextContent(t.bgRemoval.errors.timeout)
    await userEvent.click(screen.getByRole('button', { name: t.bgRemoval.otherOption }))
    await userEvent.click(screen.getByRole('radio', { name: /Fast \(server\)/ }))
    await userEvent.click(screen.getByRole('button', { name: t.bgRemoval.start }))
    expect(optionUsed(run, 1)).toBe('env-1:fast')
  })

  it('offers Try again on the same server when there is no in-browser model', async () => {
    registerBackgroundRemover(null)
    const run = vi.fn<Run>().mockRejectedValueOnce(new ApiError({ status: 503, code: 'ai_busy', message: 'busy' })).mockReturnValue(new Promise<boolean>(() => undefined))
    const ctx = setup(fakeAi([BEST]), run)
    engine = ctx.engine
    expect(await screen.findByRole('alert')).toHaveTextContent(t.bgRemoval.errors.busy)
    expect(screen.queryByRole('button', { name: t.bgRemoval.retryOnDevice })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: t.panels.retry }))
    expect(optionUsed(run, 1)).toBe('env-1:best')
  })

  it('closes with a toast when the server result is applied', async () => {
    const ctx = setup(fakeAi([DEVICE, BEST], { remembered: 'env-1:best' }), async () => true)
    engine = ctx.engine
    await userEvent.click(await screen.findByRole('button', { name: t.bgRemoval.start }))
    await waitFor(() => expect(ctx.closeDialog).toHaveBeenCalledTimes(1))
    expect(ctx.toast).toHaveBeenCalledWith(t.errors.bgRemovalDone, 'success')
  })

  it('does not start background removal if cancelled while options are loading', async () => {
    let resolveOptions!: (val: { default: string | null; models: AiOption[] }) => void
    const optionsPromise = new Promise<{ default: string | null; models: AiOption[] }>((resolve) => {
      resolveOptions = resolve
    })
    const ai: AiService & { remember: ReturnType<typeof vi.fn> } = {
      options: vi.fn(() => optionsPromise),
      run: vi.fn(),
      remembered: vi.fn(() => null),
      remember: vi.fn<(task: string, option: string) => void>(),
      offsiteNotice: '',
    }
    const run = vi.fn<Run>().mockResolvedValue(true)
    const ctx = setup(ai, run)
    engine = ctx.engine

    const closeBtn = screen.getByRole('button', { name: t.dialog.close })
    await userEvent.click(closeBtn)
    expect(ctx.closeDialog).toHaveBeenCalledTimes(1)

    resolveOptions({ default: null, models: [BEST] })
    await new Promise((r) => setTimeout(r, 50))

    expect(run).not.toHaveBeenCalled()
    expect(ctx.closeDialog).toHaveBeenCalledTimes(1)
  })
})
