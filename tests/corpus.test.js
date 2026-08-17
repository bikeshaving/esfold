import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import * as espree from 'espree';
import { SourceCode } from 'eslint';
import { format, applyEdits } from '../src/index.js';
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

// ESLint's own source, resolved by asking Node where the package is
// rather than guessing at node_modules' position. Its entry point lives
// inside lib/, so this is the corpus directory exactly — and it stays
// correct under bundling, a different cwd, or a hoisted install.
const CORPUS_ROOT = dirname(createRequire(import.meta.url).resolve('eslint'));
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

function run(code, maxWidth) {
  const ast = tryParse(code);
  if (!ast) return null;
  const sourceCode = new SourceCode({ text: code, ast });
  return applyEdits(code, format(sourceCode, { maxWidth }));
}

// Two widths. 80 is the realistic setting, and this corpus is already
// formatted to it — at 60 the same files need hundreds of breaks, which is
// what makes the "did anything happen" guard below meaningful.
for (const maxWidth of [80, 60]) {
  test(`corpus: ${files.length} files from eslint/lib at maxWidth ${maxWidth}`, () => {
    let formatted = 0;
    let changed = 0;
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      if (!tryParse(code)) continue;

      let once;
      try {
        once = run(code, maxWidth);
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
      const twice = run(once, maxWidth);
      assert.equal(twice, once, `not idempotent: ${file}`);
    }
    assert.ok(formatted > 50, `only ${formatted} corpus files parsed`);
    // Guard against Fold quietly becoming a no-op.
    if (maxWidth === 60) {
      assert.ok(changed > 10, `only ${changed} files changed at width 60`);
    }
  });
}
