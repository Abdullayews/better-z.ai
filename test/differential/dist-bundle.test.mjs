/*
 * Smoke test: load the ACTUAL built dist artifact (dist/chrome/inject.bundle.js
 * = classifier + sign + wasm-embedded + wasm-loader + inject, exactly what
 * Chrome injects into the MAIN world) in a vm and verify:
 *   - the WASM core activates inside the shipped bundle;
 *   - a captured completion request is classified via the wasm path;
 *   - the signature computed through the bundle matches the JS reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from '../unit/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const BUNDLE = path.join(ROOT, 'dist', 'chrome', 'inject.bundle.js');

/* realm-agnostic structural equality (bundle + reference live in separate
 * vm realms; node's deepEqual compares prototypes and would always fail) */
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
}

test('dist bundle — wasm core active in the shipped MAIN-world artifact', { skip: !existsSync(BUNDLE) && 'dist not built' }, async () => {
  const messages = [];
  const sandbox = {
    self: {
      location: { origin: 'https://chat.z.ai', href: 'https://chat.z.ai/', pathname: '/' },
      postMessage: (m) => messages.push(m)
    },
    globalThis: {},
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    WebAssembly,
    URL,
    URLSearchParams,
    crypto,
    Math,
    Date,
    console
  };
  sandbox.globalThis = sandbox;
  // content-script bridge: window messages from the MAIN world
  sandbox.self.addEventListener = () => {};
  vm.createContext(sandbox);

  vm.runInContext(readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'inject.bundle.js' });

  const C = sandbox.self.__zaiExtCore;
  assert.equal(C.__wasmActive, true, 'wasm core must be active in the built bundle');
  assert.equal(sandbox.self.__zaiExtInject, true, 'inject.js loaded');
  assert.ok(C.__wasmVersion, 'wasm version marker present');

  // classification through the shipped bundle must equal the JS reference
  const Cjs = loadCore();
  const bodies = [
    'System is busy, try again',
    '<!doctype html><html>WAF</html>',
    'FRONTEND_CAPTCHA_REQUIRED',
    'signature expired'
  ];
  for (const body of bodies) {
    for (const status of [200, 400, 403, 429, 503]) {
      assert.ok(
        deepEq(C.classifyHttpError(status, body, true), Cjs.classifyHttpError(status, body, true)),
        `bundle vs reference: ${status} / ${body.slice(0, 30)}\n  got:  ${JSON.stringify(C.classifyHttpError(status, body, true))}\n  want: ${JSON.stringify(Cjs.classifyHttpError(status, body, true))}`
      );
    }
  }

  // signature through the bundle must equal the JS reference
  const ts = 1767225600000;
  const viaBundle = await C.computeSignature('Salam dünya 🌊', 'req-1', 'user-1', ts);
  const viaJs = await Cjs.computeSignature('Salam dünya 🌊', 'req-1', 'user-1', ts);
  assert.equal(viaBundle.signature, viaJs.signature);
  assert.equal(viaBundle.data, viaJs.data);

  // resignUrl end-to-end (dates + form encoding)
  const entries = [
    ['timestamp', '1'], ['requestId', 'req-1'], ['user_id', 'user-1'],
    ['local_time', 'x'], ['utc_time', 'x'], ['title', 'ş ğ 🌊']
  ];
  const ru1 = await C.resignUrl(entries, 'https://chat.z.ai', '/api/v2/chat/completions', 'Salam', 'req-1', 'user-1', ts);
  const ru2 = await Cjs.resignUrl(entries, 'https://chat.z.ai', '/api/v2/chat/completions', 'Salam', 'req-1', 'user-1', ts);
  assert.ok(deepEq(
    { url: ru1.url, signature: ru1.signature, ts: ru1.ts },
    { url: ru2.url, signature: ru2.signature, ts: ru2.ts }
  ), `resignUrl bundle vs reference: ${ru1.url} != ${ru2.url}`);

  console.log('   wasm version in bundle:', C.__wasmVersion);
});
