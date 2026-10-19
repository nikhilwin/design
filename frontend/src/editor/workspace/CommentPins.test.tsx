import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commentsOf } from '../panels/commentsController'
import { type CommentsRig, createCommentsRig, installPointerEvents } from '../panels/commentsTesting'
import { COMMENTS_UI_DEFAULT } from '../store/editorStore'
import { t } from '../strings'
import { CommentPins } from './CommentPins'

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  installPointerEvents()
})

interface Rect {
  left: number
  top: number
  width: number
  height: number
}
const rectOf = (r: Rect): DOMRect => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect

let rig: CommentsRig | null = null
let boards = new Map<string, HTMLDivElement>()
let rects = new Map<string, Rect>()
let scroller: HTMLDivElement

/** Pages laid out one under the other at `zoom`, each as big as it is (the pages may differ in size). */
function layout(zoom: number): void {
  if (!rig) return
  let top = 100
  rects = new Map()
  for (const page of rig.engine.state.doc.pages) {
    const size = rig.engine.pageSizeOf(page.id)
    rects.set(page.id, { left: 100, top, width: size.width * zoom, height: size.height * zoom })
    top += size.height * zoom + 40
  }
  rig.engine.store.setState({ zoom })
}

/** What the workspace tells the engine about the screen: where each artboard is. */
function installViewport(r: CommentsRig, scrollToPage: (id: string) => void = () => undefined): void {
  r.engine.view.setController({ scrollToPage, viewportSize: () => ({ width: 1400, height: 800 }), relayout: () => undefined, artboardRect: (id) => rects.get(id) ?? null })
}

function mount(options: Parameters<typeof createCommentsRig>[0] = {}, state: Partial<typeof COMMENTS_UI_DEFAULT> = { pins: true }): CommentsRig {
  rig = createCommentsRig(options)
  rig.engine.store.setState({ comments: { ...COMMENTS_UI_DEFAULT, ...state } })
  scroller = document.createElement('div')
  scroller.getBoundingClientRect = () => rectOf({ left: 0, top: 0, width: 1400, height: 800 })
  document.body.append(scroller)
  boards = new Map()
  for (const id of rig.pages) {
    const art = document.createElement('div')
    art.dataset.artboard = ''
    art.dataset.pageId = id
    scroller.append(art)
    boards.set(id, art)
  }
  layout(1)
  installViewport(rig)
  rig.renderIn(<CommentPins scrollRef={{ current: scroller }} artboards={{ current: boards }} />)
  return rig
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const layer = this.getAttribute('data-comment-layer')
    const page = layer ?? this.getAttribute('data-page-id')
    const r = page ? rects.get(page) : undefined
    if (r) return rectOf(r)
    // A pin is drawn inside the layer of its page: its tip is at (left, top) of the page's rectangle, the box reaches up from there.
    const pin = this.closest('[data-comment-layer]')
    const home = pin ? rects.get(pin.getAttribute('data-comment-layer') ?? '') : undefined
    if (home && this instanceof HTMLElement && this.style.left) return rectOf({ left: home.left + Number.parseFloat(this.style.left), top: home.top + Number.parseFloat(this.style.top) - 28, width: 28, height: 28 })
    return rectOf({ left: 0, top: 0, width: 0, height: 0 })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rig?.engine.dispose()
  rig = null
  scroller.remove()
})

const pinsOf = (page: string): HTMLElement[] => within(boards.get(page) as HTMLElement).queryAllByTestId('comment-pin')
const named = (text: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`: ${text}`) })
const px = (el: HTMLElement, prop: 'left' | 'top'): number => Number.parseFloat(el.style[prop])

describe('pins in page coordinates', () => {
  it('draws each pin inside the artboard of its page, with its tip at the stored point times the zoom', async () => {
    mount()
    await screen.findAllByTestId('comment-pin')
    expect(pinsOf('page-1')).toHaveLength(2)
    expect(pinsOf('page-2')).toHaveLength(1)
    // "Try a bolder headline" sits at (240, 180), "The photo looks soft" at (620, 420) of page 1.
    expect([px(named('Try a bolder'), 'left'), px(named('Try a bolder'), 'top')]).toEqual([240, 180])
    expect([px(named('The photo'), 'left'), px(named('The photo'), 'top')]).toEqual([620, 420])
    act(() => layout(0.5))
    await waitFor(() => expect(px(named('Try a bolder'), 'left')).toBe(120))
    expect(px(named('Try a bolder'), 'top')).toBe(90)
    act(() => layout(2.5))
    await waitFor(() => expect(px(named('The photo'), 'left')).toBe(1550))
    expect(px(named('The photo'), 'top')).toBe(1050)
  })

  it('numbers the pins like the list and says who, what and how many replies in the name', async () => {
    mount()
    const pin = await screen.findByRole('button', { name: /Comment 1 by Sam Lee, 1 reply: Try a bolder headline here\./ })
    expect(pin).toHaveTextContent('1')
    expect(named('Logo placement approved')).toHaveAccessibleName(/Comment 3 by Alex Rivera, resolved: Logo placement approved\./)
    expect(named('Logo placement approved')).toHaveAttribute('data-resolved', 'true')
  })

  it('does not draw a thread whose page is gone, and has no layer for pages that are not mounted', async () => {
    mount()
    await screen.findAllByTestId('comment-pin')
    expect(screen.queryByRole('button', { name: /no longer exists/ })).toBeNull()
    expect(screen.getAllByTestId('comment-pin')).toHaveLength(3)
    // A page whose artboard is not there yet gets its layer as soon as it is.
    const art = boards.get('page-2') as HTMLDivElement
    art.remove()
    boards.delete('page-2')
    await waitFor(() => expect(screen.getAllByTestId('comment-pin')).toHaveLength(2))
    scroller.append(art)
    boards.set('page-2', art)
    await waitFor(() => expect(screen.getAllByTestId('comment-pin')).toHaveLength(3))
  })

  it('keeps a pin on its page when the page is smaller than where the comment was left, using each page’s own size', async () => {
    const r = mount({ pages: 2 })
    await screen.findAllByTestId('comment-pin')
    r.handle.comments.remote.add({ body: 'Off the page', page_id: 'page-2', x: 5000, y: -40 })
    // Page 2 is made smaller than page 1: 400 x 300.
    act(() => {
      r.engine.store.setState((s) => ({ doc: { ...s.doc, pages: s.doc.pages.map((p) => (p.id === 'page-2' ? { ...p, width: 400, height: 300 } : p)) } }))
      layout(1)
    })
    await act(() => commentsOf(r.engine).refresh())
    const off = await screen.findByRole('button', { name: /: Off the page/ })
    expect([px(off, 'left'), px(off, 'top')]).toEqual([400, 0])
    // Page 1 keeps its own size.
    expect(px(named('The photo'), 'left')).toBe(620)
  })

  it('draws only the pages near the screen when the browser can tell which those are', async () => {
    const seen = new Set<Element>()
    let notify: IntersectionObserverCallback = () => undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          notify = cb
        }
        observe(el: Element): void {
          seen.add(el)
        }
        disconnect(): void {
          seen.clear()
        }
        unobserve(): void {
          return undefined
        }
      },
    )
    try {
      mount()
      await waitFor(() => expect(seen.size).toBe(2))
      expect(screen.queryAllByTestId('comment-pin')).toHaveLength(0)
      const entry = (page: string, isIntersecting: boolean) => ({ target: boards.get(page) as Element, isIntersecting }) as IntersectionObserverEntry
      act(() => notify([entry('page-1', true)], {} as IntersectionObserver))
      await waitFor(() => expect(screen.getAllByTestId('comment-pin')).toHaveLength(2))
      act(() => notify([entry('page-2', true)], {} as IntersectionObserver))
      await waitFor(() => expect(screen.getAllByTestId('comment-pin')).toHaveLength(3))
      act(() => notify([entry('page-1', false)], {} as IntersectionObserver))
      await waitFor(() => expect(screen.getAllByTestId('comment-pin')).toHaveLength(1))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('draws nothing when the pins are switched off, and nothing for an editor without comments', async () => {
    mount({}, { pins: false })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryAllByTestId('comment-pin')).toHaveLength(0)
    expect(rig?.handle.comments.calls).not.toContain('list')
    act(() => rig?.engine.store.setState((s) => ({ comments: { ...s.comments, pins: true } })))
    await screen.findAllByTestId('comment-pin')
  })

  it('snaps a pin to a whole device pixel', async () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    mount()
    await screen.findAllByTestId('comment-pin')
    act(() => layout(0.4137))
    await waitFor(() => expect(px(named('Try a bolder'), 'left')).toBe(99.5))
    expect(px(named('Try a bolder'), 'top')).toBe(74.5)
  })
})

describe('pins that cover each other', () => {
  it('are fanned out so that each can be reached, and the stored places do not change', async () => {
    const r = mount({ seed: null })
    for (let i = 0; i < 5; i += 1) r.handle.comments.remote.add({ body: `Same spot ${i}`, page_id: 'page-1', x: 300, y: 300 })
    await screen.findAllByTestId('comment-pin')
    await waitFor(() => expect(pinsOf('page-1')).toHaveLength(5))
    const spots = new Set(pinsOf('page-1').map((el) => `${px(el, 'left')},${px(el, 'top')}`))
    expect(spots.size).toBe(5)
    expect(spots.has('300,300')).toBe(true)
    expect(r.handle.comments.snapshot().every((c) => c.x === 300 && c.y === 300)).toBe(true)
  })
})

describe('comment mode', () => {
  it('puts a click surface over every page; a click starts a comment at the clicked page point', async () => {
    const r = mount({}, { pins: true, mode: true })
    layout(0.5)
    const surfaces = await screen.findAllByTestId('comment-surface')
    expect(surfaces).toHaveLength(2)
    expect(surfaces[0]).toHaveAccessibleName(t.comments.mode.surface(1))
    // Page 1 is drawn at (100, 100); a click at (300, 220) is (400, 240) in page pixels at 50 %.
    fireEvent.click(surfaces[0], { clientX: 300, clientY: 220, detail: 1 })
    await waitFor(() => expect(r.engine.state.comments.draft).toMatchObject({ pageId: 'page-1', x: 400, y: 240 }))
    expect(await screen.findByTestId('pin-draft-card')).toBeInTheDocument()
    expect(screen.getByTestId('comment-draft-pin')).toBeInTheDocument()
    // Another click moves the spot and keeps the text.
    await userEvent.type(screen.getByTestId('pin-compose-text'), 'draft text')
    fireEvent.click(surfaces[1], { clientX: 150, clientY: 500, detail: 1 })
    await waitFor(() => expect(r.engine.state.comments.draft).toMatchObject({ pageId: 'page-2', body: 'draft text' }))
  })

  it('uses each page’s own size: the same click means different points on pages of different sizes', async () => {
    const r = mount({ seed: null }, { pins: true, mode: true })
    act(() => {
      r.engine.store.setState((s) => ({ doc: { ...s.doc, pages: s.doc.pages.map((p) => (p.id === 'page-2' ? { ...p, width: 400, height: 300 } : p)) } }))
      layout(1)
    })
    const surfaces = await screen.findAllByTestId('comment-surface')
    const second = rects.get('page-2') as Rect
    fireEvent.click(surfaces[1], { clientX: second.left + 390, clientY: second.top + 290, detail: 1 })
    await waitFor(() => expect(r.engine.state.comments.draft).toMatchObject({ pageId: 'page-2', x: 390, y: 290 }))
    // Beyond the page it is clamped to the page.
    fireEvent.click(surfaces[1], { clientX: second.left + 900, clientY: second.top - 50, detail: 1 })
    await waitFor(() => expect(r.engine.state.comments.draft).toMatchObject({ pageId: 'page-2', x: 400, y: 0 }))
  })

  it('starts in the middle of the page when the surface is used with the keyboard', async () => {
    const r = mount({ seed: null }, { pins: true, mode: true })
    const [first] = await screen.findAllByTestId('comment-surface')
    first.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(r.engine.state.comments.draft).toMatchObject({ pageId: 'page-1', x: 400, y: 300 }))
  })

  it('does not start a comment while the hand tool is on', async () => {
    const r = mount({ seed: null }, { pins: true, mode: true })
    r.engine.patchUi({ tool: 'hand' })
    const [first] = await screen.findAllByTestId('comment-surface')
    fireEvent.click(first, { clientX: 300, clientY: 300, detail: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.engine.state.comments.draft).toBeNull()
  })

  it('asks a visitor who is not signed in to sign up before the comment box opens', async () => {
    const r = mount({ seed: null, role: 'anonymous', mode: 'shared-comment' }, { pins: true, mode: true })
    const [first] = await screen.findAllByTestId('comment-surface')
    await waitFor(() => expect(r.engine.state.comments.pins).toBe(true))
    await act(async () => {
      fireEvent.click(first, { clientX: 300, clientY: 300, detail: 1 })
    })
    await waitFor(() => expect(r.handle.accountRequests).toContain('comment'))
    await waitFor(() => expect(r.engine.state.comments.draft).not.toBeNull())
  })

  it('sends the comment to the spot, shows it as a pin and closes the box', async () => {
    const r = mount({ seed: null }, { pins: true, mode: true })
    const [first] = await screen.findAllByTestId('comment-surface')
    fireEvent.click(first, { clientX: 200, clientY: 250, detail: 1 })
    await userEvent.type(await screen.findByTestId('pin-compose-text'), 'Made here')
    await userEvent.click(screen.getByTestId('pin-compose-send'))
    const pin = await screen.findByRole('button', { name: /: Made here/ })
    expect([px(pin, 'left'), px(pin, 'top')]).toEqual([100, 150])
    expect(r.handle.comments.snapshot()).toMatchObject([{ body: 'Made here', page_id: 'page-1', x: 100, y: 150 }])
    expect(r.engine.state.comments.draft).toBeNull()
    expect(screen.queryByTestId('pin-draft-card')).toBeNull()
  })

  it('Esc steps back: the box first, then the open card, then comment mode', async () => {
    const r = mount({}, { pins: true, mode: true })
    const [first] = await screen.findAllByTestId('comment-surface')
    fireEvent.click(first, { clientX: 300, clientY: 300, detail: 1 })
    await screen.findByTestId('pin-draft-card')
    await userEvent.keyboard('{Escape}')
    expect(r.engine.state.comments.draft).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: /: Try a bolder/ }))
    expect(await screen.findByTestId('pin-card')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('pin-card')).toBeNull())
    expect(named('Try a bolder')).toHaveFocus()
    expect(r.engine.state.comments.mode).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(r.engine.state.comments.mode).toBe(false)
    expect(screen.queryAllByTestId('comment-surface')).toHaveLength(0)
    expect(screen.getAllByTestId('comment-pin')).toHaveLength(3)
  })

  it('shows a hint with a way out', async () => {
    const r = mount({}, { pins: true, mode: true })
    await userEvent.click(await screen.findByTestId('comment-mode-done'))
    expect(r.engine.state.comments.mode).toBe(false)
    expect(screen.queryByTestId('comment-mode-hint')).toBeNull()
  })
})

describe('a pin and its card', () => {
  it('opens on a click and closes on a second click, an outside press or Esc', async () => {
    const r = mount()
    const pin = await screen.findByRole('button', { name: /: Try a bolder/ })
    await userEvent.click(pin)
    const card = await screen.findByTestId('pin-card')
    expect(card).toHaveAccessibleName(t.comments.pin.thread(1))
    expect(within(card).getByText('Good call, I will make it heavier.')).toBeInTheDocument()
    expect(pin).toHaveAttribute('aria-expanded', 'true')
    expect(r.engine.state.comments.activeThreadId).toBe(pin.getAttribute('data-comment-pin'))
    await userEvent.click(pin)
    expect(screen.queryByTestId('pin-card')).toBeNull()

    await userEvent.click(pin)
    await screen.findByTestId('pin-card')
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('pin-card')).toBeNull())

    // Opening another pin replaces the card.
    await userEvent.click(pin)
    await userEvent.click(named('The photo'))
    await waitFor(() => expect(screen.getAllByTestId('pin-card')).toHaveLength(1))
    expect(screen.getByTestId('pin-card')).toHaveTextContent('The photo looks soft')
  })

  it('does not draw the card while its pin is scrolled out of the workspace, and brings it back with the pin', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /: Try a bolder/ }))
    const card = await screen.findByTestId('pin-card')
    expect(card).not.toHaveAttribute('data-hidden')
    // The pin leaves the workspace (it is above its top edge).
    rects.set('page-1', { left: 100, top: -2000, width: 800, height: 600 })
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(card).toHaveAttribute('data-hidden', 'true'))
    rects.set('page-1', { left: 100, top: 100, width: 800, height: 600 })
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(card).not.toHaveAttribute('data-hidden'))
  })

  it('walks the pins with the arrow keys, Home and End; only one pin per page is in the tab order', async () => {
    mount()
    const first = await screen.findByRole('button', { name: /: Try a bolder/ })
    const second = named('The photo')
    expect(first).toHaveAttribute('tabindex', '0')
    expect(second).toHaveAttribute('tabindex', '-1')
    first.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(second).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(named('Logo placement')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(named('Logo placement')).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(first).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(first).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(named('Logo placement')).toHaveFocus()
  })

  it('asks the page to scroll when the next pin is on a page that is not drawn', async () => {
    const r = mount()
    const first = await screen.findByRole('button', { name: /: Try a bolder/ })
    const scrolled: string[] = []
    installViewport(r, (id) => scrolled.push(id))
    // Page 2's layer goes away; the arrow key still gets there.
    boards.get('page-2')?.remove()
    boards.delete('page-2')
    await waitFor(() => expect(screen.getAllByTestId('comment-pin')).toHaveLength(2))
    first.focus()
    await userEvent.keyboard('{End}')
    expect(scrolled).toEqual(['page-2'])
    expect(r.engine.state.comments.reveal).toMatchObject({ focus: true })
  })

  it('shows a hover preview with the author and the first words, not for a touch pointer', async () => {
    mount()
    const pin = await screen.findByRole('button', { name: /: The photo/ })
    fireEvent.pointerOver(pin, { pointerType: 'touch' })
    expect(screen.queryByTestId('comment-pin-preview')).toBeNull()
    fireEvent.pointerOut(pin, { pointerType: 'touch' })
    await userEvent.hover(pin)
    expect(screen.getByTestId('comment-pin-preview')).toHaveTextContent('Sam Lee')
    expect(screen.getByTestId('comment-pin-preview')).toHaveTextContent('The photo looks soft at this size.')
    await userEvent.unhover(pin)
    expect(screen.queryByTestId('comment-pin-preview')).toBeNull()
  })

  it('pulses a thread that is asked for and takes the keyboard focus when told to, without moving a view that already shows it', async () => {
    const r = mount()
    const pin = await screen.findByRole('button', { name: /: The photo/ })
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    act(() => r.engine.store.setState((s) => ({ comments: { ...s.comments, reveal: { id: pin.getAttribute('data-comment-pin') as string, nonce: 1, focus: true } } })))
    await waitFor(() => expect(pin).toHaveAttribute('data-pulse', 'true'))
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(pin).toHaveFocus()
    expect(r.engine.state.comments.reveal).toBeNull()
  })

  it('scrolls to a thread that is asked for when the pin is not on the screen', async () => {
    const r = mount()
    const pin = await screen.findByRole('button', { name: /: The photo/ })
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    rects.set('page-1', { left: 100, top: 3000, width: 800, height: 600 })
    act(() => r.engine.store.setState((s) => ({ comments: { ...s.comments, reveal: { id: pin.getAttribute('data-comment-pin') as string, nonce: 1, focus: false } } })))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center', inline: 'center' })))
    expect(pin).toHaveAttribute('data-pulse', 'true')
  })
})

describe('who may move a pin', () => {
  it('lets the owner move every pin, and a commenter only their own', async () => {
    mount({ role: 'owner' })
    await screen.findAllByTestId('comment-pin')
    for (const pin of screen.getAllByTestId('comment-pin')) expect(pin).toHaveAttribute('data-movable', 'true')
    rig?.engine.dispose()
    document.body.innerHTML = ''
    mount({ role: 'commenter', mode: 'shared-comment' })
    await screen.findAllByTestId('comment-pin')
    expect(named('Try a bolder')).toHaveAttribute('data-movable', 'true')
    expect(named('Logo placement')).not.toHaveAttribute('data-movable')
  })

  it('moves a pin that is dragged to where the tip was dropped, and takes it to another page', async () => {
    const r = mount()
    const pin = await screen.findByRole('button', { name: /: Try a bolder/ })
    // The pin box: its tip (bottom-left) is at the page point (240, 180) of page 1, drawn at (100, 100).
    vi.spyOn(pin, 'getBoundingClientRect').mockReturnValue(rectOf({ left: 340, top: 252, width: 28, height: 28 }))
    fireEvent.pointerDown(pin, { button: 0, clientX: 350, clientY: 262, pointerId: 1 })
    fireEvent.pointerMove(pin, { clientX: 450, clientY: 332, pointerId: 1 })
    fireEvent.pointerUp(pin, { clientX: 450, clientY: 332, pointerId: 1 })
    await waitFor(() => expect(r.handle.comments.calls.some((c) => c.startsWith('move:'))).toBe(true))
    // The tip moved by (100, 70) on screen: the page point is now (340, 250).
    expect(r.handle.comments.snapshot().find((c) => c.body.startsWith('Try a bolder'))).toMatchObject({ page_id: 'page-1', x: 340, y: 250 })
    expect(r.engine.state.comments.activeThreadId).toBeNull()

    // Dropped on page 2, which starts at (100, 740): the pin belongs to that page now.
    const again = await screen.findByRole('button', { name: /: Try a bolder/ })
    vi.spyOn(again, 'getBoundingClientRect').mockReturnValue(rectOf({ left: 440, top: 322, width: 28, height: 28 }))
    fireEvent.pointerDown(again, { button: 0, clientX: 450, clientY: 332, pointerId: 1 })
    fireEvent.pointerMove(again, { clientX: 250, clientY: 782, pointerId: 1 })
    fireEvent.pointerUp(again, { clientX: 250, clientY: 782, pointerId: 1 })
    await waitFor(() => expect(r.handle.comments.snapshot().find((c) => c.body.startsWith('Try a bolder'))?.page_id).toBe('page-2'))
  })

  it('leaves the pin where it was when the drag is dropped outside every page, and does not treat a tiny movement as a drag', async () => {
    const r = mount()
    const pin = await screen.findByRole('button', { name: /: Try a bolder/ })
    vi.spyOn(pin, 'getBoundingClientRect').mockReturnValue(rectOf({ left: 340, top: 252, width: 28, height: 28 }))
    fireEvent.pointerDown(pin, { button: 0, clientX: 350, clientY: 262, pointerId: 1 })
    fireEvent.pointerMove(pin, { clientX: 20, clientY: 20, pointerId: 1 })
    fireEvent.pointerUp(pin, { clientX: 20, clientY: 20, pointerId: 1 })
    fireEvent.pointerDown(pin, { button: 0, clientX: 350, clientY: 262, pointerId: 1 })
    fireEvent.pointerMove(pin, { clientX: 352, clientY: 263, pointerId: 1 })
    fireEvent.pointerUp(pin, { clientX: 352, clientY: 263, pointerId: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.handle.comments.calls.some((c) => c.startsWith('move:'))).toBe(false)
  })

  it('nudges with Alt + arrows (10 with Shift), keeps the pin on its page and saves once', async () => {
    const r = mount()
    const pin = await screen.findByRole('button', { name: /: Try a bolder/ })
    pin.focus()
    fireEvent.keyDown(pin, { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(pin, { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(pin, { key: 'ArrowDown', altKey: true, shiftKey: true })
    await waitFor(() => expect(r.handle.comments.calls.filter((c) => c.startsWith('move:'))).toHaveLength(1))
    expect(r.handle.comments.snapshot().find((c) => c.body.startsWith('Try a bolder'))).toMatchObject({ x: 242, y: 190 })
    // At the edge of the page it stops.
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(pin, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(pin, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    await waitFor(() => expect(r.handle.comments.snapshot().find((c) => c.body.startsWith('Try a bolder'))?.x).toBe(0))
  })

  it('does nothing for a pin that is not the person’s to move', async () => {
    const r = mount({ role: 'commenter', mode: 'shared-comment' })
    const pin = await screen.findByRole('button', { name: /: Logo placement/ })
    pin.focus()
    fireEvent.keyDown(pin, { key: 'ArrowRight', altKey: true })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(r.handle.comments.calls.some((c) => c.startsWith('move:'))).toBe(false)
  })
})
