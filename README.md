# dsh-villager-hmm

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
Whenever the model goes *"hmm"* — inside its chain of thought, or in the reply
itself — a vanilla Minecraft villager hums back at you.

A small floating villager sits in the bottom-right corner, bobs its head on
every hit, and carries the controls: pause, volume, which stream to watch, and
the matcher itself.

```
思维链 1284 字 · 正文 356 字 · 音效 2 段
[ 监听中 · 点击暂停 ]  [ 试听一次 ]  音量 ────●────
```

## Install

```sh
# 1. install the package into your profile (web is the browser profile)
dsh plugin --profile web add dsh-villager-hmm

# 2. register it as a profile bundle — add the name to the `dsh.profile.bundles`
#    array in  $DSH_HOME/profiles/web/package.json
```

The package ships its own `cordis.patch.yml`, so step 2 is what actually
inserts the plugin row. After editing, restart the profile.

<details>
<summary>Installing from a local checkout instead of npm</summary>

```sh
git clone <this repo> && cd dsh-villager-hmm
dsh plugin --profile web add "$PWD"
```
Then do step 2 as above.
</details>

## Uninstall

Remove the name from `dsh.profile.bundles`, then:

```sh
dsh plugin --profile web remove dsh-villager-hmm
```

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
```

Everything here is also editable from the floating panel while it runs.

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
lib/index.js          host half — event listener + HTTP routes
client/client.js      browser half — prebuilt __ModuleLoader__ bundle
assets/idle1.ogg      villager "hmm"
assets/idle2.ogg      villager "hmm", second take
assets/villager-face.png  villager head front, cropped 10x10 from the vanilla texture
cordis.patch.yml      the row this package inserts
test/self-test.mjs    unit + integration tests
```

## Routes

The plugin owns one HTTP prefix, `/dsh-villager-hmm`:

| Route | Purpose |
| --- | --- |
| `GET /state?cursor=N` | counters + triggers newer than `N` |
| `GET /config?enabled&mode&pattern` | change settings at runtime |
| `GET /sound/<n>.ogg` | the audio |
| `GET /face.png` | the villager face |

## Tests

```sh
node test/self-test.mjs
```

Covers the scanner against character-by-character streams with `revision`
incrementing per frame, boundary and false-positive cases, config changes, the
route surface, and the client bundle's materialization.

## Assets and licensing

The **code** is MIT (see `LICENSE`).

`assets/idle1.ogg`, `assets/idle2.ogg` and `assets/villager-face.png` are
**Mojang assets**, taken from the vanilla 1.21.4 client
(`assets/minecraft/sounds/mob/villager/idle*.ogg`, and the head-front region of
`assets/minecraft/textures/entity/villager/villager.png`). They are **not**
covered by the MIT license, they remain Mojang's property, and this package
ships them for local personal use only. Do not redistribute them commercially,
and swap in your own audio before publishing a fork.
