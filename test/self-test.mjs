/**
 * dsh-villager-hmm self-test.
 *
 * Drives the real host half through a fake cordis context and the real client
 * bundle through a fake module loader. The stream simulation deliberately
 * increments `frame.revision` on every frame, because that is what the live
 * harness does — and mistaking it for a stream identity is the bug that made
 * an earlier revision of this plugin count zero hits.
 *
 * Run: node test/self-test.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log('  PASS  ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + label + '\n        ' + (error && error.message))
  }
}

/** Build a fake cordis host context plus the recorder for its effects. */
const makeContext = () => {
  const record = { handlers: {}, routes: [], injected: [] }
  const hostCtx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register: (route) => {
        record.routes.push(route)
        return () => {}
      },
    },
  }
  record.ctx = {
    on: (name, fn) => { record.handlers[name] = fn },
    inject: (deps, cb) => { record.injected.push(deps); cb(hostCtx) },
    logger: { info: () => {} },
  }
  return record
}

// ------------------------------------------------------------------ host half

const mod = await import('../lib/index.js')
console.log('host half')

check('exports a cordis plugin shape', () => {
  assert.equal(mod.name, 'dsh-villager-hmm')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.DEFAULT_PATTERN, 'string')
})

check('defaults to scanning both channels', () => {
  // A model with no reasoning channel must still work out of the box.
  const bare = makeContext()
  mod.apply(bare.ctx, {})
  const state = JSON.parse(String(callOn(bare, '/dsh-villager-hmm/state?cursor=0').body))
  assert.equal(state.mode, 'both')
  assert.equal(state.enabled, true)
  assert.equal(state.pattern, mod.DEFAULT_PATTERN)
})

// The scanning suite runs in reasoning-only mode so each case is isolated.
const rec = makeContext()
mod.apply(rec.ctx, { mode: 'reasoning' })

check('subscribes to the assistant stream', () => {
  assert.equal(typeof rec.handlers['agent/assistant-stream'], 'function')
})
check('injects webServer and registers one prefix route', () => {
  assert.deepEqual(rec.injected[0], ['webServer'])
  assert.equal(rec.routes.length, 1)
  assert.equal(rec.routes[0].kind, 'prefix')
  assert.equal(rec.routes[0].path, '/dsh-villager-hmm')
})

/** Call a route handler on a given recording with a synthetic request. */
function callOn(recording, path) {
  let status = 0
  let body = null
  const res = {
    writeHead(code) { status = code; return res },
    end(chunk) { body = chunk },
  }
  recording.routes[0].handler({ url: path, method: 'GET' }, res)
  return { status, body }
}
const call = (path) => callOn(rec, path)
const getJson = (path) => JSON.parse(String(call(path).body))

/**
 * Frame emitters. `revision` increments on every frame, exactly as the live
 * agent loop does; the attempt identity is carried separately, as it is there.
 */
let revision = 0
let attempt = 'attempt-1'
const emitFrame = (frame) => {
  revision += 1
  rec.handlers['agent/assistant-stream']({ agent: { id: 's1' }, frame })
}
const startAttempt = (id) => {
  attempt = id
  emitFrame({ type: 'start', attemptId: id, revision, turn: 1, step: 1 })
}
const emitDelta = (type, text) => {
  revision += 1
  rec.handlers['agent/assistant-stream']({
    agent: { id: 's1' },
    frame: { type: 'chunk', attemptId: attempt, revision, turn: 1, step: 1, chunk: { type, index: 0, text } },
  })
}
/** Feed text one character per frame — the worst case for boundary handling. */
const streamText = (text) => { for (const ch of text) emitDelta('reasoning-delta', ch) }
const streamReply = (text) => { for (const ch of text) emitDelta('text-delta', ch) }
const endAttempt = () => emitFrame({ type: 'end', attemptId: attempt, revision, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })

/**
 * Drain everything pending and return the trigger words. Reading with a huge
 * cursor would observe without consuming; this deliberately consumes so each
 * case starts clean.
 */
const takeWords = () => {
  const seen = []
  for (let guard = 0; guard < 20; guard += 1) {
    const state = getJson('/dsh-villager-hmm/state?cursor=' + lastCursor)
    if (state.triggers.length === 0) break
    state.triggers.forEach((t) => seen.push(t.word))
    lastCursor = state.cursor
  }
  return seen
}
let lastCursor = 0

const runCase = (text, stream = streamText) => {
  startAttempt('attempt-' + (++caseId))
  stream(text)
  endAttempt()
  return takeWords()
}
let caseId = 0

check('counts hmm split one character per frame', () => {
  const words = runCase('Hmm, let me think about that.')
  assert.deepEqual(words.map((w) => w.toLowerCase()), ['hmm'])
  assert.ok(getJson('/dsh-villager-hmm/state?cursor=999999').reasoningChars > 0)
})

check('counts a trailing hmm that has no following character', () => {
  assert.deepEqual(runCase('so that works. Hmm').map((w) => w.toLowerCase()), ['hmm'])
})

check('counts repeated hums and does not split a longer one', () => {
  assert.deepEqual(runCase('hmm hmm hmmmmm ok').map((w) => w.toLowerCase()), ['hmm', 'hmm', 'hmmmmm'])
})

check('counts the Chinese hums', () => {
  assert.deepEqual(runCase('嗯，那不对。唔……呃。'), ['嗯', '唔', '呃'])
})

check('ignores hmm inside ordinary words', () => {
  assert.deepEqual(runCase('a comma, a comment and a command, ahmm'), [])
})

check('ignores the visible reply in reasoning-only mode', () => {
  assert.deepEqual(runCase('Hmm hmm hmm', streamReply), [])
})

check('is unaffected by chunk size', () => {
  const whole = (text) => emitDelta('reasoning-delta', text)
  assert.deepEqual(runCase('Hmm, and hmm again 嗯', whole).map((w) => w.toLowerCase()), ['hmm', 'hmm', '嗯'])
  const pairs = (text) => { for (let i = 0; i < text.length; i += 2) emitDelta('reasoning-delta', text.slice(i, i + 2)) }
  assert.deepEqual(runCase('Hmm, and hmm again 嗯', pairs).map((w) => w.toLowerCase()), ['hmm', 'hmm', '嗯'])
})

check('serves both ogg sounds with the right magic', () => {
  for (const index of [0, 1]) {
    const { status, body } = call('/dsh-villager-hmm/sound/' + index + '.ogg')
    assert.equal(status, 200)
    assert.equal(body.subarray(0, 4).toString('latin1'), 'OggS', 'sound ' + index + ' is not an Ogg stream')
    assert.ok(body.length > 1000)
  }
})

check('serves the villager face as a 10x10 PNG', () => {
  const { status, body } = call('/dsh-villager-hmm/face.png')
  assert.equal(status, 200)
  assert.equal(body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG')
  // The cropped head-front region of the vanilla villager texture.
  assert.equal(body.readUInt32BE(16), 10)
  assert.equal(body.readUInt32BE(20), 10)
})

check('rejects unknown routes and out-of-range sounds', () => {
  assert.equal(call('/dsh-villager-hmm/nope').status, 404)
  assert.equal(call('/dsh-villager-hmm/sound/9.ogg').status, 404)
})

check('applies a config change and reports a bad pattern without throwing', () => {
  const ok = getJson('/dsh-villager-hmm/config?mode=both&pattern=mmm')
  assert.equal(ok.pattern, 'mmm')
  assert.equal(ok.patternError, null)
  const bad = getJson('/dsh-villager-hmm/config?pattern=' + encodeURIComponent('([unclosed'))
  assert.ok(bad.patternError, 'an invalid pattern must be reported')
  getJson('/dsh-villager-hmm/config?pattern=' + encodeURIComponent(mod.DEFAULT_PATTERN))
})

check('scans the visible reply once mode is both', () => {
  getJson('/dsh-villager-hmm/config?mode=both&enabled=1')
  assert.deepEqual(runCase('Hmm, okay.', streamReply).map((w) => w.toLowerCase()), ['hmm'])
  getJson('/dsh-villager-hmm/config?mode=reasoning')
})

check('a paused plugin counts nothing', () => {
  getJson('/dsh-villager-hmm/config?enabled=0')
  assert.deepEqual(runCase('hmm hmm hmm'), [])
  getJson('/dsh-villager-hmm/config?enabled=1')
})

// ---------------------------------------------------------------- client half

console.log('client half')

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
let entry = null
const fakeWindow = { __ModuleLoader__: { load: (value) => { entry = value } } }
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', style: {} }),
  head: { appendChild: () => {} },
}
const FakeReact = {
  createElement: () => ({}),
  useState: () => [0, () => {}],
  useEffect: () => {},
}

check('registers a module-loader entry', () => {
  const run = new Function('window', 'document', 'fetch', 'Audio', 'setInterval', 'clearInterval', source)
  run(fakeWindow, fakeDocument, () => Promise.resolve({ ok: false }), function Audio() {}, () => 0, () => {})
  assert.ok(entry, 'the bundle never called __ModuleLoader__.load')
  assert.equal(entry.id, 'dsh-villager-hmm')
  assert.equal(typeof entry.factory, 'function')
})

check('materializes into a cordis client plugin', () => {
  const exportsObject = entry.factory((spec) => {
    if (spec === 'react') return FakeReact
    throw new Error('unexpected require: ' + spec)
  })
  assert.equal(exportsObject.name, 'dsh-villager-hmm/client')
  assert.deepEqual(exportsObject.inject, ['slots'])
  assert.equal(typeof exportsObject.apply, 'function')
})

check('apply() polls the host and registers the overlay slot', () => {
  const registrations = []
  let intervals = 0
  const clientCtx = {
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject: (key, cb) => { cb(); return () => {} },
      register: (options, component) => {
        registrations.push({ key: options.name, id: options.id, order: options.order })
        assert.equal(typeof component, 'function', 'the slot needs a component')
        return () => {}
      },
    },
  }
  const exportsObject = entry.factory((spec) => (spec === 'react' ? FakeReact : null))
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = () => { intervals += 1; return 0 }
  try {
    exportsObject.apply(clientCtx)
  } finally {
    globalThis.setInterval = originalSetInterval
  }
  assert.deepEqual(registrations, [{ key: 'shell.overlay', id: 'dsh-villager-hmm', order: 50 }])
})

check('renders without a DOM-visible crash', () => {
  const exportsObject = entry.factory((spec) => (spec === 'react' ? FakeReact : null))
  assert.equal(typeof exportsObject.apply, 'function')
})

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exitCode = failed === 0 ? 0 : 1
