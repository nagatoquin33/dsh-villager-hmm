# Contributing

Maintainer notes. None of this is published to npm — `files` in `package.json`
lists only `lib`, `client`, `scripts`, `cordis.patch.yml`, `README.md` and
`LICENSE`, so this file stays in the repository.

## Layout

```
lib/index.js                host half — event listener + HTTP routes
client/client.js            browser half — prebuilt __ModuleLoader__ bundle
scripts/fetch-assets.mjs    the asset fetcher (also the package's bin)
cordis.patch.yml            the row this package inserts
test/self-test.mjs          hermetic unit + integration tests
test/cordis-boot.mjs        mounts the host half in a real cordis Context
test/assert-tarball.mjs     asserts what would be published
.github/workflows/ci.yml    tests + repository guards
.github/workflows/release.yml  tag-driven publish
```

## Running the tests

```sh
npm install        # the cordis dev dependency, for the boot suite
npm test           # 36 hermetic cases, no dependencies at all
npm run test:boot  # imports and applies the host half for real
npm run test:all   # both
```

`npm test` covers the scanner against character-by-character streams with
`revision` incrementing per frame, boundary and false-positive cases,
chunk-size invariance, config changes, the route surface, a populated and an
empty asset cache, that no assets are bundled, and the client bundle — including
rendering the panel and replaying real clicks, because a handler bug is
invisible to a test that only asserts a slot was registered. It also renders the
panel once per locale and asserts that no Chinese reaches an English panel, and
that both dictionaries cover the same key set.

`test/cordis-boot.mjs` is the guard against a harness update breaking the row.
It applies the real host half inside a live cordis `Context` and checks that a
missing `webServer`, a throwing `register()`, a malformed request URL, and
unknown chunk and frame kinds all degrade instead of failing the boot. Cordis
resolves injections asynchronously, so every mount settles before asserting.

Cordis is an optional peer, so the suite skips cleanly when it is not
resolvable. Point `DSH_CORDIS` at a deployment's copy to run it without
installing anything:

```sh
DSH_CORDIS=/path/to/node_modules/@deepseek-ai/cordis/lib/index.js npm run test:boot
```

## What CI enforces

`.github/workflows/ci.yml` runs on ubuntu (Node 22 and 24) and **windows**
(Node 22). Windows is in the matrix on purpose: this plugin is developed on
Windows, and a Windows-only failure — a `.cmd` spawn, a path separator — would
otherwise pass a Linux-only CI. It has already caught one.

Beyond the tests, two repository guards:

- **No binary asset may ever be tracked.** `git ls-files` is scanned for
  `.ogg/.mp3/.wav/.png/…`. This is the licensing decision from the README
  turned into a build failure, so nobody re-adds Mojang material by accident.
- **`dsh.bundle.patch` must resolve.** A non-empty value in `package.json` and
  a file that exists — exactly what the community catalog's static review
  checks.

`test/assert-tarball.mjs` additionally inspects what would actually be
published, and that the harness-critical files are all present. Its parsers are
covered by tests, because `npm pack --json` changed shape between npm 11 (an
array) and npm 12 (an object) — and assuming the array form is exactly what
failed the first tag push. CI now installs `npm@latest` so it runs the same npm
the release job does.

## Releasing

Publishing is tag-driven:

```sh
npm version patch        # or minor / major — commits and creates the tag
git push --follow-tags
```

`.github/workflows/release.yml` then checks the tag against `package.json`,
runs the tests, asserts the tarball is code-only, publishes to npm, and opens a
GitHub release.

**One-time setup — trusted publishing.** No npm token is stored anywhere. The
workflow authenticates with a GitHub OIDC token that npm exchanges for a
short-lived registry token, and provenance is attached automatically because
both the repository and the package are public:

```sh
npm login
npm trust github dsh-villager-hmm --file release.yml --repo nagatoquin33/dsh-villager-hmm -y
npm trust list dsh-villager-hmm      # verify
```

The ordering is forced by npm: a trusted publisher can only be configured for a
package that already exists, so the first version has to be published by hand
(`npm publish --otp=…`) and every later release goes through CI with a
provenance attestation.

If `npm trust` rejects the request, configure it in the browser instead:
<https://www.npmjs.com/package/dsh-villager-hmm> → Settings → Trusted
Publisher → GitHub Actions, with repository `nagatoquin33/dsh-villager-hmm` and
workflow filename `release.yml`.

Prefer a long-lived token? Drop the `id-token: write` permission from the
workflow, add an automation token as the `NPM_TOKEN` repository secret, and
uncomment the `env:` block on the Publish step. Note that npm is restricting
2FA-bypass tokens for direct publishing, so trusted publishing is the durable
option.

## Installing a work-in-progress build

`dsh plugin --profile web add <path>` links a local checkout, and
`dsh plugin` reconciles `dsh.profile.bundles` from the installed state on its
own — installing registers the layer, removing withdraws it, with no manual
edit to the profile manifest. A path containing spaces breaks pnpm's argument
handling, so stage the checkout somewhere space-free.

The client bundle is read from disk when the server builds its module graph, so
a bundle change needs a profile restart. Editing the host half has the same
requirement.
