import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import fold from '../src/index.js';

test('recommended config enables the rule with defaults', () => {
  const linter = new Linter();
  const code = `const wide = compute(${'a'.repeat(40)}, ${'b'.repeat(40)});\n`;
  const result = linter.verifyAndFix(code, [fold.configs.recommended], {
    filename: 'example.js',
  });
  assert.ok(result.fixed);
  assert.equal(
    result.output,
    `const wide = compute(\n  ${'a'.repeat(40)},\n  ${'b'.repeat(40)}\n);\n`,
  );
});

test('plugin exposes exactly one rule', () => {
  assert.deepEqual(Object.keys(fold.rules), ['breaks']);
});
