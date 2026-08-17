import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

// §4.4 signature behavior, its own test file (build-order step 6).

test('chain without block bodies breaks before every dot', () => {
  const code =
    'const out = collection.filter(isActive).map(toName).join(separator);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const out = collection\n' +
      '  .filter(isActive)\n' +
      '  .map(toName)\n' +
      '  .join(separator);\n',
  );
});

test('chain containing block bodies is not broken at the chain level (§4.4)', () => {
  const code =
    'promise.then(() => { return x; }).catch(() => { return y; });\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'promise.then(() => {\n' +
      '  return x;\n' +
      '}).catch(() => {\n' +
      '  return y;\n' +
      '});\n',
  );
});

test('already-formatted block-body chain is stable', () => {
  const code =
    'promise.then(() => {\n' +
    '  return x;\n' +
    '}).catch(() => {\n' +
    '  return y;\n' +
    '});\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('single method call is not a chain — arguments break instead', () => {
  const code = 'const v = registry.lookup(firstArgument, secondArgument);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const v = registry.lookup(\n' +
      '  firstArgument,\n' +
      '  secondArgument\n' +
      ');\n',
  );
});

test('chain break is preferred over breaking the last call arguments', () => {
  const code = 'const n = builder.withOne(alpha).withTwo(beta, gamma);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const n = builder\n' +
      '  .withOne(alpha)\n' +
      '  .withTwo(beta, gamma);\n',
  );
});

test('optional chaining breaks before the ?.', () => {
  const code = 'const r = maybeThing?.first(alpha)?.second(beta)?.third(gamma);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const r = maybeThing\n' +
      '  ?.first(alpha)\n' +
      '  ?.second(beta)\n' +
      '  ?.third(gamma);\n',
  );
});

test('a parenthesized chain head is one unit, never broken inside', () => {
  // The dots inside the parens sit at a different bracket depth than the
  // chain's own dots; breaking there splits a unit across the chain
  // indentation.
  const code =
    'const result = (alphaValue.betaProperty.gammaThing).deltaMethod().epsilonMethod();\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const result = (alphaValue.betaProperty.gammaThing)\n' +
      '  .deltaMethod()\n' +
      '  .epsilonMethod();\n',
  );
});

test('a parenthesized sub-chain can still break on its own', () => {
  const code = 'const r = (first.second).third();\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

// Necessary breaks (§3.1) — implemented with step 6 because §4.4's shape
// depends on block bodies always being multi-line.

test('one-liner block bodies are always exploded (§3.1)', () => {
  const code = 'function f() { doFirst(); doSecond(); }\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'function f() {\n  doFirst();\n  doSecond();\n}\n',
  );
});

test('empty block stays inline', () => {
  const code = 'function f() {}\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('two statements on one line are separated', () => {
  const code = 'doFirst(); doSecond();\n';
  assert.equal(formatText(code, { maxWidth: 80 }), 'doFirst();\ndoSecond();\n');
});

test('switch cases land on their own lines', () => {
  const code = 'switch (kind) { case 1: handleOne(); break; default: fallback(); }\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'switch (kind) {\n' +
      '  case 1:\n' +
      '    handleOne();\n' +
      '    break;\n' +
      '  default:\n' +
      '    fallback();\n' +
      '}\n',
  );
});

test('a braced case keeps its brace on the case line', () => {
  // Same rule as a function body: the block's own breaks supply the
  // structure, so `case X: {` does not split.
  const code =
    'switch (kind) {\n  case A: {\n    handle();\n    break;\n  }\n}\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
  assert.equal(
    formatText('switch (kind) { case A: { handle(); break; } }\n', {
      maxWidth: 80,
    }),
    code,
  );
});

test('class body members land on their own lines', () => {
  const code = 'class Thing { getA() { return 1; } }\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'class Thing {\n  getA() {\n    return 1;\n  }\n}\n',
  );
});

test('trailing line comment already separates statements', () => {
  const code = 'doFirst(); // note\ndoSecond();\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});
