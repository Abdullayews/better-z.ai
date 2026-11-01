/* Unit tests — core/popupcloser.js pure decision function (PC.decide). */
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

test('does nothing when the setting is off', () => {
  assert.equal(PC.decide({ enabled: false, text: 'Currently in peak hours', patterns: ['peak hours'] }), 'keep');
});

test('a password form is NEVER closed (safety)', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'Currently in peak hours — sign in', patterns: ['peak hours'],
    hasPassword: true, hasTextInput: true, hasDismissBtn: true
  }), 'keep');
});

test('keyword + "Later" button → close', () => {
  assert.equal(PC.decide({
    enabled: true, text: '⚠️ Currently in peak hours\nTraffic is high.', patterns: ['peak hours'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: true
  }), 'close');
});

test('keyword + NO input + NO button → close via Escape', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'High traffic right now', patterns: ['high traffic'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: false
  }), 'close');
});

test('keyword + text input + no close button → hands off', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'Rate limit reached — enter your email', patterns: ['rate limit'],
    hasPassword: false, hasTextInput: true, hasDismissBtn: false
  }), 'keep');
});

test('keyword does not match → hands off', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'Are you sure you want to delete?', patterns: ['peak hours'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: true
  }), 'keep');
  assert.equal(PC.decide({
    enabled: true, text: '', patterns: ['peak hours'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: true
  }), 'keep');
});

test('case-insensitive; empty patterns are ignored', () => {
  assert.equal(PC.decide({
    enabled: true, text: 'CURRENTLY IN PEAK HOURS', patterns: ['currently in peak'],
    hasPassword: false, hasTextInput: false, hasDismissBtn: false
  }), 'close');
  assert.equal(PC.decide({
    enabled: true, text: 'peak hours', patterns: ['  ', ''],
    hasPassword: false, hasTextInput: false, hasDismissBtn: false
  }), 'keep');
});

test('DISMISS_RE recognized button texts', () => {
  for (const t of ['Close', 'close', 'Later', 'later', 'Skip', 'Not now', '×']) {
    assert.ok(PC.DISMISS_RE.test(t), 'should match: ' + t);
  }
  for (const t of ['Upgrade', 'Sign in', 'Send', 'Confirm']) {
    assert.ok(!PC.DISMISS_RE.test(t), 'should NOT match: ' + t);
  }
});

test('WINDOWS configuration matches expectations', () => {
  assert.equal(PC.WINDOWS.maxCloses, 3);
  assert.equal(PC.WINDOWS.closeWindow, 30000);
});
