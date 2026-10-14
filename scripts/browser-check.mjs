/**
 * Smoke test in headless Chrome at iPhone size: screenshots the login screen,
 * then seeds a fake account, a cached status and the fixture map and
 * screenshots the main screen. The fake credentials are rejected by the
 * broker, so the test never touches a real vacuum.
 *
 *   node scripts/browser-check.mjs [http://localhost:8792] [outdir]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:8792';
const out = process.argv[3] ?? tmpdir();
const port = 9334;
const profile = mkdtempSync(join(tmpdir(), 'saugi-chrome-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
}

async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = join(out, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.info('screenshot', file);
}

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await wait(100);
    }
  }
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m.result ?? m);
    pending.delete(m.id);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp('Page.navigate', { url: base });
  await wait(1500);
  if (!(await evaluate("!document.getElementById('login').hidden")))
    throw new Error('login screen not shown');
  await shot('saugi-login');

  const map = readFileSync(new URL(process.env.MAP ?? '../tests/fixtures/s6.bin', import.meta.url)).toString(
    'base64',
  );
  await evaluate(`(async () => {
    localStorage.setItem('saugi', JSON.stringify({
      userData: { rriot: { u: 'u', s: 's', h: 'h', k: 'k', r: { a: 'https://api-eu.roborock.com', m: 'ssl://mqtt-eu-3.roborock.com:8883' } } },
      device: { duid: 'demo', name: 'Roborock S7', localKey: 'abcdEFGH12345678', model: 'roborock.vacuum.a15' },
      rooms: {},
    }));
    localStorage.setItem('saugi.status', JSON.stringify({ state: 5, battery: 76, clean_area: 12300000, clean_time: 840, in_cleaning: 1, fan_power: 102 }));
    localStorage.setItem('saugi.roomNames', JSON.stringify({ 16: 'Kitchen', 17: 'Living room', 18: 'Bath', 19: 'Hall', 20: 'Bedroom', 21: 'Office' }));
    const bytes = Uint8Array.from(atob('${map}'), (c) => c.charCodeAt(0));
    await (await caches.open('saugi-data')).put('/last-map', new Response(bytes));
  })()`);
  await cdp('Page.reload');
  await wait(4000);
  const state = await evaluate(
    "({ state: document.getElementById('state').firstChild.textContent, main: document.getElementById('main').textContent, banner: document.getElementById('banner').textContent, mapShown: document.getElementById('empty').hidden })",
  );
  console.info(state);
  await shot('saugi-main');
  if (!state.mapShown) throw new Error('cached map was not drawn');
  if (!/Sign-in expired/.test(state.banner))
    throw new Error(`expected broker to reject fake login, got: ${state.banner}`);
} finally {
  ws?.close();
  chrome.kill();
  await wait(300);
  rmSync(profile, { recursive: true, force: true });
}
