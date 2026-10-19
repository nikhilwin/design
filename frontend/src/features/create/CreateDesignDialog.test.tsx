import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildCatalogue, setSizePresetsForTests, type SizePresetCatalogue } from '@/lib/sizePresets'
import { renderWithProviders } from '@/test/utils'
import { CreateDesignDialog } from './CreateDesignDialog'

const custom = buildCatalogue({
  version: 1,
  groups: [
    {
      slug: 'social',
      label: 'Social media',
      children: [
        {
          slug: 'platform-a',
          label: 'Platform A',
          children: [
            {
              slug: 'platform-a-feed',
              label: 'Feed',
              presets: [
                { slug: 'example-portrait', label: 'Portrait post', width: 1000, height: 1250, tags: ['4:5', 'paid'] },
                { slug: 'example-square', label: 'Square post', width: 1000, height: 1000, tags: ['1:1'] },
              ],
            },
          ],
        },
      ],
    },
    { slug: 'print', label: 'Print', presets: [{ slug: 'card', label: 'Card', width: 85, height: 55, unit: 'mm' }] },
  ],
}) as SizePresetCatalogue

const presetButtons = () => within(screen.getByRole('tabpanel')).queryAllByRole('button').filter((b) => !b.hasAttribute('aria-pressed'))

describe('Create a design dialog', () => {
  beforeEach(() => setSizePresetsForTests(custom))

  it('shows each group of presets under its full path, with the size as the catalogue defines it', () => {
    renderWithProviders(<CreateDesignDialog open onClose={() => undefined} />)
    expect(screen.getByRole('region', { name: 'Social media › Platform A › Feed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Card\s*85 × 55 mm/ })).toBeInTheDocument()
  })

  it('narrows to a top-level group and back', async () => {
    renderWithProviders(<CreateDesignDialog open onClose={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: 'Print', pressed: false }))
    expect(presetButtons().map((b) => b.textContent)).toEqual(['Card85 × 55 mm'])
    await userEvent.click(screen.getByRole('button', { name: 'All sizes' }))
    expect(presetButtons()).toHaveLength(3)
  })

  it('filters by tag and searches tags too', async () => {
    renderWithProviders(<CreateDesignDialog open onClose={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: 'paid' }))
    expect(presetButtons().map((b) => b.textContent)).toEqual(['Portrait post1000 × 1250 px'])
    await userEvent.click(screen.getByRole('button', { name: 'paid' }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search sizes' }), '1:1')
    expect(presetButtons().map((b) => b.textContent)).toEqual(['Square post1000 × 1000 px'])
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search sizes' }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search sizes' }), 'zzzz')
    expect(screen.getByText('No matching size')).toBeInTheDocument()
  })

  it('offers the built-in sizes by default', () => {
    setSizePresetsForTests()
    renderWithProviders(<CreateDesignDialog open onClose={() => undefined} />)
    expect(screen.getByRole('button', { name: /Instagram Story/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Print › Paper sizes' })).toBeInTheDocument()
  })
})
