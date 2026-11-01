/* Loads the core files into a Node vm context (no browser dependency). */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');

export function loadCore() {
  const sandbox = {
    self: {},
    globalThis: {},
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    URL,
    URLSearchParams,
    crypto,
    Math,
    Date
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['core/classifier.js', 'core/backoff.js', 'core/sign.js']) {
    vm.runInContext(readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.self.__zaiExtCore;
}
