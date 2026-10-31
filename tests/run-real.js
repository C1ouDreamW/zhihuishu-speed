// 用真实时间跑测试页（不用 virtual-time-budget，它会让媒体时钟停住）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9375;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});

const page = process.argv[2] || 'tests/auto.html';
const waitMs = Number(process.argv[3] || 14000);

(async () => {
  const ud = path.join(process.env.TEMP, 'zs-real-' + Date.now());
  const ch = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`, '--window-size=1200,900', 'about:blank'
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
    const url = 'file:///' + path.join(__dirname, page).replace(/\\/g, '/');
    await send('Page.navigate', { url });
    await sleep(waitMs);

    const r = await send('Runtime.evaluate', {
      expression: `(function(){
        var out = document.getElementById('out');
        var host = document.getElementById('zs-auto-host');
        var logs = host && host.shadowRoot && host.shadowRoot.querySelector('.logs');
        var status = host && host.shadowRoot && host.shadowRoot.querySelector('.status');
        return {
          title: document.title,
          out: out ? out.innerText : '(no #out)',
          status: status ? status.innerText : '',
          logs: logs ? logs.innerText : '(no log)'
        };
      })()`,
      returnByValue: true
    });
    const v = r.result.result.value;
    console.log('TITLE:', v.title);
    console.log('----- 测试页输出 -----');
    console.log(v.out);
    if (v.status) console.log('\n面板状态:', v.status);
    if (v.logs !== '(no log)') {
      console.log('----- 面板日志（最新在上） -----');
      console.log(v.logs);
    }
  } finally {
    try { ws && ws.close(); } catch (e) { }
    ch.kill();
  }
})();
