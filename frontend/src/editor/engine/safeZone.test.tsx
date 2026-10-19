import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '@/lib/document'
import { buildCatalogue, setSizePresetsForTests, type SizePresetCatalogue } from '@/lib/sizePresets'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { ChromeProvider } from '../chrome/ChromeContext'
import { EditorProvider } from '../EditorProvider'
import { t } from '../strings'
import { TopBar } from '../TopBar'
import { EditorEngine } from './editor'

const catalogue = buildCatalogue({
  version: 1,
  groups: [
    {
      slug: 'social',
      label: 'Social',
      presets: [
        { slug: 'tall-story', label: 'Story', width: 1080, height: 1920, meta: { safe_zone: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 } } },
        { slug: 'plain', label: 'Plain', width: 1080, height: 1080 },
      ],
    },
  ],
}) as SizePresetCatalogue

/** The top bar measures itself; jsdom has no ResizeObserver, and a desktop-wide bar keeps File and View apart. */
class FakeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([{ contentRect: { width: 1400 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  disconnect(): void {}
  unobserve(): void {}
}

let engine: EditorEngine | null = null
afterEach(() => engine?.dispose())

function open(width: number, height: number, presetId?: string): EditorEngine {
  engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: createBlankDocument(width, height, { presetId }), meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
  return engine
}

describe('safe-zone guides', () => {
  beforeEach(() => setSizePresetsForTests(catalogue))

  it('come from the design’s size preset while the page keeps its size', () => {
    const editor = open(1080, 1920, 'tall-story')
    expect(editor.safeZoneFor(1080, 1920)).toEqual({ top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 })
    expect(editor.safeZoneFor(1920, 1080)).toBeNull()
    expect(editor.showSafeZone).toBe(true)
  })

  it('are absent for presets without one, and for designs without a preset', () => {
    expect(open(1080, 1080, 'plain').safeZoneFor(1080, 1080)).toBeNull()
    engine?.dispose()
    expect(open(1080, 1920).safeZoneFor(1080, 1920)).toBeNull()
  })

  it('can be switched off from the View menu, which only offers them where there are some', async () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    const menuOf = async (editor: EditorEngine) => {
      render(
        <EditorProvider engine={editor} portalRoot={document.body}>
          <ChromeProvider>
            <TopBar onTitle={() => undefined} onPresent={() => undefined} />
          </ChromeProvider>
        </EditorProvider>,
      )
      await userEvent.click(screen.getByRole('button', { name: t.topbar.view }))
      return screen.getByRole('menu', { name: t.topbar.view })
    }
    const editor = open(1080, 1920, 'tall-story')
    await userEvent.click(within(await menuOf(editor)).getByRole('menuitemcheckbox', { name: t.menu.safeZone }))
    expect(editor.state.ui.safeZone).toBe(false)
    cleanup()
    editor.dispose()

    const view = await menuOf(open(1080, 1080, 'plain'))
    expect(within(view).queryByRole('menuitemcheckbox', { name: t.menu.safeZone })).toBeNull()
    cleanup()
    vi.unstubAllGlobals()
  })
})
