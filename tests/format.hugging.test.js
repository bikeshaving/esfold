import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

// Hugging (§4.5).

test('last-position options object hugs', () => {
  const code =
    "fetchData(requestUrl, { method: 'GET', cache: true, retries: 3 });\n";
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'fetchData(requestUrl, {\n' +
      "  method: 'GET',\n" +
      '  cache: true,\n' +
      '  retries: 3\n' +
      '});\n',
  );
});

test('first-position data array hugs, tail stays on the closing line', () => {
  const code = 'map([veryLongElement1, veryLongElement2, veryLongElement3], transformFn);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'map([\n' +
      '  veryLongElement1,\n' +
      '  veryLongElement2,\n' +
      '  veryLongElement3\n' +
      '], transformFn);\n',
  );
});

test('single complex argument never breaks at the call level', () => {
  const code = 'processData({ field1: value1, field2: value2, field3: value3 });\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'processData({\n' +
      '  field1: value1,\n' +
      '  field2: value2,\n' +
      '  field3: value3\n' +
      '});\n',
  );
});

test('two huggable arguments disables hugging — the call breaks normally', () => {
  const code = 'merge({ alpha: 1, beta: 2 }, { gamma: 3, delta: 4 });\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'merge(\n' +
      '  { alpha: 1, beta: 2 },\n' +
      '  { gamma: 3, delta: 4 }\n' +
      ');\n',
  );
});

test('huggable argument in middle position disables hugging', () => {
  const code = 'configure(first, { alpha: 1, beta: 2 }, lastArgument);\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'configure(\n' +
      '  first,\n' +
      '  { alpha: 1, beta: 2 },\n' +
      '  lastArgument\n' +
      ');\n',
  );
});

test('an author-broken un-hugged form is preserved (§5, never joined)', () => {
  // §4.5 describes what Fold *produces* when it breaks a call, not a layout
  // it imposes on one the author already broke.
  const code =
    'fetchData(\n' +
    '  url,\n' +
    "  { method: 'GET', cache: true }\n" +
    ');\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('call-level breaks around a block-bodied hug argument are preserved', () => {
  const code =
    'runTask(\n' +
    '  taskName,\n' +
    '  () => {\n' +
    '    execute();\n' +
    '  }\n' +
    ');\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('an expression-bodied arrow does not hug', () => {
  // §4.5 hugs an argument "with its own internal structure" — that is what
  // absorbs the break. A bare expression body has none, and hugging one only
  // takes the call level off the table, leaving the arrow's parameter list
  // as the next candidate.
  assert.equal(
    formatText(
      'const p = new Promise((resolve) => (r.onstop = () => resolve(undefined)));\n',
      { maxWidth: 60 },
    ),
    'const p = new Promise(\n' +
      '  (resolve) => (r.onstop = () => resolve(undefined))\n' +
      ');\n',
  );
});

test('an object-bodied arrow still hugs', () => {
  assert.equal(
    formatText('items.map((item) => ({identifier: item.id, label: item.name}));\n', {
      maxWidth: 40,
    }),
    'items.map((item) => ({\n' +
      '  identifier: item.id,\n' +
      '  label: item.name\n' +
      '}));\n',
  );
});
