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
  expect(fold(TABBED, { maxWidth: 46 })).toBe(
    fold(TABBED, { maxWidth: 46, tabWidth: 2 })
  );
});

// `join` decides whether a consistently broken group that would fit is
// pulled back onto one line. A partially broken group is joined either way.
const BROKEN = 'foo(\n  alpha,\n  beta,\n);\n';
const PARTIAL = 'foo(alpha,\n  beta);\n';

test('join defaults to off: a fully broken group that fits is kept', () => {
  expect(fold(BROKEN)).toBe(BROKEN);
  expect(fold(BROKEN)).toBe(fold(BROKEN, { join: false }));
});

test('join pulls a fully broken group that fits onto one line', () => {
  expect(fold(BROKEN, { join: true })).toBe('foo(alpha, beta);\n');
});

test('join leaves a fully broken group that does not fit', () => {
  expect(fold(BROKEN, { join: true, maxWidth: 12 })).toBe(BROKEN);
});

test('a partially broken group is joined with or without join', () => {
  expect(fold(PARTIAL)).toBe('foo(alpha, beta);\n');
  expect(fold(PARTIAL, { join: true })).toBe('foo(alpha, beta);\n');
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
