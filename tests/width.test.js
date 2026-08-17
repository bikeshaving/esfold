import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { SourceCode } from 'eslint';
import * as espree from 'espree';
import { format, applyEdits } from '../src/index.js';
import { collectGroups } from '../src/index.js';
import { isForbiddenBreak } from '../src/index.js';
import { measureLine } from '../src/index.js';

/**
 * §8 test 4, width compliance. Every output line is within `maxWidth` unless
 * it has no legal break position at all — and the exception is *computed*,
 * not tolerated: a line that stayed long while a legal candidate sat on it
 * is a bug, not an excuse.
 *
 * This is the check that caught the addition pass skipping a line whose
 * overflow was a trailing `;` outside every group.
 */

const OPTS = {
  ecmaVersion: 'latest',
  loc: true,
  range: true,
  tokens: true,
  comment: true,
};

function parse(code) {
  for (const sourceType of ['module', 'script']) {
    try {
      return espree.parse(code, { ...OPTS, sourceType });
    } catch {
      // try the other goal
    }
  }
  return null;
}

/** Lines over `maxWidth` that still hold a usable break candidate. */
function unbrokenWithCandidate(code, maxWidth) {
  const ast = parse(code);
  const sourceCode = new SourceCode({ text: code, ast });
  const { candidates } = collectGroups(sourceCode, 'after');
  const usable = (group, gap) =>
    !isForbiddenBreak(sourceCode, gap) && group.addable !== false;
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
  // A group whose single item is atomic and already wider than the limit
  // cannot be helped by breaking: the item would land on its own line at
  // exactly the width it had. Fold declines those, so they are not
  // "unused candidates" either.
  // Measured at the indent the item would actually land on — the line's own
  // indent plus one step. A fixed two spaces reads as "it would fit" for
  // anything nested, which is how this check used to disagree with the rule.
  const pointless = (group, indent) =>
    group.items &&
    group.items.length === 1 &&
    group.items[0] &&
    group.items[0].range &&
    !hasUsableGapInside(group, group.items[0].range) &&
    measureLine(indent + '  ' + code.slice(...group.items[0].range)) > maxWidth;

  const gapsFor = (indent) =>
    candidates
      .filter((group) => group.addable !== false && !pointless(group, indent))
      .flatMap((group) => group.gaps)
      .filter((gap) => !isForbiddenBreak(sourceCode, gap));

  // A line whose *code* fits and which is pushed over only by a comment at
  // the end of it is unbreakable by §7.1: the comment cannot be shortened,
  // and moving it to its own line is a vertical-spacing change (§3.4).
  const comments = sourceCode.getAllComments();
  const overflowIsTrailingComment = (start, end) =>
    comments.some(
      (c) =>
        c.range[0] >= start &&
        c.range[0] < end &&
        c.range[1] >= end &&
        measureLine(code.slice(start, c.range[0]).trimEnd()) <= maxWidth,
    );

  const offenders = [];
  let position = 0;
  for (const line of code.split('\n')) {
    const start = position;
    const end = position + line.length;
    position = end + 1;
    if (measureLine(line) <= maxWidth) continue;
    if (overflowIsTrailingComment(start, end)) continue;
    const gaps = gapsFor(/^[ \t]*/.exec(line)[0]);
    if (gaps.some((gap) => start <= gap.start && gap.end <= end)) {
      offenders.push(line.trim().slice(0, 60));
    }
  }
  return offenders;
}

const run = (code, maxWidth) => {
  const ast = parse(code);
  return applyEdits(
    code,
    format(new SourceCode({ text: code, ast }), { maxWidth }),
  );
};

test('a line pushed over by a trailing token outside every group is broken', () => {
  // Exactly one column over, with the overflow being the final `;` — a
  // token that belongs to no group. Selecting only groups that extend past
  // the overflow finds nothing here, and the line was silently left long.
  const head = '  const value = someCondition ? shortResult : ';
  const line = head + 'x'.repeat(80 - head.length) + ';';
  assert.equal(measureLine(line), 81, 'fixture must be one column over');

  const code = `function f() {\n${line}\n}\n`;
  const out = run(code, 80);
  assert.notEqual(out, code, 'the over-width line was left alone');
  assert.deepEqual(unbrokenWithCandidate(out, 80), []);
});

test('width compliance over a corpus', () => {
  const root = dirname(createRequire(import.meta.url).resolve('eslint'));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.js')) files.push(path);
    }
  };
  walk(root);

  let checked = 0;
  for (const file of files.filter((_, i) => i % 15 === 0).slice(0, 40)) {
    const code = readFileSync(file, 'utf8');
    if (!parse(code)) continue;
    checked++;
    const out = run(code, 80);
    const offenders = unbrokenWithCandidate(out, 80);
    assert.deepEqual(
      offenders,
      [],
      `${file}: over-width lines with a legal break remaining:\n  ${offenders.join('\n  ')}`,
    );
  }
  assert.ok(checked > 20, `only ${checked} files checked`);
});
