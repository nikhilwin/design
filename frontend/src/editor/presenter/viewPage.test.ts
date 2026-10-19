/**
 * The presenter view is a page of its own. Its promise to the CSP is that it carries
 * no inline script, and the build must know about it, or the window would 404 in production.
 */
import { describe, expect, it } from 'vitest'

const files = import.meta.glob<string>(['/presenter-view.html', '/vite.config.ts'], { query: '?raw', import: 'default', eager: true })
const frontend = (file: string): string => files[`/${file}`] ?? ''

describe('presenter-view.html', () => {
  const html = frontend('presenter-view.html')

  it('is found', () => {
    expect(html.length).toBeGreaterThan(100)
  })

  it('has no inline script and no inline event handler', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="[^"]+"/)
      expect(body.trim()).toBe('')
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/javascript:/i)
  })

  it('loads the presenter view entry', () => {
    expect(html).toContain('src="/src/editor/presenter/view/main.tsx"')
    expect(html).toContain('<div id="root">')
  })

  it('is marked noindex, so a session link is never listed', () => {
    expect(html).toMatch(/<meta name="robots" content="noindex"/)
  })

  it('is an input of the production build', () => {
    expect(frontend('vite.config.ts')).toMatch(/presenter-view\.html/)
  })
})
