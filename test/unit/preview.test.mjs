/* Unit testlər — core/preview.js saf qərar funksiyası (P.decide). */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');

function loadPreview() {
  const sandbox = { self: {}, globalThis: {}, Date, Math };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(SRC, 'core', 'preview.js'), 'utf8'), sandbox, { filename: 'core/preview.js' });
  return sandbox.self.__zaiExtPreview;
}

const P = loadPreview();

test('parametr söndürüldükdə hər şey açıq qalır', () => {
  assert.equal(P.decide({ blockAutoPreview: false, now: 1000 }), 'allow');
  assert.equal(P.decide({ blockAutoPreview: false, now: 1000, lastClickTs: null, lastCompletionOkTs: 900 }), 'allow');
});

test('media/chip klikli açılış həmişə saxlanılır (prioritet 1)', () => {
  // klik fresh, completion pəncərəsi də aktiv — amma klik preview triggeridir
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4800, lastClickIsPreviewTrigger: true,
    lastCompletionOkTs: 4900, lastFileChangeTs: 4850
  }), 'allow');
});

test('uğurlu completion pəncərəsində avtomatik açılış bağlanır (prioritet 2)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4500, lastClickIsPreviewTrigger: false,
    lastCompletionOkTs: 4800
  }), 'close');
  // pəncərə bitibsə → bağlanmır
  assert.equal(P.decide({
    blockAutoPreview: true, now: 20000,
    lastClickTs: 19500, lastClickIsPreviewTrigger: false,
    lastCompletionOkTs: 5000
  }), 'allow');
});

test('fayl əlavəsi pəncərəsində avtomatik açılış bağlanır (prioritet 3)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4200, lastClickIsPreviewTrigger: false,
    lastFileChangeTs: 4600
  }), 'close');
});

test('klik yoxdursa bağlanır (prioritet 4)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: null, lastClickIsPreviewTrigger: false
  }), 'close');
  assert.equal(P.decide({
    blockAutoPreview: true, now: 10000,
    lastClickTs: 1000, lastClickIsPreviewTrigger: false  // köhnə klik
  }), 'close');
});

test('təzə klik + boş pəncərələr → saxlanılır (prioritet 5)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4200, lastClickIsPreviewTrigger: false,
    lastFileChangeTs: null, lastCompletionOkTs: null
  }), 'allow');
});

test('sərhəd: gələcək zaman damğaları (mənfi yaş) bağlamır', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 1000,
    lastClickTs: 5000, lastClickIsPreviewTrigger: false,
    lastCompletionOkTs: 2000
  }), 'allow');
});

test('WINDOWS konfiqurasiyası gözləntiyə uyğundur', () => {
  assert.equal(P.WINDOWS.completion, 4000);
  assert.equal(P.WINDOWS.fileChange, 2500);
  assert.equal(P.WINDOWS.click, 2200);
});
