/**
 * The real editor with one starter template open (`?slug=<slug>`), the real fonts and an in-memory adapter. It exists for
 * `qa.ts`, which drives it with Playwright the way a person would; `window.__qa` gives that script the engine.
 */
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FontFamily, Page } from '@/types/api'
import type { DoryDocument } from '@/types/document'
import '@/styles/tokens.css'
import { EditorApp } from '@/editor/EditorApp'
import { useEditor } from '@/editor/context'
import type { EditorEngine } from '@/editor/engine/editor'
import { createMemoryAdapter, type MemoryAdapterHandle } from '@/editor/dev/memoryAdapter'
import { runExport } from '@/editor/engine/export/exporter'
import { DEFAULT_EXPORT_OPTIONS } from '@/editor/engine/export/registry'

declare global {
  interface Window {
    __qa?: {
      engine: EditorEngine
      memory: MemoryAdapterHandle
      document: DoryDocument
      /** Exports every page in a format (png, jpg, svg, pdf) and reports the files. */
      exportAll(formatId: string): Promise<{ filename: string; bytes: number; type: string }[]>
    }
  }
}

const slug = new URLSearchParams(location.search).get('slug') ?? ''

const style = document.createElement('style')
style.textContent = 'html, body, #root { height: 100%; margin: 0; } body { background: var(--color-bg); color: var(--color-text); font-family: var(--font-sans); }'
document.head.appendChild(style)

export function Probe({ memory, document: doc }: { memory: MemoryAdapterHandle; document: DoryDocument }) {
  const engine = useEditor()
  useEffect(() => {
    window.__qa = {
      engine,
      memory,
      document: doc,
      async exportAll(formatId) {
        const files = await runExport(engine, { formatId, pages: { kind: 'all' }, options: DEFAULT_EXPORT_OPTIONS })
        return files.map((file) => ({ filename: file.filename, bytes: file.blob.size, type: file.blob.type }))
      },
    }
    return () => {
      delete window.__qa
    }
  }, [engine, memory, doc])
  return null
}

export function Editor({ catalog, doc }: { catalog: FontFamily[]; doc: DoryDocument }) {
  const memory = useMemo(() => {
    const handle = createMemoryAdapter()
    const fonts = {
      async list(q: { q?: string }): Promise<Page<FontFamily>> {
        const needle = q.q?.toLowerCase() ?? ''
        const results = catalog.filter((f) => f.family.toLowerCase().includes(needle))
        return { count: results.length, next: null, previous: null, results }
      },
    }
    return { ...handle, adapter: { ...handle.adapter, services: { ...handle.adapter.services, fonts } } }
  }, [catalog])
  return <EditorApp document={doc} meta={{ id: slug, title: slug, mode: 'guest' }} adapter={memory.adapter} topBarEnd={<Probe memory={memory} document={doc} />} />
}

export function App() {
  const [state, setState] = useState<{ catalog: FontFamily[]; doc: DoryDocument } | null>(null)
  useEffect(() => {
    void Promise.all([fetch('/__fonts/catalog.json'), fetch(`/__templates/${slug}.json`)])
      .then(async ([fonts, doc]) => setState({ catalog: (await fonts.json()) as FontFamily[], doc: (await doc.json()) as DoryDocument }))
      .catch(() => document.body.setAttribute('data-failed', 'true'))
  }, [])
  return state ? <Editor catalog={state.catalog} doc={state.doc} /> : null
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
