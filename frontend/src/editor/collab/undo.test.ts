import * as Y from 'yjs'
import { LOCAL_ORIGIN } from './binding'
import { rootsOf } from './schema'
import { LocalUndo, type Place } from './undo'
import { newSharedDoc } from './room'

const place: Place = { activePageId: 'p', selection: [] }

function peer(clientID: number, base: Uint8Array) {
  const doc = newSharedDoc()
  doc.clientID = clientID
  Y.applyUpdate(doc, base)
  const steps = new LocalUndo(rootsOf(doc), LOCAL_ORIGIN, () => undefined)
  const set = (key: string, value: unknown): void => {
    steps.begin({ label: key, before: place, after: place })
    doc.transact(() => doc.getMap('meta').set(key, value), LOCAL_ORIGIN)
  }
  return { doc, steps, set, meta: doc.getMap('meta') }
}

function pair() {
  const seed = new Y.Doc()
  seed.clientID = 99
  seed.getMap('meta').set('width', 800)
  seed.getMap('meta').set('fill', 'red')
  const base = Y.encodeStateAsUpdate(seed)
  const a = peer(1, base)
  const b = peer(2, base)
  const exchange = (): void => {
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))
  }
  return { a, b, exchange }
}

describe('local undo when somebody set the same property at the same time', () => {
  it('puts the old value back instead of leaving the property without a value', () => {
    const { a, b, exchange } = pair()
    a.set('width', 1000)
    b.set('width', 2000)
    exchange()
    const winner = a.meta.get('width') === 2000 ? b : a
    const other = winner === a ? b : a
    winner.steps.undo()
    expect(winner.meta.get('width')).toBe(800)
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(winner.doc))
    expect(other.meta.get('width')).toBe(800)
  })

  it('does so for any property, and still removes a property the user added', () => {
    const { a, b, exchange } = pair()
    a.set('fill', 'green')
    b.set('fill', 'blue')
    exchange()
    const winner = a.meta.get('fill') === 'green' ? a : b
    winner.steps.undo()
    expect(winner.meta.get('fill')).toBe('red')
    winner.set('added', 1)
    winner.steps.undo()
    expect(winner.meta.has('added')).toBe(false)
    expect(winner.meta.get('fill')).toBe('red')
  })

  it('still undoes and redoes an ordinary change', () => {
    const { a } = pair()
    a.set('width', 1000)
    a.steps.undo()
    expect(a.meta.get('width')).toBe(800)
    a.steps.redo()
    expect(a.meta.get('width')).toBe(1000)
  })
})
