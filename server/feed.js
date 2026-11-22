// What the Roborock vacuum is doing, asked once for every browser that watches: its
// status and map go out as they change (server-sent events, /api/events). Nobody
// watching, nobody asking: the connection to the broker may then go idle.
import { gzipSync } from 'node:zlib';

// The same states as CLEANING and RETURNING in public/js/app.js.
const MOVING = new Set([1, 4, 5, 6, 7, 11, 15, 16, 17, 18, 26, 29]);

/** `status()`, `map()`: ask the vacuum; they reject when it cannot be reached. */
export function createFeed({ status, map }) {
  const watchers = new Set();
  let timer = null;
  let dueAt = 0;
  let running = false;
  let again = null;
  // What went out last: { status (JSON), compared (JSON without the counter), map (bytes),
  // mapText (gzip, base64) }.
  let sent = {};
  let mapAt = 0;
  let force = false;

  const emit = (event, data) => {
    for (const send of watchers) send(event, data);
  };

  function plan(ms) {
    clearTimeout(timer);
    dueAt = Date.now() + ms;
    timer = setTimeout(round, ms);
    timer.unref?.();
  }

  async function askMap() {
    mapAt = Date.now();
    const bytes = Buffer.from(await map());
    if (sent.map?.equals(bytes)) return;
    sent.map = bytes;
    sent.mapText = gzipSync(bytes).toString('base64');
    emit('map', sent.mapText);
  }

  async function round() {
    timer = null;
    running = true;
    let wait = 5000;
    try {
      const due = !mapAt;
      const [now] = await Promise.all([status(), due && askMap()]);
      const text = JSON.stringify(now);
      // The vacuum counts its answers (msg_seq): that alone is no change.
      const same = JSON.stringify({ ...now, msg_seq: 0 }) === sent.compared;
      if (force || !same) emit('status', text);
      sent.status = text;
      sent.compared = JSON.stringify({ ...now, msg_seq: 0 });
      force = false;
      const moving = MOVING.has(now.state);
      if (!due && Date.now() - mapAt > (moving ? 3000 : 60_000)) await askMap();
      wait = moving ? 2000 : 15_000;
    } catch (err) {
      // A refusal of ours (not signed in) has a status; everything else is a lost vacuum.
      const ours = typeof err.status === 'number';
      emit('fail', JSON.stringify({ message: err.message, lost: !ours }));
      // The status that follows a failure clears its message, changed or not.
      force = true;
      mapAt = 0;
      // Asking a broker that refused the sign-in again will not help: the next watcher asks.
      if (ours || /refused/.test(err.message)) wait = null;
    }
    running = false;
    if (!watchers.size) return;
    if (again !== null) wait = again;
    again = null;
    if (wait !== null) plan(wait);
  }

  /**
   * Asks within `ms`. `all`: after a command or for a new watcher, in exactly `ms`,
   * with the map, and the status goes out even when it did not change.
   */
  function kick(ms = 0, all = false) {
    if (all) {
      force = true;
      mapAt = 0;
    }
    if (!watchers.size) return;
    if (running) again = again === null ? ms : Math.min(again, ms);
    else if (all || !timer || dueAt > Date.now() + ms) plan(ms);
  }

  return {
    kick,
    get size() {
      return watchers.size;
    },
    /** `send(event, data)` gets 'status' (JSON), 'map' (gzip, base64) and 'fail' ({ message, lost }). Returns what ends it. */
    watch(send) {
      watchers.add(send);
      if (sent.status) send('status', sent.status);
      if (sent.mapText) send('map', sent.mapText);
      kick(0, true);
      return () => {
        watchers.delete(send);
        if (watchers.size) return;
        clearTimeout(timer);
        timer = null;
      };
    },
    /** Another sign-in, or none: nothing that went out counts any more. */
    reset() {
      sent = {};
      mapAt = 0;
    },
  };
}
