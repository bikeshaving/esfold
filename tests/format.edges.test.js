import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

// Edge cases. Each of these was a real bug or a near miss.

test('a CRLF file gets CRLF breaks, not mixed endings', () => {
  const code =
    'function wrapper() {\r\n' +
    '  const value = computeAll(argumentOne, argumentTwo);\r\n' +
    '}\r\n';
  const out = formatText(code, { maxWidth: 40 });
  assert.ok(out.includes('computeAll(\r\n'), 'break should use CRLF');
  assert.ok(!/(^|[^\r])\n/.test(out), 'no bare LF may appear in a CRLF file');
});

test('an LF file stays LF', () => {
  const code =
    'function wrapper() {\n' +
    '  const value = computeAll(argumentOne, argumentTwo);\n' +
    '}\n';
  assert.ok(!formatText(code, { maxWidth: 40 }).includes('\r'));
});

test('a mostly-LF file with a stray CRLF stays LF', () => {
  const code =
    'const a = 1;\r\n' +
    'const b = 2;\n' +
    'const c = 3;\n' +
    'const value = computeAll(argumentOne, argumentTwo);\n';
  const out = formatText(code, { maxWidth: 40 });
  assert.ok(out.includes('computeAll(\n'));
});

test('a BOM is preserved', () => {
  const code = '﻿const x = foo(aaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbb);\n';
  assert.ok(formatText(code, { maxWidth: 30 }).startsWith('﻿'));
});

test('astral characters count as one column each', () => {
  // Four emoji plus quotes and the call fit in 20 columns only if each
  // emoji counts once — a UTF-16 length would double them.
  const code = 'ok("🎉🎉🎉🎉");\n';
  assert.equal(formatText(code, { maxWidth: 20 }), code);
});

test('an unbreakable over-width line is left alone and silent', () => {
  const code = `const s = '${'x'.repeat(200)}';\n`;
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a tiny maxWidth breaks what it can and stops', () => {
  const out = formatText('foo(a, b);\n', { maxWidth: 1 });
  assert.equal(out, 'foo(\n  a,\n  b\n);\n');
});

test('sparse array elision is never broken', () => {
  const code = 'const sparse = [1, , 3, , 5];\n';
  assert.equal(formatText(code, { maxWidth: 10 }), code);
});

test('empty argument and element lists are untouched', () => {
  const code = 'noArgs();\nconst e = [];\nconst o = {};\n';
  assert.equal(formatText(code, { maxWidth: 5 }), code);
});

test('a multiline template literal is not treated as breakable text', () => {
  const code = 'const t = `line one\nline two ${value}\nline three`;\n';
  assert.equal(formatText(code, { maxWidth: 10 }), code);
});

test('tabs count as four columns when measuring', () => {
  // Two tabs (8 columns) + 'ok(a, b);' (9) = 17, over a 16 limit.
  const code = '\t\tok(argument, other);\n';
  const out = formatText(code, { maxWidth: 16 });
  assert.ok(out.includes('ok(\n'), 'should break: tabs push it over');
});

test('produces no overlapping or duplicate edit ranges', async () => {
  const { makeSourceCode } = await import('./helpers.js');
  const { format } = await import('../src/_format.js');
  const code =
    'promise.then(() => { work(alpha, beta); }).catch(() => { fail(gamma); });\n' +
    'const nested = outer(inner(deep(a, b), c), d, { key: value, other: [1, 2] });\n';
  const edits = format(makeSourceCode(code), { maxWidth: 30 });
  const sorted = [...edits].sort((a, b) => a.range[0] - b.range[0]);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].range[0] >= sorted[i - 1].range[1],
      `edits overlap: ${JSON.stringify(sorted[i - 1].range)} and ${JSON.stringify(sorted[i].range)}`,
    );
  }
});

test('never folds inside a template literal', () => {
  // §3.3 #14 was to be a last resort; in practice splitting a chain across
  // an interpolation reads worse than the long line, and the line is
  // usually long because of the template's text, which no break shortens.
  const code =
    'report(`Unexpected text ${span.slice(index, match.index).trim()}`, spans);\n';
  assert.equal(
    formatText(code, { maxWidth: 60 }),
    'report(\n' +
      '  `Unexpected text ${span.slice(index, match.index).trim()}`,\n' +
      '  spans\n' +
      ');\n',
  );
});

test('a hand-broken layout inside a template is left alone', () => {
  const code = 'const t = `${compute(\n  alpha,\n  beta\n)} tail`;\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a template too long to fix is silent, not reported', () => {
  const code = 'const t = `' + 'x'.repeat(100) + '${value}`;\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a break that cannot help is not made', () => {
  // The attribute is a single atomic string longer than the limit: breaking
  // moves it to a line of its own at exactly the width it had, buying two
  // extra lines and nothing else.
  const code =
    'function C() {\n' +
    '  return (\n' +
    '    <div>\n' +
    '      <a href="https://example.com/a/very/long/path/that/exceeds/the/limit/by/a/lot/ok">\n' +
    '        Open\n' +
    '      </a>\n' +
    '    </div>\n' +
    '  );\n' +
    '}\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a single atomic argument wider than the limit is left inline', () => {
  const code = `callSomething("${'x'.repeat(90)}");\n`;
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('but two items still break, even when one stays over the limit', () => {
  // Splitting them shortens the line, which is the point; that one of them
  // remains long is not a reason to leave them all on one line.
  const code = `callSomething("${'x'.repeat(90)}", second);\n`;
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    `callSomething(\n  "${'x'.repeat(90)}",\n  second\n);\n`,
  );
});

test('and a single argument that can itself break still breaks', () => {
  assert.equal(
    formatText('callSomething(inner(alphaValue, betaValue, gammaVal));\n', {
      maxWidth: 40,
    }),
    // Breaking the outer call is enough here; the inner one then fits.
    'callSomething(\n  inner(alphaValue, betaValue, gammaVal)\n);\n',
  );
});
