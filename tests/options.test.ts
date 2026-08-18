import { test, expect } from '@b9g/libuild/test';
import { fold } from './fold.js';

/**
 * `tabWidth` is the one measurement input Fold cannot read off the file. A
 * tab's width is a viewer preference, so a tab-indented file carries no
 * signal about it, and getting it wrong changes which lines are over width.
 */

// Three tabs then a call. At tabWidth 2 the indent costs 6 columns, at 4 it
// costs 12 — enough to put the same line either side of a 40-column limit.
const TABBED = '\t\t\tconst v = compute(alphaArg, betaArg);\n';

test('a line that fits at tabWidth 2 is left alone', () => {
  expect(fold(TABBED, { maxWidth: 46, tabWidth: 2 })).toBe(TABBED);
});

test('the same line breaks at tabWidth 4', () => {
  const out = fold(TABBED, { maxWidth: 46, tabWidth: 4 });
  expect(out).not.toBe(TABBED);
  expect(out).toContain('\n');
});

test('tabWidth defaults to 2', () => {
  expect(fold(TABBED, { maxWidth: 46 })).toBe(fold(TABBED, { maxWidth: 46, tabWidth: 2 }));
});

test('tabWidth does not affect space-indented files', () => {
  const spaced = '      const value = compute(alphaArgument, betaArgument);\n';
  expect(fold(spaced, { maxWidth: 46, tabWidth: 8 })).toBe(
    fold(spaced, { maxWidth: 46, tabWidth: 2 }),
  );
});

test('the inserted indent still comes from the file, not from tabWidth', () => {
  // Indent unit is inferred; tabWidth only measures. A tab-indented file gets
  // tab indents whatever width they are scored at.
  const code = 'function f() {\n\tconst v = compute(alphaArgument, betaArgument);\n}\n';
  const out = fold(code, { maxWidth: 30, tabWidth: 4 });
  expect(out).toContain('\n\t\talphaArgument');
});
