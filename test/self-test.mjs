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
writeFileSync(join(cacheDir, 'hit1.ogg'), makeOgg())
writeFileSync(join(cacheDir, 'hit2.ogg'), makeOgg())
writeFileSync(join(cacheDir, 'hit3.ogg'), makeOgg())
writeFileSync(join(cacheDir, 'hit4.ogg'), makeOgg())
writeFileSync(join(cacheDir, 'villager.png'), makePng(64, 64))
writeFileSync(join(cacheDir, 'villager-type.png'), makePng(64, 64))
writeFileSync(join(cacheDir, 'damage.png'), makePng(8, 8))
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
  assert.equal(state.hasType, false)
  assert.equal(state.hasParticle, false)
  assert.equal(state.hurtCount, 0)
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
  assert.equal(callOn(bare, '/dsh-villager-hmm/hurt/0.ogg').status, 404)
  assert.equal(callOn(bare, '/dsh-villager-hmm/texture.png').status, 404)
  assert.equal(callOn(bare, '/dsh-villager-hmm/type.png').status, 404)
  assert.equal(callOn(bare, '/dsh-villager-hmm/particle.png').status, 404)
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
  // The type overlay is a second 64x64 atlas addressed by the same UVs.
  const type = call('/dsh-villager-hmm/type.png')
  assert.equal(type.status, 200)
  assert.equal(type.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG')
  // The damage-indicator sprite is a single 8x8 frame, not a sheet.
  const particle = call('/dsh-villager-hmm/particle.png')
  assert.equal(particle.status, 200)
  assert.equal(particle.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG')
  assert.equal(particle.body.readUInt32BE(16), 8, 'the damage sprite is 8 wide')
  assert.equal(particle.body.readUInt32BE(20), 8, 'the damage sprite is 8 tall')
  // Damage clips. They are `hit*` in the vanilla assets even though the game
  // event is `entity.villager.hurt`, so the route name and the file name differ.
  for (let index = 0; index < 4; index += 1) {
    const hurt = call('/dsh-villager-hmm/hurt/' + index + '.ogg')
    assert.equal(hurt.status, 200, 'hurt ' + index + ' missing')
    assert.equal(hurt.body.subarray(0, 4).toString('latin1'), 'OggS')
  }
})

check('reports the fetched asset set', () => {
  const state = getJson('/dsh-villager-hmm/state?cursor=999999')
  assert.equal(state.soundCount, 2)
  assert.equal(state.hurtCount, 4)
  assert.equal(state.hasTexture, true)
  assert.equal(state.hasType, true)
  assert.equal(state.hasParticle, true)
})

check('rejects unknown routes and out-of-range clips', () => {
  assert.equal(call('/dsh-villager-hmm/nope').status, 404)
  assert.equal(call('/dsh-villager-hmm/sound/9.ogg').status, 404)
  assert.equal(call('/dsh-villager-hmm/hurt/9.ogg').status, 404)
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

/**
 * The bundle defines its figure geometry at module scope, so a probe copy of
 * the source can hand it back. It is the only way to test the box-UV crops:
 * they never reach the React tree in a form the fake renderer can read.
 */
const geometry = () => new Function(
  'window', 'document', 'fetch', 'Audio', 'setInterval', 'clearInterval',
  source + '\n;return { FIGURE_PARTS, FIGURE_EXTENT, FACE_PARTS, FACE_EXTENT, partStyle,'
    + ' FIGURE_BOX, FACE_BOX, PARTICLE_COUNT, particleBurst, particleStyle }',
)(fakeWindow, fakeDocument, () => Promise.resolve({ ok: false }), function Audio() {}, () => 0, () => {})

check('draws exactly the cubes of the villager model', () => {
  const g = geometry()
  // Front faces of Mojang's villager.geo.json (bedrock-samples): a cube with
  // origin o, size w/h/d and uv u/v shows (u + d, v + d) sized w x h, and the
  // canvas is flipped so canvasY = 34 - modelY. The body and the robe share a
  // canvas origin — the robe is simply the taller cube painted over it — so
  // this compares the whole list, which also pins the back-to-front order.
  assert.deepEqual(g.FIGURE_PARTS, [
    { sx: 4,  sy: 26, w: 4, h: 12, dx: 4,  dy: 22 }, // leg0     [-4, 0,-2] 4,12,4
    { sx: 4,  sy: 26, w: 4, h: 12, dx: 8,  dy: 22 }, // leg1     [ 0, 0,-2]
    { sx: 48, sy: 26, w: 4, h: 8,  dx: 0,  dy: 10 }, // arm      [-8,16,-2] 4, 8,4
    { sx: 48, sy: 26, w: 4, h: 8,  dx: 12, dy: 10 }, // arm      [ 4,16,-2]
    { sx: 22, sy: 26, w: 8, h: 12, dx: 4,  dy: 10 }, // body     [-4,12,-3] 8,12,6
    { sx: 6,  sy: 44, w: 8, h: 18, dx: 4,  dy: 10 }, // robe     [-4, 6,-3] 8,18,6
    { sx: 8,  sy: 8,  w: 8, h: 10, dx: 4,  dy: 0  }, // head     [-4,24,-4] 8,10,8
    { sx: 26, sy: 2,  w: 2, h: 4,  dx: 7,  dy: 7  }, // nose     [-1,23,-6] 2, 4,2
    { sx: 44, sy: 42, w: 8, h: 4,  dx: 4,  dy: 14 }, // forearms [-4,16,-2] 8, 4,4
  ])
  assert.deepEqual(g.FACE_PARTS, [
    { sx: 8,  sy: 8, w: 8, h: 10, dx: 0, dy: 0 },
    { sx: 26, sy: 2, w: 2, h: 4,  dx: 3, dy: 7 },
  ])
})

check('places the nose over the mouth, not the eyes', () => {
  const g = geometry()
  const head = g.FIGURE_PARTS.find((p) => p.dx === 4 && p.dy === 0)
  const nose = g.FIGURE_PARTS.find((p) => p.sx === 26)
  // Eyes are rows 5..6 of the head's 8x10 front face. The nose origin is
  // [-1,23,-6] against a head at [-4,24,-4], i.e. head-local (3,7).
  assert.equal(nose.dx - head.dx, 3, 'the nose is not centred on the face')
  assert.equal(nose.dy - head.dy, 7, 'the nose must clear the eyes and sit over the mouth')
})

check('draws the robe and the folded forearms', () => {
  const g = geometry()
  const robe = g.FIGURE_PARTS.find((p) => p.sy === 44)
  assert.ok(robe, 'the robe cube is missing, which left the villager undressed')
  assert.equal(robe.h, 18, 'the robe must reach past the waist to the ankles')
  const forearms = g.FIGURE_PARTS.find((p) => p.sy === 42)
  assert.ok(forearms, 'the folded forearms are missing')
  // Back-to-front: the forearms are drawn last so they sit over the robe.
  assert.equal(g.FIGURE_PARTS.at(-1), forearms, 'the forearms must paint over the robe')
})

check('derives every stylesheet size from one scale', () => {
  const g = geometry()
  assert.deepEqual(g.FIGURE_EXTENT, { w: 16, h: 34 }, 'figure canvas')
  assert.deepEqual(g.FACE_EXTENT, { w: 8, h: 11 }, 'the nose overhangs the chin by one')
  // The sheet used to repeat FIGURE_SCALE = 4 as 256px / 64px / 136px / 36px,
  // which is what made the sizes drift apart from the parts.
  assert.ok(!/256px/.test(source), 'the stylesheet must not hard-code the texture scale')
  assert.ok(!/\.vhm-figure\{[^}]*width:64px/.test(source), 'the stylesheet must not hard-code the figure size')
  assert.ok(!/\.vhm-min\{[^}]*width:36px/.test(source), 'the stylesheet must not hard-code the head size')
})

check('scales and layers one piece consistently', () => {
  const g = geometry()
  const part = { sx: 8, sy: 8, w: 8, h: 10, dx: 4, dy: 0 }
  const single = g.partStyle(part, 4, ['url(base)'])
  assert.equal(single.left, '16px')
  assert.equal(single.width, '32px')
  assert.equal(single.height, '40px')
  assert.equal(single.backgroundPosition, '-32px -32px')
  assert.equal(single.backgroundSize, '256px 256px')
  // Two layers need one position/size entry each, or the overlay samples the
  // wrong crop.
  const layered = g.partStyle(part, 4, ['url(type)', 'url(base)'])
  assert.equal(layered.backgroundImage, 'url(type),url(base)')
  assert.equal(layered.backgroundPosition, '-32px -32px,-32px -32px')
  assert.equal(layered.backgroundSize, '256px 256px,256px 256px')
})

check('throws a deterministic damage-indicator burst', () => {
  const g = geometry()
  const once = g.particleBurst(1, g.FACE_BOX)
  assert.equal(once.length, g.PARTICLE_COUNT, 'one sprite per particle')
  // The panel re-renders every 250 ms; a random burst would teleport mid-flight.
  assert.deepEqual(g.particleBurst(1, g.FACE_BOX), once, 'the same pet must replay the same burst')
  assert.notDeepEqual(g.particleBurst(2, g.FACE_BOX), once, 'a new pet needs its own paths')
  for (const particle of once) {
    assert.match(particle.size, /^\d+px$/, 'every particle needs a size: ' + particle.size)
    assert.match(particle.dx, /^-?\d+px$/, 'every particle needs a path: ' + particle.dx)
    assert.match(particle.dy, /^-?\d+px$/, 'every particle needs a path: ' + particle.dy)
    assert.match(particle.delay, /^\d+ms$/, 'every particle needs a delay: ' + particle.delay)
    // The vanilla sprite is 8x8; anything smaller than 7px is unreadable at the
    // size the collapsed head renders at.
    assert.ok(parseInt(particle.size, 10) >= 7, 'particles must stay legible')
  }
})

/**
 * Materializes the bundle against a document that records what it injects, so
 * the checks below read the stylesheet the browser actually receives instead of
 * pattern-matching the source's string literals.
 */
const capturedStyles = () => {
  const seen = { style: null, filter: null, matrix: null }
  const el = (tag) => ({
    tag, dataset: {}, textContent: '', style: {}, attrs: {},
    setAttribute(name, value) { this.attrs[name] = value },
    appendChild() {},
  })
  const doc = {
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tag) => { const node = el(tag); if (tag === 'style') seen.style = node; return node },
    createElementNS: (ns, tag) => {
      const node = el(tag)
      if (tag === 'filter') seen.filter = node
      if (tag === 'feColorMatrix') seen.matrix = node
      return node
    },
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  }
  let local = null
  new Function('window', 'document', 'fetch', 'Audio', 'setInterval', 'clearInterval', source)(
    { __ModuleLoader__: { load: (value) => { local = value } } },
    doc, () => Promise.resolve({ ok: false }), function Audio() {}, () => 0, () => {},
  )
  local.factory((spec) => (spec === 'react' ? FakeReact : null))
  return seen
}

check('injects the hurt filter the stylesheet references', () => {
  const seen = capturedStyles()
  assert.ok(seen.style, 'no stylesheet was injected')
  assert.ok(seen.filter, 'no SVG filter element was injected')
  assert.ok(seen.matrix, 'the filter carries no colour matrix')
  const id = seen.filter.attrs.id
  assert.ok(id, 'filter:url() cannot resolve without an id')
  assert.ok(
    seen.style.textContent.includes('url(#' + id + ')'),
    'the stylesheet does not reference the injected filter',
  )
  // The default filter colour space is linearRGB, which washes the tint out.
  assert.equal(seen.filter.attrs['color-interpolation-filters'], 'sRGB')
  // feColorMatrix needs exactly 4 rows of 5 values.
  assert.equal(seen.matrix.attrs.type, 'matrix')
  assert.equal(seen.matrix.attrs.values.trim().split(/\s+/).length, 20)
})

check('keeps the pet tint inside the animation', () => {
  const css = capturedStyles().style.textContent
  const petRule = /\.vhm-pet\{([^}]*)\}/.exec(css)
  assert.ok(petRule, '.vhm-pet is missing')
  // The class stays on the element once the animation ends, so a tint declared
  // on it would leave the villager permanently red. Only the keyframes may
  // apply it — a `hue-rotate` chain was also tried here and lands on orange or
  // magenta rather than red.
  assert.ok(!petRule[1].includes('filter'), 'the tint must not be declared on .vhm-pet')
  const frames = /@keyframes vhm-hurt\{([\s\S]*?)\}\}/.exec(css)
  assert.ok(frames, '@keyframes vhm-hurt is missing')
  assert.ok(frames[1].includes('filter:url(#'), 'the keyframes never apply the tint')
  assert.ok(/filter:none/.test(frames[1]), 'the keyframes never clear the tint')
})

check('keeps the burst out of the pet-tinted element', () => {
  const css = capturedStyles().style.textContent
  // A `filter` on an ancestor repaints the hearts the villager's own dark red,
  // which is exactly what made them invisible against the flashing body.
  assert.ok(
    /\.vhm-particles i\{[^}]*filter:brightness\(/.test(css),
    'the burst must carry its own brightening filter',
  )
  // Which is why the tint moved onto an inner box the burst can sit beside.
  assert.ok(
    /\.vhm-figure-body\{position:absolute;inset:0;\}/.test(css),
    'the expanded figure needs the inner box the pet tint animates',
  )
  const frames = /@keyframes vhm-particle\{([\s\S]*?)\}\}/.exec(css)
  assert.ok(frames, '@keyframes vhm-particle is missing')
  assert.ok(frames[1].includes('var(--vhm-pdx'), 'the flight path must come from the particle')
  assert.ok(/opacity:0/.test(frames[1]), 'the burst must fade out')
})

check('apply() polls the host and registers the overlay slot', () => {
  const registrations = []
  const clientCtx = {
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
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
  const audio = []
  const fetchStub = async (url) => {
    const href = String(url)
    urls.push(href)
    if (href.includes('/state')) {
      return {
        ok: true,
        json: async () => ({
          version: 2, cursor: 0, triggers: [], total: 0, enabled: true, mode: 'both',
          pattern: 'x', patternError: null, reasoningChars: 0, textChars: 0, recent: [],
          soundCount: 2, hurtCount: 4, hasTexture: true, hasType: true, hasParticle: true,
          assetDir: '.', setupCommand: 'x', defaultPattern: 'x',
        }),
      }
    }
    return { ok: true, json: async () => ({ ok: true, pattern: 'x', patternError: null }) }
  }

  let local = null
  const run = new Function('window', 'document', 'fetch', 'Audio', 'setInterval', 'clearInterval', source)
  // The Audio stub records what was played so a test can tell an ambient hit
  // from a pet's damage grunt.
  function AudioSpy(url) {
    audio.push(String(url))
    this.volume = 1
    this.play = () => Promise.resolve()
  }
  run(
    { __ModuleLoader__: { load: (value) => { local = value } } },
    fakeDocument, fetchStub, AudioSpy, () => 0, () => {},
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
  return { Panel, urls, walk, audio }
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

/** The pettable body: `.vhm-figure` carrying the click handler. */
const findFigure = (Panel, walk) => walk(Panel({})).find((node) =>
  typeof node.props.className === 'string'
  && node.props.className.startsWith('vhm-figure')
  && typeof node.props.onClick === 'function')

await checkAsync('petting the villager plays a damage clip', async () => {
  const { Panel, walk, audio } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const figure = findFigure(Panel, walk)
  assert.ok(figure, 'the figure does not accept a click')
  figure.props.onClick()
  assert.equal(audio.length, 1, 'a pet must play exactly one clip, played ' + audio.length)
  assert.ok(
    /\/hurt\/\d+\.ogg$/.test(audio[0]),
    'a pet must play a damage clip, not an ambient one: ' + audio[0],
  )
})

await checkAsync('a pet does not wait behind hmm hits', async () => {
  const { Panel, walk, audio } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const figure = findFigure(Panel, walk)
  figure.props.onClick()
  figure.props.onClick()
  figure.props.onClick()
  // Ambient clips go through a rate-limited queue; a pet answers a click, so
  // three pets have to be three clips.
  assert.equal(audio.length, 3, 'expected three clips, got ' + audio.length)
})

/** Collapse the panel and hand back the tree in its desktop-pet form. */
const collapsePanel = (Panel, walk) => {
  const toggle = walk(Panel({})).find((node) =>
    node.type === 'button' && node.props.className === 'vhm-icon')
  assert.ok(toggle, 'the collapse button was not rendered')
  toggle.props.onClick()
  return walk(Panel({}))
}

await checkAsync('petting the collapsed head plays a damage clip and does not expand', async () => {
  const { Panel, walk, audio } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const head = collapsePanel(Panel, walk).find((node) => node.props.className === 'vhm-min')
  assert.ok(head, 'the collapsed head was not rendered')
  head.props.onClick()
  assert.equal(audio.length, 1, 'expected one clip, got ' + audio.length)
  assert.ok(/\/hurt\/\d+\.ogg$/.test(audio[0]), 'a pet must play a damage clip, got ' + audio[0])
  // Folding "restore the panel" onto the head's click is exactly what made the
  // head unpetable, so a pet must leave the panel collapsed.
  assert.equal(
    Panel({}).props.className, 'vhm-ov vhm-ov-min',
    'petting the head must not expand the panel',
  )
})

await checkAsync('a pet throws the hearts and an idle panel carries none', async () => {
  const { Panel, walk } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const layersIn = (nodes) => nodes.filter((node) =>
    typeof node.props.className === 'string' && node.props.className === 'vhm-particles')
  assert.equal(layersIn(walk(Panel({}))).length, 0, 'an idle panel must not carry a burst')
  findFigure(Panel, walk).props.onClick()
  // One tree, one render: Panel({}) rebuilds every node, so identity only holds
  // within a single walk.
  const tree = walk(Panel({}))
  const layers = layersIn(tree)
  assert.equal(layers.length, 1, 'a pet must add exactly one burst layer')
  assert.equal(layers[0].children.length, 7, 'the burst is seven hearts')
  const host = tree.find((node) =>
    Array.isArray(node.children) && node.children.includes(layers[0]))
  assert.ok(host, 'the burst must be attached to the figure')
  assert.ok(
    !String(host.props.className).includes('vhm-pet'),
    'the burst must not sit inside the pet-tinted element',
  )
})

await checkAsync('the collapsed head restores the panel from its own button', async () => {
  const { Panel, walk } = renderPanel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const collapsed = collapsePanel(Panel, walk)
  assert.equal(Panel({}).props.className, 'vhm-ov vhm-ov-min', 'the panel should start collapsed')
  const open = collapsed.find((node) =>
    node.type === 'button' && node.props.className === 'vhm-min-open')
  assert.ok(open, 'the restore button was not rendered')
  open.props.onClick()
  assert.equal(Panel({}).props.className, 'vhm-ov', 'the restore button must expand the panel')
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

check('LICENSE is verbatim MIT, so GitHub detects it as MIT', () => {
  // Normalize line endings first: git checks the file out with CRLF on Windows,
  // and that alone failed this check on the Windows runner while Linux passed.
  const text = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
  // GitHub detects a license by matching LICENSE against known templates. Any
  // appended text — the asset notice used to live here — makes it report
  // "Other" with spdx_id NOASSERTION instead of MIT.
  assert.ok(text.startsWith('MIT License\n'), 'LICENSE must start with the MIT title')
  assert.ok(
    text.trimEnd().endsWith('SOFTWARE.'),
    'nothing may be appended after the MIT body',
  )
  // Case-sensitive, and looking for the heading rather than the word: the MIT
  // body itself contains "The above copyright notice and this permission
  // notice", so a case-insensitive /NOTICE/ matches the license it guards.
  assert.ok(
    !/NOTICE ON THIRD-PARTY ASSETS/.test(text),
    'the asset notice belongs in NOTICE, not LICENSE',
  )
  assert.ok(!/^---$/m.test(text), 'no section separator belongs in LICENSE')
})

check('the asset notice lives in NOTICE', () => {
  const notice = readFileSync(new URL('../NOTICE', import.meta.url), 'utf8')
  assert.ok(/NOTICE ON THIRD-PARTY ASSETS/.test(notice))
  assert.ok(/Mojang/.test(notice), 'the notice must name the asset owner')
})

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exitCode = failed === 0 ? 0 : 1
