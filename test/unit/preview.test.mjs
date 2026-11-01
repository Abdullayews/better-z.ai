/* Unit tests — core/preview.js pure decision function (P.decide). */
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

test('everything stays open when the setting is off', () => {
  assert.equal(P.decide({ blockAutoPreview: false, now: 1000 }), 'allow');
  assert.equal(P.decide({ blockAutoPreview: false, now: 1000, lastClickTs: null, lastCompletionOkTs: 900 }), 'allow');
});

test('media/chip open-on-click is always kept (priority 1)', () => {
  // the click is fresh and the completion window is active too — but the click is a preview trigger
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4800, lastClickIsPreviewTrigger: true,
    lastCompletionOkTs: 4900, lastFileChangeTs: 4850
  }), 'allow');
});

test('auto-open is blocked inside the completion window (priority 2)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4500, lastClickIsPreviewTrigger: false,
    lastCompletionOkTs: 4800
  }), 'close');
  // once the window is over → not blocked
  assert.equal(P.decide({
    blockAutoPreview: true, now: 20000,
    lastClickTs: 19500, lastClickIsPreviewTrigger: false,
    lastCompletionOkTs: 5000
  }), 'allow');
});

test('auto-open is blocked inside the file-add window (priority 3)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4200, lastClickIsPreviewTrigger: false,
    lastFileChangeTs: 4600
  }), 'close');
});

test('blocked when there is no click (priority 4)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: null, lastClickIsPreviewTrigger: false
  }), 'close');
  assert.equal(P.decide({
    blockAutoPreview: true, now: 10000,
    lastClickTs: 1000, lastClickIsPreviewTrigger: false  // stale click
  }), 'close');
});

test('fresh click + empty windows → kept (priority 5)', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 5000,
    lastClickTs: 4200, lastClickIsPreviewTrigger: false,
    lastFileChangeTs: null, lastCompletionOkTs: null
  }), 'allow');
});

test('edge: future timestamps (negative age) do not block', () => {
  assert.equal(P.decide({
    blockAutoPreview: true, now: 1000,
    lastClickTs: 5000, lastClickIsPreviewTrigger: false,
    lastCompletionOkTs: 2000
  }), 'allow');
});

test('WINDOWS configuration matches expectations', () => {
  assert.equal(P.WINDOWS.completion, 4000);
  assert.equal(P.WINDOWS.fileChange, 2500);
  assert.equal(P.WINDOWS.click, 2200);
});
