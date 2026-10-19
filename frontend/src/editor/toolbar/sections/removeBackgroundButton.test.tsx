import { render, screen, waitFor } from '@testing-library/react'
import { FabricImage } from 'fabric'
import { createBlankDocument } from '@/lib/document'
import type { AiService } from '@/types/adapter'
import type { AiOption } from '@/types/api'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { EditorProvider } from '../../EditorProvider'
import { registerBackgroundRemover } from '../../engine/bgRemoval'
import { EditorEngine } from '../../engine/editor'
import { installImageStub } from '../../test/imageStub'
import { ImageSection } from './image'

const SERVER: AiOption = { id: 'env-1:', label: 'High quality (server)', task: 'background-removal', kind: 'server', provider_name: 'Model server', owner: 'operator', sends_offsite: false }

function aiWith(models: AiOption[]): AiService {
  return { options: vi.fn(async () => ({ default: null, models })), run: vi.fn(), remembered: () => null, remember: vi.fn() }
}

async function renderSection(ai: AiService | null) {
  const handle = createMemoryAdapter()
  handle.adapter.services.ai = ai
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'account' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  await engine.insert.imageFiles([new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' })])
  await vi.waitFor(() => expect(view.canvas.getObjects()).toHaveLength(1))
  render(
    <EditorProvider engine={engine} portalRoot={document.body}>
      <ImageSection />
    </EditorProvider>,
  )
  return engine
}

describe('Remove background button', () => {
  let restore: () => void
  let engine: EditorEngine | null = null
  beforeEach(() => {
    restore = installImageStub({ width: 200, height: 100 })
    vi.spyOn(FabricImage.prototype, '_render').mockImplementation(() => undefined)
    URL.createObjectURL = vi.fn(() => 'blob:fake')
  })
  afterEach(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    engine?.dispose()
    engine = null
    registerBackgroundRemover(null)
    vi.restoreAllMocks()
    restore()
    document.body.innerHTML = ''
  })

  it('is shown for a server option even when this browser has no model', async () => {
    engine = await renderSection(aiWith([SERVER]))
    expect(await screen.findByTestId('ed-remove-bg')).toBeInTheDocument()
  })

  it('is not shown with neither a model in this browser nor a server option', async () => {
    const ai = aiWith([])
    engine = await renderSection(ai)
    await waitFor(() => expect(ai.options).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.queryByTestId('ed-remove-bg')).toBeNull()
  })

  it('is shown for the in-browser model as before, without asking a server', async () => {
    registerBackgroundRemover({ remove: async (image) => image })
    engine = await renderSection(null)
    expect(screen.getByTestId('ed-remove-bg')).toBeInTheDocument()
  })
})
