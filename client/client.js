/**
 * dsh-villager-hmm — client half (prebuilt browser bundle).
 *
 * This file is consumed verbatim by the harness client module system: it
 * registers a lazy CJS factory, and the module body only runs when the
 * factory is materialized. There is no bundler step, so everything it needs
 * is either a `require` resolved by the module table or a plain browser
 * global.
 */
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
      assetDir: '',
      setupCommand: 'npx dsh-villager-hmm-assets',
      blocked: false,
      volume: 0.7,
      open: true,
      hitSeq: 0,
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
        merge({ error: '无法创建音频对象: ' + describe(err) })
        return
      }
      node.volume = Math.max(0, Math.min(1, state.volume === undefined ? 0.7 : state.volume))
      let outcome = null
      try {
        outcome = node.play()
      } catch (err) {
        merge({ blocked: true, error: '播放失败: ' + describe(err) })
        return
      }
      state.played += 1
      state.hitSeq += 1
      state.blocked = false
      notify()
      if (outcome && typeof outcome.catch === 'function') {
        outcome.catch((err) => {
          merge({ blocked: true, error: '浏览器拦截了自动播放: ' + describe(err) })
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
        merge({ error: '无法连接宿主: ' + describe(err) })
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
        merge({ error: '配置下发失败: ' + describe(err) })
      }
    }

    // ------------------------------------------------------------------- ui

    function Overlay() {
      const s = useStore()
      const face = s.hasTexture
        ? h('div', {
            // A fresh key remounts the node so the CSS animation replays.
            key: 'face-' + s.hitSeq,
            className: 'vhm-face' + (s.hitSeq > 0 ? ' vhm-face-hit' : ''),
          })
        : h('div', { className: 'vhm-face vhm-face-missing', title: '贴图未获取' }, '?')

      return h('div', { className: 'vhm-ov' + (s.open ? '' : ' vhm-ov-min') },
        h('div', { className: 'vhm-bar' },
          face,
          h('span', { className: 'vhm-title' }, '村民 hmm 音效'),
          h('span', { className: 'vhm-count' }, '触发 ' + String(s.total) + ' · 播放 ' + String(s.played)),
          h('button', {
            className: 'vhm-icon',
            title: s.open ? '收起' : '展开',
            onClick: () => { state.open = !state.open; notify() },
          }, s.open ? '－' : '＋'),
        ),
        s.open ? h('div', { className: 'vhm-body' },
          s.ready
            ? null
            : h('div', { className: 'vhm-hint' }, '正在连接宿主…'),
          s.soundCount === 0
            ? h('div', { className: 'vhm-setup' },
                h('div', { className: 'vhm-err' }, '音效素材尚未获取，暂时不会出声。'),
                h('div', { className: 'vhm-hint' }, '在 profile 目录下执行：'),
                h('code', { className: 'vhm-cmd' }, s.setupCommand),
                s.assetDir ? h('div', { className: 'vhm-hint' }, '缓存目录 ' + s.assetDir) : null,
              )
            : null,
          h('div', { className: 'vhm-stats' },
            h('span', null, '思维链 ', h('b', null, String(s.reasoningChars)), ' 字'),
            h('span', null, '正文 ', h('b', null, String(s.textChars)), ' 字'),
            h('span', null, '音效 ', h('b', null, String(s.soundCount)), ' 段'),
          ),
          h('div', { className: 'vhm-row' },
            h('button', {
              className: 'vhm-btn' + (s.enabled ? ' vhm-btn-on' : ''),
              onClick: () => { merge({ enabled: !s.enabled }); pushConfig({ enabled: !s.enabled }) },
            }, s.enabled ? '监听中 · 点击暂停' : '已暂停 · 点击开启'),
            h('button', {
              className: 'vhm-btn',
              onClick: () => { playOne(); drain() },
            }, '试听一次'),
            h('label', null, '音量'),
            h('input', {
              className: 'vhm-range', type: 'range', min: '0', max: '1', step: '0.05',
              value: String(state.volume === undefined ? 0.7 : state.volume),
              onChange: (event) => { state.volume = Number(event.target.value); notify() },
            }),
          ),
          h('div', { className: 'vhm-row' },
            h('label', null, '检测源'),
            h('select', {
              className: 'vhm-select', value: s.mode,
              onChange: (event) => { merge({ mode: event.target.value }); pushConfig({ mode: event.target.value }) },
            },
              h('option', { value: 'reasoning' }, '仅思维链'),
              h('option', { value: 'both' }, '思维链 + 正文'),
            ),
          ),
          h('div', { className: 'vhm-row' },
            h('label', null, '匹配式'),
            h('input', {
              className: 'vhm-input', value: s.patternDraft, spellCheck: false,
              onChange: (event) => { state.patternDraft = event.target.value; notify() },
            }),
            h('button', { className: 'vhm-btn', onClick: () => pushConfig({ pattern: s.patternDraft }) }, '应用'),
            s.defaultPattern
              ? h('button', {
                  className: 'vhm-btn',
                  onClick: () => { merge({ patternDraft: s.defaultPattern }); pushConfig({ pattern: s.defaultPattern }) },
                }, '默认')
              : null,
          ),
          s.patternError ? h('div', { className: 'vhm-err' }, '正则无效：' + s.patternError) : null,
          h('div', { className: 'vhm-row' },
            h('label', null, '最近命中'),
            s.recent.length === 0
              ? h('span', { className: 'vhm-hint' }, '等待模型说出「嗯…」')
              : h('div', { className: 'vhm-words' },
                  s.recent.map((word, index) => h('span', { className: 'vhm-word', key: index }, word)),
                ),
          ),
          s.blocked
            ? h('div', { className: 'vhm-hint' }, '⚠️ 浏览器拦截了自动播放：在页面上点一下任意位置即可解锁。')
            : null,
          s.error ? h('div', { className: 'vhm-err' }, s.error) : null,
        ) : null,
      )
    }

    // -------------------------------------------------------------- exports

    exports.name = 'dsh-villager-hmm/client'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        poll()
        const id = setInterval(poll, 250)
        return () => clearInterval(id)
      }, 'dsh-villager-hmm: poll host state')

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-villager-hmm',
        order: 50,
        label: '村民 hmm 音效',
      }, Overlay))
    }

    injectStyles()

    return module.exports

    // ------------------------------------------------------------- helpers

    function describe(err) {
      return err && err.message ? String(err.message) : String(err)
    }

    function injectStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-villager-hmm/styles'
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-villager-hmm'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
  },
})

/** Package-owned stylesheet, injected once at materialization. */
const CSS = [
  '.vhm-ov{position:fixed;right:16px;bottom:16px;z-index:60;width:400px;max-width:calc(100vw - 32px);',
  'pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;',
  'background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 30px rgba(0,0,0,.3);',
  'color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow:hidden;}',
  '.vhm-ov-min{width:auto;}',
  '.vhm-bar{display:flex;align-items:center;gap:9px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);}',
  '.vhm-face{width:30px;height:30px;flex:none;border-radius:7px;image-rendering:pixelated;',
  // The fetched villager.png is the full 64x64 skin; the head front face sits
  // at (7,8) 10x10, so scale 3 puts it at 192px with a -21/-24px offset.
  'background-image:url("/dsh-villager-hmm/texture.png");background-repeat:no-repeat;',
  'background-size:192px 192px;background-position:-21px -24px;',
  'box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);transform-origin:50% 80%;}',
  '.vhm-face-missing{display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1);',
  'color:var(--dsw-alias-label-secondary);font-size:16px;}',
  '.vhm-face-hit{animation:vhm-bob .46s cubic-bezier(.36,.07,.19,.97);}',
  '@keyframes vhm-bob{0%{transform:translateY(0) scale(1) rotate(0)}',
  '16%{transform:translateY(-6px) scale(1.16) rotate(-7deg)}',
  '44%{transform:translateY(1px) scale(.95) rotate(5deg)}',
  '72%{transform:translateY(-2px) scale(1.04) rotate(-2deg)}',
  '100%{transform:translateY(0) scale(1) rotate(0)}}',
  '.vhm-title{font-weight:600;font-size:12px;white-space:nowrap;}',
  '.vhm-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);',
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
