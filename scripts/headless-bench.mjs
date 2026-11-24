/**
 * Headless Chrome 性能/正确性基准（无第三方依赖，走 CDP，自包含）。
 * 脚本自行 spawn vite 与 headless chrome 作为子进程，主进程退出时统一回收，
 * 因此整个流程必须在一次前台调用内跑完。
 *
 * 验收门限：
 *   - 24MP（6000×4000）端到端处理 ≤ 4000ms；
 *   - 四种模型粗糙度误差 ≤ 10%。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITE_ENTRY = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9333;
const VITE_PORT = 5288;
const PROFILE = resolve(ROOT, '..', '.bench-chrome-profile');
const FOUR_SEC = 4000;
const ERR_LIMIT = 10;

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpJson(`http://127.0.0.1:${port}/json`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 重试 */
    }
    await sleep(250);
  }
  throw new Error('无法连接 Chrome CDP 页面 target');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((resolve) => ws.addEventListener('open', () => resolve()));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      (listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
    }
  });
  async function send(method, params = {}) {
    await ready;
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  return {
    send,
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => ws.close(),
  };
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

async function waitForPort(port, label) {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`${label} 端口 ${port} 等待超时`);
}

async function main() {
  const children = [];
  const killAll = () => children.forEach((p) => { try { p.kill(); } catch { /* noop */ } });
  process.on('exit', killAll);
  process.on('SIGINT', () => { killAll(); process.exit(130); });

  // 1) vite（IPv4 回环，关闭文件监视避免锁文件崩溃）
  const vite = spawn(process.execPath, [VITE_ENTRY, '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, VITE_NO_WATCH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(vite);
  vite.stderr.on('data', (d) => {
    const s = String(d);
    if (!s.includes('watch')) process.stderr.write(`[vite] ${s}`);
  });

  // 每个用例独立启动一个全新 Chrome 进程，进程级隔离显存/驱动状态，
  // 彻底规避 headless ANGLE 在同一进程内反复重建 GPU 设备导致的渲染进程崩溃。
  const benchUrl = `http://127.0.0.1:${VITE_PORT}/bench.html`;
  const runInFreshBrowser = async (expr) => {
    const chrome = spawn(CHROME, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-proxy-server',
      '--proxy-bypass-list=*',
      '--disable-gpu-sandbox',
      '--disable-gpu-watchdog',
      '--no-first-run',
      '--no-sandbox',
      `--user-data-dir=${PROFILE}`,
      'about:blank',
    ], { stdio: 'ignore' });
    let client;
    try {
      client = cdp(await getWsUrl(CDP_PORT));
      await client.send('Page.enable');
      await client.send('Runtime.enable');
      await client.send('Page.navigate', { url: benchUrl });
      let status = '';
      for (let i = 0; i < 80; i++) {
        status = await evaluate(client, 'document.getElementById("status")?.textContent ?? "no-dom"').catch(() => 'eval-err');
        if (status === 'ready') break;
        if (status.startsWith('error')) throw new Error(status);
        await sleep(200);
      }
      if (status !== 'ready') throw new Error(`bench 未就绪 status=${status}`);
      return await evaluate(client, expr);
    } finally {
      client?.close();
      chrome.kill();
      await sleep(300); // 等端口与 GPU 资源完全释放
    }
  };

  const glInfo = await runInFreshBrowser('window.reefBench.glInfo()');
  console.log('GPU:', glInfo.vendor, '|', glInfo.renderer);
  console.log('扩展 EXT_color_buffer_float:', glInfo.extFloat, '| EXT_color_buffer_half_float:', glInfo.extHalf);

  // GPU 管线诊断（小图）
  const diag = await runInFreshBrowser('window.reefBench.diagPipeline(256, 192)');
  if (!diag.ok) {
    console.log('GPU 管线诊断失败：', JSON.stringify(diag));
    process.exitCode = 1;
    return;
  }
  console.log('GPU 管线诊断通过：z 范围', diag.error);
  if (process.env.BENCH_DIAG_ONLY) return;

  const cases = [
    { kind: 'massive', w: 1600, h: 1200, edge: 1536, label: '2MP' },
    { kind: 'branching', w: 1600, h: 1200, edge: 1536, label: '2MP' },
    { kind: 'mixed', w: 1600, h: 1200, edge: 1536, label: '2MP' },
    { kind: 'flat', w: 1600, h: 1200, edge: 1536, label: '2MP' },
  ];
  const cases24 = [{ edge: 1536 }];

  let allOk = true;
  for (const c of cases) {
    let row;
    try {
      row = await runInFreshBrowser(
        `window.reefBench.run(${JSON.stringify(c.kind)}, ${c.w}, ${c.h}, ${c.edge})`,
      );
    } catch (e) {
      console.log(`[FAIL] ${c.label.padEnd(5)} ${c.kind.padEnd(9)} 用例异常（独立浏览器进程）：${String(e?.message ?? e).slice(0, 140)}`);
      allOk = false;
      continue;
    }
    const ok = row.errorPct <= ERR_LIMIT;
    allOk = allOk && ok;
    console.log(
      `[${ok ? 'PASS' : 'FAIL'}] ${c.label.padEnd(5)} ${c.kind.padEnd(9)} ` +
      `${row.megapixel.toFixed(1)}MP 真值R=${row.truthR.toFixed(4)} 测得R=${row.gotR.toFixed(4)} ` +
      `误差=${row.errorPct.toFixed(2)}% 耗时=${row.totalMs.toFixed(0)}ms 后端=${row.backend}`,
    );
  }

  // 24MP 纯 GPU 吞吐门限
  for (const c of cases24) {
    let row;
    try {
      row = await runInFreshBrowser(`window.reefBench.runUpscaled24MP(${c.edge})`);
    } catch (e) {
      console.log(`[FAIL] 24MP  用例异常（独立浏览器进程）：${String(e?.message ?? e).slice(0, 140)}`);
      allOk = false;
      continue;
    }
    const errOk = row.errorPct <= ERR_LIMIT;
    const perfOk = row.totalMs <= FOUR_SEC;
    const ok = errOk && perfOk;
    allOk = allOk && ok;
    console.log(
      `[${ok ? 'PASS' : 'FAIL'}] 24MP  mixed     ` +
      `${row.megapixel.toFixed(1)}MP 真值R=${row.truthR.toFixed(4)} 测得R=${row.gotR.toFixed(4)} ` +
      `误差=${row.errorPct.toFixed(2)}% 处理=${row.totalMs.toFixed(0)}ms 后端=${row.backend} （门限 ${FOUR_SEC}ms）`,
    );
    for (const [k, v] of Object.entries(row.timings)) {
      console.log(`         └ ${k}: ${v.toFixed(1)}ms`);
    }
  }

  console.log(allOk ? '\n✅ 全部验收门限通过' : '\n❌ 存在未达标项');
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  console.error('基准运行失败：', e);
  process.exit(1);
});
