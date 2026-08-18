import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { test } from '@b9g/libuild/test';
import fold from '../src/index.js';

// Both hooks run their callback directly rather than opening a subtest.
// RuleTester nests `describe('valid')` inside `describe(ruleName)`, so mapping
// `describe` onto a test function produces a test inside a test: the outer
// callback returns before the inner one finishes and node cancels it, while
// bun refuses the nesting outright.
RuleTester.describe = (_name: string, fn: () => void) => fn();
RuleTester.it = (_name: string, fn: () => void) => fn();

const ruleTester = new RuleTester();
const breaks = fold.rules!.breaks!;

test('reports and fixes through the rule API', () => {
  ruleTester.run('breaks', breaks, {
    valid: [
      'const x = 1;',
      { code: 'const y = 2;', options: [{ maxWidth: 40 }] },
      // Exactly at the limit is valid.
      { code: `const a = '${'x'.repeat(24)}';`, options: [{ maxWidth: 40 }] },
      // An over-width line with no legal break position produces no report at
      // all, rather than an unfixable one.
      { code: `const s = '${'x'.repeat(100)}';` },
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

// Whatever syntax ESLint hands the rule, the rule handles: it declares no
// parser of its own.
test('runs under a TypeScript + JSX parser', () => {
  const tsJsx = {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  };

  ruleTester.run('breaks', breaks, {
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
