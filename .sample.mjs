import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import { format, applyEdits } from './src/format.js';

const ROOT =
  '/private/tmp/claude-501/-Users-brian-Projects-eslint-plugin-fold/e15f35ab-829a-4b0f-b8b0-5c4d4935ebe3/scratchpad/repos';
const repo = process.argv[2];
const width = Number(process.argv[3] ?? 80);
const want = Number(process.argv[4] ?? 8);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'lib', 'es', 'umd', 'esm', 'coverage', 'fixtures', '__fixtures__', 'snapshots', '__snapshots__', 'types']);
const P = { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true, tokens: true, comment: true, filePath: 'x.tsx' };

function collect(dir, out = [], d = 0) {
  if (d > 6) return out;
  let ns; try { ns = readdirSync(dir); } catch { return out; }
  for (const n of ns) {
    if (SKIP.has(n) || n.startsWith('.')) continue;
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collect(p, out, d + 1);
    else if (/\.(m?[jt]sx?)$/.test(n) && !/\.d\.ts$/.test(n) && st.size < 400000) out.push(p);
  }
  return out;
}

const files = collect(join(ROOT, repo));
let shown = 0;
for (const file of files) {
  if (shown >= want) break;
  let code; try { code = readFileSync(file, 'utf8'); } catch { continue; }
  let ast; try { ast = tseslint.parser.parseForESLint(code, P).ast; } catch { continue; }
  const out = applyEdits(code, format(new SourceCode({ text: code, ast }), { maxWidth: width }));
  if (out === code) continue;

  const a = code.split('\n'), b = out.split('\n');
  let i = 0, j = 0;
  while (i < a.length && j < b.length && shown < want) {
    if (a[i] === b[j]) { i++; j++; continue; }
    // gather the changed run
    const oldLine = a[i];
    const added = [];
    let k = j;
    while (k < b.length && b[k] !== a[i + 1]) { added.push(b[k]); k++; }
    console.log(`--- ${file.slice(ROOT.length + 1)}:${i + 1}`);
    console.log('  - ' + oldLine.replace(/\t/g, '  '));
    for (const l of added.slice(0, 8)) console.log('  + ' + l.replace(/\t/g, '  '));
    shown++;
    i++; j = k;
  }
}
