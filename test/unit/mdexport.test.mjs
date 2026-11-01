/* Unit tests — core/mdexport.js (Markdown export). */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');

function loadMd() {
  const sandbox = { self: {}, globalThis: {}, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(SRC, 'core', 'mdexport.js'), 'utf8'), sandbox, { filename: 'core/mdexport.js' });
  return sandbox.self.__zaiExtMdExport;
}

const MD = loadMd();

function sampleHistory() {
  return {
    currentId: 'a2',
    messages: {
      u1: { id: 'u1', parentId: null, role: 'user', content: 'Hello, how are you?' },
      a1: { id: 'a1', parentId: 'u1', role: 'assistant', content: 'I am fine, you?' },
      u2: { id: 'u2', parentId: 'a1', role: 'user', content: [{ type: 'text', text: 'look at the image' }, { type: 'image_url', image_url: { url: 'x' } }] },
      a2: { id: 'a2', parentId: 'u2', role: 'assistant', content: 'Looked ✅' }
    }
  };
}

test('orderMessages: root from currentId — chronological order', () => {
  const chain = MD.orderMessages(sampleHistory());
  assert.deepEqual(Array.from(chain.map((m) => m.id)), ['u1', 'a1', 'u2', 'a2']);
});

test('orderMessages: timestamp fallback when the chain is broken', () => {
  const hist = {
    currentId: null,
    messages: {
      b: { id: 'b', parentId: null, role: 'user', content: 'second', timestamp: 2 },
      a: { id: 'a', parentId: null, role: 'user', content: 'first', timestamp: 1 }
    }
  };
  const chain = MD.orderMessages(hist);
  assert.deepEqual(Array.from(chain.map((m) => m.id)), ['a', 'b']);
});

test('orderMessages: cycle (a→b→a) does not loop forever', () => {
  const hist = {
    currentId: 'a',
    messages: {
      a: { id: 'a', parentId: 'b', role: 'user', content: 'x' },
      b: { id: 'b', parentId: 'a', role: 'user', content: 'y' }
    }
  };
  const chain = MD.orderMessages(hist);
  assert.ok(chain.length <= 2);
});

test('buildMarkdown: title, roles, content, attachment markers', () => {
  const chat = { title: 'Mock chat', models: ['x-preview-l'], history: sampleHistory() };
  const md = MD.buildMarkdown(chat, { date: 0, url: 'https://chat.z.ai/c/abc' });
  assert.ok(md.startsWith('# Mock chat'));
  assert.ok(md.includes('## 🧑 You'));
  assert.ok(md.includes('## 🤖 Z.ai'));
  assert.ok(md.includes('Hello, how are you?'));
  assert.ok(md.includes('Looked ✅'));
  assert.ok(md.includes('look at the image'));
  assert.ok(md.includes('📎 [image]'));
  assert.ok(md.includes('Model: x-preview-l'));
  assert.ok(md.includes('https://chat.z.ai/c/abc'));
  // chronology: the first question comes before the answer
  assert.ok(md.indexOf('Hello, how are you?') < md.indexOf('I am fine'));
});

test('buildMarkdown: empty history → null', () => {
  assert.equal(MD.buildMarkdown(null), null);
  assert.equal(MD.buildMarkdown({ history: { messages: {}, currentId: null } }), null);
});

test('contentText: string / array / object', () => {
  assert.equal(MD.contentText('hello'), 'hello');
  assert.equal(MD.contentText([{ type: 'text', text: 'a' }, { type: 'file_url' }]), 'a\n📎 [file]');
  assert.equal(MD.contentText(null), '');
  assert.ok(typeof MD.contentText({ x: 1 }) === 'string');
});
