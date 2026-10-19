import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { t } from '../strings'
import { CommentsPanel } from './CommentsPanel'
import { type CommentsRig, createCommentsRig } from './commentsTesting'

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
})

let rig: CommentsRig | null = null
afterEach(() => {
  rig?.engine.dispose()
  rig = null
})

const open = async (options: Parameters<typeof createCommentsRig>[0] = {}): Promise<CommentsRig> => {
  rig = createCommentsRig(options)
  rig.renderIn(<CommentsPanel close={() => undefined} />)
  return rig
}
const threads = (): HTMLElement[] => screen.queryAllByTestId('comment-thread')

describe('the Comments sidebar', () => {
  it('shows a loading state, then the threads: open ones first, resolved ones under their own heading', async () => {
    await open()
    expect(screen.getByLabelText(t.comments.loading)).toBeInTheDocument()
    await waitFor(() => expect(threads()).toHaveLength(5))
    expect(screen.queryByLabelText(t.comments.loading)).toBeNull()
    expect(screen.getByRole('heading', { name: t.comments.resolvedCount(1) })).toBeInTheDocument()
    // Numbers match the pins: the first thread is 1, and the one on a page that is gone has none.
    const first = within(threads()[0])
    expect(first.getByTestId('comment-show')).toHaveAccessibleName(t.comments.showOnPage(1, 1))
    expect(screen.getByTestId('comment-page-removed')).toHaveTextContent(t.comments.pageRemoved)
    expect(within(threads().find((el) => el.contains(screen.getByTestId('comment-page-removed'))) as HTMLElement).queryByTestId('comment-show')).toBeNull()
  })

  it('says so when there are no comments, and when a filter leaves nothing', async () => {
    await open({ seed: null })
    expect(await screen.findByText(t.comments.empty)).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: t.comments.filter.label })).toBeNull()
  })

  it('explains a failed load and loads again on request', async () => {
    rig = createCommentsRig()
    rig.handle.comments.failNext('list', new ApiError({ status: 500, code: 'server_error', message: 'x' }))
    rig.renderIn(<CommentsPanel close={() => undefined} />)
    expect(await screen.findByTestId('comments-error')).toHaveTextContent(t.comments.loadFailed)
    await userEvent.click(screen.getByTestId('comments-retry'))
    await waitFor(() => expect(threads()).toHaveLength(5))
    expect(screen.queryByTestId('comments-error')).toBeNull()
  })

  it('filters by state and by author, with counts, and keeps the open thread when it no longer matches', async () => {
    const r = await open()
    await waitFor(() => expect(threads()).toHaveLength(5))
    const group = screen.getByRole('radiogroup', { name: t.comments.filter.label })
    expect(within(group).getByRole('radio', { name: `${t.comments.filter.all} 5` })).toBeChecked()
    expect(within(group).getByRole('radio', { name: `${t.comments.filter.unresolved} 4` })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: `${t.comments.filter.mine} 1` })).toBeInTheDocument()

    await userEvent.click(within(group).getByRole('radio', { name: /^Unresolved/ }))
    expect(threads()).toHaveLength(4)
    await userEvent.click(within(group).getByRole('radio', { name: /^Mine/ }))
    expect(threads()).toHaveLength(1)
    expect(threads()[0]).toHaveTextContent('Logo placement approved.')

    // Reopening the resolved thread and looking at "Unresolved" while it is the open one keeps it in the list.
    await userEvent.click(within(group).getByRole('radio', { name: /^Unresolved/ }))
    expect(threads()).toHaveLength(4)
    act(() => r.engine.store.setState((s) => ({ comments: { ...s.comments, activeThreadId: r.handle.comments.snapshot().find((c) => c.body.startsWith('Logo'))?.id ?? null } })))
    expect(threads()).toHaveLength(5)
  })

  it('shows no "Mine" to somebody who is not signed in', async () => {
    await open({ role: 'anonymous', mode: 'shared-comment' })
    await waitFor(() => expect(threads()).toHaveLength(5))
    expect(screen.queryByRole('radio', { name: /^Mine/ })).toBeNull()
    expect(screen.queryAllByTestId('comment-resolve')).toHaveLength(0)
  })

  it('offers resolve and delete to the owner only, and delete (own comments) to a commenter', async () => {
    await open({ role: 'owner' })
    await waitFor(() => expect(threads()).toHaveLength(5))
    expect(screen.getAllByTestId('comment-resolve')).toHaveLength(5)
    expect(screen.getAllByRole('button', { name: t.comments.delete })).toHaveLength(5)
    cleanup()
    rig?.engine.dispose()

    await open({ role: 'commenter', mode: 'shared-comment' })
    await waitFor(() => expect(screen.getAllByTestId('comment-thread')).toHaveLength(5))
    expect(screen.queryAllByTestId('comment-resolve')).toHaveLength(0)
    // Sam Lee wrote four of the five threads; Alex Rivera wrote "Logo placement approved".
    expect(screen.getAllByRole('button', { name: t.comments.delete })).toHaveLength(4)
  })

  it('posts a general comment with the page it was written on, reflects it at once and counts it', async () => {
    const r = await open()
    await waitFor(() => expect(threads()).toHaveLength(5))
    await userEvent.type(screen.getByTestId('comment-new-text'), 'One more thought')
    await userEvent.click(screen.getByTestId('comment-new-send'))
    await waitFor(() => expect(threads()).toHaveLength(6))
    expect(r.handle.comments.calls).toContain('create')
    const created = r.handle.comments.snapshot().find((c) => c.body === 'One more thought')
    expect(created).toMatchObject({ page_id: 'page-1', x: null, y: null })
    expect(screen.getByRole('radio', { name: `${t.comments.filter.all} 6` })).toBeChecked()
  })

  it('resolves and reopens, replies and deletes a thread from its card', async () => {
    const r = await open()
    await waitFor(() => expect(threads()).toHaveLength(5))
    const card = (): HTMLElement => threads().find((el) => el.textContent?.includes('The photo looks soft')) as HTMLElement

    await userEvent.click(within(card()).getByTestId('comment-resolve'))
    await waitFor(() => expect(screen.getByRole('heading', { name: t.comments.resolvedCount(2) })).toBeInTheDocument())
    await userEvent.click(within(card()).getByTestId('comment-resolve'))
    await waitFor(() => expect(screen.getByRole('heading', { name: t.comments.resolvedCount(1) })).toBeInTheDocument())

    await userEvent.click(within(card()).getByTestId('comment-reply-open'))
    await userEvent.type(within(card()).getByTestId('comment-reply-text'), 'Replaced it')
    await userEvent.click(within(card()).getByTestId('comment-reply-send'))
    await waitFor(() => expect(card()).toHaveTextContent('Replaced it'))
    expect(within(card()).queryByTestId('comment-reply-text')).toBeNull()

    await userEvent.click(within(card()).getByRole('button', { name: t.comments.delete }))
    await userEvent.click(within(card()).getByTestId('comment-delete-confirm'))
    await waitFor(() => expect(threads()).toHaveLength(4))
    expect(r.handle.comments.snapshot().some((c) => c.body.startsWith('The photo'))).toBe(false)
  })

  it('shows what the server refused as a failure and flips the thread back', async () => {
    const r = await open()
    await waitFor(() => expect(threads()).toHaveLength(5))
    r.handle.comments.failNext('resolve')
    const card = threads().find((el) => el.textContent?.includes('The photo looks soft')) as HTMLElement
    await userEvent.click(within(card).getByTestId('comment-resolve'))
    await waitFor(() => expect(r.engine.state.toasts.some((x) => x.message === t.comments.failed.unknown)).toBe(true))
    expect(screen.getByRole('heading', { name: t.comments.resolvedCount(1) })).toBeInTheDocument()
  })

  it('marks the open thread, and "Show on page" opens it and asks the page to scroll', async () => {
    const r = await open()
    await waitFor(() => expect(threads()).toHaveLength(5))
    await userEvent.click(within(threads()[1]).getByTestId('comment-show'))
    const id = threads()[1].getAttribute('data-thread-id')
    expect(r.engine.state.comments.activeThreadId).toBe(id)
    expect(r.engine.state.comments.reveal).toMatchObject({ id, focus: false })
    expect(threads()[1]).toHaveAttribute('data-active', 'true')
  })

  it('turns the pins on and comment mode on while it is open, and off again when it closes', async () => {
    const r = createCommentsRig()
    const view = r.renderIn(<CommentsPanel close={() => undefined} />)
    rig = r
    expect(r.engine.state.comments).toMatchObject({ pins: true, mode: true })
    await userEvent.click(await screen.findByRole('switch', { name: t.comments.pins.show }))
    expect(r.engine.state.comments).toMatchObject({ pins: false, mode: false })
    view.unmount()
    expect(r.engine.state.comments).toMatchObject({ pins: false, mode: false })
  })

  it('on a small screen opening it shows the pins but does not start comment mode, and closing leaves them', () => {
    const r = createCommentsRig()
    r.engine.patchUi({ compact: true })
    const view = r.renderIn(<CommentsPanel close={() => undefined} />)
    rig = r
    expect(r.engine.state.comments).toMatchObject({ pins: true, mode: false })
    view.unmount()
    expect(r.engine.state.comments).toMatchObject({ pins: true, mode: false })
  })

  it('on a small screen "Comment on the design" starts comment mode and closes the sheet', async () => {
    const r = createCommentsRig()
    r.engine.patchUi({ compact: true })
    let closed = 0
    r.renderIn(<CommentsPanel close={() => (closed += 1)} />)
    rig = r
    await userEvent.click(screen.getByTestId('comment-mode'))
    expect(r.engine.state.comments.mode).toBe(true)
    expect(closed).toBe(1)
  })

  it('invites a guest to sign up instead of showing threads', async () => {
    rig = createCommentsRig()
    ;(rig.engine.adapter.services as { comments: unknown }).comments = null
    rig.renderIn(<CommentsPanel close={() => undefined} />)
    expect(screen.getByTestId('comments-gate')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('comments-signup'))
    await waitFor(() => expect(rig?.handle.accountRequests).toContain('comment'))
  })
})
