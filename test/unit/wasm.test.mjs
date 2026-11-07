/*
 * better z.ai — WASM artifact differential test.
 *
 * Loads the REAL compiled artifact (src/core/wasm-embedded.js) through the
 * REAL loader (src/core/wasm-loader.js) in a Node vm and replays every
 * vector from core-wasm/tests/vectors.json (recorded from the JavaScript
 * reference). This exercises the exact same code path the extension uses
 * in the browser — marshalling, memory growth, JSON round-trips included.
 *
 * Skips gracefully when the wasm has not been built (pure-JS CI):
 *   python3 core-wasm/build-wasm.py
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');
const ROOT = path.join(HERE, '..', '..');
const EMBEDDED = path.join(SRC, 'core', 'wasm-embedded.js');
const LOADER = path.join(SRC, 'core', 'wasm-loader.js');
const VECTORS = path.join(ROOT, 'core-wasm', 'tests', 'vectors.json');

function sandboxBase() {
  const sandbox = {
    self: {},
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
    Date
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function run(sandbox, file) {
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: path.basename(file) });
}

/** core + embedded wasm + loader → patched __zaiExtCore */
function loadWasmCore() {
  const sandbox = sandboxBase();
  for (const f of ['core/classifier.js', 'core/backoff.js', 'core/sign.js']) {
    run(sandbox, path.join(SRC, f));
  }
  run(sandbox, EMBEDDED);
  run(sandbox, LOADER);
  return sandbox.self.__zaiExtCore;
}

const have = existsSync(EMBEDDED);
const skipReason = have ? false : 'wasm-embedded.js not built — run: python3 core-wasm/build-wasm.py';

/* realm-agnostic structural equality (objects come from inside the vm,
 * so node's assert.deepEqual would fail on the prototype difference) */
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
function mustDeepEq(got, want, msg) {
  if (!deepEq(got, want)) {
    assert.fail(`${msg || ''}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

test('wasm core — differential vs the JavaScript reference', { skip: skipReason }, async (t) => {
  const V = JSON.parse(readFileSync(VECTORS, 'utf8'));
  const Cjs = loadCore();   // untouched JS reference
  const Cw = loadWasmCore(); // wasm-patched

  assert.equal(Cw.__wasmActive, true, 'loader did not activate');
  assert.ok(Cw.__wasmVersion, 'version marker missing');

  await t.test('vectors are fresh (JS reference still matches)', async () => {
    const v = V.signature[0];
    const r = await Cjs.computeSignature(v.prompt, v.req, v.user, v.ts);
    assert.equal(r.signature, v.sig, 'vectors.json is stale — regenerate: node test/differential/gen-vectors.mjs');
    const d = Cjs.classifyHttpError(429, '<!doctype html><html>', true);
    const w = V.classifyHttp.find((x) => x.status === 429 && x.body.startsWith('<!doctype') && x.retry === true);
    mustDeepEq(d, w.out, 'JS reference vs vectors (classifyHttpError 429/HTML)');
  });

  await t.test('signature', async () => {
    for (const v of V.signature) {
      const got = await Cw.computeSignature(v.prompt, v.req, v.user, v.ts);
      assert.equal(got.signature, v.sig, `prompt=${JSON.stringify(v.prompt.slice(0, 40))} ts=${v.ts}`);
      assert.equal(got.data, v.data);
    }
  });

  await t.test('formEncode / b64 / hmac', async () => {
    for (const v of V.formEncode) assert.equal(Cw.formEncode(v.in), v.out, `in=${JSON.stringify(v.in)}`);
    for (const v of V.b64) assert.equal(Cw.b64Utf8(v.in), v.out);
    for (const v of V.hmac) assert.equal(await Cw.hmacHex(v.key, v.msg), v.out);
  });

  await t.test('firstLine / countWords / isHtmlBody', () => {
    for (const v of V.firstLine) assert.equal(Cw.firstLine(v.t, v.n), v.out, `t=${JSON.stringify(v.t.slice(0, 40))} n=${v.n}`);
    for (const v of V.countWords) assert.equal(Cw.countWords(v.in), v.out);
    for (const v of V.isHtmlBody) assert.equal(Cw.isHtmlBody(v.in), v.out);
  });

  await t.test('classifyHttpError (full grid)', () => {
    for (const v of V.classifyHttp) {
      mustDeepEq(
        Cw.classifyHttpError(v.status, v.body, v.retry),
        v.out,
        `status=${v.status} body=${JSON.stringify(v.body.slice(0, 60))} retry=${v.retry}`
      );
    }
  });

  await t.test('classifyBodyText', () => {
    for (const v of V.classifyBody) {
      mustDeepEq(Cw.classifyBodyText(v.body), v.out, `body=${JSON.stringify(v.body.slice(0, 60))}`);
    }
  });

  await t.test('classifyStream (with a large .text field, like inject.js passes)', () => {
    for (const v of V.classifyStream) {
      const s = Object.assign({}, v.state, { text: 'x'.repeat(50000) }); // must be ignored
      mustDeepEq(Cw.classifyStream(s), v.out, `state=${JSON.stringify(v.state)}`);
    }
  });

  await t.test('extractMessage / extractError / errText', () => {
    for (const v of V.extractMessage) {
      const j = JSON.parse(v.raw);
      const got = Cw.extractMessage(j);
      const want = v.out === null ? null : JSON.parse(v.out);
      assert.ok(deepEq(got, want), `extractMessage raw=${v.raw}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    }
    for (const v of V.extractError) {
      const j = JSON.parse(v.raw);
      const got = Cw.extractError(j);
      const want = v.out === null ? null : JSON.parse(v.out);
      assert.ok(deepEq(got, want), `extractError raw=${v.raw}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    }
    for (const v of V.errText) {
      const e = Cw.extractError(JSON.parse(v.raw));
      assert.equal(Cw.errText(e), v.out, `raw=${v.raw}`);
    }
  });

  await t.test('computeDelay (wrapper coercion included)', () => {
    for (const v of V.delay) {
      const got = Cw.computeDelay(v.attempt, v.cfg, () => v.rand);
      assert.equal(got, v.out, `attempt=${v.attempt} cfg=${JSON.stringify(v.cfg)} rand=${v.rand}`);
    }
  });

  await t.test('applyRetryAfter (null/undefined/string coercions)', () => {
    for (const v of V.retryAfter) {
      assert.equal(Cw.applyRetryAfter(v.d, v.ra), v.out, `d=${v.d} ra=${JSON.stringify(v.ra)}`);
    }
  });

  await t.test('congestionMultiplier', () => {
    for (const v of V.congestion) assert.equal(Cw.congestionMultiplier(v.n), v.out, `n=${v.n}`);
  });

  await t.test('resignUrl (dates + encoding end-to-end)', async () => {
    for (const v of V.resignUrl) {
      const got = await Cw.resignUrl(v.entries, v.origin, v.pathname, v.prompt, v.requestId, v.userId, v.now);
      mustDeepEq(got, v.out, `entries=${JSON.stringify(v.entries)}`);
    }
  });

  await t.test('memory growth does not break marshalling (5 MB of input)', () => {
    // forces several memory.grow cycles inside one call
    const big = 'ə'.repeat(1_500_000); // 3 MB UTF-8
    const out = Cw.firstLine(big, 10);
    assert.equal(out.length <= 12, true);
    // arena is bigger than this input — succeeds without fallback
    assert.ok(/[ə…]/.test(out));
    // and the core still works afterwards
    assert.equal(Cw.countWords('one two three'), 3);
  });
});

test('wasm loader — graceful no-op paths', async (t) => {
  await t.test('no WebAssembly → pure JS, loader is a no-op', () => {
    const sandbox = sandboxBase();
    sandbox.WebAssembly = undefined;
    for (const f of ['core/classifier.js', 'core/backoff.js', 'core/sign.js']) {
      run(sandbox, path.join(SRC, f));
    }
    run(sandbox, EMBEDDED);
    run(sandbox, LOADER);
    const C = sandbox.self.__zaiExtCore;
    assert.equal(C.__wasmActive, undefined);
    assert.equal(typeof C.firstLine, 'function'); // JS implementation intact
    assert.equal(C.firstLine('  a  b  ', 10), 'a b');
  });

  await t.test('no embedded blob → loader is a no-op', () => {
    const sandbox = sandboxBase();
    for (const f of ['core/classifier.js', 'core/backoff.js', 'core/sign.js']) {
      run(sandbox, path.join(SRC, f));
    }
    run(sandbox, LOADER); // no wasm-embedded.js executed first
    const C = sandbox.self.__zaiExtCore;
    assert.equal(C.__wasmActive, undefined);
  });

  await t.test('loader is idempotent', () => {
    const sandbox = sandboxBase();
    for (const f of ['core/classifier.js', 'core/backoff.js', 'core/sign.js']) {
      run(sandbox, path.join(SRC, f));
    }
    run(sandbox, EMBEDDED);
    run(sandbox, LOADER);
    const first = sandbox.self.__zaiExtCore.firstLine;
    run(sandbox, LOADER); // second run must not re-patch
    assert.equal(sandbox.self.__zaiExtCore.firstLine, first);
  });
});
