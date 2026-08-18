import { Linter } from 'eslint';
import { test, expect } from '@b9g/libuild/test';
import fold from '../src/index.js';

test('the plugin registers and fixes under a flat config', () => {
  const linter = new Linter();
  const code = `const wide = compute(${'a'.repeat(40)}, ${'b'.repeat(40)});\n`;
  const result = linter.verifyAndFix(
    code,
    { plugins: { esfold: fold }, rules: { 'esfold/breaks': 'error' } },
    { filename: 'example.js' },
  );

  expect(result.fixed).toBe(true);
  expect(result.output).toBe(
    `const wide = compute(\n  ${'a'.repeat(40)},\n  ${'b'.repeat(40)}\n);\n`,
  );
});

test('the plugin exposes exactly one rule and no presets', () => {
  expect(Object.keys(fold.rules ?? {})).toEqual(['breaks']);
  expect(fold.configs).toBeUndefined();
});
