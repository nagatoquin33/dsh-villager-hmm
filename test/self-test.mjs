/**
 * dsh-villager-hmm self-test.
 *
 * Drives the real host half through a fake cordis context and the real client
 * bundle through a fake module loader. The stream simulation deliberately
 * increments `frame.revision` on every frame, because that is what the live
 * harness does — and mistaking it for a stream identity is the bug that made
 * an earlier revision of this plugin count zero hits.
 *
 * Assets are fixtures here: the package ships no Mojang material, so the tests
 * cover both a populated cache directory and an empty one.
 *
 * Run: node test/self-test.mjs
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCodeOnly, parsePackListing, REQUIRED_FILES } from './assert-tarball.mjs'

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

/** Build a minimal but structurally valid PNG of the given size. */
const makePng = (width, height) => {
  const ihdr = Buffer.alloc(8)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), // signature
    Buffer.from([0, 0, 0, 13]), // IHDR length
    Buffer.from('IHDR', 'latin1'),
    ihdr, // width at offset 16, height at offset 20
    Buffer.from([8, 6, 0, 0, 0]),
  ])
}
const makeOgg = () => Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(2048)])

// A populated cache: the layout scripts/fetch-assets.mjs produces.
const cacheDir = mkdtempSync(join(tmpdir(), 'vhm-assets-'))
writeFileSync(join(cacheDir, 'idle1.ogg'), makeOgg())
writeFileSync(join(cacheDir, 'idle2.ogg'), makeOgg())
writeFileSync(join(cacheDir, 'villager.png'), makePng(64, 64))
// An empty cache: the state a fresh install is in before the fetch script runs.
const emptyDir = mkdtempSync(join(tmpdir(), 'vhm-empty-'))

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
    logger: { info: () => {}, warn: () => {} },
  }
  return record
}

/** Call a route handler on a recording with a synthetic request. */
const callOn = (recording, path) => {
  let status = 0
  let body = null
  const res = {
    writeHead(code) { status = code; return res },
    end(chunk) { body = chunk },
  }
  recording.routes[0].handler({ url: path, method: 'GET' }, res)
  return { status, body }
}

// ------------------------------------------------------------------ host half

const mod = await import('../lib/index.js')
console.log('host half')

check('exports a cordis plugin shape', () => {
  assert.equal(mod.name, 'dsh-villager-hmm')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.DEFAULT_PATTERN, 'string')
  assert.deepEqual(mod.SOUND_FILES, ['idle1.ogg', 'idle2.ogg'])
})

check('has no bundled assets in the package tree', () => {
  // The repository must never carry Mojang material.
  assert.throws(() => readFileSync(new URL('../assets/idle1.ogg', import.meta.url)), /ENOENT/)
})

check('defaults to scanning both channels', () => {
  // A model with no reasoning channel must still work out of the box.
  const bare = makeContext()
  mod.apply(bare.ctx, { assetDir: emptyDir })
  const state = JSON.parse(String(callOn(bare, '/dsh-villager-hmm/state?cursor=0').body))
  assert.equal(state.mode, 'both')
  assert.equal(state.enabled, true)
  assert.equal(state.pattern, mod.DEFAULT_PATTERN)
})

check('resolves the asset directory from the harness home', () => {
  const dir = mod.assetDirFor({}, { DSH_HOME: 'X:/dsh-home' })
  assert.equal(dir, join('X:/dsh-home', mod.CACHE_DIR, 'assets'))
  assert.equal(mod.assetDirFor({ assetDir: 'Y:/custom' }, {}), 'Y:/custom')
})

check('reports a missing asset set instead of failing', () => {
  const bare = makeContext()
  mod.apply(bare.ctx, { assetDir: emptyDir })
  const state = JSON.parse(String(callOn(bare, '/dsh-villager-hmm/state?cursor=0').body))
  assert.equal(state.soundCount, 0)
  assert.equal(state.hasTexture, false)
  assert.equal(typeof state.setupCommand, 'string')
  assert.ok(state.setupCommand.length > 0, 'the panel needs a command to show')
  // The suggested command must work from any working directory. The bin name
  // differs from the package name, so a bare `npx dsh-villager-hmm-assets`
  // only resolves where the package's bin is linked and 404s everywhere else.
  assert.ok(
    !state.setupCommand.trimStart().startsWith('npx '),
    'must not suggest a bare npx bin name: ' + state.setupCommand,
  )
  assert.ok(
    state.setupCommand.includes(mod.FETCH_SCRIPT),
    'must name the fetcher by absolute path: ' + state.setupCommand,
  )
  assert.ok(existsSync(mod.FETCH_SCRIPT), 'the suggested script must exist: ' + mod.FETCH_SCRIPT)
  assert.equal(callOn(bare, '/dsh-villager-hmm/sound/0.ogg').status, 404)
  assert.equal(callOn(bare, '/dsh-villager-hmm/texture.png').status, 404)
})

// The scanning suite runs in reasoning-only mode so each case is isolated.
const rec = makeContext()
mod.apply(rec.ctx, { mode: 'reasoning', assetDir: cacheDir })

check('subscribes to the assistant stream', () => {
  assert.equal(typeof rec.handlers['agent/assistant-stream'], 'function')
})
check('injects webServer and registers one prefix route', () => {
  assert.deepEqual(rec.injected[0], ['webServer'])
  assert.equal(rec.routes.length, 1)
  assert.equal(rec.routes[0].kind, 'prefix')
  assert.equal(rec.routes[0].path, '/dsh-villager-hmm')
})

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

/** Drain everything pending and return the trigger words. */
let lastCursor = 0
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

let caseId = 0
const runCase = (text, stream = streamText) => {
  startAttempt('attempt-' + (++caseId))
  stream(text)
  endAttempt()
  return takeWords()
}

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

check('serves the fetched assets with the right magic', () => {
  for (const index of [0, 1]) {
    const { status, body } = call('/dsh-villager-hmm/sound/' + index + '.ogg')
    assert.equal(status, 200)
    assert.equal(body.subarray(0, 4).toString('latin1'), 'OggS', 'sound ' + index + ' is not an Ogg stream')
  }
  const texture = call('/dsh-villager-hmm/texture.png')
  assert.equal(texture.status, 200)
  assert.equal(texture.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG')
  // The client crops the head front out of this 64x64 skin.
  assert.equal(texture.body.readUInt32BE(16), 64)
  assert.equal(texture.body.readUInt32BE(20), 64)
})

check('reports the fetched asset set', () => {
  const state = getJson('/dsh-villager-hmm/state?cursor=999999')
  assert.equal(state.soundCount, 2)
  assert.equal(state.hasTexture, true)
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
  globalThis.setInterval = () => 0
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

/**
 * Render the panel and replay real clicks.
 *
 * The checks above only prove that apply() registers a slot. They cannot see a
 * handler bug, which is how "clicking pause sends the wrong value" shipped
 * once: the handler read the live state object twice, so the second read saw
 * the value it had just written.
 */
/**
 * A stand-in for the client `locale` service: registers dictionaries, binds a
 * translator that reads the active one at call time, and exposes what it was
 * given so a test can check both languages.
 */
const makeLocale = (active) => ({
  dicts: {},
  register(namespace, tag, dict) {
    this.dicts[tag] = dict
    return () => {}
  },
  bind() {
    return (key) => {
      const dict = this.dicts[active]
      return dict !== undefined && dict[key] !== undefined ? dict[key] : key
    }
  },
  subscribe() {
    return () => {}
  },
})

/** Every string rendered anywhere in an element tree. */
const collectText = (node, out = []) => {
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  collectText(node.children, out)
  return out
}

const renderPanel = (locale) => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  const walk = (node, out = []) => {
    if (node === null || node === undefined) return out
    if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
    if (typeof node !== 'object') return out
    out.push(node)
    walk(node.children, out)
    return out
  }
  const urls = []
  const fetchStub = async (url) => {
    const href = String(url)
    urls.push(href)
    if (href.includes('/state')) {
      return {
        ok: true,
        json: async () => ({
          version: 2, cursor: 0, triggers: [], total: 0, enabled: true, mode: 'both',
          pattern: 'x', patternError: null, reasoningChars: 0, textChars: 0, recent: [],
          soundCount: 2, hasTexture: true, assetDir: '.', setupCommand: 'x', defaultPattern: 'x',
        }),
      }
    }
    return { ok: true, json: async () => ({ ok: true, pattern: 'x', patternError: null }) }
  }

  let local = null
  const run = new Function('window', 'document', 'fetch', 'Audio', 'setInterval', 'clearInterval', source)
  run(
    { __ModuleLoader__: { load: (value) => { local = value } } },
    fakeDocument, fetchStub, function Audio() {}, () => 0, () => {},
  )
  const exportsObject = local.factory((spec) => (spec === 'react' ? React : null))
  let Panel = null
  exportsObject.apply({
    effect: (fn) => { fn(); return () => {} },
    // The locale service is optional; `undefined` here exercises the English
    // fallback that keeps the panel rendering without it.
    get: (name) => (name === 'locale' ? locale : undefined),
    slots: {
      inject: (key, cb) => { cb(); return () => {} },
      register: (options, component) => { Panel = component; return () => {} },
    },
  })
  return { Panel, urls, walk }
}

const checkAsync = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log('  PASS  ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + label + '\n        ' + (error && error.message))
  }
}

const findToggle = (Panel, walk) => {
  // Matched by class, not by label: the label depends on the active locale.
  const toggle = walk(Panel({})).find((node) =>
    node.type === 'button'
    && typeof node.props.className === 'string'
    && node.props.className.startsWith('vhm-btn'))
  assert.ok(toggle, 'the toggle button was not found in the rendered tree')
  return toggle
}

await checkAsync('clicking pause sends enabled=0 to the host', async () => {
  const { Panel, urls, walk } = renderPanel()
  // Let the immediate poll settle so it cannot interleave with the click.
  await new Promise((resolve) => setTimeout(resolve, 0))
  findToggle(Panel, walk).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const configUrl = urls.find((url) => url.includes('/config'))
  assert.ok(configUrl, 'clicking pause sent no config request at all')
  assert.ok(
    configUrl.includes('enabled=0'),
    'clicking pause must disable the host, but it sent: ' + configUrl,
  )
})

await checkAsync('clicking again re-enables the host', async () => {
  const { Panel, urls, walk } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const toggle = findToggle(Panel, walk)
  toggle.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  toggle.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const configs = urls.filter((url) => url.includes('/config'))
  assert.equal(configs.length, 2, 'expected two config requests, got ' + configs.length)
  assert.ok(configs[0].includes('enabled=0'), 'first click should disable: ' + configs[0])
  assert.ok(configs[1].includes('enabled=1'), 'second click should re-enable: ' + configs[1])
})

await checkAsync('the panel can be dragged clear of the composer', async () => {
  const { Panel, walk } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const bar = walk(Panel({})).find((node) => node.props.className === 'vhm-bar')
  assert.ok(bar, 'the drag bar was not found')
  assert.equal(typeof bar.props.onPointerDown, 'function', 'the bar is not draggable')

  // Grab at (120,60) with the panel's top-left at (100,50): offset 20,10.
  bar.props.onPointerDown({
    target: null,
    currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 50 }), setPointerCapture: () => {} },
    clientX: 120, clientY: 60, pointerId: 1,
  })
  bar.props.onPointerMove({ clientX: 300, clientY: 200 })
  bar.props.onPointerUp({ currentTarget: { releasePointerCapture: () => {} }, pointerId: 1 })

  const placed = Panel({}).props.style
  assert.ok(placed, 'a dragged panel must carry an inline position')
  assert.equal(placed.left, '280px', 'expected left 280px, got ' + JSON.stringify(placed))
  assert.equal(placed.top, '190px', 'expected top 190px, got ' + JSON.stringify(placed))
  // The stylesheet anchor must be released or both would apply.
  assert.equal(placed.right, 'auto')
  assert.equal(placed.bottom, 'auto')
})

await checkAsync('double-clicking the bar restores the default corner', async () => {
  const { Panel, walk } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const bar = walk(Panel({})).find((node) => node.props.className === 'vhm-bar')
  bar.props.onPointerDown({
    target: null,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: () => {} },
    clientX: 10, clientY: 10, pointerId: 1,
  })
  bar.props.onPointerMove({ clientX: 200, clientY: 200 })
  bar.props.onPointerUp({ currentTarget: { releasePointerCapture: () => {} }, pointerId: 1 })
  assert.ok(Panel({}).props.style, 'expected a pinned position first')
  bar.props.onDoubleClick()
  assert.equal(Panel({}).props.style, null, 'double-click must clear the pinned position')
})

await checkAsync('the default anchor is not the bottom-right corner', async () => {
  const { Panel } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  // No inline position by default, so the stylesheet decides. The composer is
  // full-width, which is why the default must not be bottom-anchored.
  assert.equal(Panel({}).props.style, null, 'the default must come from the stylesheet')
  assert.ok(
    !/\.vhm-ov\{[^}]*bottom:/.test(source),
    'the overlay stylesheet must not bottom-anchor the panel over the composer',
  )
})

await checkAsync('the panel follows the interface language', async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  const zhLocale = makeLocale('zh')
  const zhPanel = renderPanel(zhLocale).Panel
  await tick()
  const zhText = collectText(zhPanel({})).join(' ')
  assert.ok(zhText.includes('村民 hmm 音效'), 'expected the Chinese title, got: ' + zhText)
  assert.ok(!zhText.includes('Villager hmm'), 'the English title leaked into zh: ' + zhText)

  const enLocale = makeLocale('en')
  const enPanel = renderPanel(enLocale).Panel
  await tick()
  const enText = collectText(enPanel({})).join(' ')
  assert.ok(enText.includes('Villager hmm'), 'expected the English title, got: ' + enText)
  // The bug this replaces: an English panel with hard-coded Chinese in it.
  assert.ok(!/[\u4e00-\u9fff]/.test(enText), 'Chinese leaked into the English panel: ' + enText)
})

await checkAsync('no Chinese is hard-coded outside the dictionaries', async () => {
  // A rendered-panel check cannot see strings that only appear on an error
  // path, which is exactly how the error messages stayed Chinese in an English
  // panel. This strips the dictionary object and looks at everything else.
  const start = source.indexOf('const MESSAGES = {')
  assert.ok(start !== -1, 'the MESSAGES table was not found')
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  assert.ok(end !== -1, 'could not find the end of the MESSAGES table')
  const outside = source.slice(0, start) + source.slice(end + 1)
  const cjk = outside.match(/[\u4e00-\u9fff]+/g)
  assert.equal(cjk, null, 'hard-coded Chinese outside the dictionaries: ' + String(cjk))
})

await checkAsync('both dictionaries cover the same keys', async () => {
  const locale = makeLocale('en')
  renderPanel(locale)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const en = Object.keys(locale.dicts.en || {}).sort()
  const zh = Object.keys(locale.dicts.zh || {}).sort()
  assert.ok(en.length >= 20, 'the dictionaries were not registered (' + en.length + ' keys)')
  assert.deepEqual(zh, en, 'a key is missing from one of the dictionaries')
})

// ------------------------------------------------------- publish assertions

console.log('publish assertions')

/** A pack entry carrying exactly the required files. */
const packEntry = (extra = []) => ({
  size: 1234,
  files: [...REQUIRED_FILES.map((path) => ({ path })), ...extra.map((path) => ({ path }))],
})

check('parses both npm pack --json shapes', () => {
  const entry = packEntry()
  // npm 11 prints an array of one entry; npm 12 prints an object keyed by
  // package name. Assuming the array form is what broke the first release,
  // because the local npm was 11 and the release job installs npm@latest.
  assert.equal(parsePackListing(JSON.stringify([entry])).size, 1234)
  assert.equal(parsePackListing(JSON.stringify({ 'dsh-villager-hmm': entry })).size, 1234)
  assert.throws(() => parsePackListing(JSON.stringify({})), /unexpected npm --json shape/)
  assert.throws(() => parsePackListing('[]'), /unexpected npm --json shape/)
})

check('rejects a tarball that carries a binary asset', () => {
  assert.throws(() => assertCodeOnly(packEntry(['assets/idle1.ogg'])), /binary assets/)
})

check('rejects a tarball missing a harness-critical file', () => {
  assert.throws(() => assertCodeOnly({ files: [{ path: 'package.json' }] }), /missing required files/)
})

check('accepts a code-only tarball', () => {
  assert.equal(assertCodeOnly(packEntry()).length, REQUIRED_FILES.length)
})

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exitCode = failed === 0 ? 0 : 1
