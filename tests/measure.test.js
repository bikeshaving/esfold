import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLine, TAB_WIDTH } from '../src/index.js';
import { inferIndentUnit } from '../src/index.js';

/**
 * `@stylistic/max-len`'s own `computeLineLength`, transcribed. §7.1's premise
 * is that a project running both rules never disagrees about which lines are
 * too long, so that agreement is asserted against the real algorithm rather
 * than against a re-derivation of what it ought to be.
 */
function maxLenLength(line, tabWidth = TAB_WIDTH) {
  let extraCharacterCount = 0;
  line.replace(/\t/gu, (_, offset) => {
    const totalOffset = offset + extraCharacterCount;
    const spaceCount = tabWidth - (tabWidth ? totalOffset % tabWidth : 0);
    extraCharacterCount += spaceCount - 1;
    return '';
  });
  return Array.from(line).length + extraCharacterCount;
}

test('measureLine agrees with max-len', () => {
  const samples = [
    '',
    'plain text',
    'ab\tc',
    '\t\tindented',
    'a\tb\tc\td',
    '\t',
    '    four spaces',
    '日\tb',
    '日本語テキスト',
    // Astral characters are where the two could diverge: the total counts
    // code points while the tab stop is computed from the UTF-16 offset.
    '😀',
    '😀\ta',
    '😀😀\tx',
    'a😀\tb',
    '\ta😀\t\tz',
    'x'.repeat(50) + '\ty',
  ];
  for (const sample of samples) {
    assert.equal(
      measureLine(sample),
      maxLenLength(sample),
      `disagreed on ${JSON.stringify(sample)}`,
    );
  }
});

test('a tab advances to the next two-column stop', () => {
  assert.equal(TAB_WIDTH, 2, 'matches Prettier’s default tabWidth');
  assert.equal(measureLine('\t'), 2);
  assert.equal(measureLine('a\t'), 2);
  assert.equal(measureLine('ab\t'), 4);
  assert.equal(measureLine('abc\t'), 4);
});

test('indent inference reads the file', () => {
  const unit = (lines) => inferIndentUnit(lines);
  assert.equal(unit(['function f() {', '  a;', '}']), '  ');
  assert.equal(unit(['function f() {', '    a;', '}']), '    ');
  assert.equal(unit(['function f() {', '\ta;', '}']), '\t');
  // No nesting to learn from.
  assert.equal(unit(['const a = 1;', 'const b = 2;']), '  ');
  assert.equal(unit([]), '  ');
});

test('a mixed tab/space delta is never taken as the indent unit', () => {
  // Continuation-line alignment produces deltas like '\t ' that are not a
  // nesting step; repeating one would emit exactly the mixture
  // `no-mixed-spaces-and-tabs` exists to flag.
  const unit = inferIndentUnit([
    'function f() {',
    '\t if (a) {',
    '\t\t  b;',
    '\t }',
    '}',
  ]);
  assert.ok(
    unit === '\t'.repeat(unit.length) || unit === ' '.repeat(unit.length),
    `indent unit ${JSON.stringify(unit)} mixes tabs and spaces`,
  );
});
