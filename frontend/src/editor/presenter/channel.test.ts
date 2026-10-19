import { describe, expect, it, vi } from 'vitest'
import { initialState } from './machine'
import { createChannelHub } from './testing'
import {
  type ChannelLike,
  type ChannelMessage,
  channelName,
  type Envelope,
  isSessionId,
  newSessionId,
  openLink,
  type PagePreview,
  parseMessage,
  presenterViewUrl,
  PROTOCOL_VERSION,
} from './channel'

const SESSION = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const page = (id: string, extra: Partial<PagePreview> = {}): PagePreview => ({ id, name: `Page ${id}`, notes: 'Say hi', durationSec: 5, width: 1920, height: 1080, ...extra })
const state = initialState({ count: 3, durations: [5, 5, 5] }, { autoAdvance: true })
const wrap = (message: ChannelMessage | Record<string, unknown>, from: 'show' | 'view' = 'show'): unknown => ({ ...message, v: PROTOCOL_VERSION, from })

describe('session ids', () => {
  it('generates 128-bit hex ids that pass validation', () => {
    const a = newSessionId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(isSessionId(a)).toBe(true)
    expect(newSessionId()).not.toBe(a)
  })

  it('rejects anything else', () => {
    for (const bad of ['', 'short', 'a'.repeat(65), 'has space in it 1234', '../../etc/passwd/1234', 'a'.repeat(32) + '<script>', 42, null, undefined]) expect(isSessionId(bad)).toBe(false)
  })

  it('builds the view address from the session', () => {
    const url = new URL(presenterViewUrl(SESSION, '/', 'https://doory.example/design/7'))
    expect(url.origin).toBe('https://doory.example')
    expect(url.pathname).toBe('/presenter-view.html')
    expect(url.searchParams.get('session')).toBe(SESSION)
    expect(channelName(SESSION)).toContain(SESSION)
  })
})

describe('parseMessage', () => {
  const init = { kind: 'init', title: 'Deck', theme: 'dark', pages: [page('a'), page('b'), page('c', { durationSec: null })], state } as const

  it('accepts well-formed messages from the right side', () => {
    expect(parseMessage(wrap({ kind: 'hello' }, 'view'), 'show')).toMatchObject({ kind: 'hello', from: 'view' })
    expect(parseMessage(wrap(init), 'view')).toMatchObject({ kind: 'init', title: 'Deck' })
    expect(parseMessage(wrap({ kind: 'state', state }), 'view')).toMatchObject({ kind: 'state' })
    expect(parseMessage(wrap({ kind: 'command', command: { action: 'goto', index: 2 } }, 'view'), 'show')).toMatchObject({ command: { action: 'goto', index: 2 } })
    expect(parseMessage(wrap({ kind: 'command', command: { action: 'toggle-pause' } }, 'view'), 'show')).toMatchObject({ command: { action: 'toggle-pause' } })
    expect(parseMessage(wrap({ kind: 'need-frame', pageId: 'a', width: 640 }, 'view'), 'show')).toMatchObject({ pageId: 'a', width: 640 })
    expect(parseMessage(wrap({ kind: 'frame', pageId: 'a', width: 640, image: new Blob(['x'], { type: 'image/png' }) }), 'view')).toMatchObject({ kind: 'frame' })
    expect(parseMessage(wrap({ kind: 'bye' }, 'view'), 'show')).toMatchObject({ kind: 'bye' })
    expect(parseMessage(wrap({ kind: 'bye' }, 'show'), 'view')).toMatchObject({ kind: 'bye' })
  })

  it('refuses things that are not envelopes of this protocol', () => {
    for (const bad of [null, undefined, 'hello', 7, [], {}, { kind: 'hello' }, { v: 2, from: 'view', kind: 'hello' }, { v: 1, from: 'other', kind: 'hello' }, { v: 1, from: 'view', kind: 'explode' }, { v: 1, from: 'view' }]) {
      expect(parseMessage(bad, 'show')).toBeNull()
    }
  })

  it('refuses a message that is sent by the wrong side or comes from the receiver itself', () => {
    expect(parseMessage(wrap({ kind: 'command', command: { action: 'next' } }, 'show'), 'view')).toBeNull()
    expect(parseMessage(wrap({ kind: 'hello' }, 'view'), 'view')).toBeNull()
    expect(parseMessage(wrap(init, 'view'), 'show')).toBeNull()
  })

  it('validates commands', () => {
    for (const command of [{ action: 'format-disk' }, { action: 'goto' }, { action: 'goto', index: -1 }, { action: 'goto', index: 1.5 }, { action: 'goto', index: 100 }, { action: 'goto', index: '1' }, 'next', null, {}]) {
      expect(parseMessage(wrap({ kind: 'command', command }, 'view'), 'show')).toBeNull()
    }
  })

  it('validates the init message: pages, state, bounds', () => {
    const bad = (patch: Record<string, unknown>): unknown => wrap({ ...init, ...patch })
    expect(parseMessage(bad({ pages: [] }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: Array.from({ length: 101 }, (_, i) => page(String(i))) }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: [page('a', { notes: 'x'.repeat(5001) })] }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: [page('a', { durationSec: 0 })] }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: [page('a', { durationSec: 601 })] }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: [page('a', { width: 0 })] }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: [page('a', { height: Number.NaN })] }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: [page('')] }), 'view')).toBeNull()
    expect(parseMessage(bad({ pages: ['page'] }), 'view')).toBeNull()
    expect(parseMessage(bad({ title: 'x'.repeat(301) }), 'view')).toBeNull()
    expect(parseMessage(bad({ theme: 'sepia' }), 'view')).toBeNull()
    expect(parseMessage(bad({ state: { ...state, index: 3 } }), 'view')).toBeNull()
    expect(parseMessage(bad({ state: { ...state, pageMs: -1 } }), 'view')).toBeNull()
    expect(parseMessage(bad({ state: { ...state, totalMs: Number.POSITIVE_INFINITY } }), 'view')).toBeNull()
    expect(parseMessage(bad({ state: { ...state, paused: 'no' } }), 'view')).toBeNull()
    expect(parseMessage(bad({ state: null }), 'view')).toBeNull()
  })

  it('validates frames', () => {
    const frame = (patch: Record<string, unknown>): unknown => wrap({ kind: 'frame', pageId: 'a', width: 640, image: new Blob(['x'], { type: 'image/png' }), ...patch })
    expect(parseMessage(frame({ image: 'data:image/png;base64,AAAA' }), 'view')).toBeNull()
    expect(parseMessage(frame({ image: new Blob([], { type: 'image/png' }) }), 'view')).toBeNull()
    expect(parseMessage(frame({ image: new Blob(['<svg/>'], { type: 'image/svg+xml' }) }), 'view')).toBeNull()
    expect(parseMessage(frame({ image: new Blob(['x'], { type: 'text/html' }) }), 'view')).toBeNull()
    expect(parseMessage(frame({ width: 0 }), 'view')).toBeNull()
    expect(parseMessage(frame({ width: 5000 }), 'view')).toBeNull()
    expect(parseMessage(frame({ pageId: '' }), 'view')).toBeNull()
  })

  it('validates frame requests', () => {
    for (const patch of [{ width: 0 }, { width: 99999 }, { width: 1.5 }, { pageId: '' }, { pageId: 'x'.repeat(65) }, { pageId: 7 }]) {
      expect(parseMessage(wrap({ kind: 'need-frame', pageId: 'a', width: 640, ...patch }, 'view'), 'show')).toBeNull()
    }
  })

  it('drops unknown extra fields from what it returns', () => {
    const out = parseMessage(wrap({ kind: 'state', state, evil: '<img onerror=alert(1)>' }), 'view') as Envelope & Record<string, unknown>
    expect(out.evil).toBeUndefined()
  })
})

describe('openLink', () => {
  it('delivers valid messages to the other end only', () => {
    const { create } = createChannelHub()
    const show = openLink(SESSION, 'show', create)
    const view = openLink(SESSION, 'view', create)
    if (!show || !view) throw new Error('no link')
    const atShow = vi.fn()
    const atView = vi.fn()
    show.subscribe(atShow)
    view.subscribe(atView)
    view.send({ kind: 'hello' })
    show.send({ kind: 'state', state })
    expect(atShow).toHaveBeenCalledTimes(1)
    expect(atShow.mock.calls[0][0]).toMatchObject({ kind: 'hello', from: 'view', v: 1 })
    expect(atView).toHaveBeenCalledTimes(1)
    expect(atView.mock.calls[0][0]).toMatchObject({ kind: 'state', from: 'show' })
  })

  it('ignores garbage on the channel', () => {
    const { create } = createChannelHub()
    const raw = create()
    const view = openLink(SESSION, 'view', () => create())
    if (!view) throw new Error('no link')
    const handler = vi.fn()
    view.subscribe(handler)
    raw.postMessage({ nonsense: true })
    raw.postMessage('state')
    raw.postMessage({ v: 1, from: 'show', kind: 'state', state: { index: 'x' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe and sending after close does nothing', () => {
    const { create } = createChannelHub()
    const show = openLink(SESSION, 'show', create)
    const view = openLink(SESSION, 'view', create)
    if (!show || !view) throw new Error('no link')
    const handler = vi.fn()
    const off = show.subscribe(handler)
    view.send({ kind: 'hello' })
    off()
    view.send({ kind: 'hello' })
    expect(handler).toHaveBeenCalledTimes(1)
    view.close()
    view.send({ kind: 'hello' })
    view.close()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('returns null for a malformed session or a browser without BroadcastChannel', () => {
    expect(openLink('nope', 'show', () => ({}) as ChannelLike)).toBeNull()
    expect(openLink(SESSION, 'show', () => null)).toBeNull()
  })
})
