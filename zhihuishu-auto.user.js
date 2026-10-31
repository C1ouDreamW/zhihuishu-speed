// ==UserScript==
// @name         智慧树 自动播放 + 播完切换
// @namespace    https://local/zhs-auto
// @version      1.0.0
// @description  自动播放当前学习页视频，播完后自动切换到下一个未学完的视频；所有操作带随机延迟与抖动
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
  var STORE_KEY = 'zs-auto-cfg';

  if (window.top !== window.self) return;
  if (window.__ZS_AUTO__ && window.__ZS_AUTO__.version === VERSION) return;

  /* ============================ 配置 ============================ */

  var DEFAULTS = {
    running: true,
    threshold: 80,          // 完成阈值（%），播到这个百分比就切下一个
    // 进入页面后多久开始播（秒）
    startDelayMin: 3,
    startDelayMax: 12,
    // 播完后多久切下一个（秒）
    switchDelayMin: 2,
    switchDelayMax: 7,
    // 检测到意外暂停后多久恢复（秒）
    resumeDelayMin: 1.2,
    resumeDelayMax: 4,
    // 偶发"分心"：低概率暂停一小段再继续，让行为更像真人
    wander: true,
    wanderChance: 0.05,
    wanderMin: 4,
    wanderMax: 14,
    // 有声播放被浏览器拦下时，退回静音播放
    muteFallback: true,
    // 面板位置
    x: null,
    y: null,
    collapsed: false
  };

  var cfg = loadCfg();

  function loadCfg() {
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
    } catch (e) { /* 忽略 */ }
    return base;
  }

  function saveCfg() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
  }

  /* ========================== 随机工具 ========================== */

  // [min, max] 秒 → 毫秒
  function randMs(minSec, maxSec) {
    var s = minSec + Math.random() * (maxSec - minSec);
    return Math.round(s * 1000);
  }

  // 给已有延迟加 ±ratio 的抖动，避免所有间隔长得一模一样
  function jitter(ms, ratio) {
    ratio = ratio == null ? 0.22 : ratio;
    return Math.round(ms * (1 + (Math.random() * 2 - 1) * ratio));
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, Math.max(0, ms)); });
  }

  /* ========================== 页面解析 ========================== */

  function getCurrentFileId() {
    var el = document.getElementById('fileId');
    if (el && el.value) return String(el.value);
    var m = location.search.match(/[?&]fileId=(\d+)/);
    return m ? m[1] : '';
  }

  function itemId(item) {
    var m = (item.id || '').match(/^file_(\d+)$/);
    return m ? m[1] : '';
  }

  function itemName(item) {
    var el = item.querySelector('.file-name');
    var t = el ? (el.textContent || '').trim() : '';
    return t || ('文件 ' + (itemId(item) || '?'));
  }

  // 只有带 i.icon-video 的才是视频资源（switchIcon 里 dataType==3）
  function isVideoItem(item) {
    return !!item.querySelector('i.icon-video');
  }

  // .status-box 里可能是 <i class="icon-finish"> 或 <span class="rate">45%</span>
  function parseStatus(item) {
    var box = item.querySelector('.status-box');
    if (!box) return { done: false, pct: 0 };
    if (box.querySelector('.icon-finish')) return { done: true, pct: 100 };
    var rate = box.querySelector('.rate');
    if (rate) {
      var n = parseInt((rate.textContent || '').replace(/[^\d]/g, ''), 10);
      return { done: false, pct: isFinite(n) ? n : 0 };
    }
    return { done: false, pct: 0 };
  }

  function listFiles() {
    var items = document.querySelectorAll('.file-item');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var id = itemId(items[i]);
      if (!id) continue;
      var st = parseStatus(items[i]);
      out.push({
        el: items[i],
        id: id,
        name: itemName(items[i]),
        video: isVideoItem(items[i]),
        done: st.done,
        pct: st.pct
      });
    }
    return out;
  }

  // 从当前文件之后开始找，到底再绕回开头；跳过当前文件本身
  function pickNextFile() {
    var files = listFiles();
    if (!files.length) return null;
    var curId = getCurrentFileId();
    var idx = -1;
    for (var i = 0; i < files.length; i++) {
      if (files[i].id === curId) { idx = i; break; }
    }
    var ordered = idx >= 0
      ? files.slice(idx + 1).concat(files.slice(0, idx))
      : files;

    for (var j = 0; j < ordered.length; j++) {
      var f = ordered[j];
      if (f.id === curId) continue;
      if (!f.video) continue;      // 文档/链接/模型类跳过
      if (f.done) continue;        // 已完成的跳过
      return f;
    }
    return null;
  }

  // 折叠的文件夹会让子项无法点击，点之前先展开
  function expandFoldersOf(item) {
    var node = item;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('folder-item') && node.classList.contains('close')) {
        var box = node.querySelector('.folder-box');
        if (box) {
          try { box.click(); } catch (e) { /* 忽略 */ }
        }
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function findVideo() {
    var box = document.getElementById('mediaPlayer');
    if (box) {
      var v = box.querySelector('video');
      if (v) return v;
    }
    var all = document.querySelectorAll('video');
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      try {
        if (c.currentSrc || c.src || c.readyState > 0) return c;
      } catch (e) { /* 忽略 */ }
    }
    return all.length ? all[0] : null;
  }

  function isFinished(v) {
    if (!v) return false;
    try {
      if (v.ended) return true;
      var d = v.duration;
      if (!isFinite(d) || d <= 0) return false;
      // 阈值 100% 时用 duration-0.6 作为安全边距（有些视频不干净地触发 ended）
      var ratio = cfg.threshold >= 100 ? (d - 0.6) / d : cfg.threshold / 100;
      return v.currentTime >= d * ratio;
    } catch (e) { return false; }
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    sec = Math.floor(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ======================= 事件驱动恢复 ======================= */
  // 轮询间隔太长，页面频繁打断时恢复不过来；改成在 video 元素上
  // 监听 pause / waiting / stalled / ended，恢复更快更稳。

  var hooked = null;      // 当前绑定过的 video
  var pendingResume = null;

  function setupVideoEvents(v) {
    if (!v || v === hooked) return;
    hooked = v;

    v.addEventListener('ended', function () {
      if (cfg.running && !state.switching) handleFinished('ended 事件');
    });

    // timeupdate 频率高（~250ms），比 tick 间隔更及时触发阈值判断
    v.addEventListener('timeupdate', function () {
      if (cfg.running && !state.switching && isFinished(v)) handleFinished('达到阈值');
    });

    v.addEventListener('pause', scheduleResume);
    v.addEventListener('waiting', scheduleResume);   // 缓冲卡住
    v.addEventListener('stalled', scheduleResume);   // 网络断流
    v.addEventListener('suspend', scheduleResume);   // 暂停加载
    v.addEventListener('error', scheduleResume);     // 解码/网络错误后恢复
  }

  function scheduleResume() {
    if (!cfg.running || state.switching || state.wandering) return;
    if (pendingResume) clearTimeout(pendingResume);

    var delay = jitter(randMs(cfg.resumeDelayMin, cfg.resumeDelayMax), 0.35);
    pendingResume = setTimeout(async function () {
      pendingResume = null;
      if (!cfg.running || state.switching || state.wandering) return;

      var v = findVideo();
      if (!v || !v.paused || isFinished(v)) return;

      var how = await attemptPlay(v);
      if (how) log('恢复播放');
    }, delay);
  }

  /* ========================== 播放控制 ========================== */

  // 模拟真人点击：带坐标偏移和完整指针事件序列
  function humanClick(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var x = r.left + r.width * (0.32 + Math.random() * 0.36);
    var y = r.top + r.height * (0.32 + Math.random() * 0.36);
    var opt = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };

    function fire(type, Ctor) {
      try { el.dispatchEvent(new Ctor(type, opt)); } catch (e) { /* 旧浏览器没有 PointerEvent */ }
    }
    if (typeof PointerEvent === 'function') {
      fire('pointerover', PointerEvent);
      fire('pointerdown', PointerEvent);
    }
    fire('mouseover', MouseEvent);
    fire('mousedown', MouseEvent);
    if (typeof PointerEvent === 'function') fire('pointerup', PointerEvent);
    fire('mouseup', MouseEvent);
    fire('click', MouseEvent);
    return true;
  }

  var state = {
    video: null,
    started: false,
    switching: false,
    wandering: false,
    lastTick: 0,
    lastNote: ''
  };

  // 会话级计数：跨页面跳转保留，刷新后清零
  var sessionCount = (function () {
    try { return parseInt(sessionStorage.getItem('zs-auto-count') || '0', 10) || 0; }
    catch (e) { return 0; }
  })();

  function incrementCount() {
    sessionCount++;
    try { sessionStorage.setItem('zs-auto-count', String(sessionCount)); } catch (e) { /* 忽略 */ }
  }

  function resetCount() {
    sessionCount = 0;
    try { sessionStorage.setItem('zs-auto-count', '0'); } catch (e) { /* 忽略 */ }
  }

  function log(msg, level) {
    state.lastNote = msg;
    addLog(msg, level);
    if (level === 'warn') console.warn('[自动播放]', msg);
    else console.log('[自动播放]', msg);
  }

  // 尝试播放：先有声，被拦就退回静音
  async function attemptPlay(v) {
    if (!v) return null;

    try {
      v.muted = false;
      await v.play();
      return 'sound';
    } catch (e) {
      // NotAllowedError 通常是自动播放策略，需要静音
      if (!cfg.muteFallback) return null;
      try {
        v.muted = true;
        await v.play();
        return 'muted';
      } catch (e2) {
        return null;
      }
    }
  }

  async function startPlayback() {
    if (!cfg.running || state.switching) return;

    var v = findVideo();
    if (!v) {
      updateUI();
      return;
    }
    state.video = v;

    if (isFinished(v)) {
      await handleFinished('页面加载时已播完');
      return;
    }

    var delay = jitter(randMs(cfg.startDelayMin, cfg.startDelayMax), 0.3);
    setStatus('等待 ' + Math.round(delay / 1000) + 's 后开始播放');
    await sleep(delay);

    if (!cfg.running || state.switching) return;
    if (!v.paused) { state.started = true; updateUI(); return; }

    var how = await attemptPlay(v);
    if (how) {
      state.started = true;
      log('开始播放' + (how === 'muted' ? '（静音，浏览器拦截了有声自动播放）' : ''));
    } else {
      log('自动播放被拦截，请在页面上点一下任意位置', 'warn');
    }
    updateUI();
  }

  function gotoFile(file) {
    if (!file) return false;
    state.switching = true;
    setStatus('切换到：' + file.name);

    // 折叠状态先展开，保证元素可交互
    expandFoldersOf(file.el);

    // 优先走页面自己的跳转逻辑（会带上 taskId 等上下文）
    if (typeof window.changeFile === 'function') {
      try {
        window.changeFile(file.id);
        return true;
      } catch (e) { /* 落到下面的兜底 */ }
    }

    humanClick(file.el);

    // 最后兜底：直接构造 URL
    setTimeout(function () {
      if (location.search.indexOf('fileId=' + file.id) < 0) {
        var p = new URLSearchParams(location.search);
        p.set('fileId', file.id);
        location.href = location.pathname + '?' + p.toString();
      }
    }, 1200);

    return true;
  }

  async function handleFinished(reason) {
    if (state.switching) return;
    state.switching = true;

    incrementCount();
    setStatus('已播完（第 ' + sessionCount + ' 个），准备切换');
    render();
    log('当前视频' + (reason || '已播放完毕'));

    var delay = jitter(randMs(cfg.switchDelayMin, cfg.switchDelayMax), 0.3);
    await sleep(delay);   // 留出时间让平台完成最后一次进度上报

    if (!cfg.running) { state.switching = false; return; }

    var next = pickNextFile();
    if (!next) {
      state.switching = false;
      setStatus('没有待学视频了');
      log('所有视频都已完成，停止', 'warn');
      return;
    }
    log('切换到「' + next.name + '」', 'ok');
    gotoFile(next);
  }

  /* ========================== 主循环 ========================== */

  async function tick() {
    if (!cfg.running) return;

    var v = findVideo();
    if (!v) { updateUI(); return; }

    state.video = v;
    setupVideoEvents(v);

    if (isFinished(v)) {
      await handleFinished();
      return;
    }

    // 偶发"分心"：暂停一小段再继续（主动暂停，不触发自动恢复）
    if (v.paused && cfg.wander && !state.wandering && Math.random() < cfg.wanderChance) {
      state.wandering = true;
      var wm = randMs(cfg.wanderMin, cfg.wanderMax);
      setStatus('短暂停顿 ' + Math.round(wm / 1000) + 's');
      await sleep(wm);
      state.wandering = false;
      if (!cfg.running) return;
      if (v.paused) await attemptPlay(v);
      updateUI();
      return;
    }

    // 兜底：长时间 paused 但事件没触发（如视频被替换后重载）
    if (v.paused && !v.ended) scheduleResume();

    updateUI();
  }

  // 主循环：间隔本身也随机，避免固定节拍
  async function loop() {
    while (true) {
      try {
        if (cfg.running) await tick();
      } catch (e) {
        console.warn('[自动播放] 循环异常', e);
      }
      await sleep(jitter(randMs(1.8, 3.6), 0.4));
    }
  }

  /* ============================ 界面 ============================ */

  var host = null, shadow = null, els = {};

  var STYLE = [
    ':host{all:initial}',
    '.panel{position:fixed;z-index:2147483646;width:252px;box-sizing:border-box;',
    ' font:12px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e2e8f5;',
    ' background:rgba(20,24,34,.96);border:1px solid rgba(120,170,255,.24);border-radius:12px;',
    ' box-shadow:0 8px 32px rgba(0,0,0,.5),0 1px 4px rgba(0,0,0,.3);user-select:none;overflow:hidden}',
    '.head{display:flex;align-items:center;gap:7px;padding:9px 10px;cursor:move;',
    ' background:linear-gradient(135deg,rgba(90,140,255,.18),rgba(90,140,255,.05))}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex:none;transition:.3s}',
    '.dot.off{background:#64748b}',
    '.dot.wait{background:#fbbf24;animation:pulse 1.2s ease-in-out infinite}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}',
    '.title{flex:1;font-weight:600;font-size:12.5px;letter-spacing:.3px}',
    '.count{font-size:11px;font-weight:700;background:rgba(90,140,255,.35);color:#93c5fd;',
    ' border-radius:10px;padding:1px 8px;min-width:20px;text-align:center;flex:none;',
    ' transition:.2s}',
    '.count.zero{opacity:.35;background:rgba(255,255,255,.08);color:#94a3b8}',
    '.body{padding:6px 10px 10px;display:block}',
    '.panel.mini .body{display:none}',
    '.row{display:flex;align-items:center;gap:5px;margin-bottom:8px}',
    'button{font:inherit;color:inherit;cursor:pointer;border-radius:7px;',
    ' border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.07);padding:4px 10px;',
    ' transition:.15s;font-size:11.5px;white-space:nowrap}',
    'button:hover{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.22)}',
    'button:active{transform:scale(.96)}',
    '.btn-run{font-weight:600;min-width:72px}',
    '.btn-run.on{background:rgba(34,197,94,.22);border-color:rgba(34,197,94,.45);color:#86efac}',
    '.btn-run:not(.on){background:rgba(239,68,68,.2);border-color:rgba(239,68,68,.4);color:#fca5a5}',
    '.btn-wander.on{background:rgba(168,85,247,.22);border-color:rgba(168,85,247,.45);color:#d8b4fe}',
    '.btn-wander:not(.on){opacity:.5}',
    '.btn-reset{opacity:.6;padding:4px 8px}',
    '.btn-reset:hover{opacity:1;background:rgba(251,191,36,.18);border-color:rgba(251,191,36,.4)}',
    '.btn-mini{opacity:.5;padding:2px 7px;font-size:14px;line-height:1.2;min-width:24px}',
    '.btn-mini:hover{opacity:1;background:rgba(255,255,255,.16)}',
    '.grow{flex:1}',
    '.info{background:rgba(255,255,255,.04);border-radius:8px;padding:7px 9px;margin-bottom:8px}',
    '.thresh-row{display:flex;align-items:center;gap:7px;margin-bottom:8px}',
    '.thresh-label{color:#7c8aa5;font-size:11px;flex:none;width:48px}',
    '.thresh-slider{flex:1;accent-color:#60a5fa;height:4px;cursor:pointer}',
    '.thresh-val{color:#93c5fd;font-size:11.5px;font-weight:700;min-width:32px;text-align:right;flex:none}',
    '.kv{display:flex;gap:6px;margin-bottom:3px;font-size:11.5px;line-height:1.5}',
    '.kv:last-child{margin-bottom:0}',
    '.k{color:#7c8aa5;flex:none;width:36px}',
    '.v{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.status{color:#94a3b8;font-size:11px;margin-bottom:6px;white-space:nowrap;overflow:hidden;',
    ' text-overflow:ellipsis;padding:2px 0}',
    '.status.warn{color:#fbbf24}',
    '.logs{max-height:88px;overflow:auto;font-size:10.5px;color:#64748b;',
    ' border-top:1px solid rgba(255,255,255,.06);padding-top:5px}',
    '.logs div{margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    ' line-height:1.5}',
    '.logs .warn{color:#fbbf24}',
    '.logs .ok{color:#4ade80}'
  ].join('\n');

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'zs-auto-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = [
      '<div class="head" data-drag>',
      '  <span class="dot"></span>',
      '  <span class="title">自动播放</span>',
      '  <span class="count" title="本次会话已刷视频数">0</span>',
      '  <button class="btn-mini" title="收起 / 展开">–</button>',
      '</div>',
      '<div class="body">',
      '  <div class="row">',
      '    <button class="btn-run on">▶ 运行中</button>',
      '    <button class="btn-wander on" title="偶发暂停一小段，模拟真人">🎲</button>',
      '    <button class="btn-reset" title="清零计数器">↺</button>',
      '    <span class="grow"></span>',
      '  </div>',
      '  <div class="thresh-row">',
      '    <span class="thresh-label">完成阈值</span>',
      '    <input type="range" min="50" max="100" step="5" value="80" class="thresh-slider">',
      '    <span class="thresh-val">80%</span>',
      '  </div>',
      '  <div class="info">',
      '    <div class="kv"><span class="k">当前</span><span class="v cur">-</span></div>',
      '    <div class="kv"><span class="k">进度</span><span class="v prog">-</span></div>',
      '    <div class="kv"><span class="k">下一个</span><span class="v next">-</span></div>',
      '  </div>',
      '  <div class="status">准备中…</div>',
      '  <div class="logs"></div>',
      '</div>'
    ].join('\n');
    shadow.appendChild(panel);

    els.panel = panel;
    els.dot = panel.querySelector('.dot');
    els.count = panel.querySelector('.count');
    els.run = panel.querySelector('.btn-run');
    els.wander = panel.querySelector('.btn-wander');
    els.reset = panel.querySelector('.btn-reset');
    els.threshSlider = panel.querySelector('.thresh-slider');
    els.threshVal = panel.querySelector('.thresh-val');
    els.cur = panel.querySelector('.cur');
    els.prog = panel.querySelector('.prog');
    els.next = panel.querySelector('.next');
    els.status = panel.querySelector('.status');
    els.logs = panel.querySelector('.logs');

    panel.querySelector('.btn-mini').addEventListener('click', function (e) {
      e.stopPropagation();
      cfg.collapsed = !cfg.collapsed;
      saveCfg();
      render();
    });

    els.run.addEventListener('click', function () {
      cfg.running = !cfg.running;
      saveCfg();
      render();
      if (cfg.running) {
        log('已恢复运行');
        startPlayback();
      } else {
        log('已暂停', 'warn');
      }
    });

    els.wander.addEventListener('click', function () {
      cfg.wander = !cfg.wander;
      saveCfg();
      render();
    });

    els.reset.addEventListener('click', function () {
      resetCount();
      log('计数器已清零');
      updateUI();
    });

    els.threshSlider.addEventListener('input', function () {
      cfg.threshold = parseInt(els.threshSlider.value, 10) || 80;
      saveCfg();
      render();
    });

    initDrag(panel, panel.querySelector('.head'));

    if (cfg.x != null && cfg.y != null) {
      panel.style.left = cfg.x + 'px';
      panel.style.top = cfg.y + 'px';
      panel.style.right = 'auto';
    } else {
      panel.style.right = '20px';
      panel.style.top = '96px';
    }

    render();
    document.documentElement.appendChild(host);
  }

  function initDrag(panel, handle) {
    var dragging = false, sx = 0, sy = 0, bx = 0, by = 0;

    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // 点在按钮上不触发拖拽，否则 setPointerCapture 会吞掉 click 事件
      if (e.target && e.target.closest && e.target.closest('button')) return;
      var r = panel.getBoundingClientRect();
      bx = r.left; by = r.top;
      panel.style.left = bx + 'px';
      panel.style.top = by + 'px';
      panel.style.right = 'auto';
      sx = e.clientX; sy = e.clientY;
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });

    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var x = bx + (e.clientX - sx);
      var y = by + (e.clientY - sy);
      x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - panel.offsetWidth));
      y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - panel.offsetHeight));
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

  function addLog(msg, level) {
    if (!els.logs) return;
    var d = document.createElement('div');
    if (level === 'warn') d.className = 'warn';
    else if (level === 'ok') d.className = 'ok';
    var t = new Date();
    var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
    d.textContent = hh + '  ' + msg;
    els.logs.insertBefore(d, els.logs.firstChild);
    while (els.logs.children.length > 40) els.logs.removeChild(els.logs.lastChild);
  }

  var uiStatus = '';
  function setStatus(s) {
    uiStatus = s;
    if (els.status) {
      els.status.textContent = s;
      els.status.className = 'status' + (/没有|拦|异常/.test(s) ? ' warn' : '');
    }
  }

  function render() {
    if (!els.panel) return;
    els.panel.classList.toggle('mini', !!cfg.collapsed);
    els.run.textContent = cfg.running ? '▶ 运行中' : '⏸ 已暂停';
    els.run.classList.toggle('on', !!cfg.running);
    els.wander.classList.toggle('on', !!cfg.wander);
    els.count.textContent = String(sessionCount);
    els.count.classList.toggle('zero', sessionCount === 0);
    if (els.threshSlider) {
      els.threshSlider.value = String(cfg.threshold);
      els.threshVal.textContent = cfg.threshold + '%';
    }
    if (uiStatus) els.status.textContent = uiStatus;
  }

  function updateUI() {
    if (!els.panel) return;

    els.dot.className = 'dot' + (!cfg.running ? ' off' : (state.switching ? ' wait' : ''));

    var curId = getCurrentFileId();
    var files = listFiles();
    var cur = null;
    for (var i = 0; i < files.length; i++) if (files[i].id === curId) { cur = files[i]; break; }

    els.cur.textContent = cur ? cur.name : (curId ? '文件 ' + curId : '-');

    var v = state.video;
    if (state.switching) {
      els.prog.textContent = '切换中…';
    } else if (v && isFinite(v.duration) && v.duration > 0) {
      var pct = Math.min(100, Math.floor(v.currentTime / v.duration * 100));
      els.prog.textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration)
        + '  (' + pct + '% / ' + cfg.threshold + '%)'
        + (v.paused ? '  已暂停' : '  播放中');
    } else if (cur) {
      els.prog.textContent = cur.done ? '已完成' : (cur.pct ? cur.pct + '%' : '未开始');
    } else {
      els.prog.textContent = '-';
    }

    var next = pickNextFile();
    els.next.textContent = next ? next.name : '（无待学视频）';

    render();
  }

  /* ============================ 启动 ============================ */

  window.__ZS_AUTO__ = {
    version: VERSION,
    cfg: cfg,
    getState: function () { return { running: cfg.running, current: getCurrentFileId(), files: listFiles() }; },
    next: pickNextFile,
    start: function () { cfg.running = true; saveCfg(); render(); startPlayback(); },
    stop: function () { cfg.running = false; saveCfg(); render(); },
    show: function () { if (els.panel) els.panel.style.display = ''; },
    hide: function () { if (els.panel) els.panel.style.display = 'none'; }
  };

  function boot() {
    buildUI();
    log('脚本已加载，当前文件 ' + (getCurrentFileId() || '未识别'));
    if (cfg.running) {
      // 视频元素可能还没渲染，稍等再开始
      setTimeout(function () { startPlayback(); }, 400);
    } else {
      setStatus('已暂停（点"运行中"开始）');
    }
    loop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  console.info('%c[自动播放] 已加载 v' + VERSION + '　控制台可用：__ZS_AUTO__.start() / .stop() / .next()', 'color:#5a8cff');
})();
