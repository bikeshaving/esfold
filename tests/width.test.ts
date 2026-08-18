import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { test, expect } from '@b9g/libuild/test';
import { fold, report, detectSourceType } from './fold.js';

/**
 * Width compliance: every output line fits, unless it has no legal break
 * position at all — and the exception is computed rather than tolerated. A
 * line that stayed long while a legal break sat on it is a bug.
 *
 * The rule reports an over-width line only when it can actually break it, so
 * asking it to re-examine its own output answers exactly that question: a
 * remaining report means a break was available and was not taken.
 */

const CORPUS_ROOT = dirname(createRequire(import.meta.url).resolve('eslint'));
const MAX_FILES = 40;

function collectFiles(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collectFiles(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

const all = collectFiles(CORPUS_ROOT);
const step = Math.max(1, Math.floor(all.length / MAX_FILES));
const files = all.filter((_, i) => i % step === 0).slice(0, MAX_FILES);

// Tabs advance to the next 2-column stop, matching the rule's own measure.
function width(line: string) {
  let columns = 0;
  for (const char of line) columns += char === '\t' ? 2 - (columns % 2) : 1;
  return columns;
}

test('no breakable line is left over width', () => {
  const maxWidth = 60;
  let checked = 0;
  let longLines = 0;
  const stuck: string[] = [];

  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    const sourceType = detectSourceType(code);
    if (!sourceType) continue;
    checked++;

    const folded = fold(code, { maxWidth, sourceType });
    longLines += folded
      .split('\n')
      .filter((line) => width(line) > maxWidth).length;

    for (const message of report(folded, { maxWidth, sourceType })) {
      stuck.push(`${file}:${message.line} ${message.messageId}`);
    }
  }

  expect(checked).toBeGreaterThan(20);
  // The corpus must actually contain unbreakable long lines, or this asserts
  // nothing: it would pass equally on a formatter that broke every line.
  expect(longLines).toBeGreaterThan(0);
  expect(stuck).toEqual([]);
});

test('a line pushed over by a trailing token outside every group is broken', () => {
  // The trailing `;` sits outside every break group, so a pass that measured
  // only group content considered this line short enough and skipped it.
  const code = `const value = compute(${'a'.repeat(30)}, ${'b'.repeat(30)});\n`;
  for (const line of fold(code, { maxWidth: 80 }).split('\n')) {
    expect(width(line)).toBeLessThanOrEqual(80);
  }
});
