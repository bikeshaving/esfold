import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

test('short lines are untouched', () => {
  const code = 'const x = foo(a, b);\n';
  assert.equal(formatText(code, { maxWidth: 40 }), code);
});

test('over-width call breaks one argument per line', () => {
  const code = 'const result = computeThing(firstArgument, secondArgument);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const result = computeThing(\n' +
      '  firstArgument,\n' +
      '  secondArgument\n' +
      ');\n',
  );
});

test('outermost group breaks first (§4.1)', () => {
  const code = 'foo(bar(x, y), baz(a, b), qux(m, n));\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'foo(\n  bar(x, y),\n  baz(a, b),\n  qux(m, n)\n);\n',
  );
});

test('recurses into inner groups only when still too long', () => {
  const code = 'foo(bar(xxxxxxxxxxxxxxxxxxxxxxxxx, yyyyyyyyyyyyyyyyyyyyyyyy));\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'foo(\n' +
      '  bar(\n' +
      '    xxxxxxxxxxxxxxxxxxxxxxxxx,\n' +
      '    yyyyyyyyyyyyyyyyyyyyyyyy\n' +
      '  )\n' +
      ');\n',
  );
});

test('array literal breaks one element per line (§4.3)', () => {
  const code = 'const xs = [firstElement, secondElement, thirdElement];\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'const xs = [\n' +
      '  firstElement,\n' +
      '  secondElement,\n' +
      '  thirdElement\n' +
      '];\n',
  );
});

test('object literal breaks one property per line', () => {
  const code = 'const o = { alpha: 1, beta: 2, gamma: 3, delta: 4 };\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'const o = {\n  alpha: 1,\n  beta: 2,\n  gamma: 3,\n  delta: 4\n};\n',
  );
});

test('partially broken group is fully broken (all-or-nothing)', () => {
  const code = 'foo(aaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbb,\n  cccccccccccccccc);\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'foo(\n' +
      '  aaaaaaaaaaaaaaaa,\n' +
      '  bbbbbbbbbbbbbbbb,\n' +
      '  cccccccccccccccc\n' +
      ');\n',
  );
});

test('respects existing indentation as the base (§7)', () => {
  const code =
    'function wrapper() {\n' +
    '  const value = computeAll(argumentOne, argumentTwo);\n' +
    '}\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'function wrapper() {\n' +
      '  const value = computeAll(\n' +
      '    argumentOne,\n' +
      '    argumentTwo\n' +
      '  );\n' +
      '}\n',
  );
});

test('infers tab indentation', () => {
  const code =
    'function wrapper() {\n' +
    '\tconst value = computeAll(argumentOne, argumentTwo);\n' +
    '}\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'function wrapper() {\n' +
      '\tconst value = computeAll(\n' +
      '\t\targumentOne,\n' +
      '\t\targumentTwo\n' +
      '\t);\n' +
      '}\n',
  );
});

test('unbreakable long string is left entirely alone (§7.1)', () => {
  const code = `const s = '${'x'.repeat(100)}';\n`;
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('trailing comma group breaks after the trailing comma', () => {
  const code = 'const xs = [firstElement, secondElement, thirdElement,];\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'const xs = [\n' +
      '  firstElement,\n' +
      '  secondElement,\n' +
      '  thirdElement,\n' +
      '];\n',
  );
});

test('block comment in a gap moves with the following item', () => {
  const code = 'foo(firstArgument, /* why */ secondArgument, thirdArgument);\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'foo(\n' +
      '  firstArgument,\n' +
      '  /* why */ secondArgument,\n' +
      '  thirdArgument\n' +
      ');\n',
  );
});

test('new expression arguments break like call arguments', () => {
  const code = 'const it = new ThingBuilder(optionOne, optionTwo, optionThree);\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'const it = new ThingBuilder(\n' +
      '  optionOne,\n' +
      '  optionTwo,\n' +
      '  optionThree\n' +
      ');\n',
  );
});

test('parenthesized first argument does not confuse the open paren', () => {
  const code = 'foo((alpha + beta), gammaValueLong, deltaValueLong);\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'foo(\n' +
      '  (alpha + beta),\n' +
      '  gammaValueLong,\n' +
      '  deltaValueLong\n' +
      ');\n',
  );
});
