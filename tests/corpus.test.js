import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as espree from 'espree';
import { SourceCode } from 'eslint';
import { format, applyEdits } from '../src/format.js';
import { stripLocations } from './helpers.js';

/**
 * Corpus harness (§8 tests 1 and 2, build-order step 4). Runs the pure
 * format() over real-world code — ESLint's own source tree from
 * node_modules — and asserts:
 *
 *   1. Semantic preservation: input and output parse to identical ASTs
 *      (locations stripped). Catches every ASI hazard automatically.
 *   2. Idempotence: format(format(x)) === format(x). This is what makes the
 *      rule architecture legal (§2.2).
 */

const CORPUS_ROOT = join(import.meta.dirname, '..', 'node_modules', 'eslint', 'lib');
const MAX_FILES = 120;

function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collectFiles(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

function tryParse(code) {
  for (const sourceType of ['module', 'script']) {
    try {
      return espree.parse(code, {
        ecmaVersion: 'latest',
        sourceType,
        loc: true,
        range: true,
        tokens: true,
        comment: true,
      });
    } catch {
      // try the next sourceType
    }
  }
  return null;
}

const all = collectFiles(CORPUS_ROOT);
const step = Math.max(1, Math.floor(all.length / MAX_FILES));
const files = all.filter((_, i) => i % step === 0).slice(0, MAX_FILES);

function run(code) {
  const ast = tryParse(code);
  if (!ast) return null;
  const sourceCode = new SourceCode({ text: code, ast });
  return applyEdits(code, format(sourceCode, { maxWidth: 80 }));
}

test(`corpus: ${files.length} files from eslint/lib`, () => {
  let formatted = 0;
  let changed = 0;
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    if (!tryParse(code)) continue;

    let once;
    try {
      once = run(code);
    } catch (error) {
      assert.fail(`format threw on ${file}: ${error.stack}`);
    }
    formatted++;
    if (once !== code) changed++;

    // 1. Semantic preservation.
    assert.deepEqual(
      stripLocations(tryParse(once)),
      stripLocations(tryParse(code)),
      `AST changed for ${file}`,
    );

    // 2. Idempotence.
    const twice = run(once);
    assert.equal(twice, once, `not idempotent: ${file}`);
  }
  assert.ok(formatted > 50, `only ${formatted} corpus files parsed`);
  // The corpus must actually exercise the formatter.
  assert.ok(changed > 0, 'corpus produced no formatting changes at all');
});
