/**
 * The pins' code is a chunk of its own. These specs run in a file of their own because a chunk that has arrived stays: the
 * first render in this file is the only one that sees it on its way, and that moment is the one under test.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CommentsRig, createCommentsRig, installPointerEvents } from '../panels/commentsTesting'
import { COMMENTS_UI_DEFAULT } from '../store/editorStore'
import { t } from '../strings'
import { LazyCommentPins } from './CommentPinsLoader'

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  installPointerEvents()
})

const rectOf = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect

let rig: CommentsRig
let scroller: HTMLDivElement
let boards: Map<string, HTMLDivElement>

beforeEach(() => {
  // Page n is drawn at 100 % with its top left corner at (100, 100 + 700 (n - 1)).
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = this.getAttribute('data-page-id') ?? this.closest('[data-page-id]')?.getAttribute('data-page-id')
    return id ? rectOf(100, 100 + (Number(id.replace('page-', '')) - 1) * 700, 800, 600) : rectOf(0, 0, 0, 0)
  })
  rig = createCommentsRig()
  rig.engine.store.setState({ zoom: 1, comments: { ...COMMENTS_UI_DEFAULT, pins: true, mode: true } })
  scroller = document.createElement('div')
  document.body.append(scroller)
  boards = new Map()
  for (const id of rig.pages) {
    const art = document.createElement('div')
    art.dataset.artboard = ''
    art.dataset.pageId = id
    scroller.append(art)
    boards.set(id, art)
  }
  const index = (id: string): number => Number(id.replace('page-', '')) - 1
  rig.engine.view.setController({
    scrollToPage: () => undefined,
    viewportSize: () => ({ width: 1400, height: 800 }),
    relayout: () => undefined,
    artboardRect: (id) => ({ left: 100, top: 100 + index(id) * 700, width: 800, height: 600 }),
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rig.engine.dispose()
  scroller.remove()
})

describe('comment mode while the code of the pins is on its way', () => {
  it('takes a click on a page at once and starts the comment there as soon as the pins have arrived', async () => {
    rig.renderIn(<LazyCommentPins scrollRef={{ current: scroller }} artboards={{ current: boards }} />)

    // The pins' chunk has not come yet: the page already has a surface that takes the click.
    const [waiting, second] = screen.getAllByTestId('comment-surface')
    expect(waiting).toHaveAttribute('aria-busy', 'true')
    expect(waiting).toHaveAccessibleName(t.comments.mode.surface(1))
    expect(second).toHaveAccessibleName(t.comments.mode.surface(2))
    expect(screen.queryByTestId('comment-draft-pin')).toBeNull()

    fireEvent.click(second, { clientX: 340, clientY: 1000, detail: 1 })

    // The chunk arrives; its layer of page 2 opens the comment where the click was: (240, 200) of that page.
    await waitFor(() => expect(rig.engine.state.comments.draft).toMatchObject({ pageId: 'page-2', x: 240, y: 200 }))
    expect(await screen.findByTestId('comment-draft-pin')).toBeInTheDocument()
    expect(await screen.findByTestId('pin-draft-card')).toBeInTheDocument()
    // The stand-ins are gone, the real surfaces are in place.
    await waitFor(() => expect(screen.getAllByTestId('comment-surface')[0]).not.toHaveAttribute('aria-busy'))
  })

  it('keeps no surface once comment mode is off', async () => {
    rig.engine.store.setState({ comments: { ...rig.engine.state.comments, mode: false } })
    rig.renderIn(<LazyCommentPins scrollRef={{ current: scroller }} artboards={{ current: boards }} />)
    await screen.findAllByRole('group')
    expect(screen.queryAllByTestId('comment-surface')).toHaveLength(0)
  })
})
