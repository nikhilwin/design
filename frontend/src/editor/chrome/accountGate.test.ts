import { describe, expect, it, vi } from 'vitest'
import type { EditorMode } from '@/types/adapter'
import type { EditorEngine } from '../engine/editor'
import { ensureAccount, openAccountDialog, whenAvailable } from './accountGate'

function fakeEditor(mode: EditorMode, requireAccount: (reason: string, snapshot: () => Promise<unknown>) => Promise<boolean>, services: Record<string, unknown> = {}) {
  const openDialog = vi.fn()
  const toast = vi.fn()
  const editor = {
    state: { mode, title: 'My design' },
    readOnly: false,
    adapter: { requireAccount, services },
    getDocument: () => ({ pages: [] }),
    openDialog,
    toast,
  } as unknown as EditorEngine
  return { editor, openDialog, toast }
}

describe('ensureAccount', () => {
  it('lets signed-in modes through without asking the shell', async () => {
    const ask = vi.fn(async () => true)
    expect(await ensureAccount(fakeEditor('account', ask).editor, 'share')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks the shell on behalf of a guest and hands over the freshest document', async () => {
    let snapshot: (() => Promise<unknown>) | undefined
    const ask = vi.fn(async (_reason: string, getSnapshot: () => Promise<unknown>) => {
      snapshot = getSnapshot
      return true
    })
    expect(await ensureAccount(fakeEditor('guest', ask).editor, 'brand-kit')).toBe(true)
    expect(ask).toHaveBeenCalledWith('brand-kit', expect.any(Function))
    expect(await snapshot?.()).toEqual({ document: { pages: [] }, title: 'My design' })
  })

  it('treats a refused or failed sign-up as "no"', async () => {
    expect(await ensureAccount(fakeEditor('guest', async () => false).editor, 'share')).toBe(false)
    expect(await ensureAccount(fakeEditor('guest', async () => Promise.reject(new Error('closed'))).editor, 'share')).toBe(false)
  })
})

describe('whenAvailable', () => {
  it('resolves true as soon as the service exists and false when it never does', async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 60)
    const { editor } = fakeEditor('account', async () => true)
    expect(await whenAvailable(editor, () => ready, 1000)).toBe(true)
    expect(await whenAvailable(editor, () => false, 120)).toBe(false)
  })
})

describe('openAccountDialog', () => {
  it('opens the dialog once the account service is there', async () => {
    const { editor, openDialog } = fakeEditor('account', async () => true, { sharing: {} })
    await openAccountDialog(editor, 'share', 'share', (e) => !!e.adapter.services.sharing, 'nope')
    expect(openDialog).toHaveBeenCalledWith('share')
  })

  it('says so instead of opening an empty dialog when the service never appears', async () => {
    const { editor, openDialog, toast } = fakeEditor('account', async () => true)
    vi.useFakeTimers()
    const pending = openAccountDialog(editor, 'share', 'share', (e) => !!e.adapter.services.sharing, 'Sharing is not available.')
    await vi.advanceTimersByTimeAsync(3500)
    await pending
    vi.useRealTimers()
    expect(openDialog).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Sharing is not available.', 'info')
  })

  it('does nothing when the guest declines the sign-up or the editor is read-only', async () => {
    const declined = fakeEditor('guest', async () => false)
    await openAccountDialog(declined.editor, 'share', 'share', () => true, 'x')
    expect(declined.openDialog).not.toHaveBeenCalled()
    const viewer = fakeEditor('shared-view', async () => true)
    ;(viewer.editor as unknown as { readOnly: boolean }).readOnly = true
    await openAccountDialog(viewer.editor, 'share', 'share', () => true, 'x')
    expect(viewer.openDialog).not.toHaveBeenCalled()
  })
})
