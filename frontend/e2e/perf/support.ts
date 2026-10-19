/** Helpers of the profile specs: the engine inside the page, frame and long-task recording, and the report. */
import { appendFileSync } from 'node:fs'
import type { CDPSession, Page } from '@playwright/test'

/** The part of the editor engine the specs call (the real class is in `src/editor/engine/editor.ts`; e2e does not import the source). */
interface ProbeView {
  canvas: {
    getObjects(): unknown[]
    getActiveObject(): { oCoords: Record<string, { x: number; y: number }> } | undefined
    upperCanvasEl: HTMLCanvasElement
  }
}

export interface EngineProbe {
  state: { doc: { pages: { id: string; objects: { id: string; type: string; left?: number; top?: number; width?: number; height?: number }[] }[] }; loadingPages: string[]; zoom: number }
  select(ids: readonly string[]): void
  undo(): Promise<void>
  redo(): Promise<void>
  sealHistory(): void
  getDocument(): unknown
  arrange: { nudge(dx: number, dy: number): void; delete(): void }
  insert: { shape(kind: string): Promise<void> }
  pages: { add(index?: number): string | null; remove(pageId: string): void }
  view: { setZoom(zoom: number): void }
  persistence: { saveNow(): Promise<void> }
  patchUi(patch: Record<string, unknown>): void
  openDialog(id: string): void
  closeDialog(): void
  viewOf(pageId: string): ProbeView | undefined
  activeView(): ProbeView | undefined
}

/** What the specs reach in the page: the engine, through the test hook of a build made with `VITE_E2E=true`. */
export interface PerfWindow {
  __doory_collab?: { engine: EngineProbe }
  __perf: {
    /** `performance.now()` when the first page canvas was in the DOM / when no page was loading any more. */
    canvasAt?: number
    readyAt?: number
    frames: number[]
    longTasks: number[]
    recording: boolean
  }
}

export interface Summary {
  n: number
  medianMs: number
  p95Ms: number
  maxMs: number
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  const round = (n: number): number => Math.round(n * 10) / 10
  return { n: sorted.length, medianMs: round(at(0.5)), p95Ms: round(at(0.95)), maxMs: round(sorted[sorted.length - 1] ?? 0) }
}

/** Prints a measurement (`[perf] name {…}`) and appends it as a JSON line to the file `PERF_OUT` names, when set. */
export function record(name: string, value: unknown): void {
  console.log(`[perf] ${name} ${JSON.stringify(value)}`)
  if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, `${JSON.stringify({ name, value })}\n`)
}

/**
 * Starts the recording the page-side helpers need: when the first canvas appears and when the pages have loaded, and (while
 * `recording` is on) every animation frame and every long task. Call before `page.goto`.
 */
export async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const perf: PerfWindow['__perf'] = { frames: [], longTasks: [], recording: false }
    ;(window as unknown as PerfWindow).__perf = perf
    new MutationObserver((_records, observer) => {
      if (document.querySelector('[data-artboard] .lower-canvas')) {
        perf.canvasAt = performance.now()
        observer.disconnect()
      }
    }).observe(document, { childList: true, subtree: true })
    const tick = (): void => {
      const now = performance.now()
      const engine = (window as unknown as PerfWindow).__doory_collab?.engine
      // The first page is "painted" when its canvas holds all its objects and no page is loading: the frame after is the first one that shows them.
      if (perf.canvasAt !== undefined && perf.readyAt === undefined && engine && engine.state.loadingPages.length === 0) {
        const first = engine.state.doc.pages[0]
        const canvas = engine.viewOf(first.id)?.canvas
        if (canvas && canvas.getObjects().length >= first.objects.length) perf.readyAt = now
      }
      if (perf.recording) perf.frames.push(now)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    try {
      new PerformanceObserver((list) => {
        if (perf.recording) for (const entry of list.getEntries()) perf.longTasks.push(entry.duration)
      }).observe({ type: 'longtask', buffered: false })
    } catch {
      /* long tasks are not reported by this browser: the frame intervals still tell */
    }
  })
}

export async function openStress(page: Page, pages: number, objects: number): Promise<void> {
  await instrument(page)
  await page.goto(`/editor-harness.html?doc=stress&pages=${pages}&objects=${objects}`)
  await page.waitForFunction(() => {
    const w = window as unknown as PerfWindow
    return w.__perf.readyAt !== undefined && !!w.__doory_collab
  }, undefined, { timeout: 60_000 })
}

/** Starts recording frames and long tasks. */
export const startRecording = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const perf = (window as unknown as PerfWindow).__perf
    perf.frames = []
    perf.longTasks = []
    perf.recording = true
  })

export interface FrameStats {
  frames: number
  fps: number
  p95FrameMs: number
  maxFrameMs: number
  longTasks: number
  longTaskMs: number
}

/** Stops recording and reduces it. */
export async function stopRecording(page: Page): Promise<FrameStats> {
  const { frames, longTasks } = await page.evaluate(() => {
    const perf = (window as unknown as PerfWindow).__perf
    perf.recording = false
    return { frames: perf.frames, longTasks: perf.longTasks }
  })
  const gaps = frames.slice(1).map((t, i) => t - frames[i])
  const total = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0
  const summary = summarize(gaps)
  return {
    frames: frames.length,
    fps: total > 0 ? Math.round(((frames.length - 1) / total) * 10000) / 10 : 0,
    p95FrameMs: summary.p95Ms,
    maxFrameMs: summary.maxMs,
    longTasks: longTasks.length,
    longTaskMs: Math.round(longTasks.reduce((s, d) => s + d, 0)),
  }
}

export interface Metrics {
  heapMb: number
  nodes: number
  listeners: number
  documents: number
}

/** Heap, DOM nodes and event listeners after a garbage collection (CDP), for leak checks. */
export async function metrics(cdp: CDPSession): Promise<Metrics> {
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  const get = (name: string): number => list.find((m) => m.name === name)?.value ?? 0
  return {
    heapMb: Math.round((get('JSHeapUsedSize') / 1024 / 1024) * 10) / 10,
    nodes: get('Nodes'),
    listeners: get('JSEventListeners'),
    documents: get('Documents'),
  }
}

/** Waits until the page has had no long task for `quietMs` (what an opening design still does in the background has finished). */
export async function waitForQuiet(page: Page, quietMs = 1500, timeoutMs = 60_000): Promise<void> {
  await page.evaluate(
    ([quiet, timeout]) =>
      new Promise<void>((resolve, reject) => {
        let last = performance.now()
        const started = last
        const observer = new PerformanceObserver(() => (last = performance.now()))
        observer.observe({ type: 'longtask', buffered: false })
        const check = (): void => {
          const now = performance.now()
          if (now - last >= quiet) {
            observer.disconnect()
            resolve()
          } else if (now - started > timeout) {
            observer.disconnect()
            reject(new Error('the page never went quiet'))
          } else setTimeout(check, 100)
        }
        check()
      }),
    [quietMs, timeoutMs] as const,
  )
}
