import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

// Consistency pass (§5): Fold never joins lines. A group the author broke
// stays broken; a partially broken group is completed to one item per line
// (§4.3, all-or-nothing).

test('a hand-broken group that would fit is left alone', () => {
  const code = 'foo(\n  alpha,\n  beta\n);\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('an FP pipeline keeps its deliberate layout', () => {
  const code =
    'const process = compose(\n' +
    '  parseInput,\n' +
    '  validate,\n' +
    '  transform,\n' +
    '  serialize\n' +
    ');\n';
  assert.equal(formatText(code, { maxWidth: 120 }), code);
});

test('a partially broken group is completed, not joined', () => {
  const code = 'foo(alpha,\n  beta, gamma);\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'foo(\n  alpha,\n  beta,\n  gamma\n);\n',
  );
});

test('a partially broken object literal is completed', () => {
  const code = 'const o = { alpha: 1,\n  beta: 2, gamma: 3 };\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'const o = {\n  alpha: 1,\n  beta: 2,\n  gamma: 3\n};\n',
  );
});

test('a partially broken operator chain is completed', () => {
  const code = 'const ok = alpha &&\n  beta && gamma;\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'const ok = alpha &&\n  beta &&\n  gamma;\n',
  );
});

test('a fully inline group that fits stays inline', () => {
  const code = 'foo(alpha, beta, gamma);\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a group with a blank line inside is frozen (§3.4)', () => {
  const code =
    'const options = {\n' +
    '  timeout: 5000, retries: 3,\n' +
    '\n' +
    '  cache: true,\n' +
    '};\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a group with a comment inside is frozen', () => {
  const code = 'foo(alpha, // why alpha\n  beta, gamma);\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a hugged call is not exploded by the consistency pass', () => {
  const code = "fetchData(url, {\n  method: 'GET',\n  cache: true\n});\n";
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a hand-broken block-body chain keeps its layout (§4.4)', () => {
  const code =
    'promise\n' +
    '  .then(() => {\n' +
    '    return x;\n' +
    '  })\n' +
    '  .catch(() => {\n' +
    '    return y;\n' +
    '  });\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('an author break at an out-of-scope position is preserved', () => {
  const code = 'const x =\n  foo(a, b);\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('completion respects the file operator side', () => {
  const code = 'const ok = alpha\n  && beta && gamma;\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'const ok = alpha\n  && beta\n  && gamma;\n',
  );
});
