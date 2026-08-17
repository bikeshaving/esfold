import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

/**
 * No staircases. A group with no bracket of its own — an operator chain, a
 * ternary — takes its nesting level from the line it begins. When that line
 * is already a continuation, stepping in again would leave the group's first
 * part one level shallower than the rest, which is the staircase.
 *
 * A bracket-less group that begins a *statement* is the exception: nothing
 * has indented it yet, so its continuation lines do step in.
 */

test('a chain in an argument aligns its operands', () => {
  assert.equal(
    formatText('call(alphaCondition && betaCondition && gammaCondition);\n', {
      maxWidth: 30,
    }),
    'call(\n' +
      '  alphaCondition &&\n' +
      '  betaCondition &&\n' +
      '  gammaCondition\n' +
      ');\n',
  );
});

test('a chain in a condition aligns its operands', () => {
  assert.equal(
    formatText('if (firstCondition && secondCondition && third) {\n  a();\n}\n', {
      maxWidth: 30,
    }),
    'if (\n' +
      '  firstCondition &&\n' +
      '  secondCondition &&\n' +
      '  third\n' +
      ') {\n' +
      '  a();\n' +
      '}\n',
  );
});

test('a ternary in an argument aligns its branches', () => {
  assert.equal(
    formatText('call(someCondition ? alphaResultValue : betaResultValue);\n', {
      maxWidth: 30,
    }),
    'call(\n' +
      '  someCondition\n' +
      '  ? alphaResultValue\n' +
      '  : betaResultValue\n' +
      ');\n',
  );
});

test('ternaries chained through the alternate share one level', () => {
  // `a ? b : c ? d : e` is one construct. Indenting each nested alternate
  // produces a staircase that gets deeper with every branch.
  const code =
    'const name = typeof tag === "function" ? tag.name : ' +
    'typeof tag === "string" ? tag : String(tag);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const name = typeof tag === "function"\n' +
      '  ? tag.name\n' +
      '  : typeof tag === "string"\n' +
      '  ? tag\n' +
      '  : String(tag);\n',
  );
});

test('a chain that begins a statement still indents its continuation', () => {
  assert.equal(
    formatText(
      'firstTarget = secondTarget = thirdTarget = someSharedDefault;\n',
      { maxWidth: 30 },
    ),
    'firstTarget =\n' +
      '  secondTarget =\n' +
      '  thirdTarget =\n' +
      '  someSharedDefault;\n',
  );
});

test('a ternary that begins a statement still indents its branches', () => {
  assert.equal(
    formatText('const label = isEnabled ? enabledLabel : disabledLabel;\n', {
      maxWidth: 30,
    }),
    'const label = isEnabled\n  ? enabledLabel\n  : disabledLabel;\n',
  );
});

test('bracketed groups still nest normally', () => {
  // The rule is about groups with no bracket; brackets keep their level.
  assert.equal(
    formatText('outer(inner(alphaValue, betaValue), gammaValue);\n', {
      maxWidth: 20,
    }),
    'outer(\n' +
      '  inner(\n' +
      '    alphaValue,\n' +
      '    betaValue\n' +
      '  ),\n' +
      '  gammaValue\n' +
      ');\n',
  );
});
