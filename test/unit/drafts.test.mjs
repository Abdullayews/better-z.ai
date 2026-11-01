/* Unit tests — core/drafts.js (draft helpers). */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');

function loadDrafts() {
  const sandbox = { self: {}, globalThis: {}, Date, Math };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(SRC, 'core', 'drafts.js'), 'utf8'), sandbox, { filename: 'core/drafts.js' });
  return sandbox.self.__zaiExtDrafts;
}

const D = loadDrafts();

test('key: path normalization', () => {
  assert.equal(D.key('/c/abc123'), '/c/abc123');
  assert.equal(D.key(''), '/');
  assert.equal(D.key(null), '/');
  const long = '/' + 'x'.repeat(300);
  assert.equal(D.key(long).length, 120);
});

test('fresh: age limits', () => {
  const now = 1000000000;
  assert.equal(D.fresh({ at: now - 3600000 }, 72, now), true);          // 1 hour
  assert.equal(D.fresh({ at: now - 73 * 3600000 }, 72, now), false);    // 73 hours
  assert.equal(D.fresh({ at: now - 72 * 3600000 }, 72, now), true);     // exactly 72
  assert.equal(D.fresh({ at: now + 5000 }, 72, now), true);             // 5s in the future — tolerance (multi-tab)
  assert.equal(D.fresh({ at: now + 120000 }, 72, now), false);          // 2 min in the future — too much
  assert.equal(D.fresh(null, 72, now), false);
  assert.equal(D.fresh({}, 72, now), false);
});

test('prune: drops the oldest when the limit is exceeded', () => {
  const map = {};
  for (let i = 0; i < 25; i++) map['k' + i] = { at: 1000 + i, text: 'x' };
  D.prune(map, 20, 99999);
  const keys = Object.keys(map);
  assert.equal(keys.length, 20);
  assert.ok(!map.k0 && !map.k4, 'the oldest should be removed');
  assert.ok(map.k24, 'the newest should remain');
});

test('prune: untouched when under the limit', () => {
  const map = { a: { at: 1 }, b: { at: 2 } };
  D.prune(map, 20, 99999);
  assert.equal(Object.keys(map).length, 2);
});

test('ageLabel: minutes / hours / days', () => {
  const now = 1000000000;
  assert.equal(D.ageLabel({ at: now - 30000 }, now), 'now');
  assert.equal(D.ageLabel({ at: now - 5 * 60000 }, now), '5 min');
  assert.equal(D.ageLabel({ at: now - 3 * 3600000 }, now), '3 h');
  assert.equal(D.ageLabel({ at: now - 48 * 3600000 }, now), '2 d');
  assert.equal(D.ageLabel(null, now), '');
});
