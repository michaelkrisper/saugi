import { fitLiteMap, liteToMm } from './align.js';
import { FIELD_MM, FLOOR, parseLiteMap, SIZE } from './litemap.js';
import { parseMap, rasterize, toPixel } from './map.js';
import { Robot } from './robot.js';
import { deviceTimer, jobName, miTimer, newJob, parseCron, parseMiTimers, updatedJob } from './schedule.js';
import { VERSION } from './version.js';
import { COUNTRIES, MiCloud, MiLogin, MiRobot, relayHttp } from './xiaomi.js';

const STATES = {
  1: 'Starting',
  2: 'Off the dock',
  3: 'Idle',
  4: 'Remote control',
  5: 'Cleaning',
  6: 'Returning home',
  7: 'Manual mode',
  8: 'Charging',
  9: 'Charging problem',
  10: 'Paused',
  11: 'Spot cleaning',
  12: 'Error',
  13: 'Shutting down',
  14: 'Updating',
  15: 'Docking',
  16: 'Going to target',
  17: 'Zone cleaning',
  18: 'Room cleaning',
  22: 'Emptying bin',
  23: 'Washing mop',
  26: 'Going to wash mop',
  29: 'Mapping',
  100: 'Fully charged',
  101: 'Offline',
  103: 'Locked',
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
// A second vacuum from Xiaomi Home (cfg.mi): { robot, status }. `active` is what the
// controls act on: 'rr' (the Roborock account's vacuum), 'mi' or 'all'.
let mi = null;
let miPoll = null;
let miFastUntil = 0;
// The second vacuum's last run laid onto the map: { id, robot, fit, canvas }.
let miMap = null;
let miMapDue = true;
// Next to a second vacuum the first goes by the app's name instead of its model name.
const RR_NAME = 'Roscoe';
let active = (cfg?.mi && localStorage.getItem(`${STORE}.active`)) || 'rr';

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
        $('login-hint').textContent = `Code sent to ${flow.email}.`;
        $('login-btn').textContent = 'Sign in';
      } else {
        const userData = await flow.login($('code').value.trim());
        const home = await fetchHome(flow.baseUrl, userData);
        const products = Object.fromEntries((home.products ?? []).map((p) => [p.id, p]));
        const devices = [...(home.devices ?? []), ...(home.receivedDevices ?? [])].filter(
          (d) => (d.pv ?? '1.0') === '1.0',
        );
        if (!devices.length) throw new Error('No supported vacuum found in this account.');
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

const isMoving = (s) => CLEANING.has(s.state) || RETURNING.has(s.state);
const isLive = (d) => d.robot?.connected && d.status;

function selected() {
  const list = [];
  if (active !== 'mi') list.push({ name: cfg.mi ? RR_NAME : cfg.device.name, robot, status });
  if (active !== 'rr' && mi) list.push({ name: cfg.mi.device.name, robot: mi.robot, status: mi.status });
  return list;
}

function render() {
  const sel = selected();
  const live = sel.filter(isLive);
  const one = sel.length === 1 ? sel[0] : null;
  const label = (s) => (!s ? 'Connecting …' : (STATES[s.state] ?? `Status ${s.state}`));
  $('state').firstChild.textContent = one ? label(one.status) : 'All vacuums';
  $('name').textContent = one ? one.name : sel.map((d) => `${d.name}: ${label(d.status)}`).join(' · ');
  const batteries = sel.map((d) => d.status?.battery);
  $('battery').textContent = `${batteries.map((b) => b ?? '--').join(' / ')} %`;
  $('battery').style.color = batteryColor(batteries.some((b) => b == null) ? null : Math.min(...batteries));
  const stats = [];
  if (one?.status?.clean_area) stats.push(`${(one.status.clean_area / 1e6).toFixed(1)} m²`);
  if (one?.status?.clean_time) stats.push(`${Math.round(one.status.clean_time / 60)} min`);
  $('stats').textContent = stats.join('   ');

  const moving = live.some((d) => isMoving(d.status));
  const main = $('main');
  main.innerHTML = moving ? `${ICON.pause}Pause` : `${ICON.play}Start`;
  main.dataset.action = moving ? 'pause' : 'start';
  main.disabled = !live.length || busy;
  $('home').disabled =
    !live.length || busy || live.every((d) => RETURNING.has(d.status.state) || DOCKED.has(d.status.state));
  for (const b of $('fan').children) {
    b.classList.toggle(
      'on',
      live.length > 0 && live.every((d) => d.status.fan_power === Number(b.dataset.fan)),
    );
    b.disabled = !live.length || busy;
  }
  // Each vacuum has its own schedule, so there is none for "all".
  $('sched-btn').hidden = active === 'all';
  $('sched-btn').classList.toggle('on', !!(active === 'mi' ? miJob : job)?.enabled);
  for (const b of $('who').children) b.classList.toggle('on', b.dataset.who === active);
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

  drawMi(ctx, P);

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

// Where the second vacuum cleaned on its last run and where it stopped.
function drawMi(ctx, P) {
  if (!miMap?.fit || active === 'rr') return;
  const at = (u, v) => P(...liteToMm(miMap.fit, u, v));
  const [x0, y0] = at(0, 0);
  const [x1, y1] = at(1, 0);
  const [x2, y2] = at(0, 1);
  ctx.save();
  ctx.transform(x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0);
  ctx.drawImage(miMap.canvas, 0, 0);
  ctx.restore();
  if (!miMap.robot) return;
  const [x, y] = at(miMap.robot.x / FIELD_MM, miMap.robot.y / FIELD_MM);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#ff9d3c';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
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
  if (status.error_code) banner(`Error code ${status.error_code}`);
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
    if (dps[123] != null) status.fan_power = dps[123];
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
    loadJob().catch(() => {});
  } catch (err) {
    robot.close();
    render();
    if (/refused/.test(err.message)) {
      banner('Sign-in expired. Tap the device name to sign in again.');
      return;
    }
    banner(`No connection: ${err.message}`);
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

async function command(run) {
  busy = true;
  render();
  navigator.vibrate?.(15);
  const results = await Promise.allSettled(selected().filter(isLive).map(run));
  const failed = results.find((r) => r.status === 'rejected');
  banner(failed ? `Command failed: ${failed.reason.message}` : '');
  busy = false;
  render();
}

// In "all" mode every vacuum gets the same command, whatever it is doing.
async function send(action) {
  await command(async ({ robot: r, status: s }) => {
    let method = { start: 'app_start', pause: 'app_pause', home: 'app_charge' }[action];
    if (action === 'start' && s.state === 10) {
      if (s.in_cleaning === 2) method = 'resume_zoned_clean';
      if (s.in_cleaning === 3) method = 'resume_segment_clean';
    }
    await r.rpc(method);
    // Show the new state at once; the next status confirms it.
    s.state = { start: 5, pause: 10, home: 6 }[action];
  });
  lastMap = 0;
  schedule(800);
  // The cloud reports the old state for a moment, so ask a little later, then often.
  miFastUntil = Date.now() + 30000;
  scheduleMi(2500);
}

function setFan(power) {
  return command(async ({ robot: r, status: s }) => {
    const prev = s.fan_power;
    s.fan_power = power;
    render();
    try {
      await r.rpc('set_custom_mode', [power]);
    } catch (err) {
      s.fan_power = prev;
      throw err;
    }
  });
}

// --- second vacuum (Xiaomi Home): polled over the Xiaomi cloud, no push, no live map ---

function scheduleMi(ms) {
  clearTimeout(miPoll);
  if (mi) miPoll = setTimeout(pollMi, ms);
}

// The vacuum stores a map only after a run, in a frame of its own: fetch it once it
// rests and fit it onto the first vacuum's map.
async function loadMiMap() {
  miMapDue = false;
  try {
    const last = await mi.robot.lastMap();
    if (!last || last.id === miMap?.id) return;
    const lite = parseLiteMap(last.bytes);
    const fit = lite.fields && (await fitLiteMap(lite.fields, map.image));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    if (fit) {
      const img = new ImageData(SIZE, SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (lite.fields[i] === FLOOR) img.data.set([255, 157, 60, 90], i * 4);
      }
      canvas.getContext('2d').putImageData(img, 0, 0);
    }
    miMap = { id: last.id, robot: lite.robot, fit, canvas };
    draw();
  } catch {
    // No map is no reason for a banner; the next run asks again.
  }
}

async function pollMi() {
  if (!mi || document.hidden) return;
  try {
    mi.status = await mi.robot.status();
    localStorage.setItem(`${STORE}.mi.status`, JSON.stringify(mi.status));
    scheduleMi(isMoving(mi.status) || Date.now() < miFastUntil ? 3000 : 15000);
    if (isMoving(mi.status)) miMapDue = true;
    else if (miMapDue && map?.image) loadMiMap();
  } catch (err) {
    if (active !== 'rr') banner(`${cfg.mi.device.name}: ${err.message}`);
    scheduleMi(15000);
  }
  render();
}

function openMiLogin() {
  const login = new MiLogin(relayHttp);
  let step = null;
  const show = () => {
    $('mi-user').disabled = $('mi-pass').disabled = !!step;
    $('mi-captcha').hidden = !step?.captcha;
    $('mi-answer').hidden = !step;
    $('mi-answer').value = '';
    $('mi-next').textContent = step ? 'Continue' : 'Sign in';
    if (step?.captcha) {
      $('mi-captcha').src = URL.createObjectURL(new Blob([step.captcha]));
      $('mi-answer').placeholder = 'Characters in the picture';
    } else if (step) {
      $('mi-answer').placeholder = `Code from the ${step.code === 'phone' ? 'text message' : 'e-mail'}`;
    }
    if (step) $('mi-answer').focus();
  };
  $('mi-error').textContent = '';
  show();
  $('mi').showModal();
  $('mi-cancel').onclick = () => $('mi').close();
  $('mi').querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    $('mi-error').textContent = '';
    $('mi-next').disabled = true;
    try {
      const answer = $('mi-answer').value.trim();
      if (!step) step = await login.start($('mi-user').value.trim(), $('mi-pass').value);
      else if (step.captcha) step = await login.captcha(answer);
      else step = await login.verify(answer);
      if (step.session) {
        for (const country of COUNTRIES) {
          const list = await new MiCloud(relayHttp, step.session, country).devices().catch(() => []);
          const d = list.find((d) => /^(roborock|rockrobo)\.vacuum\./.test(d.model));
          if (!d) continue;
          cfg.mi = { session: step.session, country, device: { did: d.did, name: d.name, model: d.model } };
          save();
          localStorage.setItem(`${STORE}.active`, 'mi');
          location.reload();
          return;
        }
        throw new Error('No Roborock vacuum found in this Xiaomi account.');
      }
    } catch (err) {
      $('mi-error').textContent = err.message;
      // A wrong code can be retyped; everything else starts over.
      if (!step?.code) step = null;
    } finally {
      $('mi-next').disabled = false;
    }
    show();
  };
}

function removeMi() {
  miMap = null;
  miMapDue = true;
  delete cfg.mi;
  save();
  localStorage.removeItem(`${STORE}.mi.status`);
  localStorage.removeItem(`${STORE}.active`);
  location.reload();
}

// --- schedule: the oldest job the vacuum knows, created on first save if there is none ---

let job = null;
let miJob = null;

async function loadJob() {
  const { getJobs } = await import('./api.js');
  const [jobs, timers] = await Promise.all([
    getJobs(cfg.userData.rriot, cfg.device.duid),
    robot.rpc('get_server_timer'),
  ]);
  const known = new Set((Array.isArray(timers[0]) ? timers : [timers]).map(([name]) => name));
  // The cloud reorders jobs on edit; take the oldest so it stays the same one.
  job = jobs.filter((j) => known.has(jobName(j))).sort((a, b) => a.id - b.id)[0] ?? null;
  render();
}

async function loadMiJob() {
  miJob = parseMiTimers(await mi.robot.rpc('get_timer'));
  render();
}

async function openSchedule() {
  $('sched-error').textContent = '';
  $('sched-save').disabled = true;
  $('sched').showModal();
  try {
    const forMi = active === 'mi';
    if (!(forMi ? mi.robot : robot)?.connected) throw new Error('the vacuum is offline');
    await (forMi ? loadMiJob() : loadJob());
    const j = forMi ? miJob : job;
    const { hour, minute, days } = j ? parseCron(j.cron) : { hour: 10, minute: 0, days: [1, 2, 3, 4, 5] };
    $('sched-on').checked = j ? j.enabled : true;
    $('sched-time').value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    for (const b of $('sched-days').children) b.classList.toggle('on', days.includes(Number(b.dataset.day)));
    $('sched-save').disabled = false;
  } catch (err) {
    $('sched-error').textContent = `Could not load the schedule: ${err.message}`;
  }
}

async function saveSchedule() {
  const [hour, minute] = $('sched-time').value.split(':').map(Number);
  const days = [...$('sched-days').querySelectorAll('.on')].map((b) => Number(b.dataset.day));
  if (!days.length) {
    $('sched-error').textContent = 'Pick at least one day.';
    return;
  }
  const plan = { hour, minute, days, enabled: $('sched-on').checked };
  if (active === 'mi') return saveMiSchedule(plan);
  const { addJob, putJob } = await import('./api.js');
  const { rriot } = cfg.userData;
  const { duid } = cfg.device;
  $('sched-save').disabled = true;
  try {
    if (!robot?.connected) throw new Error('the vacuum is offline');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const next = job ? updatedJob(job, plan) : newJob(plan, status, tz);
    // Same order as the Roborock app: the vacuum entry first, then the cloud job.
    // The cloud does not sync on/off to the vacuum, so that is set separately.
    await robot.rpc('set_server_timer', [deviceTimer(next, plan)]);
    if (job) await putJob(rriot, duid, job.id, next);
    else await addJob(rriot, duid, next);
    await robot.rpc('upd_server_timer', [[jobName(next), plan.enabled ? 'on' : 'off']]);
    await loadJob();
    $('sched').close();
  } catch (err) {
    $('sched-error').textContent = `Could not save: ${err.message}`;
  } finally {
    $('sched-save').disabled = false;
  }
}

// A timer cannot be edited: the new one is set first, then the old one removed, so
// a failure in between never leaves the vacuum without its schedule.
async function saveMiSchedule(plan) {
  $('sched-save').disabled = true;
  try {
    if (!mi.robot.connected) throw new Error('the vacuum is offline');
    const next = miTimer(Date.now(), plan);
    if (miJob?.cron === next[1][0]) {
      await mi.robot.rpc('upd_timer', [miJob.id, plan.enabled ? 'on' : 'off']);
    } else {
      await mi.robot.rpc('set_timer', [next]);
      if (!plan.enabled) await mi.robot.rpc('upd_timer', [next[0], 'off']);
      if (miJob) await mi.robot.rpc('del_timer', [miJob.id]);
    }
    await loadMiJob();
    $('sched').close();
  } catch (err) {
    $('sched-error').textContent = `Could not save: ${err.message}`;
  } finally {
    $('sched-save').disabled = false;
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
  $('fan').onclick = (e) => {
    const b = e.target.closest('[data-fan]');
    if (b) setFan(Number(b.dataset.fan));
  };
  $('version').textContent = VERSION === 'dev' ? VERSION : `v${VERSION}`;
  $('sched-btn').onclick = openSchedule;
  $('sched-days').onclick = (e) => e.target.closest('[data-day]')?.classList.toggle('on');
  $('sched').querySelector('form').onsubmit = (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    saveSchedule();
  };
  $('name').onclick = () => {
    $('mi-add').textContent = cfg.mi ? `Remove ${cfg.mi.device.name}` : 'Add a Xiaomi Home vacuum';
    $('menu').showModal();
  };
  $('mi-add').onclick = () => {
    $('menu').close();
    if (!cfg.mi) openMiLogin();
    else if (confirm(`Remove ${cfg.mi.device.name}?`)) removeMi();
  };
  $('signout').onclick = () => {
    if (!confirm('Sign out?')) return;
    localStorage.clear();
    caches.delete('saugi-data');
    location.reload();
  };
  if (cfg.mi) {
    mi = {
      robot: new MiRobot(cfg.mi),
      status: JSON.parse(localStorage.getItem(`${STORE}.mi.status`) || 'null'),
    };
    $('who').hidden = false;
    $('who').children[0].textContent = RR_NAME;
    $('who').children[1].textContent = cfg.mi.device.name;
    $('who').onclick = (e) => {
      const b = e.target.closest('[data-who]');
      if (!b) return;
      active = b.dataset.who;
      localStorage.setItem(`${STORE}.active`, active);
      banner('');
      render();
      draw();
    };
    render();
    pollMi().then(() => loadMiJob().catch(() => {}));
  }
  new ResizeObserver(draw).observe($('map'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      clearTimeout(miPoll);
      robot?.close();
      robot = null;
    } else {
      connect();
      pollMi();
    }
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
