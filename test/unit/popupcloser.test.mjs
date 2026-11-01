/* Unit testlər — core/popupcloser.js saf qərar funksiyası (PC.decide). */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');

function loadPopupCloser() {
  const sandbox = { self: {}, globalThis: {}, Date, Math };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(SRC, 'core', 'popupcloser.js'), 'utf8'), sandbox, { filename: 'core/popupcloser.js' });
  return sandbox.self.__zaiExtPopupCloser;
}

const PC = loadPopupCloser();

test('parametr söndürüldükdə heç nəyə toxunmur', () => {
  assert.equal(PC.decide({ enabled: false, text: 'Currently in peak hours', patterns: ['peak hours'] }), 'keep');
});

test('parol forması HEÇ VAXT bağlanmır (təhlükəsizlik)', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'Currently in peak hours — sign in', patterns: ['peak hours'],
    hasPassword: true, hasTextInput: true, hasDismissBtn: true
  }), 'keep');
});

test('açar söz + "Later" düyməsi → bağla', () => {
  assert.equal(PC.decide({
    enabled: true, text: '⚠️ Currently in peak hours\nTraffic is high.', patterns: ['peak hours'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: true
  }), 'close');
});

test('açar söz + input YOXDUR + düymə YOXDUR → Escape ilə bağla', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'High traffic right now', patterns: ['high traffic'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: false
  }), 'close');
});

test('açar söz + mətn inputu + bağla düyməsi YOXDUR → toxunma', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'Rate limit reached — enter your email', patterns: ['rate limit'],
    hasPassword: false, hasTextInput: true, hasDismissBtn: false
  }), 'keep');
});

test('açar söz uyğun gəlmirsə → toxunma', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'Silmək istədiyinizə əminsiniz?', patterns: ['peak hours'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: true
  }), 'keep');
  assert.equal(PC.decide({
    enabled: true, text: '', patterns: ['peak hours'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: true
  }), 'keep');
});

test('böyük/kiçik hərf fərqi yoxdur; boş patternlər nəzərə alınmır', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'CURRENTLY IN PEAK HOURS', patterns: ['currently in peak'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: false
  }), 'close');
  assert.equal(PC.decide({
    enabled: true, text: 'peak hours', patterns: ['  ', ''],
    hasPassword: false, hasTextInput: false, hasDismissBtn: false
  }), 'keep');
});

test('DISMISS_RE tanınan düymə mətnləri', () => {
  for (const t of ['Close', 'close', 'Later', 'later', 'sonra', 'Keç', 'Skip', 'Not now', 'Tamam', '×']) {
    assert.ok(PC.DISMISS_RE.test(t), 'geçməli: ' + t);
  }
  for (const t of ['Upgrade', 'Daxil ol', 'Göndər', 'Confirm']) {
    assert.ok(!PC.DISMISS_RE.test(t), 'keçməməli: ' + t);
  }
});

test('WINDOWS konfiqurasiyası gözləntiyə uyğundur', () => {
  assert.equal(PC.WINDOWS.maxCloses, 3);
  assert.equal(PC.WINDOWS.closeWindow, 30000);
});
