import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSourceCode } from './helpers.js';
import { format } from '../src/index.js';

/**
 * A guard against reintroducing a superlinear scan. The rule runs on every
 * file, up to MAX_AUTOFIX_PASSES times per `--fix`, so a quadratic addition
 * pass turns a large file into a multi-second editor stall.
 *
 * The size separates two regimes rather than measuring absolute speed. On
 * this input (~190KB, one break needed per line): scanning every candidate
 * group per over-width line took ~4.9s; the gap index takes well under 1s.
 *
 * Timed as the *best* of several runs, because `node --test` runs test files
 * in parallel and this one shares a machine with the corpus suites. A single
 * timing measures contention as much as complexity — it read 5.6s while the
 * same work took 0.64s alone. The minimum is the closest thing to an
 * uncontended sample, and a genuinely quadratic implementation cannot get
 * under the threshold on any of its attempts.
 */
test('a large file where every line needs breaking stays fast', () => {
  let code = '';
  for (let i = 0; i < 2000; i++) {
    code += `const resultValue${i} = computeSomething(alphaArgumentName, betaArgumentName, gammaArgumentName);\n`;
  }

  let best = Infinity;
  let edits = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    // A fresh SourceCode each time: format() caches inference per instance.
    const sourceCode = makeSourceCode(code);
    const started = Date.now();
    edits = format(sourceCode, { maxWidth: 80 });
    best = Math.min(best, Date.now() - started);
  }

  assert.ok(edits.length > 2000, `expected many edits, got ${edits.length}`);
  assert.ok(best < 4000, `best of 3 took ${best}ms — check for a quadratic scan`);
});
