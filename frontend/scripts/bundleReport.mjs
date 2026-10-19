#!/usr/bin/env node
/**
 * Size report and budget check of the production build (`npm run build` first; Vite writes `dist/.vite/manifest.json`).
 *
 *   node scripts/bundleReport.mjs            prints the table of chunk sizes
 *   node scripts/bundleReport.mjs --check    also exits 1 when a budget below is exceeded (CI runs it after the build)
 *   node scripts/bundleReport.mjs --json     machine-readable output
 *
 * "Initial JS" of a route is what the browser must download before the page can run: the entry chunk, the route's own
 * chunk and everything those import *statically*. Chunks behind `import()` are not part of it. The editor route also
 * counts the editor chunk (loaded by `LazyEditor` as soon as the route renders) and its static imports, which is what
 * "before the first interaction" means. Sizes are gzip (zlib level 6, like Vite's own report and nginx's default).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const KB = 1000

/** The budgets, in gzipped bytes unless noted. Raise one only with a good reason. */
export const BUDGETS = {
  /**
   * Landing page: entry + landing chunk + their static imports. The aim was 120 kB; React and ReactDOM (71 kB), the data router (33 kB)
   * and TanStack Query (10 kB) already take 114 kB of it, so this guards what the shell has today.
   */
  initialLanding: 170 * KB,
  /** Editor route before the first interaction: entry + page + editor chunk + Fabric + strings + styles. */
  initialEditor: 450 * KB,
  /** The editor chunk itself (its own file, not its imports). */
  editorChunk: 160 * KB,
  /** Any single JS chunk that is not one of the named vendor chunks, minified bytes (Vite's own warning is 500 kB). */
  chunkMinified: 500 * 1000,
}

/** Third-party chunks that are allowed to be large because they are loaded only on the action named. */
const VENDOR_LARGE = new Map([
  ['jspdf', 'first PDF export'],
  ['html2canvas', 'never used by Doory (an optional part of jsPDF)'],
  ['fabric', 'with the editor, own chunk'],
])

/** vite.config.ts names the chunk of `src/editor/index.tsx` `assets/editor-<hash>.js`; its manifest key is the file name without `assets/`. */
const EDITOR_CHUNK = '*editor'

const ROUTES = [
  { name: '/', page: 'src/pages/LandingPage.tsx', budget: BUDGETS.initialLanding },
  { name: '/login', page: 'src/pages/auth/LoginPage.tsx' },
  { name: '/templates', page: 'src/pages/TemplatesPage.tsx' },
  { name: '/dashboard', page: 'src/features/dashboard/DashboardLayout.tsx' },
  { name: '/local/:id (editor)', page: 'src/pages/LocalEditorPage.tsx', also: [EDITOR_CHUNK], budget: BUDGETS.initialEditor },
]

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', process.env.BUNDLE_DIST ?? 'dist')
const manifestPath = join(dist, '.vite', 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`No ${manifestPath}: run "npm run build" first.`)
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const byFile = new Map(Object.entries(manifest).map(([key, chunk]) => [chunk.file, { key, ...chunk }]))

const sizes = new Map()
function sizeOf(file) {
  let size = sizes.get(file)
  if (!size) {
    const bytes = readFileSync(join(dist, file))
    size = { raw: statSync(join(dist, file)).size, gzip: gzipSync(bytes).length }
    sizes.set(file, size)
  }
  return size
}

/** Files (scripts and styles) of a chunk and everything it imports statically. */
function closure(keys) {
  const seen = new Set()
  const files = new Set()
  const visit = (key) => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) throw new Error(`Unknown chunk ${key} in the manifest`)
    files.add(chunk.file)
    for (const css of chunk.css ?? []) files.add(css)
    for (const next of chunk.imports ?? []) visit(next)
  }
  for (const key of keys) visit(key)
  return [...files]
}

const total = (files, pick) => files.reduce((sum, f) => sum + sizeOf(f)[pick], 0)
const scripts = (files) => files.filter((f) => f.endsWith('.js'))
const styles = (files) => files.filter((f) => f.endsWith('.css'))
const entryKey = Object.entries(manifest).find(([, c]) => c.isEntry && c.src === 'index.html')?.[0]
if (!entryKey) throw new Error('No index.html entry in the manifest')

const editorKey = Object.entries(manifest).find(([, c]) => /^assets\/editor-[\w-]+\.js$/.test(c.file))?.[0]
if (!editorKey) throw new Error('No assets/editor-<hash>.js chunk in the manifest (chunkFileNames in vite.config.ts)')

const routes = ROUTES.map((route) => {
  const keys = [entryKey, route.page, ...(route.also ?? []).map((key) => (key === EDITOR_CHUNK ? editorKey : key))]
  for (const key of keys) if (!manifest[key]) throw new Error(`${key} is not in the manifest (moved or renamed? update scripts/bundleReport.mjs)`)
  const files = closure(keys)
  return {
    name: route.name,
    budget: route.budget ?? null,
    chunks: files.length,
    jsGzip: total(scripts(files), 'gzip'),
    jsRaw: total(scripts(files), 'raw'),
    cssGzip: total(styles(files), 'gzip'),
  }
})

const chunks = [...byFile.values()]
  .filter((c) => c.file.endsWith('.js'))
  .map((c) => ({ file: c.file, key: c.key, ...sizeOf(c.file) }))
  .sort((a, b) => b.gzip - a.gzip)

const editorChunk = { file: manifest[editorKey].file, ...sizeOf(manifest[editorKey].file) }

const failures = []
for (const r of routes) if (r.budget !== null && r.jsGzip > r.budget) failures.push(`${r.name}: initial JS ${fmt(r.jsGzip)} gzip is over the budget of ${fmt(r.budget)}`)
if (editorChunk.gzip > BUDGETS.editorChunk) failures.push(`editor chunk ${fmt(editorChunk.gzip)} gzip is over the budget of ${fmt(BUDGETS.editorChunk)}`)
for (const c of chunks) {
  const vendor = [...VENDOR_LARGE.keys()].find((name) => c.file.includes(`/${name}`))
  if (c.raw > BUDGETS.chunkMinified && !vendor) failures.push(`${c.file}: ${fmt(c.raw)} minified is over ${fmt(BUDGETS.chunkMinified)}`)
}

function fmt(bytes) {
  return `${(bytes / KB).toFixed(1)} kB`
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ routes, editorChunk, chunks: chunks.slice(0, 40), budgets: BUDGETS, failures }, null, 2))
} else {
  console.log('Initial JS per route (entry + route chunk + static imports; the editor route includes the editor chunk and Fabric)\n')
  console.log('| Route | JS chunks | JS (gzip) | JS (minified) | CSS (gzip) | Budget |')
  console.log('|-------|----------:|----------:|--------------:|-----------:|-------:|')
  for (const r of routes) console.log(`| ${r.name} | ${r.chunks} | ${fmt(r.jsGzip)} | ${fmt(r.jsRaw)} | ${fmt(r.cssGzip)} | ${r.budget ? `≤ ${fmt(r.budget)}` : ''} |`)
  console.log('\nLargest chunks\n')
  console.log('| Chunk | Minified | Gzip |')
  console.log('|-------|---------:|-----:|')
  for (const c of chunks.slice(0, 16)) console.log(`| ${c.file.replace(/^assets\//, '')} | ${fmt(c.raw)} | ${fmt(c.gzip)} |`)
  console.log(`\nEditor chunk: ${fmt(editorChunk.raw)} minified, ${fmt(editorChunk.gzip)} gzip (budget ${fmt(BUDGETS.editorChunk)})`)
}

if (process.argv.includes('--check')) {
  if (failures.length > 0) {
    console.error(`\nBundle budget exceeded:\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\nBundle budgets: ok')
}
