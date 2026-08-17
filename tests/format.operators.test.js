import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

test('breaks at || before touching && (§4.2)', () => {
  const code =
    'const check = condition1 && condition2 || condition3 && condition4;\n';
  assert.equal(
    formatText(code, { maxWidth: 50 }),
    'const check = condition1 && condition2 ||\n' +
      '  condition3 && condition4;\n',
  );
});

test('descends to the next precedence level only when still too long', () => {
  const code =
    'const check = firstLongCondition && secondLongCondition || ' +
    'thirdLongCondition && fourthLongCondition;\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    // Every operand sits at the same depth: a chain that already begins a
    // continuation line does not step in again.
    'const check = firstLongCondition &&\n' +
      '  secondLongCondition ||\n' +
      '  thirdLongCondition &&\n' +
      '  fourthLongCondition;\n',
  );
});

test('equal-precedence run breaks at every operator', () => {
  const code = 'const all = alphaCondition || betaCondition || gammaCondition;\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'const all = alphaCondition ||\n' +
      '  betaCondition ||\n' +
      '  gammaCondition;\n',
  );
});

test('additive splits before multiplicative descends', () => {
  const code = 'const total = firstFactor * secondFactor + thirdFactor * fourthFactor;\n';
  // The additive break comes first; the multiplicative one follows only
  // because the head line is *still* over width afterwards (§4.2 descends
  // one precedence level at a time, and only while too long).
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const total = firstFactor *\n' +
      '  secondFactor +\n' +
      '  thirdFactor * fourthFactor;\n',
  );
  // With room for the additive break alone, arithmetic stays intact.
  assert.equal(
    formatText(code, { maxWidth: 45 }),
    'const total = firstFactor * secondFactor +\n' +
      '  thirdFactor * fourthFactor;\n',
  );
});

test('operator chain is preferred over an inner call group (outermost first)', () => {
  const code = 'const ok = validate(inputData) && sanitize(inputData, options);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const ok = validate(inputData) &&\n  sanitize(inputData, options);\n',
  );
});

test('assignment chain breaks at the =s (§4.2)', () => {
  const code =
    'firstTarget = secondTarget = thirdTarget = someSharedDefaultValue;\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'firstTarget =\n  secondTarget =\n  thirdTarget =\n  someSharedDefaultValue;\n',
  );
});

test('a lone assignment is not a break candidate — the RHS breaks instead', () => {
  const code = 'target = computeSomething(firstArgument, secondArgument);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'target = computeSomething(\n  firstArgument,\n  secondArgument\n);\n',
  );
});

test('parenthesized operand stops the chain', () => {
  const code =
    'const v = (alphaCondition || betaCondition) && (gammaCondition || deltaCondition);\n';
  assert.equal(
    formatText(code, { maxWidth: 50 }),
    'const v = (alphaCondition || betaCondition) &&\n' +
      '  (gammaCondition || deltaCondition);\n',
  );
});

// The §3.2 table itself is tested in forbidden.test.js.

// Operator-break side (§4.2 + convergence): inferred from the file like the
// indent unit, 'after' fallback; a break on either side counts as broken.

test('fallback with no signal is break-after', () => {
  const code = 'const all = alphaCondition || betaCondition || gammaCondition;\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'const all = alphaCondition ||\n  betaCondition ||\n  gammaCondition;\n',
  );
});

test('a file that already breaks before operators keeps that side', () => {
  const code =
    'const existing = someCondition\n' +
    '  && otherCondition;\n' +
    'const all = alphaCondition || betaCondition || gammaCondition;\n';
  assert.equal(
    formatText(code, { maxWidth: 30 }),
    'const existing = someCondition\n' +
      '  && otherCondition;\n' +
      'const all = alphaCondition\n' +
      '  || betaCondition\n' +
      '  || gammaCondition;\n',
  );
});

test('an existing break on the non-preferred side is left alone', () => {
  // Break-before layout in an after-preferring file: side-agnostic
  // detection sees it as broken and does not double-break or move it.
  const code =
    'const check = someVeryLongConditionName\n' +
    '  && anotherVeryLongConditionName;\n';
  assert.equal(formatText(code, { maxWidth: 40 }), code);
});

test('an existing break is preserved on whichever side holds it', () => {
  const brokenBefore = 'const ok = alpha\n  && beta;\n';
  const brokenAfter = 'const ok = alpha &&\n  beta;\n';
  assert.equal(formatText(brokenBefore, { maxWidth: 80 }), brokenBefore);
  assert.equal(formatText(brokenAfter, { maxWidth: 80 }), brokenAfter);
});

// Same side-agnostic treatment for the other position rules on Fold's axis:
// @stylistic/comma-style "first" and @stylistic/dot-location "object".

test('comma-first breaks are never re-broken or moved', () => {
  // The leading-comma newlines count as broken, so Fold neither adds a
  // second break at each comma nor moves the existing ones. The bracket
  // gaps are still unbroken, so §4.3 completes them — consistency, not a
  // relocation of the author's breaks.
  const wide =
    'computeAll(firstLongArgument\n' +
    '  , secondLongArgument\n' +
    '  , thirdLongArgument);\n';
  assert.equal(
    formatText(wide, { maxWidth: 30 }),
    'computeAll(\n' +
      '  firstLongArgument\n' +
      '  , secondLongArgument\n' +
      '  , thirdLongArgument\n' +
      ');\n',
  );
});

test('a comma-first group with a dangling comma is already consistent', () => {
  // `,}` is comma-style "first"'s own output for a trailing comma: the
  // close break sits before the comma, so the group reads as fully broken
  // and Fold leaves it exactly alone.
  const code = 'const o = {\n  a: 1\n  ,b: 2\n  ,};\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('trailing-dot chain counts as broken — never re-broken or moved', () => {
  const wide =
    'const out = collection.\n' +
    '  filter(isActive).\n' +
    '  map(toName).\n' +
    '  join(separator);\n';
  assert.equal(formatText(wide, { maxWidth: 40 }), wide);
  const narrow = 'const out = xs.\n  filter(f).\n  map(g);\n';
  assert.equal(formatText(narrow, { maxWidth: 80 }), narrow);
});
