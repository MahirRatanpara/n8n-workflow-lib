// Loads the lib files exactly the way build.mjs inlines them into Code nodes
// (plain concatenation), so tests exercise the shipped code.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const LIB_ORDER = ['util', 'schema', 'company', 'mail', 'sync', 'planner', 'ai', 'send', 'digest', 'enrich', 'setup', 'commands'];

export function libSource(names = LIB_ORDER) {
  return names.map(n => readFileSync(join(here, 'lib', `${n}.js`), 'utf8')).join('\n\n');
}

export function loadLibs() {
  const src = libSource();
  const names = [...src.matchAll(/^(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { ${[...new Set(names)].join(', ')} };`)();
}
