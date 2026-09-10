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
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * Normalize `npm pack --dry-run --json`.
 *
 * npm 11 prints an array of one entry; npm 12 prints an object keyed by package
 * name. Destructuring the array form blindly is what broke the first release:
 * the local npm was 11 while the release workflow installs `npm@latest`, so the
 * mismatch only appeared on a tag push and never in CI.
 *
 * @param text - raw stdout from `npm pack --dry-run --json`.
 * @returns the single pack entry.
 * @throws when the payload is neither shape, or carries no file list.
 */
export function parsePackListing(text) {
  const parsed = JSON.parse(text)
  const info = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  if (info === undefined || info === null || !Array.isArray(info.files)) {
    throw new Error('could not read the pack listing: unexpected npm --json shape')
  }
  return info
}

/** Files the harness needs in order to compose and mount the plugin at all. */
export const REQUIRED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'client/client.js',
  'LICENSE',
  'NOTICE',
]

/**
 * Assert one pack entry is publishable code.
 * @param info - a pack entry from {@link parsePackListing}.
 * @returns the packed file paths.
 * @throws when a binary asset or a required file is present/absent wrongly.
 */
export function assertCodeOnly(info) {
  const files = info.files.map((entry) => entry.path)
  const binary = files.filter((path) => /\.(ogg|mp3|wav|png|jpe?g|gif|webp)$/i.test(path))
  const missing = REQUIRED_FILES.filter((path) => !files.includes(path))

  if (binary.length > 0) {
    throw new Error('binary assets in the tarball: ' + binary.join(', '))
  }
  if (missing.length > 0) {
    throw new Error('the tarball is missing required files: ' + missing.join(', '))
  }
  return files
}

/** Run the check against the real package. */
function main() {
  // execSync (shell form) rather than execFileSync: on Windows `npm` is a .cmd
  // shim, and Node refuses to spawn those without a shell (EINVAL), which would
  // make this pass on Linux CI and fail on the maintainer's own machine.
  const output = execSync('npm pack --dry-run --json', { encoding: 'utf8' })
  const info = parsePackListing(output)
  const files = assertCodeOnly(info)
  console.log(`tarball is code-only (${files.length} files, ${info.size} bytes packed)`)
  for (const path of files) console.log('  ' + path)
}

// Only run when invoked directly, so the tests can import the parsers.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error('::error:: ' + String((error && error.message) || error))
    process.exitCode = 1
  }
}
