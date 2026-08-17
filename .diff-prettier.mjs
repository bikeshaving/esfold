import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import { format, applyEdits } from './src/format.js';

const BOX =
  '/private/tmp/claude-501/-Users-brian-Projects-eslint-plugin-fold/e15f35ab-829a-4b0f-b8b0-5c4d4935ebe3/scratchpad/prettierbox';
const ROOT =
  '/private/tmp/claude-501/-Users-brian-Projects-eslint-plugin-fold/e15f35ab-829a-4b0f-b8b0-5c4d4935ebe3/scratchpad/repos';
const prettier = createRequire(join(BOX, 'noop.js'))('prettier');

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'lib', 'es', 'umd', 'esm', 'coverage', 'fixtures', '__fixtures__', 'snapshots', '__snapshots__', 'types']);
const P = { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true, tokens: true, comment: true, filePath: 'x.tsx' };
const WIDTH = 80;
const PER_REPO = Number(process.env.N ?? 25);

function collect(dir, out = [], d = 0) {
  if (d > 6) return out;
  let ns; try { ns = readdirSync(dir); } catch { return out; }
  for (const n of ns) {
    if (SKIP.has(n) || n.startsWith('.')) continue;
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collect(p, out, d + 1);
    else if (/\.(m?[jt]sx?)$/.test(n) && !/\.d\.ts$/.test(n) && st.size < 200000) out.push(p);
  }
  return out;
}

const buckets = new Map();
function classify(before, after) {
  const b = before.trim(), a = after.trim();
  let key = 'other';
  if (/^(import|export)\b/.test(b)) key = 'import/export specifier list';
  else if (/^[)\]}]/.test(a) || /[([{]$/.test(a)) key = 'bracketed list';
  if (/\?|:/.test(a.slice(0, 2))) key = 'ternary';
  if (/^(&&|\|\||[+*/%-]|\?\?)/.test(a)) key = 'operator chain';
  if (/^\./.test(a)) key = 'method chain';
  const list = buckets.get(key) ?? [];
  if (list.length < 3) list.push(`${JSON.stringify(before.trim().slice(0, 72))}`);
  buckets.set(key, list);
  return key;
}

let files = 0, agreed = 0, differed = 0, totalHunks = 0;
const repos = readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory()).sort();

for (const repo of repos) {
  const all = collect(join(ROOT, repo));
  const step = Math.max(1, Math.floor(all.length / PER_REPO));
  const picked = all.filter((_, i) => i % step === 0).slice(0, PER_REPO);
  let rAgreed = 0, rDiffered = 0;

  for (const file of picked) {
    let raw; try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    let pretty;
    try {
      pretty = await prettier.format(raw, {
        parser: /\.tsx?$/.test(file) ? 'typescript' : 'babel',
        printWidth: WIDTH,
      });
    } catch { continue; }

    let ast; try { ast = tseslint.parser.parseForESLint(pretty, P).ast; } catch { continue; }
    let out;
    try { out = applyEdits(pretty, format(new SourceCode({ text: pretty, ast }), { maxWidth: WIDTH })); }
    catch { continue; }

    files++;
    if (out === pretty) { agreed++; rAgreed++; continue; }
    differed++; rDiffered++;

    const a = pretty.split('\n'), b = out.split('\n');
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      let k = j;
      while (k < b.length && b[k] !== a[i + 1]) k++;
      classify(a[i], b[j] ?? '');
      if (process.env.SHOW) {
        console.log(`--- ${file.slice(ROOT.length + 1)}:${i + 1}`);
        console.log('  P ' + a[i]);
        for (let q = j; q < Math.min(k, j + 6); q++) console.log('  F ' + b[q]);
      }
      totalHunks++;
      i++; j = k;
    }
  }
  console.log(`${repo.padEnd(10)} prettier-clean files: ${String(rAgreed + rDiffered).padStart(3)} | fold agrees ${String(rAgreed).padStart(3)} | differs ${rDiffered}`);
}

console.log(`\nTOTAL ${files} files: agree ${agreed} (${Math.round((agreed / files) * 100)}%), differ ${differed}, hunks ${totalHunks}`);
console.log('\nDisagreements by kind:');
for (const [k, v] of [...buckets].sort()) {
  console.log(`  ${k}`);
  for (const s of v) console.log(`      ${s}`);
}
