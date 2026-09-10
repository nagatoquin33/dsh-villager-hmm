/** Trace the scanner character by character without consuming triggers. */
const mod = await import('../lib/index.js')

const handlers = {}
const webRoutes = []
const hostCtx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  webServer: { register: (r) => { webRoutes.push(r); return () => {} } },
}
mod.apply({ on: (n, f) => { handlers[n] = f }, inject: (d, cb) => cb(hostCtx), logger: { info() {} } }, {})

const call = (path) => {
  let body = null
  const res = { writeHead() { return res }, end(c) { body = c } }
  webRoutes[0].handler({ url: path, method: 'GET' }, res)
  return JSON.parse(String(body))
}
// A huge cursor never receives triggers, but `total` is still reported.
const total = () => call('/dsh-villager-hmm/state?cursor=999999').total

let revision = 0
const emit = (frame) => { revision += 1; handlers['agent/assistant-stream']({ agent: { id: 's1' }, frame }) }

const text = 'hmm hmm hmmmmm ok'
console.log('streaming: ' + JSON.stringify(text))
emit({ type: 'start', attemptId: 'a', revision, turn: 1, step: 1 })
let last = 0
for (const ch of text) {
  emit({ type: 'chunk', attemptId: 'a', revision, turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: ch } })
  const now = total()
  if (now !== last) {
    console.log('  after ' + JSON.stringify(text.slice(0, text.indexOf(ch) + 1)).padEnd(20) + ' total=' + now)
    last = now
  }
}
emit({ type: 'end', attemptId: 'a', revision, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
console.log('final total=' + total())
console.log('words=' + JSON.stringify(call('/dsh-villager-hmm/state?cursor=0').triggers.map((t) => t.word)))
