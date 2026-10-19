// Starts the real backend for the collab specs: Django on SQLite in a fresh temporary directory, served by uvicorn
// (ASGI, so WebSockets work) with the in-memory channel layer (one process). Used by playwright.collab.config.ts.
//
//   DOORY_PYTHON   interpreter with the backend requirements (default: backend/.venv/bin/python, else python3)
//   E2E_COLLAB_API_PORT / E2E_COLLAB_PORT   ports of the API and of the Vite dev server (defaults 8110 / 5380)
//   E2E_COLLAB_CONTROL_PORT                 port of the control server that restarts the API (default: API port + 1)
//   REALTIME_*                              passed through to the API (a spec that needs a short idle time sets them in the config)
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const backend = resolve(here, '../../../backend')
const apiPort = process.env.E2E_COLLAB_API_PORT ?? '8110'
const webPort = process.env.E2E_COLLAB_PORT ?? '5380'
const controlPort = process.env.E2E_COLLAB_CONTROL_PORT ?? String(Number(apiPort) + 1)
const venv = join(backend, '.venv/bin/python')
const python = process.env.DOORY_PYTHON ?? (existsSync(venv) ? venv : 'python3')

const work = join(tmpdir(), `doory-collab-e2e-${apiPort}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const env = {
  ...process.env,
  DJANGO_SETTINGS_MODULE: 'doory.settings.dev',
  // SQLite lets one writer in at a time: wait for the lock (30 s) and take it when a transaction starts, so that two writers queue instead
  // of failing with "database is locked" (a room that saves a big design while the specs create designs). A deployment uses PostgreSQL.
  DATABASE_URL: `sqlite:///${join(work, 'db.sqlite3')}?timeout=30&transaction_mode=IMMEDIATE`,
  MEDIA_ROOT: join(work, 'media'),
  SITE_URL: `http://localhost:${webPort}`,
  CSRF_TRUSTED_ORIGINS: `http://localhost:${webPort},http://127.0.0.1:${webPort}`,
  REDIS_URL: '',
  EMAIL_BACKEND: 'django.core.mail.backends.locmem.EmailBackend',
}

const migrate = spawnSync(python, ['manage.py', 'migrate', '--noinput'], { cwd: backend, env, stdio: 'inherit' })
if (migrate.status !== 0) process.exit(migrate.status ?? 1)

function launch() {
  return spawn(python, ['-m', 'uvicorn', 'doory.asgi:application', '--host', '127.0.0.1', '--port', apiPort, '--log-level', 'warning'], { cwd: backend, env, stdio: 'inherit' })
}

let server = launch()
let stopping = false
let restarting = false
const stop = () => {
  stopping = true
  server.kill('SIGTERM')
  control.close()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
server.on('exit', onExit)

function onExit(code) {
  if (!restarting) process.exit(code ?? 0)
}

async function healthy() {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/v1/health/`)).ok) return
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  throw new Error('the API did not come back')
}

/** Stops the API process ('graceful' = SIGTERM, 'crash' = SIGKILL); the database stays, so the next process finds what the last one left. */
async function halt(mode) {
  if (server.exitCode !== null || server.signalCode !== null) return
  restarting = true
  const gone = once(server, 'exit')
  server.kill(mode === 'crash' ? 'SIGKILL' : 'SIGTERM')
  await gone
}

async function bring() {
  server = launch()
  server.on('exit', onExit)
  restarting = false
  await healthy()
}

// A tiny control port for the chaos specs: stop, start or restart the API process while browsers are connected.
//   POST /restart?mode=crash|graceful        POST /halt?mode=crash|graceful        POST /start
const control = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const mode = url.searchParams.get('mode') === 'crash' ? 'crash' : 'graceful'
  try {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    if (stopping) throw new Error('shutting down')
    if (url.pathname === '/restart') {
      await halt(mode)
      await bring()
    } else if (url.pathname === '/halt') await halt(mode)
    else if (url.pathname === '/start') await bring()
    else {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
  }
})
control.listen(Number(controlPort), '127.0.0.1')
