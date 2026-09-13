import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@b9g/libuild/test';
import plugin from '../src/index.js';

// The plugin states its own version, and a bump that forgets it leaves every
// later release reporting an old one.
test('meta.version matches package.json', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(plugin.meta?.version).toBe(pkg.version);
});
