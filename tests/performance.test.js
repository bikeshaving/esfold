import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSourceCode } from './helpers.js';
import { format } from '../src/format.js';

/**
 * A guard against reintroducing a superlinear scan. The rule runs on every
 * file, up to MAX_AUTOFIX_PASSES times per `--fix`, so a quadratic addition
 * pass turns a large file into a multi-second editor stall.
 *
 * The size is chosen to separate two regimes rather than to measure absolute
 * speed. On this input (~190KB, one break needed per line): scanning every
 * candidate group per over-width line took ~4.9s; the gap index takes ~0.9s.
 * The threshold sits between them, leaving ~4x headroom for a slower machine
 * while still failing outright on a return to quadratic behavior.
 */
test('a large file where every line needs breaking stays fast', () => {
  let code = '';
  for (let i = 0; i < 2000; i++) {
    code += `const resultValue${i} = computeSomething(alphaArgumentName, betaArgumentName, gammaArgumentName);\n`;
  }
  const sourceCode = makeSourceCode(code);

  const started = Date.now();
  const edits = format(sourceCode, { maxWidth: 80 });
  const elapsed = Date.now() - started;

  assert.ok(edits.length > 2000, `expected many edits, got ${edits.length}`);
  assert.ok(elapsed < 4000, `took ${elapsed}ms — check for a quadratic scan`);
});
