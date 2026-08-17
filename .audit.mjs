import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import { format, applyEdits } from './src/format.js';
import { collectGroups } from './src/groups.js';
import { isForbiddenBreak } from './src/forbidden.js';
import { measureLine } from './src/measure.js';

const ROOT =
  '/private/tmp/claude-501/-Users-brian-Projects-eslint-plugin-fold/e15f35ab-829a-4b0f-b8b0-5c4d4935ebe3/scratchpad/repos';
const MAX_PER_REPO = Number(process.env.MAX_FILES ?? 120);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'lib', 'es', 'umd', 'esm',
  'coverage', 'fixtures', '__fixtures__', 'snapshots', '__snapshots__',
  'vendor', 'flow-typed', '.next', 'out', 'types',
]);
const EXT = /\.(m?[jt]sx?)$/;

const PARSE = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  loc: true,
  range: true,
  tokens: true,
  comment: true,
  filePath: 'x.tsx',
};

function parse(code) {
  try {
    return tseslint.parser.parseForESLint(code, PARSE).ast;
  } catch {
    return null;
  }
}

const strip = (n) =>
  JSON.stringify(n, (k, v) => {
    if (k === 'range' || k === 'loc' || k === 'start' || k === 'end' || k === 'parent')
      return undefined;
    return typeof v === 'bigint' ? `${v}n` : v;
  });

function collect(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) collect(path, out, depth + 1);
    else if (EXT.test(name) && st.size < 400000 && !/\.d\.ts$/.test(name))
      out.push(path);
  }
  return out;
}

/** Over-width lines that still hold a usable break candidate (§8 test 4). */
function stuckLines(code, maxWidth) {
  const ast = parse(code);
  if (!ast) return [];
  const sourceCode = new SourceCode({ text: code, ast });
  const { candidates } = collectGroups(sourceCode, 'after');
  const LB = /\r\n|[\n\r\u2028\u2029]/;
  const broken = (r) => r && LB.test(code.slice(r.start, r.end));
  const gaps = candidates
    .filter((g) => g.addable !== false)
    .flatMap((g) => g.gaps)
    // A gap that already holds a break (on either side, for operator/dot/
    // comma gaps) is not an unused candidate.
    .filter((g) => !broken(g) && !broken(g.alt))
    .filter((g) => !isForbiddenBreak(sourceCode, g));
  const comments = sourceCode.getAllComments();
  const trailingComment = (s, e) =>
    comments.some((c) => c.range[0] >= s && c.range[0] < e && c.range[1] >= e &&
      measureLine(code.slice(s, c.range[0]).trimEnd()) <= maxWidth);
  const out = [];
  let pos = 0;
  for (const line of code.split('\n')) {
    const s = pos;
    const e = pos + line.length;
    pos = e + 1;
    if (measureLine(line) <= maxWidth) continue;
    if (trailingComment(s, e)) continue;
    if (gaps.some((g) => s <= g.start && g.end <= e)) out.push(line.trim().slice(0, 70));
  }
  return out;
}

function printWidth(dir) {
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return null; } };
  for (const f of ['.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml', '.prettierrc.yml', 'prettier.config.js', 'prettier.config.mjs', '.prettierrc.js', '.prettierrc.mjs', '.editorconfig']) {
    const text = read(f);
    if (!text) continue;
    const m = text.match(/(?:printWidth|max_line_length)"?\s*[:=]\s*"?(\d+)/);
    if (m) return Number(m[1]);
  }
  const pkg = read('package.json');
  if (pkg) {
    const m = pkg.match(/"printWidth"\s*:\s*(\d+)/);
    if (m) return Number(m[1]);
    // XO (sindresorhus' config) formats at 100.
    if (/"xo"\s*:/.test(pkg)) return 100;
  }
  return 80;
}

function repoStyle(dir) {
  const has = (f) => existsSync(join(dir, f));
  const prettier =
    has('.prettierrc') || has('.prettierrc.json') || has('.prettierrc.js') ||
    has('prettier.config.js') || has('prettier.config.mjs') ||
    (() => {
      try {
        return 'prettier' in JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      } catch {
        return false;
      }
    })();
  return prettier ? 'prettier' : 'other';
}

const repos = readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory());
const totals = { files: 0, changed: 0, crash: 0, ast: 0, idem: 0, stuck: 0, lines: 0, edits: 0 };

for (const repo of repos.sort()) {
  const dir = join(ROOT, repo);
  const width = printWidth(dir);
  const all = collect(dir);
  const step = Math.max(1, Math.floor(all.length / MAX_PER_REPO));
  const files = all.filter((_, i) => i % step === 0).slice(0, MAX_PER_REPO);

  let n = 0, changed = 0, crash = 0, astBad = 0, idemBad = 0, stuck = 0, lines = 0, edits = 0, tabs = 0;
  const kinds = {};
  const samples = [];

  for (const file of files) {
    let code;
    try {
      code = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const ast = parse(code);
    if (!ast) continue;
    n++;
    lines += code.split('\n').length;
    if (/^\t/m.test(code)) tabs++;

    let out, editList;
    try {
      const sc = new SourceCode({ text: code, ast });
      editList = format(sc, { maxWidth: width });
      out = applyEdits(code, editList);
    } catch (e) {
      crash++;
      if (samples.length < 2) samples.push(`CRASH ${file.slice(dir.length + 1)}: ${e.message}`);
      continue;
    }
    edits += editList.length;
    for (const e of editList) kinds[e.messageId] = (kinds[e.messageId] ?? 0) + 1;
    if (out !== code) changed++;

    const after = parse(out);
    if (!after || strip(after) !== strip(ast)) {
      astBad++;
      if (samples.length < 2) samples.push(`AST ${file.slice(dir.length + 1)}`);
      continue;
    }
    try {
      const a2 = parse(out);
      if (applyEdits(out, format(new SourceCode({ text: out, ast: a2 }), { maxWidth: width })) !== out) {
        idemBad++;
        if (samples.length < 2) samples.push(`IDEM ${file.slice(dir.length + 1)}`);
      }
    } catch (e) {
      idemBad++;
    }
    const s = stuckLines(out, width);
    if (s.length) {
      stuck += s.length;
      if (samples.length < 2) samples.push(`STUCK ${file.slice(dir.length + 1)}: ${s[0]}`);
    }
  }

  totals.files += n; totals.changed += changed; totals.crash += crash;
  totals.ast += astBad; totals.idem += idemBad; totals.stuck += stuck;
  totals.lines += lines; totals.edits += edits;

  const pct = n ? Math.round((changed / n) * 100) : 0;
  const flag = crash || astBad || idemBad || stuck ? ' ***' : '';
  console.log(
    `${repo.padEnd(10)} ${repoStyle(dir).padEnd(8)} w${String(width).padEnd(4)} ${String(n).padStart(4)} files ` +
      `${String(lines).padStart(6)} lines | touched ${String(pct).padStart(3)}% ` +
      `${String(edits).padStart(5)} edits (w${kinds.overWidth ?? 0}/c${kinds.inconsistentGroup ?? 0}/n${kinds.necessaryBreak ?? 0}) | crash ${crash} ast ${astBad} idem ${idemBad} stuck ${stuck}${flag}`,
  );
  for (const s of samples) console.log('    ' + s);
}

console.log('\nTOTAL', JSON.stringify(totals));
