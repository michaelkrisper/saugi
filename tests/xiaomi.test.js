// Xiaomi cloud signing against values computed with the signing functions of
// Xiaomi-cloud-tokens-extractor (RC4 by OpenSSL).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decryptResponse, encryptParams, MiCloud, makeNonce, signedNonce } from '../public/js/xiaomi.js';

const v = JSON.parse(readFileSync(new URL('./fixtures/xiaomi-vectors.json', import.meta.url)));

test('nonce and signed nonce', async () => {
  assert.equal(makeNonce(v.millis, Uint8Array.from(v.rand)), v.nonce);
  assert.equal(await signedNonce(v.ssecurity, v.nonce), v.signedNonce);
});

test('request parameters are encrypted and signed', async () => {
  assert.deepEqual(await encryptParams('POST', v.path, { data: v.data }, v.ssecurity, v.nonce), v.fields);
});

test('responses are decrypted', async () => {
  assert.equal(await decryptResponse(v.replyEncrypted, v.ssecurity, v.nonce), v.reply);
});

test('an RPC call posts signed parameters and returns the result', async () => {
  let seen = null;
  const session = { userId: '42', ssecurity: v.ssecurity, serviceToken: 'tok' };
  const http = async (url, opts) => {
    seen = { url, ...opts };
    assert.equal(
      JSON.parse(await decryptResponse(opts.query.data, v.ssecurity, opts.query._nonce)).method,
      'get_status',
    );
    // RC4 is symmetric: encrypt the reply the same way the request was.
    const { data } = await encryptParams('POST', '/x', { data: v.reply }, v.ssecurity, opts.query._nonce);
    return { status: 200, bytes: new TextEncoder().encode(data), headers: {}, cookies: {} };
  };
  const result = await new MiCloud(http, session, 'de').rpc('123456789', 'get_status');
  assert.deepEqual(result, [{ state: 8, battery: 100 }]);
  assert.equal(seen.url, 'https://de.api.io.mi.com/app/home/rpc/123456789');
  assert.equal(seen.cookies.serviceToken, 'tok');
});
