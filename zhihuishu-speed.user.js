// ==UserScript==
// @name         智慧树/知到 视频倍速控制
// @namespace    https://local/zhs-speed
// @version      1.0.0
// @description  为智慧树学习页（hike.zhihuishu.com/aidedteaching/sourceLearning 等）添加浮动倍速面板：0.25x–16x、快捷键、倍速锁定（防止播放器把倍速改回 1.5x）
// @author       -
// @match        *://*.zhihuishu.com/*
// @match        *://*.polymas.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  var VERSION = '1.0.0';
  var STORE_KEY = 'zs-speed-config';
  var RATE_MIN = 0.25;
  var RATE_MAX = 16;

  // 只在顶层窗口运行（同源 iframe 里的视频由下面的 getDocs() 跨文档查找）
  if (window.top !== window.self) return;
  if (window.__ZS_SPEED__ && window.__ZS_SPEED__.version === VERSION) return;

  var DEFAULTS = {
    rate: 1.5,
    locked: true,
    visible: true,
    collapsed: false,
    x: null,
    y: null
  };

  /* ------------------------------ 配置 ------------------------------ */

  var cfg = (function () {
    var base = {};
    for (var k in DEFAULTS) base[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var key in saved) {
          if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) base[key] = saved[key];
        }
      }
    } catch (e) { /* 隐私模式等，忽略 */ }
    var r = Number(base.rate);
    base.rate = isFinite(r) ? clamp(r) : DEFAULTS.rate;
    base.locked = base.locked !== false;
    base.visible = base.visible !== false;
    base.collapsed = base.collapsed === true;
    return base;
  })();

  function saveCfg() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
  }

  function clamp(v) {
    if (!isFinite(v)) return DEFAULTS.rate;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(v * 100) / 100));
  }

  function near(a, b) { return Math.abs(a - b) < 0.001; }

  // 2 -> "2x"，1.5 -> "1.5x"，1.25 -> "1.25x"
  function fmtRate(v) {
    return String(v.toFixed(2)).replace(/0+$/, '').replace(/\.$/, '') + 'x';
  }

  /* --------------------------- 倍速核心逻辑 --------------------------- */

  // 原生 playbackRate 属性描述符：用于在锁定（实例属性被我们遮蔽）之后，
  // 仍然能把"真正生效"的倍速写进播放器。
  var nativeRate = (function () {
    try {
      return Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    } catch (e) { return null; }
  })();

  function setNativeRate(media, rate) {
    try {
      if (nativeRate && nativeRate.set) nativeRate.set.call(media, rate);
      else media.playbackRate = rate;
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 锁定倍速：在 media 实例上定义同名属性，遮住原型上的 playbackRate。
   * 播放器之后再写 video.playbackRate = 1.5 会被 setter 吞掉，不会生效。
   */
  function lockMedia(media, rate) {
    if (!media) return;
    var lock = media.__zsSpeedLock;
    if (!lock) {
      lock = { rate: rate };
      try {
        Object.defineProperty(media, 'playbackRate', {
          configurable: true,
          enumerable: true,
          get: function () { return lock.rate; },
          set: function () { /* 忽略页面/播放器的设置 */ }
        });
        media.__zsSpeedLock = lock;
      } catch (e) {
        lock = null; // 定义失败则退化为定时纠正
      }
    }
    if (lock) lock.rate = rate;
    setNativeRate(media, rate);
    try { media.defaultPlaybackRate = rate; } catch (e) { /* 忽略 */ }
  }

  function unlockMedia(media, rate) {
    if (!media) return;
    if (media.__zsSpeedLock) {
      try { delete media.playbackRate; } catch (e) { /* 忽略 */ }
      try { delete media.__zsSpeedLock; } catch (e) { /* 忽略 */ }
    }
    setNativeRate(media, rate);
  }

  /* --------------------------- 视频元素查找 --------------------------- */

  function getDocs() {
    var docs = [];
    var seen = [];
    (function walk(doc) {
      if (!doc || seen.indexOf(doc) >= 0) return;
      seen.push(doc);
      docs.push(doc);
      var frames;
      try { frames = doc.querySelectorAll('iframe'); } catch (e) { return; }
      for (var i = 0; i < frames.length; i++) {
        var inner = null;
        try { inner = frames[i].contentDocument; } catch (e) { inner = null; } // 跨域 iframe 拿不到
        if (inner) walk(inner);
      }
    })(document);
    return docs;
  }

  function scoreMedia(el) {
    var s = 0;
    if (!el) return -1;
    if (el.id === 'mediaPlayer') s += 100;              // 智慧树校内课播放器
    if (el.id === 'vjs_container_html5_api') s += 90;   // 旧版 video.js 播放器
    try { if (el.currentSrc) s += 40; } catch (e) { /* 忽略 */ }
    try { if (!el.paused) s += 20; } catch (e) { /* 忽略 */ }
    try { if (el.duration > 0) s += 10; } catch (e) { /* 忽略 */ }
    if (el.tagName === 'AUDIO') s -= 15;
    return s;
  }

  function findMedia() {
    var list = [];
    var docs = getDocs();
    for (var i = 0; i < docs.length; i++) {
      var found;
      try { found = docs[i].querySelectorAll('video, audio'); } catch (e) { found = []; }
      for (var j = 0; j < found.length; j++) list.push(found[j]);
    }
    list.sort(function (a, b) { return scoreMedia(b) - scoreMedia(a); });
    return list;
  }

  var seenMedia = typeof WeakSet === 'function' ? new WeakSet() : null;

  // 给"所有找到的媒体"应用倍速；locked 时同时加锁
  function applyRate(rate) {
    var list = findMedia();
    for (var i = 0; i < list.length; i++) {
      if (cfg.locked) lockMedia(list[i], rate);
      else unlockMedia(list[i], rate);
      if (seenMedia) seenMedia.add(list[i]);
    }
    lastList = list;
    return list;
  }

  var lastList = [];

  /* --------------------------- 周期巡检 --------------------------- */

  function tick() {
    var list = findMedia();
    lastList = list;

    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var fresh = seenMedia ? !seenMedia.has(m) : false;
      if (seenMedia) seenMedia.add(m);

      if (cfg.locked) {
        // 新出现的元素 / 锁被清掉 / 实际倍速被改：重新锁定
        if (!m.__zsSpeedLock || !near(m.__zsSpeedLock.rate, cfg.rate)) {
          lockMedia(m, cfg.rate);
        } else if (!near(m.playbackRate, cfg.rate)) {
          setNativeRate(m, cfg.rate);
        }
      } else if (fresh) {
        unlockMedia(m, cfg.rate);
      }
    }

    updateStatus();
    if (host && !host.isConnected) document.documentElement.appendChild(host);
  }

  /* ------------------------------ 界面 ------------------------------ */

  var host = null;
  var shadow = null;
  var els = {};

  var STYLE = [
    ':host{all:initial}',
    '.panel{position:fixed;z-index:2147483647;width:232px;box-sizing:border-box;',
    '  font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e9eef7;',
    '  background:rgba(24,28,38,.94);border:1px solid rgba(120,170,255,.28);border-radius:10px;',
    '  box-shadow:0 10px 28px rgba(0,0,0,.45);backdrop-filter:blur(6px);user-select:none;overflow:hidden}',
    '.panel.mini{width:132px}',
    '.head{display:flex;align-items:center;gap:6px;padding:7px 9px;cursor:move;',
    '  background:linear-gradient(180deg,rgba(90,140,255,.20),rgba(90,140,255,.04))}',
    '.dot{width:7px;height:7px;border-radius:50%;background:#59d18c;flex:none;box-shadow:0 0 6px #59d18c}',
    '.dot.off{background:#8a93a6;box-shadow:none}',
    '.title{flex:1;font-weight:600;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cur{font-variant-numeric:tabular-nums;font-weight:700;color:#8fc0ff}',
    '.body{padding:8px 10px 10px;display:block}',
    '.panel.mini .body{display:none}',
    'input[type=range]{width:100%;margin:2px 0 8px;accent-color:#5a8cff;cursor:pointer}',
    '.row{display:flex;align-items:center;gap:6px;margin-bottom:8px}',
    'input[type=number]{width:64px;box-sizing:border-box;padding:3px 6px;border-radius:6px;',
    '  border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e9eef7;',
    '  font:inherit;text-align:right;-moz-appearance:textfield}',
    'input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
    '.unit{color:#8a93a6;margin-left:-2px}',
    'button{font:inherit;color:inherit;cursor:pointer;border-radius:6px;',
    '  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);padding:3px 8px;transition:.15s}',
    'button:hover{background:rgba(255,255,255,.14)}',
    'button.on{background:rgba(90,140,255,.32);border-color:rgba(120,170,255,.6);color:#cfe2ff}',
    '.grow{flex:1}',
    '.presets{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px}',
    '.presets button{padding:3px 0}',
    '.presets button.active{background:rgba(90,140,255,.32);border-color:rgba(120,170,255,.6)}',
    '.tip{color:#8a93a6;font-size:11px;line-height:1.45;margin-bottom:5px}',
    '.status{color:#9aa6bd;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.status.warn{color:#ffb454}',
    '.hidden{display:none!important}'
  ].join('\n');

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'zs-speed-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = [
      '<div class="head" data-drag>',
      '  <span class="dot"></span>',
      '  <span class="title">视频倍速</span>',
      '  <span class="cur">1.50x</span>',
      '  <button class="btn-mini" title="收起 / 展开">–</button>',
      '</div>',
      '<div class="body">',
      '  <input type="range" min="' + RATE_MIN + '" max="4" step="0.05" value="' + cfg.rate + '">',
      '  <div class="row">',
      '    <input type="number" min="' + RATE_MIN + '" max="' + RATE_MAX + '" step="0.05" value="' + cfg.rate + '">',
      '    <span class="unit">x</span>',
      '    <span class="grow"></span>',
      '    <button class="btn-lock">锁定</button>',
      '  </div>',
      '  <div class="presets"></div>',
      '  <div class="tip">[ 减 0.1 &nbsp; ] 加 0.1 &nbsp; \\ 复位 1x<br>拖动标题栏可移动面板</div>',
      '  <div class="status">正在查找视频…</div>',
      '</div>'
    ].join('\n');
    shadow.appendChild(panel);

    els.panel = panel;
    els.dot = panel.querySelector('.dot');
    els.cur = panel.querySelector('.cur');
    els.range = panel.querySelector('input[type=range]');
    els.num = panel.querySelector('input[type=number]');
    els.lock = panel.querySelector('.btn-lock');
    els.presets = panel.querySelector('.presets');
    els.status = panel.querySelector('.status');

    [1, 1.25, 1.5, 2, 3, 4, 8, 16].forEach(function (v) {
      var b = document.createElement('button');
      b.textContent = v + 'x';
      b.dataset.rate = String(v);
      b.addEventListener('click', function () { setRate(v); });
      els.presets.appendChild(b);
    });

    panel.querySelector('.btn-mini').addEventListener('click', function (e) {
      e.stopPropagation();
      cfg.collapsed = !cfg.collapsed;
      saveCfg();
      render();
    });

    els.range.addEventListener('input', function () { setRate(parseFloat(els.range.value)); });
    els.num.addEventListener('change', function () { setRate(parseFloat(els.num.value)); });
    els.lock.addEventListener('click', function () { setLocked(!cfg.locked); });

    initDrag(panel, panel.querySelector('.head'));

    if (cfg.x != null && cfg.y != null) {
      panel.style.left = cfg.x + 'px';
      panel.style.top = cfg.y + 'px';
      panel.style.right = 'auto';
    } else {
      panel.style.right = '20px';
      panel.style.top = '84px';
    }

    render();
    document.documentElement.appendChild(host);
  }

  function initDrag(panel, handle) {
    var dragging = false, startX = 0, startY = 0, baseX = 0, baseY = 0;

    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var rect = panel.getBoundingClientRect();
      baseX = rect.left; baseY = rect.top;
      panel.style.left = baseX + 'px';
      panel.style.top = baseY + 'px';
      panel.style.right = 'auto';
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });

    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var x = baseX + (e.clientX - startX);
      var y = baseY + (e.clientY - startY);
      var maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
      var maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
      x = Math.min(maxX, Math.max(0, x));
      y = Math.min(maxY, Math.max(0, y));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      cfg.x = Math.round(x);
      cfg.y = Math.round(y);
    });

    handle.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      saveCfg();
    });
  }

  function render() {
    if (!els.panel) return;
    var has = lastList.length > 0;
    els.dot.className = 'dot' + (has ? '' : ' off');
    els.panel.classList.toggle('mini', !!cfg.collapsed);
    els.cur.textContent = fmtRate(cfg.rate);
    els.range.value = String(Math.min(cfg.rate, 4));
    var focused = shadow.activeElement || document.activeElement;
    if (focused !== els.num) els.num.value = String(cfg.rate);
    els.lock.textContent = cfg.locked ? '已锁定' : '未锁定';
    els.lock.classList.toggle('on', !!cfg.locked);
    var btns = els.presets.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', near(parseFloat(btns[i].dataset.rate), cfg.rate));
    }
    if (!cfg.visible) els.panel.classList.add('hidden');
    else els.panel.classList.remove('hidden');
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    sec = Math.floor(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateStatus() {
    if (!els.status) return;
    if (!lastList.length) {
      els.status.textContent = '未找到视频，等待页面加载…';
      els.status.className = 'status warn';
      return;
    }
    var v = null;
    for (var i = 0; i < lastList.length; i++) {
      if (lastList[i].tagName === 'VIDEO') { v = lastList[i]; break; }
    }
    if (!v) v = lastList[0];
    var state = v.paused ? '暂停' : '播放中';
    var text = state + ' · ' + fmtTime(v.currentTime) + '/' + fmtTime(v.duration);
    if (lastList.length > 1) text += ' · ' + lastList.length + ' 个媒体';
    els.status.textContent = text;
    els.status.className = 'status';
  }

  /* ------------------------------ 操作 ------------------------------ */

  function setRate(rate) {
    var v = clamp(Number(rate));
    cfg.rate = v;
    saveCfg();
    applyRate(v);
    render();
  }

  function setLocked(on) {
    cfg.locked = on !== false;
    saveCfg();
    applyRate(cfg.rate);
    render();
  }

  function setVisible(on) {
    cfg.visible = on !== false;
    saveCfg();
    render();
  }

  /* ----------------------------- 快捷键 ----------------------------- */

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    var key = e.key;
    var code = e.code;
    if (key === '[' || code === 'BracketLeft') {
      setRate(cfg.rate - 0.1);
      e.preventDefault();
    } else if (key === ']' || code === 'BracketRight') {
      setRate(cfg.rate + 0.1);
      e.preventDefault();
    } else if (key === '\\' || code === 'Backslash') {
      setRate(1);
      e.preventDefault();
    }
  }, true);

  /* ------------------------------ 启动 ------------------------------ */

  function scan() {
    var list = findMedia();
    var rows = list.map(function (m, i) {
      return {
        '#': i,
        tag: m.tagName,
        id: m.id || '-',
        cls: (typeof m.className === 'string' ? m.className : '') || '-',
        src: (function () {
          var s = '';
          try { s = m.currentSrc || m.src || ''; } catch (e) { s = ''; }
          return s ? s.slice(0, 60) : '(无)';
        })(),
        duration: isFinite(m.duration) ? Math.round(m.duration) + 's' : '-',
        rate: (function () { try { return m.playbackRate; } catch (e) { return '?'; } })(),
        locked: !!m.__zsSpeedLock,
        path: (function () {
          var parts = [], node = m;
          while (node && node.nodeType === 1 && parts.length < 5) {
            var s = node.tagName.toLowerCase();
            if (node.id) { s += '#' + node.id; parts.unshift(s); break; }
            parts.unshift(s);
            node = node.parentElement;
          }
          return parts.join(' > ');
        })()
      };
    });
    if (rows.length && console.table) console.table(rows);
    else console.warn('[倍速] 当前页面没有找到 video/audio 元素');
    return list;
  }

  window.__ZS_SPEED__ = {
    version: VERSION,
    set: setRate,
    get: function () { return cfg.rate; },
    lock: function (on) { setLocked(on !== false); },
    unlock: function () { setLocked(false); },
    toggle: function () { setVisible(!cfg.visible); },
    show: function () { setVisible(true); },
    hide: function () { setVisible(false); },
    reset: function () { setRate(1); },
    scan: scan,
    cfg: cfg
  };

  function boot() {
    buildUI();
    applyRate(cfg.rate);
    updateStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  setInterval(tick, 600);

  console.info('%c[倍速] 已加载 v' + VERSION + '　可用的控制台命令：__ZS_SPEED__.set(2) / .scan() / .lock(false)', 'color:#5a8cff');
})();
