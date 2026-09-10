# dsh-villager-hmm

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
Whenever the model goes *"hmm"* — inside its chain of thought, or in the reply
itself — a Minecraft villager hums back at you.

A villager stands in the top-right corner, bobs on every hit, and carries the
controls: pause, volume, which stream to watch, and the matcher itself.

**Drag the title bar to move it; double-click the bar to send it back to the
corner.** The position is remembered in `localStorage`. It defaults to the
top-right rather than the bottom-right on purpose — the composer is full-width,
so a bottom-anchored overlay would sit on top of the send button.

```
┌──────────┬──────────────────────────────────┐
│ villager │ Villager hmm                  － │
│  figure  │ hits 12 · played 12              │
├──────────┴──────────────────────────────────┤
│ Reasoning 1284 chars  Reply 356 chars        │
│ Sounds 2 clips                               │
│ [ Listening · click to pause ] [ Play once ] │
│ Volume ─●─                                   │
│ Source  [ Reasoning only ▾ ]                 │
│ Matcher [ (?<!…) ]   [Apply] [Default]       │
│ Recent   hmm  嗯  唔                         │
└──────────────────────────────────────────────┘
```

The panel follows the interface language: it registers English and Chinese
dictionaries with the shared `locale` service and re-renders when the locale
changes. If that service is unavailable it falls back to English rather than
failing to render.

## Install

```sh
dsh plugin --profile web add dsh-villager-hmm
```

That is the whole install. The package declares `dsh.bundle`, so `dsh plugin`
registers it as a profile layer by itself — there is no configuration file to
edit. Restart the profile when it finishes.

Then fetch the assets, from the profile directory (where the package's `bin` is
linked):

```sh
cd "$DSH_HOME/profiles/web"
npx dsh-villager-hmm-assets
```

Skip this step and the plugin still loads. It shows its panel and prints the
exact command to run — with an absolute path, so it works from any directory —
and never fails silently.

## Assets

**This package ships no Minecraft material.** The two villager sounds and the
villager skin are fetched on your machine into a per-user cache:

```
$DSH_HOME/.dsh-villager-hmm/assets/
  idle1.ogg      villager "hmm"
  idle2.ogg      villager "hmm", second take
  villager.png   the 64x64 villager skin, cropped into the figure by CSS
```

The panel shows the exact command if the cache is empty. Two sources are
supported:

| Flag | Meaning |
| --- | --- |
| *(none)* | Download from a public mirror of the vanilla 1.21.4 client assets |
| `--from <dir>` | Copy from an asset tree you extracted yourself — **the option that matches the game's terms** |
| `--base <url>` | Your own mirror with the same layout |
| `--dir <path>` | Use a different cache directory |
| `--force` | Re-fetch files that are already there |

```sh
# from an extraction you made yourself
node "$DSH_HOME/profiles/web/node_modules/dsh-villager-hmm/scripts/fetch-assets.mjs" \
  --from "C:/mc-extract/assets/minecraft"
```

The cache lives outside `node_modules`, so it survives plugin upgrades. The host
half re-reads it per request, so running the fetch script takes effect on a page
reload — no harness restart.

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
the panel's **Reasoning** counter tells you: if it climbs, you have a reasoning
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

**The plugin only consumes.** It registers one event listener and one HTTP
prefix route; it publishes no service and patches nothing. If the harness stops
emitting the event, or the overlay slot disappears, the plugin degrades to doing
nothing — it does not take the boot or the page with it.

Two details shape the scanner:

**`frame.revision` is not a stream identity.** It increments on *every* frame.
Keying the scan buffer by it resets the buffer on every delta, so the matcher
only ever sees one character and never matches. The buffer is keyed by
`attemptId:turn:step`.

**The scan is inline, not debounced.** Deltas arrive far faster than any
debounce window, so every new delta cancels the pending timer before it can
fire. Because the matcher keeps a consumed-offset cursor, scanning on every
delta is amortised O(n). A match that ends exactly at the buffer end is deferred
unless the attempt is finishing, so `hm` is never counted before the next delta
can turn it into `hmm`.

## Routes

The plugin owns one HTTP prefix, `/dsh-villager-hmm`:

| Route | Purpose |
| --- | --- |
| `GET /state?cursor=N` | counters, asset status, and triggers newer than `N` |
| `GET /config?enabled&mode&pattern` | change settings at runtime |
| `GET /sound/<n>.ogg` | the audio, read from the cache |
| `GET /texture.png` | the villager skin, read from the cache |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test suites, what CI enforces,
and the release process.

## License

The code is MIT (see `LICENSE` — kept verbatim, with nothing appended, so
GitHub detects it as MIT rather than "Other").

No third-party assets are bundled or redistributed: `scripts/fetch-assets.mjs`
downloads them on your machine, at your direction, into a local cache. See
[`NOTICE`](NOTICE) for the asset terms. Minecraft is a trademark of Mojang
Studios; this project is not affiliated with or endorsed by Mojang or
Microsoft.
