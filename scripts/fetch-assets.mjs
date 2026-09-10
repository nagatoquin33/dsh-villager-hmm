#!/usr/bin/env node
/**
 * Fetch the assets dsh-villager-hmm needs into its per-user cache directory.
 *
 * This package deliberately ships no Mojang material. The villager sounds and
 * the villager texture are downloaded here, on your machine, into
 * `<DSH_HOME>/.dsh-villager-hmm/assets` — so nothing copyrighted is ever
 * redistributed by the repository or by npm.
 *
 * Two sources are supported:
 *
 *   --from <dir>   Copy from a directory you already have, laid out like a
 *                  vanilla asset tree (sounds/mob/villager/..., textures/...).
 *                  Extracting these from your own Minecraft installation is
 *                  the option that matches the game's terms.
 *   --base <url>   Download from an HTTP base with the same layout. The
 *                  default is a public mirror of the vanilla client assets.
 *
 * Usage:
 *   npx dsh-villager-hmm-assets
 *   npx dsh-villager-hmm-assets --from "C:/path/to/extracted/assets/minecraft"
 *   npx dsh-villager-hmm-assets --base https://example.invalid/vanilla/
 *   npx dsh-villager-hmm-assets --force --dir ./local-assets
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assetDirFor, CACHE_DIR, SOUND_FILES, TEXTURE_FILE } from '../lib/index.js'

/** Default source: a public mirror of the vanilla 1.21.4 client assets. */
const DEFAULT_BASE =
  'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.4/assets/minecraft/'

/** Remote path -> cache file name. Keys are relative to the source root. */
const FILES = [
  { from: 'sounds/mob/villager/idle1.ogg', to: SOUND_FILES[0], kind: 'ogg' },
  { from: 'sounds/mob/villager/idle2.ogg', to: SOUND_FILES[1], kind: 'ogg' },
  { from: 'textures/entity/villager/villager.png', to: TEXTURE_FILE, kind: 'png' },
]

const MAGIC = { ogg: Buffer.from('OggS', 'latin1'), png: Buffer.from('89504e470d0a1a0a', 'hex') }

const USAGE = `dsh-villager-hmm-assets — fetch the villager sounds and texture

Options:
  --dir <path>    cache directory (default: <DSH_HOME>/${CACHE_DIR}/assets)
  --from <dir>    copy from a local extracted asset tree
  --base <url>    download from an HTTP base (default: public 1.21.4 mirror)
  --force         re-fetch files that are already present
  --help          show this message

Without --dir the assets land in the per-user cache, which survives plugin
upgrades. The plugin serves whatever is there and says so in its panel when
the directory is empty.`

/** Parse the small flag set; unknown flags are a hard error. */
function parseArgs(argv) {
  const options = { dir: null, from: null, base: DEFAULT_BASE, force: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--force') { options.force = true; continue }
    if (arg === '--dir' || arg === '--from' || arg === '--base') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      options[arg.slice(2)] = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** Reject a payload that is not the format we asked for (HTML error pages!). */
function validate(buffer, kind, source) {
  const magic = MAGIC[kind]
  if (buffer.length < magic.length || !buffer.subarray(0, magic.length).equals(magic)) {
    throw new Error(
      `${source} is not a valid ${kind.toUpperCase()} file ` +
        `(first bytes: ${buffer.subarray(0, 8).toString('hex') || 'empty'})`,
    )
  }
  return buffer
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Download one URL with retries. */
async function download(url) {
  let lastError = null
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < 4) await sleep(1000 * attempt)
    }
  }
  throw new Error(`${url}: ${lastError && lastError.message}`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const targetDir = options.dir !== null ? resolve(options.dir) : assetDirFor({})
mkdirSync(targetDir, { recursive: true })

const base = options.base.endsWith('/') ? options.base : options.base + '/'
const sourceLabel = options.from !== null ? resolve(options.from) : base

console.log(`dsh-villager-hmm: assets -> ${targetDir}`)
console.log(`dsh-villager-hmm: source -> ${sourceLabel}`)
console.log('')

let fetched = 0
let present = 0
const failures = []

for (const file of FILES) {
  const target = join(targetDir, file.to)
  if (!options.force && existsSync(target)) {
    console.log(`  skip   ${file.to} (already present)`)
    present += 1
    continue
  }
  const origin = options.from !== null ? join(resolve(options.from), file.from) : base + file.from
  try {
    const raw = options.from !== null
      ? readFileSync(origin)
      : await download(origin)
    writeFileSync(target, validate(raw, file.kind, origin))
    console.log(`  ok     ${file.to}  ${raw.length} bytes`)
    fetched += 1
  } catch (error) {
    console.log(`  FAIL   ${file.to}  ${error && error.message}`)
    failures.push(file.to)
  }
}

console.log('')
console.log(`dsh-villager-hmm: ${fetched} fetched, ${present} already present, ${failures.length} failed`)

if (failures.length > 0) {
  console.log('')
  console.log('Some files could not be fetched. Options:')
  console.log('  - retry, the mirror is occasionally rate limited')
  console.log('  - point --from at an asset tree you extracted yourself')
  console.log('  - pass --base with your own mirror')
  process.exitCode = 1
} else if (fetched === 0 && present > 0) {
  console.log('Nothing to do. Restart is not required: the plugin reads this directory per request.')
} else {
  console.log('Done. Reload the DSH web page; no harness restart is required.')
}
