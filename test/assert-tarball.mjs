#!/usr/bin/env node
/**
 * Assert that the packed tarball contains code only.
 *
 * This package must never ship Minecraft material: the sounds and the texture
 * are fetched onto the operator's machine by scripts/fetch-assets.mjs. The CI
 * workflow already fails if a binary asset is *tracked*; this checks what would
 * actually be *published*, which is the thing that matters.
 *
 * Uses `npm pack --dry-run --json` rather than `npm pack` piped through tar:
 * no file is written, and the result is structured rather than scraped.
 *
 * Run: node test/assert-tarball.mjs
 */
import { execFileSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const output = execFileSync(npm, ['pack', '--dry-run', '--json'], { encoding: 'utf8' })
const [info] = JSON.parse(output)

if (info === undefined || !Array.isArray(info.files)) {
  console.error('::error:: could not read the pack listing')
  process.exit(1)
}

const files = info.files.map((entry) => entry.path)
const binary = files.filter((path) => /\.(ogg|mp3|wav|png|jpe?g|gif|webp)$/i.test(path))

// Files the harness needs in order to compose and mount the plugin at all.
const required = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'client/client.js']
const missing = required.filter((path) => !files.includes(path))

if (binary.length > 0) {
  console.error('::error::binary assets in the tarball: ' + binary.join(', '))
  process.exit(1)
}
if (missing.length > 0) {
  console.error('::error::the tarball is missing required files: ' + missing.join(', '))
  process.exit(1)
}

console.log(`tarball is code-only (${files.length} files, ${info.size} bytes packed)`)
for (const path of files) console.log('  ' + path)
