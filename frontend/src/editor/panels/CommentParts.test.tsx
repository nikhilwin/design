import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { CommentT } from '@/types/api'
import { t } from '../strings'
import { Avatar, CommentComposer, CommentEntry, DeleteControl } from './CommentParts'
import { MAX_COMMENT_LENGTH } from './commentOps'

const comment: CommentT = { id: 'c1', author: { id: 'u1', name: 'Alex Rivera', avatar_url: null }, body: '<b>bold?</b> & more', page_id: 'p1', x: 1, y: 2, parent: null, resolved: false, created_at: '2026-03-01T09:00:00Z' }

function composer(onSubmit: (body: string) => Promise<void | false>, props: Partial<React.ComponentProps<typeof CommentComposer>> = {}) {
  return render(<CommentComposer placeholder="Write something" submitLabel="Send" testId="t" onSubmit={onSubmit} {...props} />)
}

describe('CommentComposer', () => {
  it('sends the trimmed text with the button and empties the box', async () => {
    const onSubmit = vi.fn(async () => undefined)
    composer(onSubmit)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Write something'), '  hello there  ')
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(onSubmit).toHaveBeenCalledWith('hello there')
    await waitFor(() => expect(screen.getByLabelText('Write something')).toHaveValue(''))
  })

  it('sends with Ctrl+Enter and with Cmd+Enter, and ignores a text of blanks', async () => {
    const onSubmit = vi.fn(async () => undefined)
    composer(onSubmit)
    const box = screen.getByLabelText('Write something')
    await userEvent.type(box, '   ')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.type(box, 'one')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    await userEvent.type(box, 'two')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit).toHaveBeenLastCalledWith('two')
  })

  it('keeps the text and says why when the comment could not be saved, and sends again on the next try', async () => {
    const onSubmit = vi
      .fn<(body: string) => Promise<void | false>>()
      .mockRejectedValueOnce(new ApiError({ status: 429, code: 'throttled', message: 'slow down', retryAfter: 12 }))
      .mockResolvedValueOnce(undefined)
    composer(onSubmit)
    await userEvent.type(screen.getByLabelText('Write something'), 'again')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(t.comments.failed.rateLimited(12))
    expect(screen.getByLabelText('Write something')).toHaveValue('again')
    expect(screen.getByLabelText('Write something')).toHaveAttribute('aria-invalid', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByLabelText('Write something')).toHaveValue('')
  })

  it.each([
    [new ApiError({ status: 0, code: 'network_error', message: 'x' }), t.comments.failed.offline],
    [new ApiError({ status: 401, code: 'not_authenticated', message: 'x' }), t.comments.failed.signedOut],
    [new ApiError({ status: 400, code: 'comment_limit_reached', message: 'x' }), t.comments.failed.limit],
    [new ApiError({ status: 404, code: 'not_found', message: 'x' }), t.comments.failed.gone],
    [new ApiError({ status: 400, code: 'validation_error', message: 'x', fields: { body: ['This field may not be blank.'] } }), 'This field may not be blank.'],
    [new Error('boom'), t.comments.failed.unknown],
  ])('explains %#', async (error, message) => {
    composer(vi.fn().mockRejectedValue(error))
    await userEvent.type(screen.getByLabelText('Write something'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('keeps the text without a message when the person declined to sign in (the submit says "not sent")', async () => {
    composer(vi.fn(async () => false as const))
    await userEvent.type(screen.getByLabelText('Write something'), 'keep me')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    expect(screen.getByLabelText('Write something')).toHaveValue('keep me')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sends once while the first request is still on its way', async () => {
    let finish: () => void = () => undefined
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    composer(onSubmit)
    await userEvent.type(screen.getByLabelText('Write something'), 'slow')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled())
  })

  it('counts down near the limit and cannot go past it', async () => {
    composer(vi.fn(async () => undefined))
    const box = screen.getByLabelText('Write something')
    expect(box).toHaveAttribute('maxlength', String(MAX_COMMENT_LENGTH))
    expect(screen.queryByText(/characters left/)).toBeNull()
    fireEvent.change(box, { target: { value: 'x'.repeat(MAX_COMMENT_LENGTH - 20) } })
    expect(screen.getByText('20 characters left')).toBeInTheDocument()
  })

  it('can be controlled from outside (the draft kept in the editor) and cancelled', async () => {
    const onChange = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(<CommentComposer placeholder="Write something" submitLabel="Send" testId="t" value="kept text" onChange={onChange} onCancel={onCancel} cancelLabel="Cancel" onSubmit={async () => undefined} />)
    expect(screen.getByLabelText('Write something')).toHaveValue('kept text')
    await userEvent.type(screen.getByLabelText('Write something'), '!')
    expect(onChange).toHaveBeenLastCalledWith('kept text!')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    rerender(<CommentComposer placeholder="Write something" submitLabel="Send" testId="t" value="" onChange={onChange} onSubmit={async () => undefined} />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('takes focus on request, and again when told to', () => {
    const { rerender } = render(<CommentComposer placeholder="Write something" submitLabel="Send" testId="t" autoFocus refocusKey="a" onSubmit={async () => undefined} />)
    expect(screen.getByLabelText('Write something')).toHaveFocus()
    screen.getByLabelText('Write something').blur()
    rerender(<CommentComposer placeholder="Write something" submitLabel="Send" testId="t" autoFocus refocusKey="b" onSubmit={async () => undefined} />)
    expect(screen.getByLabelText('Write something')).toHaveFocus()
  })

  it('can be disabled', () => {
    composer(vi.fn(), { disabled: true })
    expect(screen.getByLabelText('Write something')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('CommentEntry', () => {
  it('shows the words as text, never as markup, with who and when', () => {
    const { container } = render(<CommentEntry comment={comment} />)
    expect(screen.getByText('<b>bold?</b> & more')).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText('Alex Rivera')).toBeInTheDocument()
    expect(container.querySelector('time')).toHaveAttribute('datetime', comment.created_at)
  })

  it('shows "Sending" for a comment the server has not confirmed', () => {
    const { container } = render(<CommentEntry comment={comment} pending />)
    expect(screen.getByText(t.comments.sending)).toBeInTheDocument()
    expect(container.querySelector('time')).toBeNull()
  })

  it('offers deleting a reply only when asked to, and asks again first', async () => {
    const onDelete = vi.fn()
    const { rerender } = render(<CommentEntry comment={comment} />)
    expect(screen.queryByRole('button', { name: t.comments.deleteReply })).toBeNull()
    rerender(<CommentEntry comment={comment} onDelete={onDelete} />)
    await userEvent.click(screen.getByRole('button', { name: t.comments.deleteReply }))
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: t.comments.deleteReply }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})

describe('DeleteControl', () => {
  it('turns into a question that can be dismissed', async () => {
    const onConfirm = vi.fn()
    render(<DeleteControl label="Delete thread" confirmLabel="Yes, delete" onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete thread' }))
    await userEvent.click(screen.getByRole('button', { name: t.comments.cancel }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete thread' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete thread' }))
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('Avatar', () => {
  it('shows the picture, and the initials when it cannot be loaded or there is none', () => {
    const { container, rerender } = render(<Avatar name="Alex Rivera" src="/media/a.png" />)
    const img = container.querySelector('img')
    expect(img).toHaveAttribute('src', '/media/a.png')
    fireEvent.error(img as HTMLImageElement)
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('AR')
    rerender(<Avatar name="Sam" src={null} />)
    expect(container).toHaveTextContent('S')
  })
})
