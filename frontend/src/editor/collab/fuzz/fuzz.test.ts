import { OP_KINDS, type OpKind } from './ops'
import type { Step } from './ops'
import { type Script, describeScript, generateScript, runScript, shrink } from './model'
import { REGRESSIONS, UNDO_AFTER_REMOVAL } from './regressions'
import { newSharedDoc } from '../room'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const EXCLUDE = (process.env.FUZZ_EXCLUDE ?? '').split(',').filter(Boolean) as OpKind[]

/** How many seeded runs each property gets (raise it for a long soak: `FUZZ_RUNS=2000 npx vitest run fuzz`). */
const RUNS = Number(process.env.FUZZ_RUNS ?? 120)
const FIRST = Number(process.env.FUZZ_FIRST ?? 1)

vi.setConfig({ testTimeout: 300_000 })

let runs = 0

async function expectClean(script: Script, label: string): Promise<void> {
  // A long soak must not starve the test runner of its heartbeat.
  if (++runs % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  const { failure } = await runScript(script)
  if (!failure) return
  const small = await shrink(script, failure)
  const again = await runScript(small)
  throw new Error(`${label} failed with ${failure.kind} after step ${failure.at}: ${failure.detail}\nShrunk to ${small.steps.length} steps (${again.failure?.kind}: ${again.failure?.detail}):\n${describeScript(small)}`)
}

describe('co-editing fuzz: editors, a server and a network that delays, repeats, reorders and cuts', () => {
  it('converges, stays a saveable design and never turns remote changes into undo steps (random edits)', async () => {
    for (let seed = FIRST; seed < FIRST + RUNS; seed++) await expectClean(generateScript(seed, { exclude: EXCLUDE }), `seed ${seed}`)
  })

  it('keeps every edit when people edit one after the other (the shared design equals the plain result)', async () => {
    for (let seed = FIRST; seed < FIRST + RUNS; seed++) await expectClean(generateScript(seed, { sequential: true, steps: 40, exclude: EXCLUDE }), `sequential seed ${seed}`)
  })

  it('keeps undo and redo local when everybody edits the same few things', async () => {
    const ops = ['opacity', 'fill', 'move', 'rotate', 'delete', 'duplicate', 'zorder', 'lock', 'hide', 'shadow', 'pageRemove', 'pageAdd', 'pageBackground'] as const
    for (let seed = FIRST; seed < FIRST + RUNS; seed++) await expectClean(generateScript(seed + 7000, { peers: 3, steps: 120, ops: ops.filter((op) => !EXCLUDE.includes(op)), weights: { undo: 22, redo: 10, op: 40 } }), `undo seed ${seed}`)
  })

  it('survives long runs with many editors', async () => {
    for (let seed = FIRST; seed < FIRST + Math.max(3, Math.floor(RUNS / 12)); seed++) await expectClean(generateScript(seed + 5000, { peers: 4, steps: 220, exclude: EXCLUDE }), `long seed ${seed}`)
  })

  it('exercises every kind of edit', async () => {
    for (const op of OP_KINDS) await expectClean(generateScript(OP_KINDS.indexOf(op) + 9000, { steps: 40, ops: [op], weights: { restore: 0 } }), `only ${op}`)
  })

  it.each(REGRESSIONS.map((r) => [r.name, r.script] as const))('stays fixed: %s', async (_name, script) => {
    await expectClean(script, 'regression')
  })
})

const step = (p: number, k: Step['k'], extra: Partial<Step> = {}): Step => ({ p, k, a: 1, b: 2, c: 3, d: 4, n: 0, dt: 0, ...extra })

describe('local undo with other people around', () => {
  const overwritten = (): Script => ({
    doc: 1,
    peers: 2,
    steps: [
      step(0, 'join'),
      step(1, 'join'),
      step(0, 'op', { op: 'opacity', c: 10, n: 1 }),
      step(0, 'send'),
      step(1, 'recv'),
      step(1, 'flush'),
      step(1, 'op', { op: 'opacity', c: 90, n: 2 }),
      step(1, 'send'),
      step(0, 'recv'),
      step(0, 'flush'),
      step(0, 'undo'),
    ],
  })

  it('does not take back a property somebody else changed after the user did', async () => {
    expect((await runScript(overwritten())).failure).toBeNull()
  })
})

describe('the shared document', () => {
  it('keeps what was deleted, because Yjs\' undo manager breaks on collected content', async () => {
    expect(newSharedDoc().gc).toBe(false)
    // The same script with Yjs' default fails inside the undo manager: if this ever passes, the setting can go.
    const collected = await runScript(UNDO_AFTER_REMOVAL, { collectGarbage: true })
    expect(collected.failure?.kind).toBe('exception')
    expect(collected.failure?.detail).toContain('redoItem')
  })
})

describe('the harness itself', () => {
  it('notices an editor that shows something other than the shared state, and shrinks the run to a few steps', async () => {
    const script = generateScript(3, { steps: 40 })
    const { failure } = await runScript(script, { sabotage: true })
    expect(failure?.kind).toBe('editor-differs')
    const small = await shrink(script, failure as NonNullable<typeof failure>, 200, { sabotage: true })
    expect(small.steps.length).toBeLessThanOrEqual(8)
    expect((await runScript(small, { sabotage: true })).failure?.kind).toBe('editor-differs')
    expect((await runScript(small)).failure).toBeNull()
  })

  it('replays the same script to the same result', async () => {
    const script = generateScript(11, { steps: 50 })
    const first = await runScript(script, { record: true })
    const second = await runScript(script, { record: true })
    expect(first.failure).toBeNull()
    expect(second.recording?.document).toEqual(first.recording?.document)
    expect(second.recording?.updates.map((u) => Array.from(u))).toEqual(first.recording?.updates.map((u) => Array.from(u)))
  })
})

/** Fixture for the server's replay test: `FUZZ_FIXTURE=../backend/apps/collab/tests/fixtures/fuzz_replay.json npx vitest run fuzz -t fixture`. */
const FIXTURE = process.env.FUZZ_FIXTURE
const FIXTURE_SEEDS = [41, 43, 47, 53, 59, 61, 67, 71]

describe.skipIf(!FIXTURE)('replay fixture for the backend', () => {
  it('records what the server received from the editors, and the design it ended with', async () => {
    const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
    const cases = []
    for (const seed of FIXTURE_SEEDS) {
      const { failure, recording } = await runScript(generateScript(seed, { peers: 3, steps: 70 }), { record: true })
      expect(failure).toBeNull()
      const run = recording as NonNullable<typeof recording>
      cases.push({ seed, initial: b64(run.initial), updates: run.updates.map(b64), document: run.document })
    }
    mkdirSync(dirname(FIXTURE as string), { recursive: true })
    writeFileSync(FIXTURE as string, `${JSON.stringify(cases)}\n`)
  })
})
