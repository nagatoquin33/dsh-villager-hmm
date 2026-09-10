/**
 * Boot smoke test: load the plugin's host half into a REAL cordis Context.
 *
 * `dsh --profile web --dump-config` composes the YAML tree but never imports
 * the plugin module, so it cannot prove the row will survive a restart. This
 * does import it, under the same cordis the harness runs, and checks the ways
 * a plugin can hurt a boot: throwing in apply(), throwing while a service is
 * missing, throwing while registering, and choking on a changed payload.
 *
 * Cordis resolves injections asynchronously, so every mount is followed by a
 * settle before anything is asserted. An earlier revision of this file
 * asserted synchronously and reported a working plugin as broken.
 *
 * Cordis is an optional peer, so this suite SKIPS (exit 0) when it cannot be
 * resolved. Point DSH_CORDIS at a deployment's copy to run it locally:
 *
 *   DSH_CORDIS=/path/to/node_modules/@deepseek-ai/cordis/lib/index.js npm run test:boot
 *
 * Run: node test/cordis-boot.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Resolve cordis from an explicit override, the local install, or not at all. */
async function loadCordis() {
  const candidates = []
  if (process.env.DSH_CORDIS) candidates.push(process.env.DSH_CORDIS)
  candidates.push('@deepseek-ai/cordis')
  for (const specifier of candidates) {
    try {
      return await import(specifier)
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

const cordis = await loadCordis()
if (cordis === null || typeof cordis.Context !== 'function') {
  console.log('cordis-boot: SKIPPED — @deepseek-ai/cordis is not resolvable.')
  console.log('cordis-boot: set DSH_CORDIS, or run `npm install` first.')
  process.exit(0)
}

const { Context } = cordis
const mod = await import('../lib/index.js')

/** Rejections that escape a plugin are boot-level failures; record them. */
const escaped = []
process.on('unhandledRejection', (reason) => escaped.push(String(reason)))

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
const emptyAssets = mkdtempSync(join(tmpdir(), 'vhm-boot-'))
const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

let passed = 0
let failed = 0
const check = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log('  PASS  ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + label + '\n        ' + (error && error.message))
  }
}

/** A stand-in for the harness web server, optionally failing on register. */
const makeWebServer = (onRegister) => {
  const routes = []
  return {
    routes,
    register(route) {
      if (onRegister) onRegister(route)
      routes.push(route)
      return () => {}
    },
  }
}

/** Mount the plugin on a fresh Context and wait for injections to resolve. */
const mount = async (webServer) => {
  const app = new Context()
  app.provide('logger', quietLogger)
  if (webServer) app.provide('webServer', webServer)
  app.plugin(mod, { assetDir: emptyAssets })
  await settle()
  return app
}

const request = (route, url) => {
  let status = 0
  let body = null
  const res = { writeHead(code) { status = code; return res }, end(chunk) { body = chunk } }
  route.handler({ url, method: 'GET' }, res)
  return { status, body }
}

console.log('host half loaded into a live cordis Context')

await check('applies with webServer present and registers one prefix route', async () => {
  const web = makeWebServer()
  await mount(web)
  assert.equal(web.routes.length, 1, 'expected exactly one route, got ' + web.routes.length)
  assert.equal(web.routes[0].kind, 'prefix')
  assert.equal(web.routes[0].path, '/dsh-villager-hmm')
  assert.equal(typeof web.routes[0].handler, 'function')
})

await check('applies with webServer ABSENT without throwing', async () => {
  // ctx.inject must simply park the callback, not fail the row.
  await mount(null)
})

await check('survives a webServer whose register() throws', async () => {
  const web = makeWebServer(() => { throw new Error('route collision (simulated)') })
  await mount(web)
  assert.equal(web.routes.length, 0)
})

await check('serves /state off the real Context route', async () => {
  const web = makeWebServer()
  await mount(web)
  const state = JSON.parse(String(request(web.routes[0], '/dsh-villager-hmm/state?cursor=0').body))
  assert.equal(state.soundCount, 0, 'an empty cache must report zero sounds')
  assert.equal(state.enabled, true)
})

await check('a malformed request URL returns 500 instead of throwing', async () => {
  const web = makeWebServer()
  await mount(web)
  const { status } = request(web.routes[0], 'http://[')
  assert.equal(status, 500, 'expected a contained 500, got ' + status)
})

await check('survives adversarial assistant-stream payloads', async () => {
  const web = makeWebServer()
  const app = await mount(web)
  assert.equal(typeof app.emit, 'function', 'cordis Context has no emit()')
  // Everything a changed or hostile producer might hand us, including an
  // unknown chunk kind and an unknown frame kind.
  const payloads = [
    undefined, null, 0, '', {},
    { frame: null },
    { frame: {} },
    { frame: { type: 'chunk' } },
    { frame: { type: 'chunk', chunk: null } },
    { frame: { type: 'chunk', chunk: {} } },
    { frame: { type: 'chunk', chunk: { type: 'reasoning-delta' } } },
    { frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 12345 } } },
    { frame: { type: 'chunk', chunk: { type: 'brand-new-chunk-kind', text: 'hmm' } } },
    { frame: { type: 'chunk', chunk: { type: 'block-end', block: null } } },
    { frame: { type: 'chunk', chunk: { type: 'block-start', blockType: 'reasoning' } } },
    { frame: { type: 'totally-new-frame-kind' } },
    { agent: null, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'hmm' } } },
  ]
  for (const payload of payloads) app.emit('agent/assistant-stream', payload)
  await settle()
  // Still alive and still serving.
  const state = JSON.parse(String(request(web.routes[0], '/dsh-villager-hmm/state?cursor=0').body))
  assert.equal(state.enabled, true)
})

await check('a real hmm still counts under a live cordis dispatch', async () => {
  const web = makeWebServer()
  const app = await mount(web)
  let revision = 0
  const emit = (frame) => { revision += 1; app.emit('agent/assistant-stream', { agent: { id: 's1' }, frame }) }
  emit({ type: 'start', attemptId: 'a', revision, turn: 1, step: 1 })
  for (const ch of 'Hmm, let me think.') {
    emit({ type: 'chunk', attemptId: 'a', revision, turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: ch } })
  }
  emit({ type: 'end', attemptId: 'a', revision, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
  const state = JSON.parse(String(request(web.routes[0], '/dsh-villager-hmm/state?cursor=0').body))
  assert.equal(state.total, 1, 'expected one hit, got ' + state.total)
})

await check('nothing escaped as an unhandled rejection', async () => {
  await settle()
  assert.deepEqual(escaped, [], 'escaped rejections: ' + escaped.join(' | '))
})

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exitCode = failed === 0 ? 0 : 1
