import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@b9g/libuild/test';
import { fold } from './fold.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// `<name>.w40.ts` formats at width 40; a missing `.wN` means the default 80.
// The width belongs in the filename rather than in the file so that fixtures
// stay parseable source — a pragma comment would itself be input to the
// formatter and could change the result it is meant to pin down.
function parseName(file: string) {
  const match = /^(.*?)(?:\.w(\d+))?\.(m?[jt]sx?)$/.exec(file);
  if (!match) throw new Error(`unparseable fixture name: ${file}`);
  const [, name, width, ext] = match;
  return { name, maxWidth: width ? Number(width) : 80, ts: ext.startsWith('t') };
}

for (const category of readdirSync(FIXTURES).sort()) {
  const files = readdirSync(join(FIXTURES, category)).sort();

  describe(category, () => {
    for (const file of files) {
      const { name, maxWidth, ts } = parseName(file);
      test(name, () => {
        const source = readFileSync(join(FIXTURES, category, file), 'utf8');
        expect(fold(source, { maxWidth, ts })).toMatchSnapshot();
      });
    }
  });
}
