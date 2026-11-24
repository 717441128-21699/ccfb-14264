/**
 * 应用 UI 冒烟测试：加载主应用各路由，确认无 JS 异常、关键 DOM 渲染。
 * 复用 headless-bench 的自包含进程模型。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITE_ENTRY = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9444;
const VITE_PORT = 5299;
const PROFILE = resolve(ROOT, '..', '.smoke-chrome-profile');

async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP 连接失败');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((r) => ws.addEventListener('open', () => r()));
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  return {
    events,
    async send(method, params = {}) {
      await ready;
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function main() {
  const children = [];
  const killAll = () => children.forEach((p) => { try { p.kill(); } catch { /* noop */ } });
  process.on('exit', killAll);

  const vite = spawn(process.execPath, [VITE_ENTRY, '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, env: { ...process.env, VITE_NO_WATCH: '1' }, stdio: 'ignore',
  });
  children.push(vite);
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${VITE_PORT}/`); break; } catch { await sleep(250); }
  }

  const routes = ['/', '/test', '/stats'];
  let failures = 0;
  for (const route of routes) {
    const chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
      '--no-proxy-server', '--disable-gpu-sandbox', '--no-first-run', '--no-sandbox',
      `--user-data-dir=${PROFILE}${route.replace(/\W/g, '')}`, 'about:blank',
    ], { stdio: 'ignore' });
    let client;
    try {
      client = cdp(await getWsUrl(CDP_PORT));
      await client.send('Runtime.enable');
      await client.send('Page.enable');
      client.send('Log.enable');
      await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/#${route}` });
      await sleep(2500);
      const errors = client.events.filter((e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params.entry?.level === 'error'));
      const bodyLen = await (async () => {
        const r = await client.send('Runtime.evaluate', { expression: 'document.body.innerText.length', returnByValue: true });
        return r.result.value;
      })();
      const h2 = await (async () => {
        const r = await client.send('Runtime.evaluate', { expression: 'document.querySelector("h2")?.textContent ?? ""', returnByValue: true });
        return r.result.value;
      })();
      const ok = errors.length === 0 && bodyLen > 20;
      if (!ok) failures++;
      console.log(`[${ok ? 'PASS' : 'FAIL'}] 路由 ${route.padEnd(7)} 标题="${h2}" 文本长度=${bodyLen} 错误数=${errors.length}`);
      if (errors.length) console.log('   ', errors.map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text).slice(0, 3).join(' | '));
    } catch (e) {
      failures++;
      console.log(`[FAIL] 路由 ${route} 异常：${String(e?.message ?? e)}`);
    } finally {
      client?.close();
      chrome.kill();
      await sleep(300);
    }
  }

  console.log(failures === 0 ? '\n✅ UI 冒烟测试全部通过' : `\n❌ ${failures} 个路由失败`);
  killAll();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
