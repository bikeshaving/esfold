import { test } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { breaks } from '../src/index.js';

// Wire RuleTester into node:test.
//
// Both hooks run their callback directly rather than opening a subtest.
// RuleTester nests `describe('valid')` inside `describe(ruleName)`, so
// mapping `describe` onto `test` produces a `test()` inside a `test()` — the
// outer callback returns before the inner one finishes and node cancels it
// ("test did not finish before its parent"). It survived on node 22+ with
// eslint 10 and failed everywhere else. Running synchronously inside a single
// enclosing test sidesteps the nesting entirely, and is what ESLint documents
// for frameworks that do not supply these globals.
RuleTester.describe = (_name, fn) => fn();
RuleTester.it = (_name, fn) => fn();

const ruleTester = new RuleTester();

test('breaks (default parser)', () => {
  ruleTester.run('breaks (default parser)', breaks, {
    valid: [
      'const x = 1;',
      { code: 'const y = 2;', options: [{ maxWidth: 40 }] },
      // Exactly at the limit is valid.
      { code: `const a = '${'x'.repeat(24)}';`, options: [{ maxWidth: 40 }] },
      // Unbreakable over-width lines are left entirely alone (§7.1): a long
      // string literal has no legal break position, so no report at all.
      {
        code: `const s = '${'x'.repeat(100)}';`,
      },
    ],
    invalid: [
      {
        code: 'const r = computeThing(firstArgument, secondArgument);',
        options: [{ maxWidth: 40 }],
        output:
          'const r = computeThing(\n' +
          '  firstArgument,\n' +
          '  secondArgument\n' +
          ');',
        errors: [
          { messageId: 'overWidth', line: 1, column: 24 },
          { messageId: 'overWidth', line: 1, column: 39 },
          { messageId: 'overWidth', line: 1, column: 53 },
        ],
      },
    ],
  });
});

// Syntax parity (§2.4): whatever syntax ESLint handles, Fold handles. Prove
// the rule runs under a TS + JSX parser without any parser dependency of our
// own.
const tsJsx = {
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
};

test('breaks (typescript-eslint parser, JSX)', () => {
  ruleTester.run('breaks (typescript-eslint parser, JSX)', breaks, {
    valid: [
      {
        code: 'type T = { a: number };\nconst el = <div className="ok" />;',
        ...tsJsx,
      },
      {
        code: 'enum E { A, B }\nfunction f<T extends object>(x: T): T {\n  return x;\n}',
        ...tsJsx,
      },
    ],
    invalid: [],
  });
});
