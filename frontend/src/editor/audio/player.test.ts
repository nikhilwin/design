import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioTrack } from '@/types/document'
import { AudioPlayer, type PlayerDeps } from './player'
import { FakeContext, fakeBuffer } from './testing'

const track = (patch: Partial<AudioTrack> = {}): AudioTrack => ({
  id: 't',
  kind: 'sfx',
  name: 'Track',
  src: '/media/a.ogg',
  scope: { type: 'design' },
  startMs: 0,
  trimStartMs: 0,
  trimEndMs: 2000,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  muted: false,
  ...patch,
})

function setup(tracks: AudioTrack[], options: { refuse?: boolean; fail?: string[] } = {}) {
  const context = new FakeContext()
  context.state = options.refuse ? 'suspended' : 'running'
  context.refuseResume = options.refuse === true
  const intervals: (() => void)[] = []
  let current = tracks
  const deps: PlayerDeps = {
    tracks: () => current,
    pageIds: () => ['a', 'b'],
    pageDurationsMs: () => [4000, 6000],
    load: vi.fn(async (t) => {
      if (options.fail?.includes(t.id)) throw new Error('missing')
      return fakeBuffer(30)
    }),
    createContext: () => context as unknown as AudioContext,
    setInterval: (fn) => intervals.push(fn),
    clearInterval: () => undefined,
  }
  const player = new AudioPlayer(deps)
  return { player, context, deps, tick: () => intervals.at(-1)?.(), setTracks: (next: AudioTrack[]) => (current = next) }
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis)
})

describe('AudioPlayer', () => {
  it('plays the whole design: a design track from its offset, a page track with its page', async () => {
    const { player, context } = setup([track({ id: 'm', kind: 'music', loop: true, startMs: 500, trimStartMs: 1000, trimEndMs: 3000 }), track({ id: 'p', scope: { type: 'page', pageId: 'b' }, startMs: 1000 })])
    await player.play({ mode: 'all' })
    expect(player.getSnapshot()).toMatchObject({ status: 'playing', startMs: 0, endMs: 10_000 })
    const [music, page] = context.sources
    const base = 0.06
    expect(music.started).toEqual({ when: expect.closeTo(base + 0.5, 5), offset: 1, duration: expect.closeTo(9.5, 5) })
    expect(music).toMatchObject({ loop: true, loopStart: 1, loopEnd: 3 })
    expect(page.started).toEqual({ when: expect.closeTo(base + 5, 5), offset: 0, duration: expect.closeTo(2, 5) })
    expect(page.loop).toBe(false)
  })

  it('plays one page: what is on it, and design tracks from the right place', async () => {
    const { player, context } = setup([
      track({ id: 'm', kind: 'music', loop: true, trimEndMs: 3000 }),
      track({ id: 'a', scope: { type: 'page', pageId: 'a' } }),
      track({ id: 'b', scope: { type: 'page', pageId: 'b' } }),
    ])
    await player.play({ mode: 'page', pageId: 'b' })
    expect(player.getSnapshot()).toMatchObject({ startMs: 4000, endMs: 10_000, positionMs: 4000 })
    expect(context.sources).toHaveLength(2) // the music and page b, not page a
    const music = context.sources[0]
    // 4 s into a 3 s loop starts 1 s into it.
    expect(music.started?.offset).toBeCloseTo(1, 5)
    expect(music.started?.duration).toBeCloseTo(6, 5)
  })

  it('applies volume, fades and ducking as gain automation', async () => {
    const { player, context } = setup([
      track({ id: 'm', kind: 'music', loop: true, volume: 0.8, fadeInMs: 1000 }),
      track({ id: 'v', kind: 'voiceover', startMs: 3000, trimEndMs: 2000 }),
    ])
    await player.play({ mode: 'all' })
    const base = 0.06
    // gains in creation order: master, direct, duck, then per voice fade, level
    const [, , duck] = context.gains
    const music = context.sources[0]
    const fade = context.gains[3]
    const level = context.gains[4]
    expect(music.connections[0]).toBe(fade)
    expect(level.gain.value).toBeCloseTo(0.8)
    expect(fade.gain.valueAt(base + 0.5)).toBeCloseTo(0.5, 2)
    expect(fade.gain.valueAt(base + 2)).toBeCloseTo(1, 2)
    expect(level.connections[0]).toBe(duck)
    expect(duck.gain.valueAt(base + 1)).toBe(1)
    expect(duck.gain.valueAt(base + 3.15)).toBeCloseTo(0.3, 2)
    expect(duck.gain.valueAt(base + 6)).toBe(1)
    const voice = context.sources[1]
    expect(voice.connections[0].connections[0].connections[0]).toBe(context.gains[1]) // voiceovers do not duck
  })

  it('leaves out muted tracks, solos one, and reports files that cannot be loaded while playing the rest', async () => {
    const { player, context } = setup([track({ id: 'a' }), track({ id: 'b', muted: true }), track({ id: 'c' })], { fail: ['c'] })
    await player.play({ mode: 'all' })
    expect(context.sources).toHaveLength(1)
    expect(player.getSnapshot().failed).toEqual(['Track'])
    player.setSolo('a')
    await Promise.resolve()
    await Promise.resolve()
    expect(player.getSnapshot().soloId).toBe('a')
  })

  it('moves the playhead with the audio clock and stops at the end', async () => {
    const { player, context, tick } = setup([track({ loop: true })])
    await player.play({ mode: 'all' })
    context.currentTime = 0.06 + 2.5
    tick()
    expect(player.getSnapshot().positionMs).toBeCloseTo(2500, 0)
    context.currentTime = 0.06 + 10.5
    tick()
    expect(player.getSnapshot()).toMatchObject({ status: 'idle', positionMs: 0 })
  })

  it('pauses by suspending the context and resumes where it was', async () => {
    const { player, context, tick } = setup([track({ loop: true })])
    await player.play({ mode: 'all' })
    context.currentTime = 0.06 + 3
    tick()
    await player.pause()
    expect(player.getSnapshot().status).toBe('paused')
    expect(context.state).toBe('suspended')
    await player.resume()
    expect(player.getSnapshot()).toMatchObject({ status: 'playing' })
    expect(context.calls).toContain('suspend')
    expect(player.getSnapshot().positionMs).toBeCloseTo(3000, 0)
  })

  it('says so when the browser refuses to start the sound', async () => {
    const { player } = setup([track()], { refuse: true })
    await player.play({ mode: 'all' })
    expect(player.getSnapshot()).toMatchObject({ status: 'idle', blocked: true })
  })

  it('seeks by rescheduling from the new position', async () => {
    const { player, context } = setup([track({ id: 'm', kind: 'music', loop: true, trimEndMs: 4000 })])
    await player.play({ mode: 'all' })
    const first = context.sources[0]
    await player.seek(6500)
    expect(first.disconnected).toBe(true)
    const second = context.sources.at(-1)
    expect(second?.started?.offset).toBeCloseTo(2.5, 5)
    expect(player.getSnapshot().positionMs).toBe(6500)
  })

  it('stops everything and goes quiet', async () => {
    const { player, context } = setup([track({ loop: true })])
    await player.play({ mode: 'all' })
    player.stop()
    expect(context.sources.every((s) => s.disconnected)).toBe(true)
    expect(player.getSnapshot()).toMatchObject({ status: 'idle', positionMs: 0 })
  })

  it('follows a volume change without a gap and restarts for anything else', async () => {
    const { player, context, setTracks } = setup([track({ id: 'm', kind: 'music', loop: true, volume: 0.5 })])
    await player.play({ mode: 'all' })
    const sources = context.sources.length
    setTracks([track({ id: 'm', kind: 'music', loop: true, volume: 0.9 })])
    player.refresh()
    expect(context.sources).toHaveLength(sources)
    setTracks([track({ id: 'm', kind: 'music', loop: true, volume: 0.9, trimEndMs: 1000 })])
    player.refresh()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(context.sources.length).toBeGreaterThan(sources)
  })

  it('knows whether there is anything to play', () => {
    const { player } = setup([track({ scope: { type: 'page', pageId: 'a' } })])
    expect(player.hasAudio({ mode: 'all' })).toBe(true)
    expect(player.hasAudio({ mode: 'page', pageId: 'a' })).toBe(true)
    expect(player.hasAudio({ mode: 'page', pageId: 'b' })).toBe(false)
  })

  it('closes its audio context when disposed', async () => {
    const { player, context } = setup([track()])
    await player.play({ mode: 'all' })
    player.dispose()
    expect(context.calls).toContain('close')
  })
})
