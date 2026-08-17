/**
 * Invariants over the third-party corpus.
 *
 * This is the harness that has caught every dangerous bug in this project —
 * the hugging feedback loop, the arrow-group oscillation, the comma-dangle
 * standoff. None of them were found by a unit test, because all of them
 * needed real code to trigger. Run it after any change to the break
 * candidates or the addition pass.
 *
 *   npm run corpus     # once
 *   npm run audit
 *
 * Per file it checks: format() does not throw, the AST is unchanged, the
 * result is idempotent, and no over-width line is left holding a break Fold
 * could have taken. Each repository is measured at *its own* print width, so
 * "touched" means real disagreement rather than a width mismatch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import { format, applyEdits } from '../src/format.js';
import { collectGroups } from '../src/groups.js';
import { isForbiddenBreak } from '../src/forbidden.js';
import { measureLine } from '../src/measure.js';
import {
  CORPUS, PARSE_OPTIONS, printWidth, requireCorpus, sample, sourceFiles,
  stripLocations,
} from './corpus.mjs';

const MAX_PER_REPO = Number(process.env.MAX_FILES ?? 120);

const parse = (code) => {
  try {
    return tseslint.parser.parseForESLint(code, PARSE_OPTIONS).ast;
  } catch {
    return null;
  }
};

/**
 * Over-width lines that still hold a break Fold could have taken — §8's
 * test 4. Three kinds of line are legitimately left long and are excluded:
 * ones with no candidate at all, ones pushed over only by a trailing
 * comment (§7.1), and ones whose sole item is atomic and already too wide,
 * where breaking cannot help.
 */
function stuckLines(code, maxWidth) {
  const ast = parse(code);
  if (!ast) return [];
  const sourceCode = new SourceCode({ text: code, ast });
  const { candidates } = collectGroups(sourceCode, 'after');
  const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
  const broken = (range) =>
    range && LINE_BREAK.test(code.slice(range.start, range.end));
  const usable = (group, gap) =>
    group.addable !== false && !isForbiddenBreak(sourceCode, gap);

  const hasUsableGapInside = (group, [from, to]) =>
    candidates.some((other) =>
      other.gaps.some(
        (gap) =>
          !group.gaps.includes(gap) &&
          from <= gap.start &&
          gap.end <= to &&
          usable(other, gap),
      ),
    );
  // Measured at the indent the item would actually land on — the line's own
  // indent plus one step. Assuming a fixed two spaces here reads as "it
  // would fit" for anything nested, which is how this check used to
  // disagree with the rule itself.
  const pointless = (group, indent) =>
    group.items?.length === 1 &&
    group.items[0]?.range &&
    !hasUsableGapInside(group, group.items[0].range) &&
    measureLine(indent + '  ' + code.slice(...group.items[0].range)) > maxWidth;

  const gapsFor = (indent) =>
    candidates
      .filter((group) => group.addable !== false && !pointless(group, indent))
      .flatMap((group) => group.gaps)
      .filter((gap) => !broken(gap) && !broken(gap.alt))
      .filter((gap) => !isForbiddenBreak(sourceCode, gap));

  const comments = sourceCode.getAllComments();
  const trailingComment = (start, end) =>
    comments.some(
      (c) =>
        c.range[0] >= start &&
        c.range[0] < end &&
        c.range[1] >= end &&
        measureLine(code.slice(start, c.range[0]).trimEnd()) <= maxWidth,
    );

  const out = [];
  let position = 0;
  for (const line of code.split('\n')) {
    const start = position;
    const end = position + line.length;
    position = end + 1;
    if (measureLine(line) <= maxWidth) continue;
    if (trailingComment(start, end)) continue;
    const gaps = gapsFor(/^[ \t]*/.exec(line)[0]);
    if (gaps.some((gap) => start <= gap.start && gap.end <= end))
      out.push(line.trim().slice(0, 70));
  }
  return out;
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

    let out, editList;
    try {
      editList = format(new SourceCode({ text: code, ast }), { maxWidth: width });
      out = applyEdits(code, editList);
    } catch (error) {
      crash++;
      if (notes.length < 2) notes.push(`CRASH ${file.slice(dir.length + 1)}: ${error.message}`);
      continue;
    }
    edits += editList.length;
    for (const edit of editList) kinds[edit.messageId] = (kinds[edit.messageId] ?? 0) + 1;
    if (out !== code) changed++;

    const after = parse(out);
    if (!after || stripLocations(after) !== stripLocations(ast)) {
      astBad++;
      if (notes.length < 2) notes.push(`AST CHANGED ${file.slice(dir.length + 1)}`);
      continue;
    }
    try {
      const reparsed = parse(out);
      const twice = applyEdits(
        out,
        format(new SourceCode({ text: out, ast: reparsed }), { maxWidth: width }),
      );
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
