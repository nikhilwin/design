import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FREE_PORT = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"

function freePort(): number {
  return Number(execFileSync(process.execPath, ['-e', FREE_PORT], { encoding: 'utf8' }))
}

export interface AppStack {
  web: number
  api: number
  smtp: number
  /** Database, uploads and the e-mails the API sent (`mail/*.eml`). */
  work: string
}

/**
 * The ports and the work directory of the real-stack specs. They are chosen once, in the Playwright runner, and handed
 * to the web servers and the workers through the environment, so nothing assumes that 5173 or 8000 are free (other
 * checkouts on the same machine run their own servers). Set `E2E_APP_WEB_PORT` / `E2E_APP_API_PORT` /
 * `E2E_APP_SMTP_PORT` to pin them.
 */
export function appStack(): AppStack {
  const pick = (name: string): number => {
    const fixed = Number(process.env[name])
    if (Number.isInteger(fixed) && fixed > 0) return fixed
    const port = freePort()
    process.env[name] = String(port)
    return port
  }
  const web = pick('E2E_APP_WEB_PORT')
  const api = pick('E2E_APP_API_PORT')
  const smtp = pick('E2E_APP_SMTP_PORT')
  const work = process.env.E2E_APP_WORK ?? join(tmpdir(), `doory-app-e2e-${api}`)
  process.env.E2E_APP_WORK = work
  return { web, api, smtp, work }
}
