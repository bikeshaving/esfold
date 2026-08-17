import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

/**
 * The break after an arrow's `=>` (§3.3 #15), and its interaction with
 * hugging. Which of the three shapes a call takes depends entirely on what
 * the arrow's body can do with a line of its own:
 *
 *   - a bracketed body keeps its bracket on the call line and breaks inside
 *   - a body that can break further takes the line after the `=>`
 *   - a body that can do neither stays put, and the call breaks instead
 *
 * When the arrow takes the line after the `=>`, the call's closing paren
 * goes on its own line too: the two breaks are one decision.
 */

test('a block body hugs; the brace stays on the call line', () => {
  assert.equal(
    formatText(
      'promise.then((response) => { transformTheResponse(response, opts); });\n',
      { maxWidth: 60 },
    ),
    'promise.then((response) => {\n' +
      '  transformTheResponse(response, opts);\n' +
      '});\n',
  );
});

test('an object body hugs', () => {
  assert.equal(
    formatText(
      'items.mapValues((item) => ({identifier: item.id, label: item.name}));\n',
      { maxWidth: 60 },
    ),
    'items.mapValues((item) => ({\n' +
      '  identifier: item.id,\n' +
      '  label: item.name\n' +
      '}));\n',
  );
});

test('a call body takes the break after the arrow', () => {
  assert.equal(
    formatText(
      'promise.then((response) => transformTheResponse(response, options, extra));\n',
      { maxWidth: 60 },
    ),
    'promise.then((response) =>\n' +
      '  transformTheResponse(response, options, extra)\n' +
      ');\n',
  );
});

test('a ternary body takes the break after the arrow', () => {
  assert.equal(
    formatText(
      'items.mapIt((item) => item.enabled ? item.longNameValue : fallbackXY);\n',
      { maxWidth: 60 },
    ),
    'items.mapIt((item) =>\n' +
      '  item.enabled ? item.longNameValue : fallbackXY\n' +
      ');\n',
  );
});

test('a member body has nowhere to put a break, so the call breaks', () => {
  // Breaking after the `=>` would only move the body to a line of its own
  // at the same width. Prettier draws this line in the same place.
  assert.equal(
    formatText(
      'promise.then((response) => response.data.attributes.values.longName);\n',
      { maxWidth: 60 },
    ),
    'promise.then(\n' +
      '  (response) => response.data.attributes.values.longName\n' +
      ');\n',
  );
});

test('a binary body likewise lets the call break', () => {
  assert.equal(
    formatText(
      'promise.then((response) => response.first + response.second + third);\n',
      { maxWidth: 60 },
    ),
    'promise.then(\n' +
      '  (response) => response.first + response.second + third\n' +
      ');\n',
  );
});

test('the arrow break is idempotent', () => {
  const code =
    'promise.then((response) => transformTheResponse(response, options, extra));\n';
  const once = formatText(code, { maxWidth: 60 });
  assert.equal(formatText(once, { maxWidth: 60 }), once);
});
