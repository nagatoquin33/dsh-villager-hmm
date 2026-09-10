# dsh-villager-hmm

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
Whenever the model goes *"hmm"* — inside its chain of thought, or in the reply
itself — a Minecraft villager hums back at you.

A small villager sits in the bottom-right corner, bobs its head on every hit,
and carries the controls: pause, volume, which stream to watch, and the matcher
itself.

```
🧑‍🌾 村民 hmm 音效                    触发 12 · 播放 12   －
   思维链 1284 字   正文 356 字   音效 2 段
   [ 监听中 · 点击暂停 ]  [ 试听一次 ]   音量 ────●────
   检测源 [ 仅思维链 ▾ ]
   匹配式 [(?<![0-9A-Za-z])(?:h+m+|mhm+|m{2,})|[嗯唔哼呃] ] [应用] [默认]
   最近命中  hmm  嗯  唔
```

## Install

```sh
# 1. install the package into your profile
dsh plugin --profile web add dsh-villager-hmm
```

```jsonc
// 2. register it as a profile bundle — add the name to the
//    `dsh.profile.bundles` array in $DSH_HOME/profiles/web/package.json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-villager-hmm"] } }
```

```sh
# 3. fetch the sounds and the villager texture (see Assets below)
npx dsh-villager-hmm-assets
```

The package ships its own `cordis.patch.yml`, so step 2 is what actually
inserts the plugin row. Restart the profile after editing.

Skip step 2 and nothing happens; skip step 3 and the plugin loads, shows its
panel, and tells you which command to run — it never fails silently.

<details>
<summary>Installing from a local checkout instead of npm</summary>

```sh
git clone https://github.com/nagatoquin33/dsh-villager-hmm && cd dsh-villager-hmm
dsh plugin --profile web add "$PWD"
```

Note that a path containing spaces breaks pnpm's argument handling — install
from a space-free directory.
</details>

## Assets

**This package ships no Minecraft material.** The two villager sounds and the
villager skin are fetched on your machine into a per-user cache:

```
$DSH_HOME/.dsh-villager-hmm/assets/
  idle1.ogg      villager "hmm"
  idle2.ogg      villager "hmm", second take
  villager.png   the 64x64 villager skin; the panel crops the head front in CSS
```

`npx dsh-villager-hmm-assets` (or `node scripts/fetch-assets.mjs`) populates it.
Two sources are supported:

| Flag | Meaning |
| --- | --- |
| *(none)* | Download from a public mirror of the vanilla 1.21.4 client assets |
| `--from <dir>` | Copy from an asset tree you extracted yourself — **the option that matches the game's terms** |
| `--base <url>` | Your own mirror with the same layout |
| `--dir <path>` | Use a different cache directory |
| `--force` | Re-fetch files that are already there |

```sh
# from your own extraction
npx dsh-villager-hmm-assets --from "C:/mc-extract/assets/minecraft"
```

The cache lives outside `node_modules`, so it survives plugin upgrades. The
host half re-reads it per request, which means running the fetch script takes
effect on a page reload — no harness restart.

## Configuration

Defaults live in the row. To override them, replace the insert in your own
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-villager-hmm
      name: 'dsh-villager-hmm'
      config:
        enabled: true
        mode: both      # 'reasoning' (chain of thought only) | 'both'
        pattern: '(?<![0-9A-Za-z])(?:h+m+|mhm+|m{2,})|[嗯唔哼呃]'
        assetDir: 'D:/my-assets'
```

Everything except `assetDir` is also editable from the floating panel.

`mode` defaults to `both` on purpose: plenty of models expose no separate
reasoning channel, and a plugin that silently does nothing looks broken. Switch
to `reasoning` once you have confirmed your model streams `reasoning-delta` —
the panel's **思维链** counter tells you: if it climbs, you have a reasoning
channel and can narrow the scope.

## The matcher

The default pattern is
`(?<![0-9A-Za-z])(?:h+m+|mhm+|m{2,})|[嗯唔哼呃]`.

It uses a **lookbehind rather than `\b`**, for two reasons:

- `\b` is ASCII-only in JavaScript, so it behaves unpredictably next to CJK
  characters — `嗯hmm` would not match.
- The CJK branch deliberately has no boundary at all, because those characters
  are always standalone interjections.

`h+m+` covers `hm`, `hmm`, `hmmm…`; `mhm+` covers the closed-mouth variant;
`m{2,}` covers a bare `mm`. None of them fire inside ordinary words — `comma`,
`comment`, `command` and `ahmm` all stay silent.

Write your own in the panel's **匹配式** field and hit **应用**. A pattern that
does not compile is reported inline instead of being swallowed.

## How it works

The host half listens to the `agent/assistant-stream` event and scans
`reasoning-delta` (and optionally `text-delta`) chunks against the matcher. The
browser half polls that counter over the plugin's own HTTP prefix and plays a
sound per hit.

Two details are worth knowing if you touch the scanner:

**`frame.revision` is not a stream identity.** It increments on *every* frame
(`dsh-agent-loop`, `() => ++this.assistantStreamRevision`). Keying the scan
buffer by it resets the buffer on every delta, so the matcher only ever sees one
character and never matches. The buffer is keyed by `attemptId:turn:step`.

**The scan is inline, not debounced.** Deltas arrive far faster than any debounce
window, so every new delta cancels the pending timer before it can fire — on a
real stream, 1623 schedules produced 5 fires. Because the matcher keeps a
consumed-offset cursor, scanning on every delta is amortised O(n).

A match that ends exactly at the buffer end is deferred unless the attempt is
finishing, so `hm` is never counted before the next delta can turn it into
`hmm`; the block-end/end frames flush whatever is left.

## Layout

```
lib/index.js              host half — event listener + HTTP routes
client/client.js          browser half — prebuilt __ModuleLoader__ bundle
scripts/fetch-assets.mjs  the asset fetcher (also the package's bin)
cordis.patch.yml          the row this package inserts
test/self-test.mjs        unit + integration tests
```

## Routes

The plugin owns one HTTP prefix, `/dsh-villager-hmm`:

| Route | Purpose |
| --- | --- |
| `GET /state?cursor=N` | counters, asset status, and triggers newer than `N` |
| `GET /config?enabled&mode&pattern` | change settings at runtime |
| `GET /sound/<n>.ogg` | the audio, read from the cache |
| `GET /texture.png` | the villager skin, read from the cache |

## Tests

```sh
npm test
```

24 cases: the scanner against character-by-character streams with `revision`
incrementing per frame, boundary and false-positive cases, chunk-size
invariance, config changes, the route surface, a populated and an empty asset
cache, that no assets are bundled, and the client bundle's materialization.

## Releasing

CI (`.github/workflows/ci.yml`) runs the tests on every push and pull request
against Node 22 and 24. It also fails the build if a binary asset is ever
tracked, or if `dsh.bundle.patch` stops resolving — the two things this
repository must not get wrong.

Publishing is tag-driven:

```sh
npm version patch        # or minor / major — commits and creates the tag
git push --follow-tags
```

`.github/workflows/release.yml` then checks the tag against `package.json`,
runs the tests, asserts the tarball carries no Minecraft assets, publishes to
npm, and opens a GitHub release.

**One-time setup — trusted publishing.** No npm token is stored anywhere. The
workflow authenticates with a GitHub OIDC token that npm exchanges for a
short-lived registry token, and provenance is attached automatically because
both the repository and the package are public:

```sh
npm login
npm trust github dsh-villager-hmm --file release.yml --repo nagatoquin33/dsh-villager-hmm -y
npm trust list dsh-villager-hmm      # verify
```

If `npm trust` refuses because the package does not exist yet, publish once by
hand (`npm publish`) and run the command above afterwards — every later release
goes through CI.

Prefer a long-lived token instead? Drop the `id-token: write` permission, add
an automation token as the `NPM_TOKEN` repository secret, and uncomment the
`env:` block on the Publish step.

## License

The code is MIT (see `LICENSE`).

No third-party assets are bundled or redistributed: `scripts/fetch-assets.mjs`
downloads them on the operator's machine, at the operator's direction, into a
local cache. Minecraft is a trademark of Mojang Studios; this project is not
affiliated with or endorsed by Mojang or Microsoft.
