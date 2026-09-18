/**
 * dsh-villager-hmm — client half (prebuilt browser bundle).
 *
 * This file is consumed verbatim by the harness client module system: it
 * registers a lazy CJS factory, and the module body only runs when the
 * factory is materialized. There is no bundler step, so everything it needs
 * is either a `require` resolved by the module table or a plain browser
 * global.
 */
/**
 * Villager figure geometry, shared by the stylesheet and the bundle body.
 *
 * Taken verbatim from Mojang's own model — `Mojang/bedrock-samples`,
 * `resource_pack/models/entity/villager.geo.json`, whose Bedrock cube list
 * matches the Java villager. Each cube's `uv` is a Minecraft box-UV origin, and
 * the FRONT face of a `w x h x d` cube sits at `(u + d, v + d)` sized `w x h`:
 *
 *   cube                origin              size     uv      front      piece
 *   head                [-4, 24, -4]        8,10, 8  [ 0, 0] ( 8, 8)  8x10
 *   nose                [-1, 23, -6]        2, 4, 2  [24, 0] (26, 2)  2x4
 *   body                [-4, 12, -3]        8,12, 6  [16,20] (22,26)  8x12
 *   robe  (inflate .5)  [-4,  6, -3]        8,18, 6  [ 0,38] ( 6,44)  8x18
 *   arm L / R           [-8,16,-2]/[4,16,-2] 4, 8, 4 [44,22] (48,26)  4x8
 *   forearms            [-4, 16, -2]        8, 4, 4  [40,38] (44,42)  8x4
 *   leg L / R           [-4, 0,-2]/[ 0, 0,-2] 4,12, 4 [ 0,22] ( 4,26)  4x12
 *
 * The model spans y 0..34 with the feet at 0, so the canvas is 34 tall with the
 * head on top and `canvasY = 34 - modelY`. Every number stays integral, which is
 * what keeps the 4x nearest-neighbour upscale crisp.
 *
 * Two cubes were missing before this was derived from the model: the robe, which
 * is what makes the figure look dressed, and the folded forearms. The robe's
 * front face is fully transparent in the base skin — the game paints it from the
 * villager TYPE overlay at the same UVs — so it only shows once that second
 * texture is present.
 *
 * Order is back-to-front. Forearms go last so the folded arms sit over the robe,
 * and the robe covers the legs down to the hem, leaving bare shins below.
 */
const FIGURE_SCALE = 4
const FIGURE_PARTS = [
  { sx: 4,  sy: 26, w: 4, h: 12, dx: 4,  dy: 22 }, // leg  [-4, 0,-2]
  { sx: 4,  sy: 26, w: 4, h: 12, dx: 8,  dy: 22 }, // leg  [ 0, 0,-2]
  { sx: 48, sy: 26, w: 4, h: 8,  dx: 0,  dy: 10 }, // arm  [-8,16,-2]
  { sx: 48, sy: 26, w: 4, h: 8,  dx: 12, dy: 10 }, // arm  [ 4,16,-2]
  { sx: 22, sy: 26, w: 8, h: 12, dx: 4,  dy: 10 }, // body [-4,12,-3]
  { sx: 6,  sy: 44, w: 8, h: 18, dx: 4,  dy: 10 }, // robe [-4, 6,-3]
  { sx: 8,  sy: 8,  w: 8, h: 10, dx: 4,  dy: 0  }, // head [-4,24,-4]
  { sx: 26, sy: 2,  w: 2, h: 4,  dx: 7,  dy: 7  }, // nose [-1,23,-6]
  { sx: 44, sy: 42, w: 8, h: 4,  dx: 4,  dy: 14 }, // forearms [-4,16,-2]
]

/**
 * Collapsed floating head: the face plus its nose. The nose hangs one pixel
 * below the chin in the model (y 23..27 against a head ending at 24), so this
 * canvas is 11 tall rather than the head's 10.
 */
const FACE_SCALE = 4
const FACE_PARTS = [
  { sx: 8,  sy: 8, w: 8, h: 10, dx: 0, dy: 0 },
  { sx: 26, sy: 2, w: 2, h: 4,  dx: 3, dy: 7 },
]

/** Canvas extents are derived, so editing a part cannot desync the stylesheet. */
const canvasExtent = (parts) => ({
  w: parts.reduce((max, part) => Math.max(max, part.dx + part.w), 0),
  h: parts.reduce((max, part) => Math.max(max, part.dy + part.h), 0),
})
const FIGURE_EXTENT = canvasExtent(FIGURE_PARTS)
const FACE_EXTENT = canvasExtent(FACE_PARTS)

/** The fetched skins are 64x64 box-UV atlases. */
const TEXTURE_PX = 64

/**
 * Inline crop for one piece, scaled by `scale`. Every background layer shares
 * the piece's UV, which is what makes the type overlay line up with the base
 * skin pixel for pixel. `layers` is ordered topmost first, per CSS.
 */
function partStyle(part, scale, layers) {
  const size = (TEXTURE_PX * scale) + 'px ' + (TEXTURE_PX * scale) + 'px'
  const position = (-part.sx * scale) + 'px ' + (-part.sy * scale) + 'px'
  return {
    left: part.dx * scale + 'px',
    top: part.dy * scale + 'px',
    width: part.w * scale + 'px',
    height: part.h * scale + 'px',
    backgroundImage: layers.join(','),
    backgroundPosition: layers.map(() => position).join(','),
    backgroundSize: layers.map(() => size).join(','),
  }
}

window.__ModuleLoader__.load({
  id: 'dsh-villager-hmm',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    /** HTTP prefix owned by this plugin's host half. */
    const PREFIX = '/dsh-villager-hmm'
    /** Minimum spacing between two sounds, so a burst does not machine-gun. */
    const MIN_GAP_MS = 260

    /**
     * Background layers for one piece, topmost first (CSS order).
     *
     * The type overlay carries the robe; it is drawn over the base skin at the
     * same UV. When it has not been fetched the figure still renders, in the
     * base skin's under-robe, and the panel says the robe is missing.
     */
    const textureLayers = (withType) => {
      const base = 'url("' + PREFIX + '/texture.png")'
      return withType ? ['url("' + PREFIX + '/type.png")', base] : [base]
    }

    // ---------------------------------------------------------------- store

    const listeners = new Set()
    const state = {
      ready: false,
      error: null,
      enabled: true,
      mode: 'both',
      pattern: '',
      patternDraft: '',
      patternError: null,
      defaultPattern: '',
      total: 0,
      played: 0,
      reasoningChars: 0,
      textChars: 0,
      recent: [],
      soundCount: 0,
      hasTexture: false,
      hasType: false,
      assetDir: '',
      setupCommand: 'npx dsh-villager-hmm-assets',
      blocked: false,
      volume: 0.7,
      open: true,
      hitSeq: 0,
      pos: null,
    }

    const notify = () => {
      listeners.forEach((fn) => {
        try { fn() } catch (err) { /* a view must not break the loop */ }
      })
    }
    const merge = (patch) => {
      Object.keys(patch).forEach((key) => { state[key] = patch[key] })
      notify()
    }

    function useStore() {
      const [, bump] = useState(0)
      useEffect(() => {
        const fn = () => bump((n) => n + 1)
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      }, [])
      return state
    }

    // ---------------------------------------------------------------- audio

    let soundUrls = []
    let cursor = 0
    let busy = false
    let lastPlay = 0
    let draining = false
    const queue = []

    const playOne = () => {
      if (soundUrls.length === 0) return
      const url = soundUrls[Math.floor(Math.random() * soundUrls.length)]
      let node = null
      try {
        node = new Audio(url)
      } catch (err) {
        merge({ error: t('errAudio') + describe(err) })
        return
      }
      node.volume = Math.max(0, Math.min(1, state.volume === undefined ? 0.7 : state.volume))
      let outcome = null
      try {
        outcome = node.play()
      } catch (err) {
        merge({ blocked: true, error: t('errPlay') + describe(err) })
        return
      }
      state.played += 1
      state.hitSeq += 1
      state.blocked = false
      notify()
      if (outcome && typeof outcome.catch === 'function') {
        outcome.catch((err) => {
          merge({ blocked: true, error: t('errBlocked') + describe(err) })
        })
      }
    }

    const drain = () => {
      if (draining) return
      if (queue.length === 0 || soundUrls.length === 0) return
      if (state.enabled !== true) { queue.length = 0; return }
      draining = true
      const step = () => {
        if (queue.length === 0 || state.enabled !== true) { draining = false; return }
        const wait = lastPlay + MIN_GAP_MS - Date.now()
        if (wait > 0) { setTimeout(step, wait); return }
        queue.shift()
        lastPlay = Date.now()
        playOne()
        if (queue.length > 0) setTimeout(step, MIN_GAP_MS)
        else draining = false
      }
      step()
    }

    // ----------------------------------------------------------------- poll

    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const response = await fetch(PREFIX + '/state?cursor=' + cursor, { cache: 'no-store' })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const data = await response.json()
        if (data.soundCount > 0 && soundUrls.length !== data.soundCount) {
          soundUrls = []
          for (let i = 0; i < data.soundCount; i += 1) soundUrls.push(PREFIX + '/sound/' + i + '.ogg')
        }
        cursor = typeof data.cursor === 'number' ? data.cursor : cursor
        const patch = {
          ready: true,
          error: null,
          enabled: data.enabled !== false,
          total: data.total,
          reasoningChars: data.reasoningChars,
          textChars: data.textChars,
          recent: Array.isArray(data.recent) ? data.recent.slice(-8) : [],
          soundCount: data.soundCount,
          hasTexture: data.hasTexture === true,
          hasType: data.hasType === true,
          assetDir: typeof data.assetDir === 'string' ? data.assetDir : '',
          setupCommand: typeof data.setupCommand === 'string' ? data.setupCommand : state.setupCommand,
          patternError: data.patternError ? String(data.patternError) : null,
          defaultPattern: typeof data.defaultPattern === 'string' ? data.defaultPattern : state.defaultPattern,
        }
        if (data.mode === 'reasoning' || data.mode === 'both') patch.mode = data.mode
        if (typeof data.pattern === 'string' && state.patternDraft === '') patch.patternDraft = data.pattern
        if (typeof data.pattern === 'string') patch.pattern = data.pattern
        const triggers = Array.isArray(data.triggers) ? data.triggers : []
        for (let i = 0; i < triggers.length; i += 1) queue.push(1)
        if (queue.length > 16) queue.splice(0, queue.length - 16)
        merge(patch)
        if (triggers.length > 0) drain()
      } catch (err) {
        merge({ error: t('errHost') + describe(err) })
      } finally {
        busy = false
      }
    }

    const pushConfig = async (patch) => {
      const params = new URLSearchParams()
      if (typeof patch.enabled === 'boolean') params.set('enabled', patch.enabled ? '1' : '0')
      if (patch.mode) params.set('mode', patch.mode)
      if (patch.pattern) params.set('pattern', patch.pattern)
      try {
        const response = await fetch(PREFIX + '/config?' + params.toString(), { cache: 'no-store' })
        const data = await response.json()
        merge({
          pattern: typeof data.pattern === 'string' ? data.pattern : state.pattern,
          patternError: data.patternError ? String(data.patternError) : null,
        })
      } catch (err) {
        merge({ error: t('errConfig') + describe(err) })
      }
    }

    // ------------------------------------------------------------ placement

    /**
     * Where the panel sits. The default is the top-right anchor; dragging
     * switches to an absolute position that survives a reload, so a panel
     * parked out of the way stays out of the way.
     */
    const POSITION_KEY = 'dsh-villager-hmm:position'
    const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

    const loadPosition = () => {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(POSITION_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed && isNum(parsed.left) && isNum(parsed.top)) {
          return { left: parsed.left, top: parsed.top }
        }
      } catch (error) {
        // A blocked or corrupt store must not stop the panel rendering.
      }
      return null
    }

    const savePosition = (position) => {
      try {
        if (typeof localStorage === 'undefined') return
        if (position === null) localStorage.removeItem(POSITION_KEY)
        else localStorage.setItem(POSITION_KEY, JSON.stringify(position))
      } catch (error) {
        // A convenience, not state worth failing over.
      }
    }

    /** Keep the panel reachable: never fully off the top or left edge. */
    const clampPosition = (left, top) => {
      const width = typeof window !== 'undefined' && isNum(window.innerWidth) ? window.innerWidth : 0
      const height = typeof window !== 'undefined' && isNum(window.innerHeight) ? window.innerHeight : 0
      const maxLeft = width > 0 ? Math.max(0, width - 80) : left
      const maxTop = height > 0 ? Math.max(0, height - 44) : top
      return { left: Math.max(0, Math.min(maxLeft, left)), top: Math.max(0, Math.min(maxTop, top)) }
    }

    const drag = { active: false, moved: false, offsetX: 0, offsetY: 0 }

    const onBarDown = (event) => {
      // A control inside the bar must stay clickable, not start a drag.
      const target = event.target
      if (target && typeof target.closest === 'function' && target.closest('button') !== null) return
      const rect = event.currentTarget.getBoundingClientRect()
      drag.active = true
      drag.moved = false
      drag.offsetX = event.clientX - rect.left
      drag.offsetY = event.clientY - rect.top
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* optional */ }
    }

    const onBarMove = (event) => {
      if (!drag.active) return
      drag.moved = true
      merge({ pos: clampPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY) })
    }

    const onBarUp = (event) => {
      if (!drag.active) return
      drag.active = false
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* optional */ }
      savePosition(state.pos)
    }

    /** Double-clicking the bar returns the panel to its default corner. */
    const onBarDoubleClick = () => {
      merge({ pos: null })
      savePosition(null)
    }

    state.pos = loadPosition()

    // ------------------------------------------------------------- messages

    /**
     * Panel text.
     *
     * Registered through the shared `locale` service so the panel follows the
     * interface language instead of hard-coding one. Values are concatenated at
     * the call site rather than interpolated, which is how the other plugins in
     * this ecosystem use the service.
     */
    const NS = 'dsh-villager-hmm'
    const MESSAGES = {
      en: {
        title: 'Villager hmm',
        hits: 'hits',
        played: 'played',
        reasoning: 'Reasoning',
        reply: 'Reply',
        sounds: 'Sounds',
        chars: 'chars',
        clips: 'clips',
        listening: 'Listening · click to pause',
        paused: 'Paused · click to resume',
        playOnce: 'Play once',
        volume: 'Volume',
        source: 'Source',
        modeReasoning: 'Reasoning only',
        modeBoth: 'Reasoning + reply',
        matcher: 'Matcher',
        apply: 'Apply',
        reset: 'Default',
        recent: 'Recent',
        waiting: 'waiting for a hmm…',
        connecting: 'connecting to the host…',
        assetsMissing: 'Sounds are not fetched yet, so nothing will play.',
        assetsHow: 'Run this from any directory:',
        assetsCache: 'Cache',
        autoplayBlocked: 'The browser blocked autoplay — click anywhere on the page to unlock.',
        invalidPattern: 'Invalid pattern: ',
        dragHint: 'Drag to move · double-click to reset',
        collapse: 'Collapse',
        expand: 'Expand',
        expandHint: 'Expand · double-click to reset',
        noTexture: 'texture not fetched',
        noType: 'Type overlay not fetched — the villager has no robe yet',
        errAudio: 'Could not create an audio element: ',
        errPlay: 'Playback failed: ',
        errBlocked: 'The browser blocked autoplay: ',
        errHost: 'Cannot reach the host: ',
        errConfig: 'Could not send the configuration: ',
      },
      zh: {
        title: '村民 hmm 音效',
        hits: '触发',
        played: '播放',
        reasoning: '思维链',
        reply: '正文',
        sounds: '音效',
        chars: '字',
        clips: '段',
        listening: '监听中 · 点击暂停',
        paused: '已暂停 · 点击开启',
        playOnce: '试听一次',
        volume: '音量',
        source: '检测源',
        modeReasoning: '仅思维链',
        modeBoth: '思维链 + 正文',
        matcher: '匹配式',
        apply: '应用',
        reset: '默认',
        recent: '最近命中',
        waiting: '等待模型说出「嗯…」',
        connecting: '正在连接宿主…',
        assetsMissing: '音效素材尚未获取，暂时不会出声。',
        assetsHow: '在任意目录执行：',
        assetsCache: '缓存目录',
        autoplayBlocked: '⚠️ 浏览器拦截了自动播放：在页面上点一下任意位置即可解锁。',
        invalidPattern: '正则无效：',
        dragHint: '拖动可移动 · 双击复位',
        collapse: '收起',
        expand: '展开',
        expandHint: '展开 · 双击复位',
        noTexture: '贴图未获取',
        noType: '未获取类型覆盖层，村民还没有袍子',
        errAudio: '无法创建音频对象：',
        errPlay: '播放失败：',
        errBlocked: '浏览器拦截了自动播放：',
        errHost: '无法连接宿主：',
        errConfig: '配置下发失败：',
      },
    }

    /**
     * Bound in apply() once the locale service is reachable. Defaults to
     * English so the panel renders even when that service is absent.
     */
    let t = (key) => (MESSAGES.en[key] === undefined ? key : MESSAGES.en[key])

    // ------------------------------------------------------------------- ui

    function Overlay() {
      const s = useStore()
      const layers = textureLayers(s.hasType)
      const figure = s.hasTexture
        ? h('div', {
            // A fresh key remounts the node so the CSS animation replays.
            key: 'figure-' + s.hitSeq,
            className: 'vhm-figure' + (s.hitSeq > 0 ? ' vhm-figure-hit' : ''),
            // The robe comes from the overlay; without it the villager is drawn
            // in the base skin's under-robe, which is worth saying out loud.
            title: s.hasType ? t('dragHint') : t('noType'),
          }, FIGURE_PARTS.map((part, index) => h('i', { key: index, style: partStyle(part, FIGURE_SCALE, layers) })))
        : h('div', { className: 'vhm-figure vhm-figure-missing', title: t('noTexture') }, '?')

      // A dragged position pins the panel with left/top, so the stylesheet's
      // top/right anchor has to be released or both would apply.
      const placed = s.pos
        ? { left: s.pos.left + 'px', top: s.pos.top + 'px', right: 'auto', bottom: 'auto' }
        : null

      // Collapsed shows nothing but the villager's head: the figure doubles as
      // the toggle, and drag/expand handlers live on it directly.
      if (!s.open) {
        return h('div', { className: 'vhm-ov vhm-ov-min', style: placed },
          h('div', {
            className: 'vhm-min',
            title: t('expandHint'),
            onPointerDown: onBarDown,
            onPointerMove: onBarMove,
            onPointerUp: onBarUp,
            onPointerCancel: onBarUp,
            onDoubleClick: onBarDoubleClick,
            onClick: (event) => {
              if (drag.moved) return
              state.open = true; notify()
            },
          }, s.hasTexture
            ? h('div', {
                key: 'head-' + s.hitSeq,
                className: 'vhm-min-face vhm-face' + (s.hitSeq > 0 ? ' vhm-min-hit' : ''),
              }, FACE_PARTS.map((part, index) => h('i', { key: index, style: partStyle(part, FACE_SCALE, layers) })))
            : h('div', { className: 'vhm-min-face vhm-figure-missing' }, '?'),
          ),
        )
      }

      return h('div', { className: 'vhm-ov', style: placed },
        h('div', {
          className: 'vhm-bar',
          title: t('dragHint'),
          onPointerDown: onBarDown,
          onPointerMove: onBarMove,
          onPointerUp: onBarUp,
          onPointerCancel: onBarUp,
          onDoubleClick: onBarDoubleClick,
        },
          figure,
          h('div', { className: 'vhm-barinfo' },
            h('span', { className: 'vhm-title' }, t('title')),
            h('span', { className: 'vhm-count' },
              t('hits') + ' ' + String(s.total) + ' · ' + t('played') + ' ' + String(s.played)),
          ),
          h('button', {
            className: 'vhm-icon',
            title: s.open ? t('collapse') : t('expand'),
            onClick: () => { state.open = !state.open; notify() },
          }, s.open ? '－' : '＋'),
        ),
        s.open ? h('div', { className: 'vhm-body' },
          s.ready
            ? null
            : h('div', { className: 'vhm-hint' }, t('connecting')),
          s.soundCount === 0
            ? h('div', { className: 'vhm-setup' },
                h('div', { className: 'vhm-err' }, t('assetsMissing')),
                h('div', { className: 'vhm-hint' }, t('assetsHow')),
                h('code', { className: 'vhm-cmd' }, s.setupCommand),
                s.assetDir ? h('div', { className: 'vhm-hint' }, t('assetsCache') + ' ' + s.assetDir) : null,
              )
            : null,
          h('div', { className: 'vhm-stats' },
            h('span', null, t('reasoning') + ' ', h('b', null, String(s.reasoningChars)), ' ' + t('chars')),
            h('span', null, t('reply') + ' ', h('b', null, String(s.textChars)), ' ' + t('chars')),
            h('span', null, t('sounds') + ' ', h('b', null, String(s.soundCount)), ' ' + t('clips')),
          ),
          h('div', { className: 'vhm-row' },
            h('button', {
              className: 'vhm-btn' + (s.enabled ? ' vhm-btn-on' : ''),
              onClick: () => {
                // Evaluate once: merge() mutates the live state object, so a
                // second `!s.enabled` here would read the already-flipped value
                // and send the original one back to the host.
                const next = s.enabled !== true
                merge({ enabled: next })
                pushConfig({ enabled: next })
              },
            }, s.enabled ? t('listening') : t('paused')),
            h('button', {
              className: 'vhm-btn',
              onClick: () => { playOne(); drain() },
            }, t('playOnce')),
            h('label', null, t('volume')),
            h('input', {
              className: 'vhm-range', type: 'range', min: '0', max: '1', step: '0.05',
              value: String(state.volume === undefined ? 0.7 : state.volume),
              onChange: (event) => { state.volume = Number(event.target.value); notify() },
            }),
          ),
          h('div', { className: 'vhm-row' },
            h('label', null, t('source')),
            h('select', {
              className: 'vhm-select', value: s.mode,
              onChange: (event) => { merge({ mode: event.target.value }); pushConfig({ mode: event.target.value }) },
            },
              h('option', { value: 'reasoning' }, t('modeReasoning')),
              h('option', { value: 'both' }, t('modeBoth')),
            ),
          ),
          h('div', { className: 'vhm-row' },
            h('label', null, t('matcher')),
            h('input', {
              className: 'vhm-input', value: s.patternDraft, spellCheck: false,
              onChange: (event) => { state.patternDraft = event.target.value; notify() },
            }),
            h('button', { className: 'vhm-btn', onClick: () => pushConfig({ pattern: s.patternDraft }) }, t('apply')),
            s.defaultPattern
              ? h('button', {
                  className: 'vhm-btn',
                  onClick: () => { merge({ patternDraft: s.defaultPattern }); pushConfig({ pattern: s.defaultPattern }) },
                }, t('reset'))
              : null,
          ),
          s.patternError ? h('div', { className: 'vhm-err' }, t('invalidPattern') + s.patternError) : null,
          h('div', { className: 'vhm-row' },
            h('label', null, t('recent')),
            s.recent.length === 0
              ? h('span', { className: 'vhm-hint' }, t('waiting'))
              : h('div', { className: 'vhm-words' },
                  s.recent.map((word, index) => h('span', { className: 'vhm-word', key: index }, word)),
                ),
          ),
          s.blocked
            ? h('div', { className: 'vhm-hint' }, t('autoplayBlocked'))
            : null,
          s.error ? h('div', { className: 'vhm-err' }, s.error) : null,
        ) : null,
      )
    }

    // -------------------------------------------------------------- exports

    exports.name = 'dsh-villager-hmm/client'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      // Follow the interface language. The locale service is read optionally
      // rather than injected: without it the panel still renders in English,
      // instead of parking the whole client half for want of a dictionary.
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null) {
          ctx.effect(() => {
            const disposers = [
              locale.register(NS, 'en', MESSAGES.en),
              locale.register(NS, 'zh', MESSAGES.zh),
            ]
            // Registrations bump the revision, so a late dictionary also has to
            // re-render what is already on screen.
            const unsubscribe = typeof locale.subscribe === 'function'
              ? locale.subscribe(() => notify())
              : null
            return () => {
              if (unsubscribe !== null) unsubscribe()
              for (const dispose of disposers) {
                try { dispose() } catch (error) { /* already gone */ }
              }
            }
          }, 'dsh-villager-hmm: dictionaries')
          t = locale.bind(NS)
        }
      } catch (error) {
        console.error('dsh-villager-hmm: locale wiring failed, using English', error)
      }

      // Both registrations are best-effort: a renamed slot or a missing timer
      // must degrade to "no panel", never to a broken page.
      try {
        ctx.effect(() => {
          poll()
          const id = setInterval(poll, 250)
          return () => clearInterval(id)
        }, 'dsh-villager-hmm: poll host state')
      } catch (error) {
        console.error('dsh-villager-hmm: polling unavailable', error)
      }

      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-villager-hmm',
          order: 50,
          label: () => t('title'),
        }, Overlay))
      } catch (error) {
        console.error('dsh-villager-hmm: could not register the overlay', error)
      }
    }

    injectStyles()

    return module.exports

    // ------------------------------------------------------------- helpers

    function describe(err) {
      return err && err.message ? String(err.message) : String(err)
    }

    function injectStyles() {
      // Styling is cosmetic; never let it abort materialization.
      try {
        if (typeof document === 'undefined') return
        const tagId = 'dsh-villager-hmm/styles'
        if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-villager-hmm'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (error) {
        console.error('dsh-villager-hmm: stylesheet injection failed', error)
      }
    }
  },
})

/** Package-owned stylesheet, injected once at materialization. */
const CSS = [
  // Anchored top-right, not bottom-right: the composer is full-width, so any
  // bottom-anchored overlay lands on the send button. A dragged position
  // overrides this anchor through inline left/top.
  '.vhm-ov{position:fixed;top:76px;right:16px;z-index:60;width:400px;max-width:calc(100vw - 32px);',
  'pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;',
  'background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 30px rgba(0,0,0,.3);',
  'color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow:hidden;}',
  '.vhm-ov-min{width:auto;}',
  // Collapsed: a bare floating head, nothing but the villager's face.
  '.vhm-ov-min{border:none;background:transparent;box-shadow:none;overflow:visible;}',
  '.vhm-min{cursor:grab;touch-action:none;user-select:none;position:relative;',
  'width:' + (FACE_EXTENT.w * FACE_SCALE) + 'px;height:' + (FACE_EXTENT.h * FACE_SCALE) + 'px;',
  'image-rendering:pixelated;filter:drop-shadow(0 3px 6px rgba(0,0,0,.4));transform-origin:50% 100%;}',
  '.vhm-min:active{cursor:grabbing;}',
  '.vhm-min:hover .vhm-min-face{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
  '.vhm-min-face{position:absolute;inset:0;}',
  // The image, its scale and every crop offset are inline (partStyle), because
  // they all derive from FIGURE_*/FACE_* and the layer count. Duplicating the
  // scale here is what used to let the stylesheet and the parts drift apart.
  '.vhm-min-face i{position:absolute;display:block;background-repeat:no-repeat;}',
  '.vhm-bar{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);',
  'cursor:grab;touch-action:none;user-select:none;}',
  '.vhm-bar:active{cursor:grabbing;}',
  '.vhm-barinfo{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}',
  // Each `i` crops one model cube out of the fetched 64x64 skin; see the
  // geometry block at the top of this file for the box-UV derivation.
  '.vhm-figure{position:relative;flex:none;image-rendering:pixelated;',
  'width:' + (FIGURE_EXTENT.w * FIGURE_SCALE) + 'px;height:' + (FIGURE_EXTENT.h * FIGURE_SCALE) + 'px;',
  'transform-origin:50% 88%;}',
  '.vhm-figure i{position:absolute;display:block;background-repeat:no-repeat;}',
  '.vhm-figure-missing{display:flex;align-items:center;justify-content:center;width:44px;height:44px;',
  'background:var(--dsw-alias-bg-layer-1);border-radius:8px;color:var(--dsw-alias-label-secondary);',
  'font-size:16px;}',
  // The missing-texture placeholder inside the collapsed head needs a tighter
  // box than the expanded figure's 44x44.
  '.vhm-min .vhm-figure-missing{width:' + (FACE_EXTENT.w * FACE_SCALE) + 'px;',
  'height:' + (FACE_EXTENT.h * FACE_SCALE) + 'px;border-radius:10px;}',
  '.vhm-figure-hit{animation:vhm-bob .46s cubic-bezier(.36,.07,.19,.97);}',
  '@keyframes vhm-bob{0%{transform:translateY(0) scale(1) rotate(0)}',
  '16%{transform:translateY(-6px) scale(1.16) rotate(-7deg)}',
  '44%{transform:translateY(1px) scale(.95) rotate(5deg)}',
  '72%{transform:translateY(-2px) scale(1.04) rotate(-2deg)}',
  '100%{transform:translateY(0) scale(1) rotate(0)}}',
  '.vhm-min-hit{animation:vhm-bob-min .46s cubic-bezier(.36,.07,.19,.97);}',
  '@keyframes vhm-bob-min{0%{transform:translateY(0) scale(1)}',
  '25%{transform:translateY(-5px) scale(1.18)}',
  '60%{transform:translateY(1px) scale(.94)}',
  '100%{transform:translateY(0) scale(1)}}',
  '.vhm-title{font-weight:600;font-size:12px;white-space:nowrap;}',
  '.vhm-count{font-size:11px;color:var(--dsw-alias-label-secondary);',
  'font-variant-numeric:tabular-nums;white-space:nowrap;}',
  '.vhm-icon{cursor:pointer;font:inherit;line-height:1;font-size:14px;width:22px;height:22px;flex:none;',
  'border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
  'color:var(--dsw-alias-label-primary);}',
  '.vhm-icon:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.vhm-body{display:flex;flex-direction:column;gap:9px;padding:11px 13px;}',
  '.vhm-stats{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;}',
  '.vhm-stats b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}',
  '.vhm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
  '.vhm-row>label{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:52px;}',
  '.vhm-btn{cursor:pointer;font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;',
  'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
  'color:var(--dsw-alias-label-primary);}',
  '.vhm-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.vhm-btn-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
  '.vhm-input{flex:1;min-width:160px;font:inherit;font-size:12px;',
  'font-family:ui-monospace,Menlo,Consolas,monospace;padding:4px 8px;border-radius:8px;',
  'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);',
  'color:var(--dsw-alias-label-primary);}',
  '.vhm-select{font:inherit;font-size:12px;padding:4px 6px;border-radius:8px;',
  'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
  'color:var(--dsw-alias-label-primary);}',
  '.vhm-range{flex:1;min-width:110px;accent-color:var(--dsw-alias-brand-primary);}',
  '.vhm-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.vhm-setup{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;',
  'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-state-warn-primary);}',
  '.vhm-cmd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;padding:3px 7px;',
  'border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
  'word-break:break-all;}',
  '.vhm-err{font-size:11px;color:var(--dsw-alias-state-error-primary);word-break:break-all;}',
  '.vhm-words{display:flex;gap:6px;flex-wrap:wrap;}',
  '.vhm-word{font-size:11px;padding:1px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);',
  'border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}',
].join('\n')
