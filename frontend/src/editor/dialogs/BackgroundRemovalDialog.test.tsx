import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorProvider } from '../EditorProvider'
import { BackgroundRemovalError, type BgRemovalPhase } from '../engine/bgRemoval'
import { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { BackgroundRemovalDialog } from './BackgroundRemovalDialog'

type Run = (onProgress: ((phase: BgRemovalPhase, percent: number) => void) | undefined, signal: AbortSignal | undefined) => Promise<boolean>

function setup(run: Run) {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
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

describe('BackgroundRemovalDialog', () => {
  let engine: EditorEngine | null = null
  beforeEach(() => {
    engine = null
  })
  afterEach(() => engine?.dispose())

  it('cancels the run it started: the signal handed to the engine aborts and the dialog closes without a toast', async () => {
    let signal: AbortSignal | undefined
    const ctx = setup((_progress, s) => {
      signal = s
      return new Promise<boolean>(() => undefined)
    })
    engine = ctx.engine
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(signal?.aborted).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: t.dialog.cancel }))

    expect(signal?.aborted).toBe(true)
    expect(ctx.closeDialog).toHaveBeenCalledTimes(1)
    expect(ctx.toast).not.toHaveBeenCalled()
  })

  it('ignores the answer of a cancelled run: no second close, no toast, no error message', async () => {
    let finish: (applied: boolean) => void = () => undefined
    const ctx = setup(() => new Promise<boolean>((resolve) => (finish = resolve)))
    engine = ctx.engine
    await userEvent.click(screen.getByRole('button', { name: t.dialog.cancel }))
    finish(true)
    await Promise.resolve()
    expect(ctx.closeDialog).toHaveBeenCalledTimes(1)
    expect(ctx.toast).not.toHaveBeenCalled()
  })

  it('shows the phase and the percentage while it runs and closes with a toast when the cut-out is applied', async () => {
    let finish: (applied: boolean) => void = () => undefined
    const ctx = setup((onProgress) => {
      onProgress?.('processing', 60)
      return new Promise<boolean>((resolve) => (finish = resolve))
    })
    engine = ctx.engine
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60'))
    expect(screen.getByRole('status')).toHaveTextContent(t.errors.bgRemovalProcessing)
    finish(true)
    await waitFor(() => expect(ctx.closeDialog).toHaveBeenCalledTimes(1))
    expect(ctx.toast).toHaveBeenCalledWith(t.errors.bgRemovalDone, 'success')
  })

  it('says so when the model found no subject, and does not offer a retry that would find the same nothing', async () => {
    const ctx = setup(() => Promise.reject(new BackgroundRemovalError('empty', 'no-subject')))
    engine = ctx.engine
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(t.errors.bgRemovalNoSubject)
    expect(alert).toHaveTextContent(/couldn.t find a subject to cut out/i)
    expect(alert).not.toHaveTextContent(/not available/i)
    expect(screen.queryByRole('button', { name: t.panels.retry })).toBeNull()
    await userEvent.click(screen.getAllByRole('button', { name: t.dialog.close })[0])
    expect(ctx.closeDialog).toHaveBeenCalledTimes(1)
  })

  it('tells a policy block apart from an engine that is not available', async () => {
    const run = vi.fn<Run>().mockRejectedValueOnce(new BackgroundRemovalError('csp', 'blocked')).mockRejectedValue(new Error('network'))
    const ctx = setup(run)
    engine = ctx.engine
    expect(await screen.findByRole('alert')).toHaveTextContent(t.errors.bgRemovalBlocked)
    await userEvent.click(screen.getByRole('button', { name: t.panels.retry }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t.errors.bgRemoval))
  })

  it('offers Retry after a failure and starts a fresh run', async () => {
    const run = vi.fn<Run>().mockRejectedValueOnce(new BackgroundRemovalError('offline')).mockReturnValue(new Promise<boolean>(() => undefined))
    const ctx = setup(run)
    engine = ctx.engine
    expect(await screen.findByRole('alert')).toHaveTextContent(t.errors.bgRemoval)
    await userEvent.click(screen.getByRole('button', { name: t.panels.retry }))
    expect(run).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })
})
