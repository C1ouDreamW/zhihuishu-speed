// 智慧树 newVideoPlay.js 反混淆工具
//
// 原理：该脚本用 jsjiami.com.v6 混淆，字符串表以 RC4 加密，解码器 _0x1e77(index, key)
// 定义在 IIFE 内部，外部拿不到。这里在 IIFE 结束前注入 `window.__DEC__ = _0x1e77`
// 把解码器导出来，再对源码中每个调用点用其自带的 key 逐个解码，最后全文替换成明文。
//
// 用法：node decode_full.js
// 依赖：本机安装了 Chrome（路径见下方 CHROME），不需要任何 npm 包。
// 产物：parsed/annotated.js（明文版）、parsed/dec_map.json（index+key → 明文映射）

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9354;
const ORIGIN = 'https://hike.zhihuishu.com';
// 学习页引用的两个关键脚本（静态资源，无需登录）
const TARGETS = {
  'sourceLearning_newVideoPlay.js': '/aidedteaching/assets/student/scripts/sourceLearning/newVideoPlay.js?v=20210927',
  'sourceLearning_newSourceLearning.js': '/aidedteaching/assets/student/scripts/sourceLearning/newSourceLearning.js?v=20200907',
};
const JQUERY_URL = 'https://assets.zhihuishu.com/jquery/1.8.3/jquery.min.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});

/* ---------------------------- 1. 准备素材 ---------------------------- */

const parsedDir = path.join(__dirname, 'parsed');
fs.mkdirSync(parsedDir, { recursive: true });

// 下载脚本 + jQuery（已存在则跳过）
function fetchIfMissing(file, url) {
  const dest = path.join(parsedDir, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    console.log('已存在:', file);
    return dest;
  }
  console.log('下载:', url);
  const { execFileSync } = require('child_process');
  execFileSync('curl.exe', ['-sS', '-L', '--max-time', '60', '-A', 'Mozilla/5.0', '-o', dest, url], { stdio: 'inherit' });
  return dest;
}

fetchIfMissing('jquery.min.js', JQUERY_URL);
for (const [name, p] of Object.entries(TARGETS)) fetchIfMissing(name, ORIGIN + p);

const src = fs.readFileSync(path.join(parsedDir, 'sourceLearning_newVideoPlay.js'), 'utf8');

/* -------------------- 2. 打桩：导出 IIFE 内的解码器 -------------------- */

const defIdx = src.indexOf('_0x1e77=function');
if (defIdx < 0) {
  console.error('未找到 _0x1e77 解码器定义，脚本结构可能已变更');
  process.exit(1);
}
// 插入点：解码器所在 IIFE 的结束标记 "}(window));" 之前（此时仍在 IIFE 作用域内）
const markerIdx = src.indexOf('}(window));', defIdx);
if (markerIdx < 0) {
  console.error('未找到 IIFE 结束标记，脚本结构可能已变更');
  process.exit(1);
}
const patched = src.slice(0, markerIdx) + ';window.__DEC__=_0x1e77;' + src.slice(markerIdx);
fs.writeFileSync(path.join(parsedDir, '_probe_video.js'), patched, 'utf8');

// 宿主页：需要 jQuery（脚本运行时依赖 $）
fs.writeFileSync(path.join(parsedDir, '_host.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script src="./jquery.min.js"></script>
<script src="./_probe_video.js"></script>
</body></html>`, 'utf8');

/* ---------------------- 3. 在真实 Chrome 里解码 ---------------------- */

const calls = [...new Set([...src.matchAll(/_0x1e77\('([0-9a-f]+)','([^']+)'\)/g)].map(m => m[1] + '|' + m[2]))];
console.log('全量去重调用点:', calls.length);

(async () => {
  const ud = path.join(process.env.TEMP, 'zs-decode-' + Date.now());
  const ch = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`, 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try { targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)); if (targets.length) break; } catch (e) { }
      await sleep(200);
    }
    if (!targets || !targets.length) throw new Error('Chrome 未就绪，检查 CHROME 路径');

    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    await new Promise(r => ws.addEventListener('open', r));

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'file:///' + path.join(parsedDir, '_host.html').replace(/\\/g, '/') });
    await sleep(3000);

    const pairs = calls.map(s => { const [i, ...rest] = s.split('|'); return [parseInt(i, 16), rest.join('|')]; });
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const pairs = ${JSON.stringify(pairs)}; const out = {};
        for (const [i, k] of pairs) { try { out[i + '|' + k] = window.__DEC__(i.toString(16), k); } catch (e) {} }
        return out; })()`,
      returnByValue: true
    });
    const map = (r.result && r.result.result && r.result.result.value) || {};
    console.log('解出:', Object.keys(map).length, '/', pairs.length);
    fs.writeFileSync(path.join(parsedDir, 'dec_map.json'), JSON.stringify(Object.entries(map)), 'utf8');

    // 全文替换，明文用 〔〕 包裹便于肉眼辨识
    const out = src.replace(/_0x1e77\('([0-9a-f]+)','([^']+)'\)/g, (m, hex, key) => {
      const v = map[parseInt(hex, 16) + '|' + key];
      return v == null ? m : '〔' + v + '〕';
    });
    fs.writeFileSync(path.join(parsedDir, 'annotated.js'), out, 'utf8');
    console.log('已写 parsed/annotated.js，长度', out.length);

    for (const kw of ['saveStuStudyRecord', 'startWatchTime', 'TotalTime', 'studyTime', 'onPlay']) {
      console.log(`  ${kw} @ ${out.indexOf(kw)}`);
    }
  } finally {
    try { ws && ws.close(); } catch (e) { }
    ch.kill();
  }
})();
