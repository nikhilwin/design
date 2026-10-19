// A reference Yjs client for the collab tests. It speaks the y-websocket protocol with the real `yjs`,
// `y-protocols` and `lib0` implementations, but instead of a socket it reads and writes JSON lines, so the
// Python tests can bridge it to the server without a network:
//
//   stdin  {"in": "<base64 binary frame from the server>"}           a frame to process
//          {"cmd": "open"}                                            produce the opening sync step 1
//          {"cmd": "setProp", "page": 0, "object": 0, "prop": "left", "value": 5}
//          {"cmd": "addObject", "page": 0, "id": "n1", "props": {...}}
//          {"cmd": "moveObject", "page": 0, "from": 1, "to": 0}
//          {"cmd": "awareness", "state": {...}}
//          {"cmd": "snapshot"}                                        print the document as JSON
//          {"cmd": "awarenessStates"} · {"cmd": "clientId"}
// Every input line is answered with {"done": true} after any output it caused.
//   stdout {"out": "<base64 binary frame for the server>"}
//          {"snapshot": {...}}
import * as readline from 'node:readline'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_AUTH = 2
const MESSAGE_QUERY_AWARENESS = 3

const doc = new Y.Doc()
const meta = doc.getMap('meta')
const pageOrder = doc.getArray('pageOrder')
const pages = doc.getMap('pages')
const awareness = new awarenessProtocol.Awareness(doc)
const ORIGIN = 'server'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const emit = (encoder) => {
  if (encoding.length(encoder) > 0) send({ out: Buffer.from(encoding.toUint8Array(encoder)).toString('base64') })
}

doc.on('update', (update, origin) => {
  if (origin === ORIGIN) return
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  emit(encoder)
})

awareness.on('update', ({ added, updated, removed }, origin) => {
  if (origin === ORIGIN) return
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]))
  emit(encoder)
})

const handle = (frame) => {
  const decoder = decoding.createDecoder(frame)
  const encoder = encoding.createEncoder()
  const type = decoding.readVarUint(decoder)
  if (type === MESSAGE_SYNC) {
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, doc, ORIGIN)
    if (encoding.length(encoder) > 1) emit(encoder)
  } else if (type === MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), ORIGIN)
  } else if (type === MESSAGE_AUTH) {
    decoding.readVarUint(decoder)
    send({ denied: decoding.readVarString(decoder) })
  } else if (type === MESSAGE_QUERY_AWARENESS) {
    // not sent by the server
  }
}

const orderedObjects = (page) => {
  const objectOrder = page.get('objectOrder')
  const objects = page.get('objects')
  const seen = new Set()
  const result = []
  for (const id of objectOrder.toArray()) {
    if (seen.has(id) || !objects.has(id)) continue
    seen.add(id)
    result.push({ ...objects.get(id).toJSON(), id })
  }
  return result
}

const snapshot = () => {
  const seen = new Set()
  const result = []
  for (const id of pageOrder.toArray()) {
    if (seen.has(id) || !pages.has(id)) continue
    seen.add(id)
    const page = pages.get(id)
    const { objects: _objects, objectOrder: _order, ...props } = page.toJSON()
    result.push({ ...props, id, objects: orderedObjects(page) })
  }
  return { ...meta.toJSON(), pages: result }
}

const pageAt = (index) => pages.get(pageOrder.get(index))

const commands = {
  open() {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, doc)
    emit(encoder)
  },
  setProp({ page, object, prop, value }) {
    const target = pageAt(page)
    const id = target.get('objectOrder').get(object)
    target.get('objects').get(id).set(prop, value)
  },
  addObject({ page, id, props }) {
    doc.transact(() => {
      const target = pageAt(page)
      target.get('objects').set(id, new Y.Map(Object.entries({ id, ...props })))
      target.get('objectOrder').push([id])
    })
  },
  moveObject({ page, from, to }) {
    doc.transact(() => {
      const order = pageAt(page).get('objectOrder')
      const id = order.get(from)
      order.delete(from, 1)
      order.insert(to, [id])
    })
  },
  setMeta({ prop, value }) {
    meta.set(prop, value)
  },
  awareness({ state }) {
    awareness.setLocalState(state)
  },
  snapshot() {
    send({ snapshot: snapshot() })
  },
  clientId() {
    send({ clientId: doc.clientID })
  },
  awarenessStates() {
    send({ awarenessStates: Object.fromEntries(awareness.getStates()) })
  },
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.in !== undefined) handle(new Uint8Array(Buffer.from(message.in, 'base64')))
  else commands[message.cmd](message)
  send({ done: true })
})
lines.on('close', () => {
  awareness.destroy()
  process.exit(0)
})
