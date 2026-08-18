/**
 * Invariants over the third-party corpus.
 *
 * This is the harness that has caught every dangerous bug in this project —
 * the hugging feedback loop, the arrow-group oscillation, the comma-dangle
 * standoff. None of them were found by a unit test, because all of them
 * needed real code to trigger. Run it after any change to the break
 * candidates or the addition pass.
 *
 *   node scripts/clone-corpus.js   # once
 *   node scripts/audit.js
 *
 * Per file it checks: the rule does not throw, the AST is unchanged, the
 * result is idempotent, and no over-width line is left holding a break Fold
 * could have taken. Each repository is measured at *its own* print width, so
 * "touched" means real disagreement rather than a width mismatch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import fold from '../src/index.ts';
import {
  CORPUS, PARSE_OPTIONS, printWidth, requireCorpus, sample, sourceFiles,
  stripLocations,
} from './corpus.js';

const MAX_PER_REPO = Number(process.env.MAX_FILES ?? 120);

const parse = (code) => {
  try {
    return tseslint.parser.parseForESLint(code, PARSE_OPTIONS).ast;
  } catch {
    return null;
  }
};

const linter = new Linter();

const configFor = (maxWidth) => ({
  plugins: { fold },
  linterOptions: { reportUnusedDisableDirectives: 'off' },
  rules: { 'fold/breaks': ['error', { maxWidth }] },
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const run = (code, maxWidth) => linter.verifyAndFix(code, configFor(maxWidth));

/**
 * Over-width lines that still hold a break Fold could have taken. The rule
 * reports a long line only when it has a legal break position, so anything it
 * still reports about its own output is a break that was available and not
 * taken. Lines with no candidate at all, or whose only item is atomic and
 * already too wide, report nothing and are correctly ignored.
 */
function stuckLines(code, maxWidth) {
  return linter
    .verify(code, configFor(maxWidth))
    .filter((message) => message.ruleId === 'fold/breaks')
    .map((message) => `line ${message.line}: ${message.messageId}`);
}

const totals = { files: 0, changed: 0, crash: 0, ast: 0, idem: 0, stuck: 0, lines: 0, edits: 0 };

for (const repo of requireCorpus()) {
  const dir = join(CORPUS, repo);
  const width = printWidth(dir);
  const files = sample(sourceFiles(dir), MAX_PER_REPO);

  let n = 0, changed = 0, crash = 0, astBad = 0, idem = 0, stuck = 0, lines = 0, edits = 0;
  const kinds = {};
  const notes = [];

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

    let out;
    try {
      for (const message of linter.verify(code, configFor(width))) {
        if (message.ruleId !== 'fold/breaks') continue;
        edits++;
        kinds[message.messageId] = (kinds[message.messageId] ?? 0) + 1;
      }
      out = run(code, width).output;
    } catch (error) {
      crash++;
      if (notes.length < 2) notes.push(`CRASH ${file.slice(dir.length + 1)}: ${error.message}`);
      continue;
    }
    if (out !== code) changed++;

    const after = parse(out);
    if (!after || stripLocations(after) !== stripLocations(ast)) {
      astBad++;
      if (notes.length < 2) notes.push(`AST CHANGED ${file.slice(dir.length + 1)}`);
      continue;
    }
    try {
      const twice = run(out, width).output;
      if (twice !== out) {
        idem++;
        if (notes.length < 2) notes.push(`NOT IDEMPOTENT ${file.slice(dir.length + 1)}`);
      }
    } catch {
      idem++;
    }
    const s = stuckLines(out, width);
    if (s.length) {
      stuck += s.length;
      if (notes.length < 2) notes.push(`STUCK ${file.slice(dir.length + 1)}: ${s[0]}`);
    }
  }

  totals.files += n; totals.changed += changed; totals.crash += crash;
  totals.ast += astBad; totals.idem += idem; totals.stuck += stuck;
  totals.lines += lines; totals.edits += edits;

  const flag = crash || astBad || idem || stuck ? ' ***' : '';
  console.log(
    `${repo.padEnd(10)} w${String(width).padEnd(4)} ${String(n).padStart(4)} files ` +
      `${String(lines).padStart(6)} lines | touched ${String(Math.round((changed / (n || 1)) * 100)).padStart(3)}% ` +
      `${String(edits).padStart(5)} edits ` +
      `(width ${kinds.overWidth ?? 0}, consistency ${kinds.inconsistentGroup ?? 0}, necessary ${kinds.necessaryBreak ?? 0})` +
      ` | crash ${crash} ast ${astBad} idem ${idem} stuck ${stuck}${flag}`,
  );
  for (const note of notes) console.log('    ' + note);
}

console.log('\n' + JSON.stringify(totals));
const failed = totals.crash + totals.ast + totals.idem + totals.stuck;
if (failed > 0) {
  console.error(`\n${failed} invariant failure(s).`);
  process.exit(1);
}
console.log('All invariants hold.');
