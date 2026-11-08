import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { stamp } from '../scripts/stamp-sw.mjs';

const root = resolve(import.meta.dirname, '../public');

describe('stamp-sw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-sw-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file, text) => writeFileSync(join(dir, file), text);
  write(
    'sw.js',
    `const SHELL_CACHE = 'x-shell-dev';\nconst ASSETS_CACHE = 'x-assets-dev';\n` +
      `const SHELL = ['./', 'app.js'];\nconst ASSETS = ['big.bin'];\nself.addEventListener('install', () => {});\n`,
  );
  write('index.html', '<p>');
  write('app.js', 'one');
  write('big.bin', 'model');
  const names = () => stamp(dir).names;

  test('replaces "dev" with a hash per cache', () => {
    const { src, names } = stamp(dir);
    assert.match(names[0], /^x-shell-[0-9a-f]{10}$/);
    assert.match(names[1], /^x-assets-[0-9a-f]{10}$/);
    assert.ok(src.includes(`'${names[0]}'`) && src.includes(`'${names[1]}'`));
    assert.ok(!src.includes('-dev'));
  });

  test('a shell change renames only the shell cache', () => {
    const [shell, assets] = names();
    write('app.js', 'two');
    const [shell2, assets2] = names();
    assert.notEqual(shell2, shell);
    assert.equal(assets2, assets);
  });

  test('an asset change renames only the assets cache', () => {
    const [shell, assets] = names();
    write('big.bin', 'model 2');
    const [shell2, assets2] = names();
    assert.equal(shell2, shell);
    assert.notEqual(assets2, assets);
  });

  test('stamping a stamped file again gives the same result', () => {
    const first = stamp(dir).src;
    const original = readFileSync(join(dir, 'sw.js'), 'utf8');
    write('sw.js', first);
    assert.equal(stamp(dir).src, first);
    write('sw.js', original);
  });

  test('fails on a missing file and on an ambiguous name', () => {
    const original = readFileSync(join(dir, 'sw.js'), 'utf8');
    write('sw.js', original.replace("'big.bin'", "'gone.bin'"));
    assert.throws(() => stamp(dir), /ENOENT/);
    write('sw.js', `${original}// x-shell-dev\n`);
    assert.throws(() => stamp(dir), /exactly once/);
    write('sw.js', original);
  });

  test('every file the real sw.js precaches exists', () => {
    const { names } = stamp(root);
    assert.match(names[0], /^saugi-shell-[0-9a-f]{10}$/);
    assert.match(names[1], /^saugi-assets-[0-9a-f]{10}$/);
  });
});

/** Loads the real sw.js with fake caches holding the given cache names and entries. */
function loadWorker(initial) {
  const store = new Map(Object.entries(initial).map(([name, urls]) => [name, new Set(urls)]));
  const fetched = [];
  const deleted = [];
  const listeners = {};
  const caches = {
    keys: async () => [...store.keys()],
    delete: async (name) => deleted.push(name) && store.delete(name),
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Set());
      const urls = store.get(name);
      return {
        match: async (url) => (urls.has(url) ? {} : undefined),
        add: async (req) => {
          fetched.push(req);
          urls.add(req.url);
        },
      };
    },
  };
  const self = {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  class Request {
    constructor(url, init) {
      this.url = url;
      this.cache = init?.cache;
    }
  }
  runInNewContext(readFileSync(join(root, 'sw.js'), 'utf8'), { self, caches, Request });
  const fire = async (type) => {
    let done;
    listeners[type]({
      waitUntil: (p) => {
        done = p;
      },
    });
    await done;
  };
  return { fire, fetched, deleted, store };
}

describe('service worker', () => {
  test('install keeps the files a cache of the same name already holds', async () => {
    const sw = loadWorker({ 'saugi-assets-dev': ['/icon-512.png'] });
    await sw.fire('install');
    const urls = sw.fetched.map((r) => r.url);
    assert.ok(urls.includes('/js/app.js'));
    assert.ok(!urls.includes('/icon-512.png'));
    assert.ok(sw.fetched.every((r) => r.cache === 'reload'));
  });

  test('activate deletes only outdated caches of this app', async () => {
    const sw = loadWorker({
      'saugi-shell-dev': [],
      'saugi-assets-dev': [],
      'saugi-shell-0123456789': [],
      'saugi-shell-v10': [],
      'saugi-data': [],
      v3: [],
      'other-app': [],
    });
    await sw.fire('activate');
    assert.deepEqual(sw.deleted, ['saugi-shell-0123456789', 'saugi-shell-v10']);
  });
});
