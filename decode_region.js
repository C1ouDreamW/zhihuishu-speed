// 按区域解码反混淆脚本
//
// decode_full.js 会把整个文件替换成明文（产物 ~130KB，不易定位）。
// 本工具只解码指定区域，输出更聚焦，适合逐个分析函数。
//
// 用法：
//   node decode_region.js <起始标记> [长度]
//
// 示例：
//   node decode_region.js "var _0x227696={}" 4200     # $interval 计时器模块
//   node decode_region.js "function _0x773bf3"        # 签名函数
//
// 前置：先跑过一次 decode_full.js（需要 parsed/_host.html 与 _probe_video.js）
// 产物：parsed/region_<标记>.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9360;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});

const marker = process.argv[2];
const span = parseInt(process.argv[3] || '3000', 10);
if (!marker) {
  console.error('用法: node decode_region.js <起始标记> [长度]');
  process.exit(1);
}

const parsedDir = path.join(__dirname, 'parsed');
const srcPath = path.join(parsedDir, 'sourceLearning_newVideoPlay.js');
const hostPath = path.join(parsedDir, '_host.html');

for (const [p, hint] of [[srcPath, '先跑 node decode_full.js'], [hostPath, '先跑 node decode_full.js']]) {
  if (!fs.existsSync(p)) { console.error('缺少 ' + p + '，' + hint); process.exit(1); }
}

const src = fs.readFileSync(srcPath, 'utf8');
const at = src.indexOf(marker);
if (at < 0) { console.error('未找到标记: ' + marker); process.exit(1); }

const region = src.slice(Math.max(0, at - 100), at + span);
const calls = [...new Set([...region.matchAll(/_0x1e77\('([0-9a-f]+)','([^']+)'\)/g)].map(m => m[1] + '|' + m[2]))];
console.log('标记 @' + at + '，区域 ' + region.length + ' 字符，调用点 ' + calls.length);

(async () => {
  const ud = path.join(process.env.TEMP, 'zs-region-' + Date.now());
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
    await send('Page.navigate', { url: 'file:///' + hostPath.replace(/\\/g, '/') });
    await sleep(3000);

    const pairs = calls.map(s => { const [i, ...rest] = s.split('|'); return [parseInt(i, 16), rest.join('|')]; });
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const pairs = ${JSON.stringify(pairs)}; const out = {};
        for (const [i, k] of pairs) { try { out[i + '|' + k] = window.__DEC__(i.toString(16), k); } catch (e) {} }
        return out; })()`,
      returnByValue: true
    });
    const map = (r.result && r.result.result && r.result.result.value) || {};
    console.log('解出 ' + Object.keys(map).length + '/' + pairs.length);

    const out = region.replace(/_0x1e77\('([0-9a-f]+)','([^']+)'\)/g, (m, hex, key) => {
      const v = map[parseInt(hex, 16) + '|' + key];
      return v == null ? m : '〔' + v + '〕';
    });

    const safeName = marker.replace(/[^\w\u4e00-\u9fa5]/g, '_').slice(0, 40);
    const dest = path.join(parsedDir, 'region_' + safeName + '.js');
    fs.writeFileSync(dest, out, 'utf8');
    console.log('已写 ' + path.relative(__dirname, dest));
    console.log('\n' + out);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    ch.kill();
  }
})();
