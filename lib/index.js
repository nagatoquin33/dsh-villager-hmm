/**
 * dsh-villager-hmm — host half.
 *
 * Watches the model's streaming chain-of-thought (and optionally its visible
 * reply) and counts every "hmm"-like interjection. The browser half polls the
 * counters over the plugin's own HTTP routes and plays a villager sound once
 * per hit.
 *
 * Host and client halves talk over plain HTTP rather than a Remote service:
 * the payload is a counter plus a few small files, so a route prefix keeps the
 * package self-contained and needs no codegen.
 *
 * The audio and the villager texture are Mojang assets and are deliberately
 * NOT bundled. `scripts/fetch-assets.mjs` populates a per-user cache directory
 * from a source the operator chooses; this half serves whatever is there and
 * reports clearly when nothing is.
 *
 * @module dsh-villager-hmm
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'dsh-villager-hmm'

/** HTTP prefix this plugin owns on the harness web server. */
const PREFIX = '/dsh-villager-hmm'

/** Cache directory name under the harness home. */
export const CACHE_DIR = '.dsh-villager-hmm'

/**
 * Asset file names inside the cache's `assets/` directory. `SOUND_FILES` order
 * defines the `/sound/<index>.ogg` routes.
 */
export const SOUND_FILES = ['idle1.ogg', 'idle2.ogg']
export const TEXTURE_FILE = 'villager.png'

/**
 * Default matcher. Uses a lookbehind rather than `\b` so that `comma`'s `mm`
 * is not a hit while a CJK character immediately followed by `hmm` still is.
 * The CJK branch has no boundary because `\w` is ASCII-only in JavaScript.
 */
export const DEFAULT_PATTERN = '(?<![0-9A-Za-z])(?:h+m+|mhm+|m{2,})|[嗯唔哼呃]'

/**
 * Which stream channel to scan.
 * - `reasoning` — only the chain of thought (models that expose one).
 * - `both` — chain of thought plus the visible reply.
 */
const MODES = new Set(['reasoning', 'both'])

/** The harness home directory, as the other DSH packages resolve it. */
export function harnessHome(env = process.env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return env.DSH_HOME
  const home = env.USERPROFILE || env.HOME
  return typeof home === 'string' && home.length > 0 ? join(home, '.dsh') : process.cwd()
}

/** Absolute path of the asset cache directory. */
export function assetDirFor(config = {}, env = process.env) {
  if (typeof config.assetDir === 'string' && config.assetDir.length > 0) return config.assetDir
  return join(harnessHome(env), CACHE_DIR, 'assets')
}

/** Read one asset, or null when it is absent or unreadable. */
function readAsset(dir, file) {
  try {
    const path = join(dir, file)
    if (!statSync(path).isFile()) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

/** Write a JSON response. */
function sendJson(res, value) {
  const body = JSON.stringify(value)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Write a binary response. */
function sendBytes(res, buffer, contentType, maxAge) {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': buffer.length,
    'cache-control': `public, max-age=${maxAge}`,
  })
  res.end(buffer)
}

/**
 * Register the villager-hmm plugin.
 * @param ctx - Cordis host context.
 * @param config - optional row config (`enabled`, `mode`, `pattern`, `assetDir`).
 */
export function apply(ctx, config = {}) {
  const settings = {
    enabled: config.enabled !== false,
    mode: MODES.has(config.mode) ? config.mode : 'both',
    pattern: typeof config.pattern === 'string' && config.pattern.length > 0
      ? config.pattern
      : DEFAULT_PATTERN,
  }
  const assetDir = assetDirFor(config)

  /** Compiled matcher, rebuilt whenever the pattern changes. */
  let matcher = null
  let patternError = null
  const compile = () => {
    try {
      matcher = new RegExp(settings.pattern, 'gi')
      patternError = null
    } catch (error) {
      matcher = null
      patternError = String((error && error.message) || error)
    }
  }
  compile()

  /** Monotonic trigger id; the client's poll cursor refers to this. */
  let cursor = 0
  let total = 0
  let reasoningChars = 0
  let textChars = 0
  /** Triggers not yet delivered to a poller. */
  const pending = []
  /** Most recent matched words, newest last (bounded). */
  const recent = []

  /**
   * One scan buffer per channel. `text` accumulates the stream; `scanned` is
   * the offset already consumed; `key` identifies the attempt so a new one
   * starts clean.
   */
  const streams = {
    reasoning: { key: null, text: '', scanned: 0 },
    text: { key: null, text: '', scanned: 0 },
  }

  const resetChannel = (channel) => {
    const stream = streams[channel]
    stream.key = null
    stream.text = ''
    stream.scanned = 0
  }

  /** Record one hit. */
  const fire = (word) => {
    cursor += 1
    total += 1
    pending.push({ id: cursor, word })
    if (pending.length > 300) pending.splice(0, pending.length - 300)
    recent.push(word)
    if (recent.length > 10) recent.shift()
  }

  /**
   * Scan one channel's buffer for new hits.
   *
   * A match that ends exactly at the buffer end is deferred unless `final`:
   * the stream may still be growing, and `hm` must not be counted before the
   * next delta can turn it into `hmm`.
   */
  const scanChannel = (channel, final) => {
    if (!settings.enabled || matcher === null) return
    const stream = streams[channel]
    if (stream.text.length === 0) return
    matcher.lastIndex = stream.scanned
    let fired = 0
    let match
    while ((match = matcher.exec(stream.text)) !== null) {
      const word = match[0]
      if (word.length === 0) {
        matcher.lastIndex += 1
        continue
      }
      const end = match.index + word.length
      if (!final && end >= stream.text.length) break
      stream.scanned = end
      if (fired < 4) {
        fire(word)
        fired += 1
      }
    }
    // Drop consumed text so a long stream cannot grow without bound.
    if (stream.scanned > 20000) {
      stream.text = stream.text.slice(stream.scanned)
      stream.scanned = 0
    }
  }

  ctx.on('agent/assistant-stream', (payload) => {
    try {
      if (payload === null || typeof payload !== 'object') return
      if (!settings.enabled) return
      const frame = payload.frame
      if (frame === null || typeof frame !== 'object') return

      if (frame.type === 'end') {
        scanChannel('reasoning', true)
        scanChannel('text', true)
        return
      }
      if (frame.type !== 'chunk') return

      const chunk = frame.chunk
      if (chunk === null || typeof chunk !== 'object') return

      if (chunk.type === 'block-start') {
        if (chunk.blockType === 'reasoning') resetChannel('reasoning')
        if (chunk.blockType === 'text') resetChannel('text')
        return
      }
      if (chunk.type === 'block-end') {
        const blockType = chunk.block ? chunk.block.type : null
        if (blockType === 'reasoning') scanChannel('reasoning', true)
        if (blockType === 'text') scanChannel('text', true)
        return
      }

      let channel = null
      if (chunk.type === 'reasoning-delta') channel = 'reasoning'
      else if (chunk.type === 'text-delta') channel = 'text'
      if (channel === null) return

      const text = chunk.text
      if (typeof text !== 'string' || text.length === 0) return
      if (channel === 'reasoning') reasoningChars += text.length
      else textChars += text.length
      if (channel === 'text' && settings.mode !== 'both') return

      const stream = streams[channel]
      // `frame.revision` increments on every frame and is NOT a stream
      // identity; attemptId/turn/step are stable for the whole attempt.
      const key = `${frame.attemptId}:${frame.turn}:${frame.step}`
      if (stream.key !== key) {
        stream.key = key
        stream.text = ''
        stream.scanned = 0
      }
      stream.text += text
      scanChannel(channel, false)
    } catch {
      // A scanner bug must never break the agent loop.
    }
  })

  // Resolve the web carrier before registering routes; without it there is no
  // browser half and nothing to serve.
  ctx.inject(['webServer'], (host) => {
    /**
     * Assets are re-read per request so that running the fetch script takes
     * effect without restarting the harness. They are small; the alternative
     * (caching at apply time) would pin a missing state for the whole session.
     */
    const assetStatus = () => {
      const sounds = SOUND_FILES.filter((file) => readAsset(assetDir, file) !== null)
      const texture = readAsset(assetDir, TEXTURE_FILE)
      return { sounds, hasTexture: texture !== null }
    }

    const snapshot = (since) => {
      const fresh = pending.filter((item) => item.id > since)
      const deliver = fresh.slice(0, 6)
      if (deliver.length > 0) {
        const lastId = deliver[deliver.length - 1].id
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          if (pending[i].id <= lastId) pending.splice(i, 1)
        }
      }
      const status = assetStatus()
      return {
        version: 2,
        cursor: deliver.length > 0 ? deliver[deliver.length - 1].id : since,
        triggers: deliver.map((item) => ({ id: item.id, word: item.word })),
        total,
        enabled: settings.enabled,
        mode: settings.mode,
        pattern: settings.pattern,
        patternError,
        reasoningChars,
        textChars,
        recent: recent.slice(),
        soundCount: status.sounds.length,
        hasTexture: status.hasTexture,
        assetDir,
        setupCommand: 'npx dsh-villager-hmm-assets',
        defaultPattern: DEFAULT_PATTERN,
      }
    }

    const handle = (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const route = url.pathname.slice(PREFIX.length)

      if (route === '/state') {
        const raw = Number(url.searchParams.get('cursor'))
        return sendJson(res, snapshot(Number.isFinite(raw) && raw >= 0 ? raw : 0))
      }

      if (route === '/config') {
        const enabled = url.searchParams.get('enabled')
        if (enabled === '0' || enabled === '1') settings.enabled = enabled === '1'
        const mode = url.searchParams.get('mode')
        if (mode !== null && MODES.has(mode)) settings.mode = mode
        const pattern = url.searchParams.get('pattern')
        if (pattern !== null && pattern.length > 0 && pattern.length <= 400) {
          settings.pattern = pattern
          compile()
          resetChannel('reasoning')
          resetChannel('text')
        }
        return sendJson(res, { ok: true, pattern: settings.pattern, patternError })
      }

      if (route === '/texture.png') {
        const texture = readAsset(assetDir, TEXTURE_FILE)
        if (texture === null) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('dsh-villager-hmm: texture not fetched')
          return
        }
        return sendBytes(res, texture, 'image/png', 86400)
      }

      const soundMatch = /^\/sound\/(\d+)\.ogg$/.exec(route)
      if (soundMatch !== null) {
        const index = Number(soundMatch[1])
        const file = SOUND_FILES[index]
        const bytes = file === undefined ? null : readAsset(assetDir, file)
        if (bytes === null) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('dsh-villager-hmm: sound not fetched')
          return
        }
        return sendBytes(res, bytes, 'audio/ogg', 86400)
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-villager-hmm: unknown route')
    }

    host.effect(
      () => host.webServer.register({ kind: 'prefix', path: PREFIX, handler: handle }),
      'dsh-villager-hmm: http routes',
    )

    const status = assetStatus()
    if (status.sounds.length === 0) {
      ctx.logger?.warn?.(
        'dsh-villager-hmm: no sounds in %s — run `npx dsh-villager-hmm-assets` to fetch them',
        assetDir,
      )
    } else {
      ctx.logger?.info?.('dsh-villager-hmm: serving %s (%d sounds)', PREFIX, status.sounds.length)
    }
  })
}
