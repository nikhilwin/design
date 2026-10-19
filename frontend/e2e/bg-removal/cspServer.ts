/**
 * A tiny static server that behaves like the production web container for the headers that matter here:
 * it serves the built app (`dist/`) with the exact security headers of `nginx/security-headers.conf`
 * (read from the file, so the test cannot drift from the policy that ships), `/media/` from a directory
 * with the long-cache, nosniff and sandbox headers of the nginx `/media/` location, and falls back to
 * `index.html` for client-side routes. `/api/` is left to the test (Playwright route mocks).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

export interface CspServerOptions {
  /** The production build (`vite build`). */
  dist: string
  /** Directory served under `/media/` (the API's MEDIA_ROOT). */
  mediaRoot: string
  /** Rewrites the policy, for tests of what happens when it is stricter than the app needs. */
  policy?: (policy: string) => string
  /** Send COOP `same-origin` and COEP `require-corp`, which makes the page cross-origin isolated (threads). */
  isolate?: boolean
  /** Headers file to read the policy from. */
  headersFile?: string
}

export interface CspServer {
  origin: string
  /** Every path requested, in order. */
  requests: string[]
  policy: string
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

/** `add_header Name "value" always;` lines of an nginx snippet (the HSTS line uses a variable and is skipped). */
export function readSecurityHeaders(file: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const match of readFileSync(file, 'utf8').matchAll(/^\s*add_header\s+(\S+)\s+"([^"]*)"\s+always;/gm)) headers[match[1]] = match[2]
  return headers
}

export async function startCspServer(options: CspServerOptions): Promise<CspServer> {
  const dist = path.resolve(options.dist)
  const media = path.resolve(options.mediaRoot)
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error(`${dist}/index.html is missing: run "npm run build" first.`)
  const headers = readSecurityHeaders(options.headersFile ?? path.resolve('nginx/security-headers.conf'))
  const policy = options.policy ? options.policy(headers['Content-Security-Policy']) : headers['Content-Security-Policy']
  headers['Content-Security-Policy'] = policy
  if (options.isolate) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
  }
  const requests: string[] = []

  const inside = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep)

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    requests.push(url.pathname)
    const send = (status: number, extra: Record<string, string>, file?: string): void => {
      response.writeHead(status, extra)
      if (file && request.method !== 'HEAD') createReadStream(file).pipe(response)
      else response.end()
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return send(400, {})
    }

    if (pathname.startsWith('/media/')) {
      const file = path.resolve(media, pathname.slice('/media/'.length))
      if (!inside(media, file) || !existsSync(file) || !statSync(file).isFile()) return send(404, { 'Content-Type': 'text/plain' })
      return send(
        200,
        {
          'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
          'Content-Length': String(statSync(file).size),
          'Cache-Control': 'public, max-age=2592000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          // Under COEP require-corp a same-origin resource needs no header, but be explicit like a CDN would.
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
        file,
      )
    }
    if (pathname.startsWith('/api/')) return send(404, { 'Content-Type': 'application/json' })

    const file = path.resolve(dist, `.${pathname}`)
    const exists = inside(dist, file) && existsSync(file) && statSync(file).isFile()
    if (exists) {
      const hashed = pathname.startsWith('/assets/')
      return send(
        200,
        {
          ...headers,
          'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
          'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
        file,
      )
    }
    if (pathname.startsWith('/assets/') || path.extname(pathname)) return send(404, { 'Content-Type': 'text/plain' })
    return send(200, { ...headers, 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }, path.join(dist, 'index.html'))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    policy,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
