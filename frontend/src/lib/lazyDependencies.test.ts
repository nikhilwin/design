import { describe, expect, it } from 'vitest'

/**
 * The heavy libraries are only worth their size when nobody pays for them up front: a static `import ... from`
 * of any of them in code the entry chunk reaches would put it into every visitor's first download. This reads the sources, so it holds whatever the bundler does.
 */
const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })

/** Where each library may be imported statically (and why). */
const STATIC_IMPORTS_ALLOWED_IN: Record<string, string[]> = {
  // Everything below is reached only through `import('./bundled')` and the worker it starts.
  'onnxruntime-web': ['/src/editor/engine/bgRemoval/session.ts', '/src/editor/engine/bgRemoval/bundled.ts'],
  // Behind `await import()` at the point of use.
  jspdf: [],
  fflate: [],
  qrcode: [],
  html2canvas: [],
  // The video export: the muxers behind `import()` in `video/container.ts`, the GIF encoder in the one file that is itself
  // only loaded when a GIF is made (`gif.ts`, reached from the GIF worker and, where there is none, `import('./gif')` in
  // `video/gifSink.ts`).
  'mp4-muxer': [],
  'webm-muxer': [],
  gifenc: ['/src/editor/engine/export/video/gif.ts'],
}

const staticImport = (library: string): RegExp => new RegExp(`^\\s*(?:import|export)\\s[^;]*?from\\s+['"]${library}(?:/[^'"]*)?['"]`, 'm')
const bareImport = (library: string): RegExp => new RegExp(`^\\s*import\\s+['"]${library}['"]`, 'm')

describe('heavy dependencies', () => {
  it('finds the sources it checks', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100)
    expect(Object.keys(sources)).toContain('/src/editor/engine/export/formats.ts')
  })

  it.each(Object.entries(STATIC_IMPORTS_ALLOWED_IN))('%s is imported statically only where allowed', (library, allowed) => {
    const offenders = Object.entries(sources)
      .filter(([path, code]) => (staticImport(library).test(code) || bareImport(library).test(code)) && !allowed.includes(path))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it.each([
    ['jspdf', '/src/editor/engine/export/formats.ts'],
    ['fflate', '/src/editor/engine/export/zip.ts'],
    ['qrcode', '/src/editor/engine/objects/qr.ts'],
    ['mp4-muxer', '/src/editor/engine/export/video/container.ts'],
    ['webm-muxer', '/src/editor/engine/export/video/container.ts'],
  ])('%s is loaded with import() where it is used', (library, path) => {
    expect(sources[path]).toContain(`import('${library}')`)
  })

  /** The parts of the video export that are only worth their size when somebody makes a video. */
  const VIDEO_PARTS = ['pipeline', 'container', 'gif', 'gifPixels', 'gifSink', 'gifWorker', 'recorder', 'composer', 'webmDuration', 'VideoSection']

  it('the video pipeline is reached only through import(), from the format registry and the dialog', () => {
    const staticVideoImport = new RegExp(`^\\s*(?:import|export)\\s+(?!type\\b)(?:(?!\\bimport\\b)[^;])*?from\\s+['"][^'"]*video/(?:${VIDEO_PARTS.join('|')})['"]`, 'm')
    const offenders = Object.entries(sources)
      .filter(([path, code]) => !path.startsWith('/src/editor/engine/export/video/') && staticVideoImport.test(code))
      .map(([path]) => path)
    expect(offenders).toEqual([])
    expect(sources['/src/editor/engine/export/video/formats.ts']).toContain("import('./pipeline')")
    expect(sources['/src/editor/engine/export/video/pipeline.ts']).toContain("import('./gifSink')")
    expect(sources['/src/editor/engine/export/video/gifSink.ts']).toContain("import('./gif')")
    expect(sources['/src/editor/engine/export/video/pipeline.ts']).toContain("import('./recorder')")
    expect(sources['/src/editor/dialogs/VideoSectionLoader.tsx']).toContain("import('./video/VideoSection')")
    expect(sources['/src/editor/dialogs/video/useVideoJob.ts']).toContain("import('../../engine/export/video/pipeline')")
  })

  it('inside the video folder only the pipeline (and the GIF worker, for gif.ts) imports the heavy parts, and the muxers stay behind import()', () => {
    const inside = Object.entries(sources).filter(([path]) => path.startsWith('/src/editor/engine/export/video/') && !path.endsWith('/pipeline.ts') && !path.endsWith('/gifWorker.ts'))
    const staticLocal = new RegExp(`^\\s*import\\s+(?!type\\b)(?:(?!\\bimport\\b)[^;])*?from\\s+['"]\\./(?:gif|gifSink|gifWorker|recorder|pipeline|container)['"]`, 'm')
    expect(inside.filter(([, code]) => staticLocal.test(code)).map(([path]) => path)).toEqual([])
  })

  it('the editor itself is loaded with import() by the shell', () => {
    expect(sources['/src/features/editor/LazyEditor.tsx']).toContain("import('@/editor')")
    const eager = Object.entries(sources).filter(([path, code]) => !path.startsWith('/src/editor/') && /from\s+['"]@\/editor['"]/.test(code))
    expect(eager.map(([path]) => path)).toEqual([])
  })
})
