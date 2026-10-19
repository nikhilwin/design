import { afterEach, describe, expect, it, vi } from 'vitest'
import { COUNTDOWN_SECONDS, MAX_RECORDING_MS, type RecorderDeps, RECORDER_TYPES, VoiceRecorder, failureOf, formatClock, levelFromRms } from './recorder'

/** A fake MediaRecorder that delivers `data` when stopped. */
class FakeRecorder {
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  static instances: FakeRecorder[] = []
  static failStart = false
  constructor(
    readonly stream: unknown,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? ''
    FakeRecorder.instances.push(this)
  }
  start(): void {
    if (FakeRecorder.failStart) throw new Error('nope')
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)], { type: this.mimeType }) })
    this.onstop?.()
  }
}

function setup(overrides: Partial<RecorderDeps> = {}) {
  let clock = 0
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  let next = 1
  const stops = vi.fn()
  const stream = { active: true, getTracks: () => [{ stop: stops }] } as unknown as MediaStream
  const getUserMedia = vi.fn(async () => stream)
  const closeMeter = vi.fn()
  let level = 0.4
  const deps: RecorderDeps = {
    getUserMedia,
    createRecorder: (s, mimeType) => new FakeRecorder(s, { mimeType }) as unknown as MediaRecorder,
    isTypeSupported: (type) => type === 'audio/webm;codecs=opus',
    createMeter: () => ({ read: () => level, close: closeMeter }),
    now: () => clock,
    setTimeout: (fn, ms) => {
      timers.set(next, { at: clock + ms, fn })
      return next++
    },
    clearTimeout: (h) => void timers.delete(h),
    setInterval: (fn, ms) => {
      timers.set(next, { at: clock + ms, fn, every: ms })
      return next++
    },
    clearInterval: (h) => void timers.delete(h),
    ...overrides,
  }
  const advance = (ms: number): void => {
    const target = clock + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [handle, timer] = due
      clock = timer.at
      if (timer.every) timer.at += timer.every
      else timers.delete(handle)
      timer.fn()
    }
    clock = target
  }
  return { deps, advance, getUserMedia, stops, closeMeter, setLevel: (v: number) => (level = v) }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

afterEach(() => {
  FakeRecorder.instances = []
  FakeRecorder.failStart = false
})

describe('VoiceRecorder', () => {
  it('goes from asking, through the countdown, to recording and a finished take', async () => {
    const { deps, advance, getUserMedia } = setup()
    const recorder = new VoiceRecorder(deps)
    const seen: string[] = []
    recorder.subscribe(() => seen.push(recorder.getSnapshot().status))
    const started = recorder.begin()
    expect(recorder.getSnapshot().status).toBe('requesting')
    await started
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true }) })
    expect(recorder.getSnapshot()).toMatchObject({ status: 'countdown', remaining: COUNTDOWN_SECONDS })
    advance(1000)
    expect(recorder.getSnapshot()).toMatchObject({ status: 'countdown', remaining: 2 })
    advance(1000)
    expect(recorder.getSnapshot()).toMatchObject({ status: 'countdown', remaining: 1 })
    advance(1000)
    expect(recorder.getSnapshot().status).toBe('recording')
    advance(2500)
    expect(recorder.getSnapshot()).toMatchObject({ status: 'recording', elapsedMs: expect.any(Number) })
    recorder.stop()
    const done = recorder.getSnapshot()
    expect(done.status).toBe('recorded')
    if (done.status === 'recorded') {
      expect(done.durationMs).toBe(2500)
      expect(done.blob.size).toBe(2000)
      expect(done.blob.type).toBe('audio/webm;codecs=opus')
    }
    expect(seen).toContain('countdown')
  })

  it('picks the first recording type the browser supports', async () => {
    const { deps, advance } = setup({ isTypeSupported: (type) => type === RECORDER_TYPES[3] })
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    advance(3000)
    expect(FakeRecorder.instances[0].mimeType).toBe('audio/mp4')
  })

  it('shows the level of the microphone while counting down and recording', async () => {
    const { deps, advance, setLevel } = setup()
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    advance(120)
    expect(recorder.getSnapshot()).toMatchObject({ status: 'countdown', level: 0.4 })
    setLevel(0.9)
    advance(3000)
    advance(200)
    expect(recorder.getSnapshot()).toMatchObject({ status: 'recording', level: 0.9 })
  })

  it('stops by itself at the time limit', async () => {
    const { deps, advance } = setup()
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    advance(3000)
    advance(MAX_RECORDING_MS + 100)
    expect(recorder.getSnapshot().status).toBe('recorded')
  })

  it('cancels during the countdown', async () => {
    const { deps, advance } = setup()
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    advance(1000)
    recorder.stop()
    advance(5000)
    expect(recorder.getSnapshot().status).toBe('idle')
    expect(FakeRecorder.instances).toHaveLength(0)
  })

  it('records again after a take with the microphone still open', async () => {
    const { deps, advance, getUserMedia, stops } = setup()
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    advance(3000)
    advance(1000)
    recorder.stop()
    recorder.retake()
    await flush()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(recorder.getSnapshot()).toMatchObject({ status: 'countdown', remaining: 3 })
    expect(stops).not.toHaveBeenCalled()
  })

  it('releases the microphone and the meter when disposed, and goes quiet', async () => {
    const { deps, advance, stops, closeMeter } = setup()
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    advance(3000)
    const listener = vi.fn()
    recorder.subscribe(listener)
    recorder.dispose()
    advance(10_000)
    expect(stops).toHaveBeenCalled()
    expect(closeMeter).toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(recorder.getSnapshot().status).toBe('idle')
  })

  it('ignores a second start while one is under way', async () => {
    const { deps, getUserMedia } = setup()
    const recorder = new VoiceRecorder(deps)
    const first = recorder.begin()
    void recorder.begin()
    await first
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'blocked'],
    ['NotFoundError', 'no-device'],
    ['OverconstrainedError', 'no-device'],
    ['NotReadableError', 'busy'],
    ['TypeError', 'unsupported'],
    ['SomethingElse', 'failed'],
  ] as const)('explains a %s as "%s"', async (name, reason) => {
    const { deps } = setup({ getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name })) })
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    const state = recorder.getSnapshot()
    expect(state).toMatchObject({ status: 'error', reason })
    expect(state.status === 'error' && state.message.length).toBeGreaterThan(20)
    expect(failureOf(Object.assign(new Error(), { name }))).toBe(reason)
  })

  it('reports an unsupported browser without trying', async () => {
    const recorder = new VoiceRecorder(null)
    await recorder.begin()
    expect(recorder.getSnapshot()).toMatchObject({ status: 'error', reason: 'unsupported' })
  })

  it('fails when the recorder cannot be created, cannot start, or delivers nothing', async () => {
    const a = setup({
      createRecorder: () => {
        throw new Error('no')
      },
    })
    const first = new VoiceRecorder(a.deps)
    await first.begin()
    a.advance(3000)
    expect(first.getSnapshot()).toMatchObject({ status: 'error', reason: 'unsupported' })

    FakeRecorder.failStart = true
    const b = setup()
    const second = new VoiceRecorder(b.deps)
    await second.begin()
    b.advance(3000)
    expect(second.getSnapshot()).toMatchObject({ status: 'error', reason: 'failed' })
    expect(b.stops).toHaveBeenCalled()
  })

  it('lets the person try again after an error', async () => {
    let attempts = 0
    const { deps, advance } = setup({
      getUserMedia: async () => {
        if (attempts++ === 0) throw Object.assign(new Error(), { name: 'NotAllowedError' })
        return { active: true, getTracks: () => [] } as unknown as MediaStream
      },
    })
    const recorder = new VoiceRecorder(deps)
    await recorder.begin()
    expect(recorder.getSnapshot().status).toBe('error')
    await recorder.begin()
    expect(recorder.getSnapshot().status).toBe('countdown')
    advance(3000)
    expect(recorder.getSnapshot().status).toBe('recording')
  })
})

describe('helpers', () => {
  it('maps signal levels to the meter', () => {
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(0.0001)).toBe(0)
    expect(levelFromRms(1)).toBe(1)
    expect(levelFromRms(0.1)).toBeCloseTo((54 - 20 + 6) / 54 - 0.0, 1)
    expect(levelFromRms(0.5)).toBeGreaterThan(levelFromRms(0.05))
  })

  it('formats a clock', () => {
    expect([formatClock(0), formatClock(7400), formatClock(65_000), formatClock(-5)]).toEqual(['0:00', '0:07', '1:05', '0:00'])
  })
})
