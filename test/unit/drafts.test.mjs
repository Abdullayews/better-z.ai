/* Unit testlər — core/drafts.js (qaralama köməkçiləri). */
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

test('key: yol normalizasiyası', () => {
  assert.equal(D.key('/c/abc123'), '/c/abc123');
  assert.equal(D.key(''), '/');
  assert.equal(D.key(null), '/');
  const long = '/' + 'x'.repeat(300);
  assert.equal(D.key(long).length, 120);
});

test('fresh: yaş hədləri', () => {
  const now = 1000000000;
  assert.equal(D.fresh({ at: now - 3600000 }, 72, now), true);          // 1 saat
  assert.equal(D.fresh({ at: now - 73 * 3600000 }, 72, now), false);    // 73 saat
  assert.equal(D.fresh({ at: now - 72 * 3600000 }, 72, now), true);     // tam 72
  assert.equal(D.fresh({ at: now + 5000 }, 72, now), true);             // 5s gələcək — tolerans (multi-tab)
  assert.equal(D.fresh({ at: now + 120000 }, 72, now), false);          // 2 dəq gələcək — çoxdur
  assert.equal(D.fresh(null, 72, now), false);
  assert.equal(D.fresh({}, 72, now), false);
});

test('prune: limiti aşanda ən köhnələr silinir', () => {
  const map = {};
  for (let i = 0; i < 25; i++) map['k' + i] = { at: 1000 + i, text: 'x' };
  D.prune(map, 20, 99999);
  const keys = Object.keys(map);
  assert.equal(keys.length, 20);
  assert.ok(!map.k0 && !map.k4, 'ən köhnələr silinməli');
  assert.ok(map.k24, 'ən yenisi qalmalı');
});

test('prune: limit aşağı olanda toxunmur', () => {
  const map = { a: { at: 1 }, b: { at: 2 } };
  D.prune(map, 20, 99999);
  assert.equal(Object.keys(map).length, 2);
});

test('ageLabel: dəqiqə / saat / gün', () => {
  const now = 1000000000;
  assert.equal(D.ageLabel({ at: now - 30000 }, now), 'indi');
  assert.equal(D.ageLabel({ at: now - 5 * 60000 }, now), '5 dəq');
  assert.equal(D.ageLabel({ at: now - 3 * 3600000 }, now), '3 saat');
  assert.equal(D.ageLabel({ at: now - 48 * 3600000 }, now), '2 gün');
  assert.equal(D.ageLabel(null, now), '');
});
