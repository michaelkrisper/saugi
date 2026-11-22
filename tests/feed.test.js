// The feed behind /api/events, with a vacuum that is made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createFeed } from '../server/feed.js';

/** Collects what a watcher gets; `next()` waits for one more event. */
function watcher() {
  const got = [];
  let wake = null;
  const send = (event, data) => {
    got.push([event, data]);
    wake?.();
  };
  const next = async () => {
    const seen = got.length;
    while (got.length === seen) await new Promise((resolve) => (wake = resolve));
    return got.at(-1);
  };
  const fail = async () => {
    while (!got.some(([event]) => event === 'fail')) await next();
    return got.find(([event]) => event === 'fail')[1];
  };
  return { got, send, next, fail };
}

const unpack = (text) => [...gunzipSync(Buffer.from(text, 'base64'))];

test('a watcher gets status and map, a later one at once', async () => {
  let asked = 0;
  const feed = createFeed({
    status: async () => ({ state: 8, battery: 100, asked: ++asked }),
    map: async () => new Uint8Array([1, 2, 3]),
  });
  const first = watcher();
  const leave = feed.watch(first.send);
  while (first.got.length < 2) await first.next();
  const events = Object.fromEntries(first.got);
  assert.deepEqual(JSON.parse(events.status), { state: 8, battery: 100, asked: 1 });
  assert.deepEqual(unpack(events.map), [1, 2, 3]);

  const second = watcher();
  const leaveToo = feed.watch(second.send);
  assert.deepEqual(Object.fromEntries(second.got), events);
  // The newcomer makes the feed ask again: the status changed, the map did not.
  assert.deepEqual(await second.next(), ['status', '{"state":8,"battery":100,"asked":2}']);
  assert.equal(first.got.length, 3);
  leave();
  leaveToo();
  assert.equal(feed.size, 0);
});

test('a command makes the status go out again, changed or not', async () => {
  let seq = 0;
  const feed = createFeed({
    status: async () => ({ msg_seq: ++seq, state: 8 }),
    map: async () => new Uint8Array(1),
  });
  const w = watcher();
  const leave = feed.watch(w.send);
  while (w.got.length < 2) await w.next();
  // Asked again, the vacuum only counted on: nothing goes out.
  feed.kick(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seq, 2);
  assert.equal(w.got.length, 2);
  feed.kick(0, true);
  assert.deepEqual(await w.next(), ['status', '{"msg_seq":3,"state":8}']);
  leave();
});

test('a failure is told with whether the vacuum is lost', async () => {
  const lost = watcher();
  const broken = createFeed({
    status: async () => {
      throw new Error('Connection refused: not authorized');
    },
    map: async () => new Uint8Array(1),
  });
  const leave = broken.watch(lost.send);
  assert.equal(await lost.fail(), '{"message":"Connection refused: not authorized","lost":true}');
  leave();

  const ours = watcher();
  const signedOut = createFeed({
    status: async () => {
      throw Object.assign(new Error('Not signed in.'), { status: 409 });
    },
    map: async () => new Uint8Array(1),
  });
  const leaveToo = signedOut.watch(ours.send);
  assert.equal(await ours.fail(), '{"message":"Not signed in.","lost":false}');
  leaveToo();
});
