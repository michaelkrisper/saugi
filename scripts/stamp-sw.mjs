/**
 * Stamps the service worker's cache names with a content hash, run by CI on the
 * site directory before it is published:
 *
 *   node scripts/stamp-sw.mjs public
 *
 * "saugi-shell-dev" becomes "saugi-shell-<hash of the SHELL files>", and
 * the same for ASSETS. A cache thus gets a new name exactly when one of its
 * files (or its file list) changes; an unchanged cache keeps its name and
 * installed apps do not download it again.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Each file list in sw.js and the constant that names its cache.
const CACHES = [
  ['SHELL', 'SHELL_CACHE'],
  ['ASSETS', 'ASSETS_CACHE'],
];

/** Short hash over the paths and contents of `files` (URLs as in sw.js, relative to `dir`). */
export function hashFiles(dir, files) {
  const hash = createHash('sha256');
  for (const url of files) {
    let path = url.replace(/^\.?\//, '');
    if (path === '' || path.endsWith('/')) path += 'index.html';
    hash.update(`${url}\0`);
    hash.update(
      createHash('sha256')
        .update(readFileSync(join(dir, path)))
        .digest(),
    );
  }
  return hash.digest('hex').slice(0, 10);
}

/** Returns the source of `dir`/sw.js with stamped cache names, and those names. */
export function stamp(dir) {
  let src = readFileSync(join(dir, 'sw.js'), 'utf8');
  const sw = runInNewContext(`${src}\n;({ ${CACHES.flat().join(', ')} })`, {
    self: { addEventListener() {} },
  });
  const names = [];
  for (const [list, constant] of CACHES) {
    const old = sw[constant];
    const name = old.replace(/-[^-]*$/, `-${hashFiles(dir, sw[list])}`);
    if (src.split(old).length !== 2)
      throw new Error(`"${old}" (${constant}) must occur exactly once in sw.js`);
    src = src.replace(old, name);
    names.push(name);
  }
  return { src, names };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node scripts/stamp-sw.mjs <site dir>');
  const { src, names } = stamp(dir);
  writeFileSync(join(dir, 'sw.js'), src);
  console.info(`sw.js: ${names.join(', ')}`);
}
