import { parseMap, rasterize, toPixel } from './map.js';
import { Robot } from './robot.js';

const STATES = {
  1: 'Startet',
  2: 'Vom Dock getrennt',
  3: 'Bereit',
  4: 'Fernsteuerung',
  5: 'Saugt',
  6: 'Fährt nach Hause',
  7: 'Manuell',
  8: 'Lädt',
  9: 'Ladeproblem',
  10: 'Pausiert',
  11: 'Punktreinigung',
  12: 'Fehler',
  13: 'Fährt herunter',
  14: 'Update',
  15: 'Dockt an',
  16: 'Fährt zum Ziel',
  17: 'Zonenreinigung',
  18: 'Raumreinigung',
  22: 'Entleert Behälter',
  23: 'Wäscht Mopp',
  26: 'Fährt zur Moppwäsche',
  29: 'Kartiert',
  100: 'Voll geladen',
  101: 'Offline',
  103: 'Gesperrt',
};
const CLEANING = new Set([1, 4, 5, 7, 11, 16, 17, 18, 29]);
const RETURNING = new Set([6, 15, 26]);
const DOCKED = new Set([8, 22, 23, 100]);
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
};

const $ = (id) => document.getElementById(id);
const STORE = 'saugi';
let cfg = JSON.parse(localStorage.getItem(STORE) || 'null');
let robot = null;
let status = null;
let map = null;
let bitmap = null;
let roomNames = {};
let busy = false;
let pollTimer = null;
let lastMap = 0;

const save = () => localStorage.setItem(STORE, JSON.stringify(cfg));

function banner(text) {
  $('banner').textContent = text ?? '';
  $('banner').hidden = !text;
}

// --- login ---

async function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  const { LoginFlow, fetchHome } = await import('./api.js');
  let flow = null;
  $('login').onsubmit = async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    $('login-btn').disabled = true;
    try {
      if (!flow) {
        flow = new LoginFlow($('email').value);
        await flow.requestCode();
        $('email').disabled = true;
        $('code').hidden = false;
        $('code').focus();
        $('login-hint').textContent = `Code wurde an ${flow.email} geschickt.`;
        $('login-btn').textContent = 'Anmelden';
      } else {
        const userData = await flow.login($('code').value.trim());
        const home = await fetchHome(flow.baseUrl, userData);
        const products = Object.fromEntries((home.products ?? []).map((p) => [p.id, p]));
        const devices = [...(home.devices ?? []), ...(home.receivedDevices ?? [])].filter(
          (d) => (d.pv ?? '1.0') === '1.0',
        );
        if (!devices.length) throw new Error('Kein unterstützter Sauger im Konto gefunden.');
        const d = devices[0];
        cfg = {
          userData: { rriot: userData.rriot },
          device: { duid: d.duid, name: d.name, localKey: d.localKey, model: products[d.productId]?.model },
          rooms: Object.fromEntries((home.rooms ?? []).map((r) => [r.id, r.name])),
        };
        save();
        location.reload();
      }
    } catch (err) {
      $('login-error').textContent = err.message;
    } finally {
      $('login-btn').disabled = false;
    }
  };
}

// --- main screen ---

function batteryColor(b) {
  if (b == null) return '';
  if (b < 20) return 'var(--bad)';
  return b < 50 ? 'var(--warn)' : 'var(--ok)';
}

function render() {
  const s = status;
  const online = robot?.connected && s;
  $('state').firstChild.textContent = !s ? 'Verbinde …' : (STATES[s.state] ?? `Status ${s.state}`);
  $('name').textContent = cfg.device.name;
  $('battery').textContent = `${s?.battery ?? '--'} %`;
  $('battery').style.color = batteryColor(s?.battery);
  const stats = [];
  if (s?.clean_area) stats.push(`${(s.clean_area / 1e6).toFixed(1)} m²`);
  if (s?.clean_time) stats.push(`${Math.round(s.clean_time / 60)} min`);
  $('stats').textContent = stats.join('   ');

  const moving = s && (CLEANING.has(s.state) || RETURNING.has(s.state));
  const main = $('main');
  main.innerHTML = moving ? `${ICON.pause}Pause` : `${ICON.play}Start`;
  main.dataset.action = moving ? 'pause' : 'start';
  main.disabled = !online || busy;
  $('home').disabled = !online || busy || RETURNING.has(s.state) || DOCKED.has(s.state);
}

// No-go zones red, no-mop zones purple, virtual walls as red lines.
function drawZones(ctx, P) {
  const poly = (pts) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(...P(pts[i], pts[i + 1]));
  };
  ctx.lineWidth = 2;
  for (const [zones, fill, stroke] of [
    [map.noGo, 'rgba(255,93,93,.28)', '#ff5d5d'],
    [map.noMop, 'rgba(176,120,255,.28)', '#b078ff'],
  ]) {
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    for (const z of zones) {
      poly(z);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.strokeStyle = '#ff5d5d';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const w of map.walls) {
    poly(w);
    ctx.stroke();
  }
}

function draw() {
  const canvas = $('map');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!map?.image || !bitmap) return;
  $('empty').hidden = true;

  const pad = 16;
  const s = Math.min((W - 2 * pad) / bitmap.width, (H - 2 * pad) / bitmap.height);
  const offX = (W - bitmap.width * s) / 2;
  const offY = (H - bitmap.height * s) / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap.canvas, offX, offY, bitmap.width * s, bitmap.height * s);
  const P = (x, y) => {
    const [px, py] = toPixel(map.image, x, y);
    return [(px - bitmap.ox + 0.5) * s + offX, (py - bitmap.oy + 0.5) * s + offY];
  };

  drawZones(ctx, P);

  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of bitmap.centers) {
    const name = roomNames[c.id];
    if (!name) continue;
    const x = (c.x + 0.5) * s + offX;
    const y = (c.y + 0.5) * s + offY;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    const w = ctx.measureText(name).width + 10;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 9, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(name, x, y);
  }

  const path = map.path;
  if (path.length >= 4) {
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.lineWidth = Math.max(1.5, s * 0.6);
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < path.length; i += 2) {
      const [x, y] = P(path[i], path[i + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  if (map.charger) {
    const [x, y] = P(map.charger.x, map.charger.y);
    ctx.fillStyle = '#3ccf7a';
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, 2 * Math.PI);
    ctx.fill();
  }
  if (map.robot) {
    const [x, y] = P(map.robot.x, map.robot.y);
    const r = Math.max(9, s * 3.5);
    const a = (map.robot.a * Math.PI) / 180;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#4f9dff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#4f9dff';
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * r * 0.5, y - Math.sin(a) * r * 0.5, r * 0.3, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function setMap(raw, persist) {
  const parsed = parseMap(raw);
  if (!parsed.image) return;
  const sameImage = map?.image && bitmap && equalBytes(map.image.pixels, parsed.image.pixels);
  map = parsed;
  if (!sameImage) {
    const r = rasterize(map.image);
    if (!r) return;
    const c = document.createElement('canvas');
    c.width = r.width;
    c.height = r.height;
    c.getContext('2d').putImageData(new ImageData(r.rgba, r.width, r.height), 0, 0);
    bitmap = { ...r, canvas: c };
  }
  draw();
  if (persist) caches.open('saugi-data').then((c) => c.put('/last-map', new Response(raw)));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function refreshStatus() {
  status = await robot.status();
  localStorage.setItem(`${STORE}.status`, JSON.stringify(status));
  if (status.error_code) banner(`Fehlercode ${status.error_code}`);
  render();
}

async function refreshMap() {
  lastMap = Date.now();
  setMap(await robot.map(), true);
}

function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function poll() {
  if (!robot?.connected || document.hidden) return;
  try {
    await refreshStatus();
    const active = CLEANING.has(status.state) || RETURNING.has(status.state);
    if (Date.now() - lastMap > (active ? 3000 : 60000)) await refreshMap();
    schedule(active ? 2000 : 15000);
  } catch (err) {
    banner(err.message);
    schedule(5000);
  }
}

async function connect() {
  robot?.close();
  robot = new Robot(cfg.userData.rriot, cfg.device);
  robot.ondps = (dps) => {
    if (!status) return;
    if (dps[121] != null) status.state = dps[121];
    if (dps[122] != null) status.battery = dps[122];
    render();
  };
  try {
    await robot.connect();
    // Only reconnect once a session was established; a refused login also
    // closes the socket and would otherwise loop.
    robot.onclose = () => {
      render();
      if (!document.hidden) setTimeout(connect, 2000);
    };
    banner('');
    lastMap = 0;
    await poll();
    loadRoomNames();
  } catch (err) {
    robot.close();
    render();
    if (/refused/.test(err.message)) {
      banner('Anmeldung abgelaufen. Tippe auf den Gerätenamen, um dich neu anzumelden.');
      return;
    }
    banner(`Keine Verbindung: ${err.message}`);
    setTimeout(() => !robot?.connected && !document.hidden && connect(), 5000);
  }
}

async function loadRoomNames() {
  try {
    const mapping = await robot.rpc('get_room_mapping');
    roomNames = Object.fromEntries(mapping.map(([seg, iot]) => [seg, cfg.rooms?.[iot]]).filter(([, n]) => n));
    localStorage.setItem(`${STORE}.roomNames`, JSON.stringify(roomNames));
    draw();
  } catch {
    // room labels are optional
  }
}

async function send(action) {
  busy = true;
  render();
  navigator.vibrate?.(15);
  try {
    let method = { start: 'app_start', pause: 'app_pause', home: 'app_charge' }[action];
    if (action === 'start' && status?.state === 10) {
      if (status.in_cleaning === 2) method = 'resume_zoned_clean';
      if (status.in_cleaning === 3) method = 'resume_segment_clean';
    }
    await robot.rpc(method);
    banner('');
  } catch (err) {
    banner(`Befehl fehlgeschlagen: ${err.message}`);
  } finally {
    busy = false;
    render();
    lastMap = 0;
    schedule(800);
  }
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  status = JSON.parse(localStorage.getItem(`${STORE}.status`) || 'null');
  roomNames = JSON.parse(localStorage.getItem(`${STORE}.roomNames`) || '{}');
  render();
  // Paint the last known map immediately; the live one follows.
  caches
    .open('saugi-data')
    .then((c) => c.match('/last-map'))
    .then((r) => r?.arrayBuffer())
    .then((b) => b && !map && setMap(new Uint8Array(b), false))
    .catch(() => {});

  $('main').onclick = (e) => send(e.currentTarget.dataset.action);
  $('home').onclick = () => send('home');
  $('name').onclick = () => {
    if (confirm('Abmelden?')) {
      localStorage.clear();
      caches.delete('saugi-data');
      location.reload();
    }
  };
  new ResizeObserver(draw).observe($('map'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      robot?.close();
      robot = null;
    } else connect();
  });
  connect();
}

// Exposed for debugging in the console.
window.saugi = {
  get robot() {
    return robot;
  },
};

// iOS Safari ignores user-scalable=no; block its pinch gestures directly.
for (const type of ['gesturestart', 'gesturechange'])
  document.addEventListener(type, (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });

if ('serviceWorker' in navigator) {
  // A new deploy installs a new worker; reload once so it shows right away.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  }
  navigator.serviceWorker.register('/sw.js');
}
if (cfg?.device) showApp();
else showLogin();
