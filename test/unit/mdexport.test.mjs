/* Unit testlər — core/mdexport.js (Markdown ixracı). */
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
      u1: { id: 'u1', parentId: null, role: 'user', content: 'Salam, necəsən?' },
      a1: { id: 'a1', parentId: 'u1', role: 'assistant', content: 'Yaxşıyam, sən?' },
      u2: { id: 'u2', parentId: 'a1', role: 'user', content: [{ type: 'text', text: 'şəkilə bax' }, { type: 'image_url', image_url: { url: 'x' } }] },
      a2: { id: 'a2', parentId: 'u2', role: 'assistant', content: 'Baxdıq ✅' }
    }
  };
}

test('orderMessages: currentId-dən kökə — xronoloji sıra', () => {
  const chain = MD.orderMessages(sampleHistory());
  assert.deepEqual(Array.from(chain.map((m) => m.id)), ['u1', 'a1', 'u2', 'a2']);
});

test('orderMessages: zəncir pozulubsa timestamp fallback', () => {
  const hist = {
    currentId: null,
    messages: {
      b: { id: 'b', parentId: null, role: 'user', content: 'ikinci', timestamp: 2 },
      a: { id: 'a', parentId: null, role: 'user', content: 'birinci', timestamp: 1 }
    }
  };
  const chain = MD.orderMessages(hist);
  assert.deepEqual(Array.from(chain.map((m) => m.id)), ['a', 'b']);
});

test('orderMessages: dövrə (a→b→a) sonsuzluq yaratmır', () => {
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

test('buildMarkdown: başlıq, rollar, məzmun, attachment markerləri', () => {
  const chat = { title: 'Mock söhbət', models: ['x-preview-l'], history: sampleHistory() };
  const md = MD.buildMarkdown(chat, { date: 0, url: 'https://chat.z.ai/c/abc' });
  assert.ok(md.startsWith('# Mock söhbət'));
  assert.ok(md.includes('## 🧑 Siz'));
  assert.ok(md.includes('## 🤖 Z.ai'));
  assert.ok(md.includes('Salam, necəsən?'));
  assert.ok(md.includes('Baxdıq ✅'));
  assert.ok(md.includes('şəkilə bax'));
  assert.ok(md.includes('📎 [şəkil]'));
  assert.ok(md.includes('Model: x-preview-l'));
  assert.ok(md.includes('https://chat.z.ai/c/abc'));
  // xronologiya: birinci sual cavabdan əvvəl
  assert.ok(md.indexOf('Salam, necəsən?') < md.indexOf('Yaxşıyam'));
});

test('buildMarkdown: boş tarixçə → null', () => {
  assert.equal(MD.buildMarkdown(null), null);
  assert.equal(MD.buildMarkdown({ history: { messages: {}, currentId: null } }), null);
});

test('contentText: string / massiv / obyekt', () => {
  assert.equal(MD.contentText('salam'), 'salam');
  assert.equal(MD.contentText([{ type: 'text', text: 'a' }, { type: 'file_url' }]), 'a\n📎 [fayl]');
  assert.equal(MD.contentText(null), '');
  assert.ok(typeof MD.contentText({ x: 1 }) === 'string');
});
