// Starts the real backend for the app-shell specs (`npm run e2e:app`): Django on SQLite in a fresh temporary directory,
// the starter content installed offline, a local SMTP sink that keeps every e-mail the API sends, and uvicorn on top.
//
//   DOORY_PYTHON       interpreter with the backend requirements (default: backend/.venv/bin/python, else python3)
//   E2E_APP_API_PORT   port of the API; E2E_APP_SMTP_PORT port of the mail sink; E2E_APP_WEB_PORT port of the web server
//   E2E_APP_WORK       directory for the database, uploads and mail (wiped on start); the specs read the mail from it
//   E2E_APP_ENV        extra settings for the API as a JSON object, e.g. {"MAX_DESIGNS_PER_USER": "40"}
//
// Settings: `e2e_settings.py` next to this file (the development settings, minus the per-address sign-in rate limit).
//
// Content: the 14 template categories, the ten starter templates, Doory's own 572 CC0 shapes and graphics, and a font
// catalogue made of the two typefaces the app already ships (Inter, Plus Jakarta Sans), so nothing is downloaded.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backend = resolve(here, '../../../backend')
const frontend = resolve(here, '../..')
const apiPort = process.env.E2E_APP_API_PORT ?? '8210'
const webPort = process.env.E2E_APP_WEB_PORT ?? '5410'
const smtpPort = Number(process.env.E2E_APP_SMTP_PORT ?? 2510)
const venv = join(backend, '.venv/bin/python')
const python = process.env.DOORY_PYTHON ?? (existsSync(venv) ? venv : 'python3')
const work = process.env.E2E_APP_WORK
if (!work) throw new Error('E2E_APP_WORK is required')

rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'mail'), { recursive: true })
mkdirSync(join(work, 'fonts'), { recursive: true })

const fontFiles = [
  ['inter', 'inter/files/inter-latin-wght-normal.woff2', 'inter/files/inter-latin-wght-italic.woff2'],
  ['plus-jakarta-sans', 'plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2', 'plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-italic.woff2'],
]
for (const [id, normal, italic] of fontFiles) {
  for (const weight of [400, 700]) {
    copyFileSync(join(frontend, 'node_modules/@fontsource-variable', normal), join(work, 'fonts', `${id}-latin-${weight}-normal.woff2`))
    copyFileSync(join(frontend, 'node_modules/@fontsource-variable', italic), join(work, 'fonts', `${id}-latin-${weight}-italic.woff2`))
  }
}

const env = {
  ...process.env,
  DJANGO_SETTINGS_MODULE: 'e2e_settings',
  PYTHONPATH: [here, process.env.PYTHONPATH].filter(Boolean).join(':'),
  DATABASE_URL: `sqlite:///${join(work, 'db.sqlite3')}`,
  MEDIA_ROOT: join(work, 'media'),
  SITE_URL: `http://localhost:${webPort}`,
  CSRF_TRUSTED_ORIGINS: `http://localhost:${webPort},http://127.0.0.1:${webPort}`,
  CORS_ALLOWED_ORIGINS: `http://localhost:${webPort}`,
  REDIS_URL: '',
  EMAIL_URL: `smtp://127.0.0.1:${smtpPort}`,
  EMAIL_SEND_ASYNC: 'false',
  ...JSON.parse(process.env.E2E_APP_ENV ?? '{}'),
}

const manage = (...args) => {
  const run = spawnSync(python, ['manage.py', ...args], { cwd: backend, env, stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
manage('migrate', '--noinput')
manage('seed_gallery')
manage('seed_templates')
manage('seed_elements')
manage('sync_fonts', '--from-dir', join(work, 'fonts'))

// A minimal SMTP server: accepts everything and writes each message to <work>/mail/<n>.eml.
let mailCount = 0
createServer((socket) => {
  let inData = false
  let body = ''
  let buffer = ''
  const reply = (line) => socket.write(`${line}\r\n`)
  reply('220 doory-e2e ESMTP')
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      if (inData) {
        body += buffer
        buffer = ''
        const end = body.indexOf('\r\n.\r\n')
        if (end === -1) return
        mailCount += 1
        writeFileSync(join(work, 'mail', `${String(mailCount).padStart(4, '0')}.eml`), body.slice(0, end))
        buffer = body.slice(end + 5)
        body = ''
        inData = false
        reply('250 queued')
        continue
      }
      const eol = buffer.indexOf('\r\n')
      if (eol === -1) return
      const line = buffer.slice(0, eol)
      buffer = buffer.slice(eol + 2)
      const verb = line.slice(0, 4).toUpperCase()
      if (verb === 'EHLO' || verb === 'HELO') reply('250 doory-e2e')
      else if (verb === 'DATA') {
        inData = true
        reply('354 end with <CRLF>.<CRLF>')
      } else if (verb === 'QUIT') {
        reply('221 bye')
        socket.end()
        return
      } else reply('250 ok')
    }
  })
  socket.on('error', () => undefined)
}).listen(smtpPort, '127.0.0.1')

const server = spawn(python, ['-m', 'uvicorn', 'doory.asgi:application', '--host', '127.0.0.1', '--port', apiPort, '--log-level', 'warning'], { cwd: backend, env, stdio: 'inherit' })
const stop = () => server.kill('SIGTERM')
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
server.on('exit', (code) => process.exit(code ?? 0))
