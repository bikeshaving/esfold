import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { test, expect } from '@b9g/libuild/test';
import { fold, parse, detectSourceType } from './fold.js';
import { stripLocations } from './support.js';

// ESLint's own source, resolved through Node rather than by walking up from
// this file, so it is found the same way from a checkout and from an install.
const CORPUS_ROOT = dirname(createRequire(import.meta.url).resolve('eslint'));
const MAX_FILES = 120;

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

for (const maxWidth of [80, 60]) {
  test(`${files.length} files from eslint/lib at maxWidth ${maxWidth}`, () => {
    let formatted = 0;
    let changed = 0;

    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      const sourceType = detectSourceType(code);
      if (!sourceType) continue;

      const before = parse(code, { sourceType });
      const once = fold(code, { maxWidth, sourceType });
      formatted++;
      if (once !== code) changed++;

      expect(stripLocations(parse(once, { sourceType }))).toEqual(
        stripLocations(before),
      );
      expect(fold(once, { maxWidth, sourceType })).toBe(once);
    }

    expect(formatted).toBeGreaterThan(50);
    if (maxWidth === 60) expect(changed).toBeGreaterThan(10);
  });
}
