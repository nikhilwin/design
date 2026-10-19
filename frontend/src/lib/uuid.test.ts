import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuid } from './uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the browser function when it exists', () => {
    expect(uuid()).toMatch(V4)
  })

  it('still makes version-4 UUIDs where crypto.randomUUID does not exist (plain-http pages)', () => {
    const real = globalThis.crypto
    // A page on http://192.168.x.x has `getRandomValues` but no `randomUUID`.
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) })
    const ids = new Set(Array.from({ length: 500 }, () => uuid()))
    expect(ids.size).toBe(500)
    for (const id of ids) expect(id).toMatch(V4)
  })

  it('sets the version and variant bits whatever the random bytes are', () => {
    for (const fill of [0x00, 0xff]) {
      vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(fill) })
      expect(uuid()).toMatch(V4)
    }
  })
})

/** `crypto.randomUUID` is missing on plain-http pages: every caller must go through `uuid()`. */
describe('no direct crypto.randomUUID', () => {
  const root = join(process.cwd(), 'src')
  const skip = new Set([join(root, 'lib', 'uuid.ts'), join(root, 'lib', 'uuid.test.ts'), join(root, 'editor', 'collab', 'fuzz', 'ops.ts')])
  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) yield* files(path)
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path
    }
  }

  it('is called only from lib/uuid.ts', () => {
    const offenders = [...files(root)].filter((f) => !skip.has(f) && /\brandomUUID\b/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(offenders).toEqual([])
  })
})
