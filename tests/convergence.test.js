import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Linter } from 'eslint';
import stylistic from '@stylistic/eslint-plugin';
import fold from '../src/index.js';

/**
 * §8 test 3 (build-order step 7): run the real `--fix` loop with fold/breaks
 * enabled alongside a full @stylistic config, over a corpus, and assert it
 * converges — a second verifyAndFix produces zero further changes. This is
 * the test that validates §2.2: the rule doesn't need to be right in one
 * pass, it needs to settle.
 */

const CORPUS_ROOT = join(import.meta.dirname, '..', 'node_modules', 'eslint', 'lib', 'rules');
const MAX_FILES = 15;

const configFor = (indentOptions) => [
  {
    plugins: { fold, '@stylistic': stylistic },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    // The corpus is ESLint's own source, whose eslint-disable comments are
    // all "unused" under this config — ESLint's own autofix would strip
    // them, which is noise unrelated to what this test measures.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // 60, not 80. This corpus is tab-indented and already fits 80, so at
      // 80 Fold makes no edits at all and this test would verify only that
      // @stylistic converges with itself — which is not what it is for.
      'fold/breaks': ['error', { maxWidth: 60 }],
      '@stylistic/semi': 'error',
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/indent': ['error', ...indentOptions],
      '@stylistic/no-multiple-empty-lines': 'error',
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/no-trailing-spaces': 'error',
    },
  },
];

// The configs where indent inference and enforcement are most likely to
// diverge (§8 test 3): tabs, 4 spaces, and overrides.
const withRules = (config, rules) => [{ ...config[0], rules: { ...config[0].rules, ...rules } }];

const CONFIGS = {
  'two-space': configFor([2, { SwitchCase: 1 }]),
  'four-space-overrides': configFor([4, { SwitchCase: 1, MemberExpression: 1 }]),
  tabs: configFor(['tab']),
  // The one @stylistic rule that shares Fold's axis and gets enabled in the
  // wild: both sides must converge with it (§2.2 — Fold never fights an
  // existing break, whichever side the operator sits on).
  'operator-after': withRules(configFor([2]), {
    '@stylistic/operator-linebreak': ['error', 'after'],
  }),
  'operator-before': withRules(configFor([2]), {
    '@stylistic/operator-linebreak': ['error', 'before'],
  }),
  // The other two position rules on Fold's axis: dots and commas. Fold's
  // side-agnostic detection must converge with either setting.
  'dot-trailing': withRules(configFor([2]), {
    '@stylistic/dot-location': ['error', 'object'],
  }),
  'dot-leading': withRules(configFor([2]), {
    '@stylistic/dot-location': ['error', 'property'],
  }),
  'comma-first': withRules(configFor([2]), {
    '@stylistic/comma-style': ['error', 'first'],
    // comma-style "first" and comma-dangle "always-multiline" do not
    // converge with each other even with Fold absent — comma-dangle adds the
    // trailing comma, comma-style moves it to lead the brace, and they
    // disagree about the result forever. Not a pair Fold can fix, so don't
    // test against it.
    '@stylistic/comma-dangle': 'off',
  }),
  // Force-break rules: they add breaks, Fold respects them and completes the
  // group (§5). This is the payoff for never joining lines — it should
  // converge with no coordination code at all.
  'force-breaks': withRules(configFor([2]), {
    '@stylistic/array-element-newline': ['error', 'always'],
    '@stylistic/object-property-newline': 'error',
    '@stylistic/function-call-argument-newline': ['error', 'always'],
    '@stylistic/newline-per-chained-call': ['error', { ignoreChainWithDepth: 2 }],
    '@stylistic/multiline-ternary': ['error', 'always-multiline'],
  }),
};

const files = readdirSync(CORPUS_ROOT)
  .filter((name) => name.endsWith('.js'))
  .sort()
  .filter((_, i) => i % 20 === 0)
  .slice(0, MAX_FILES)
  .map((name) => join(CORPUS_ROOT, name))
  .filter((path) => statSync(path).isFile());

for (const [name, config] of Object.entries(CONFIGS)) {
  test(`--fix converges alongside @stylistic (${name})`, () => {
    const linter = new Linter();
    let exercised = 0;
    let changed = 0;
    let foldEdits = 0;
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      // A real path under node_modules would hit flat config's default
      // ignores and silently lint nothing — use a synthetic filename.
      const filename = `corpus-${files.indexOf(file)}.js`;
      foldEdits += linter
        .verify(code, config, { filename })
        .filter((m) => m.ruleId === 'fold/breaks').length;
      const first = linter.verifyAndFix(code, config, { filename });
      const fatal = first.messages.find((m) => m.fatal);
      if (fatal) continue; // unparseable under this config — not our concern
      exercised++;
      if (first.output !== code) changed++;
      const second = linter.verifyAndFix(first.output, config, {
        filename,
      });
      assert.equal(
        second.output,
        first.output,
        `did not converge under ${name}: ${file}`,
      );
    }
    assert.ok(exercised >= 10, `only ${exercised} files exercised`);
    assert.ok(changed > 0, 'the fix loop never changed anything');
    // Fold specifically must be doing work, not just @stylistic.
    assert.ok(
      foldEdits > 50,
      `fold contributed only ${foldEdits} reports — this corpus no longer ` +
        'exercises the rule, so convergence is not being tested',
    );
  });
}
