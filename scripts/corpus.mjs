/**
 * Shared plumbing for the corpus tools.
 *
 * The corpus is ten third-party repositories, deliberately spread across
 * formatters (Prettier, XO, hand-formatted), indent styles (tabs, two and
 * four spaces), print widths, and languages (JS, TS, JSX, TSX). They are not
 * vendored — `npm run corpus` clones them into `.corpus/`, which is
 * gitignored.
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CORPUS = process.env.CORPUS ?? join(ROOT, '.corpus');

export const REPOS = [
  'axios/axios',
  'colinhacks/zod',
  'date-fns/date-fns',
  'expressjs/express',
  'preactjs/preact',
  'pmndrs/zustand',
  'sindresorhus/ky',
  'sveltejs/svelte',
  'TanStack/query',
  'vuejs/core',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'lib', 'es', 'umd', 'esm',
  'coverage', 'fixtures', '__fixtures__', 'snapshots', '__snapshots__',
  'vendor', 'flow-typed', '.next', 'out', 'types',
]);

export const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  loc: true,
  range: true,
  tokens: true,
  comment: true,
  ecmaFeatures: { jsx: true },
  filePath: 'file.tsx',
};

export function requireCorpus() {
  if (!existsSync(CORPUS) || readdirSync(CORPUS).length === 0) {
    console.error(
      `No corpus at ${CORPUS}.\nRun \`npm run corpus\` first (clones ~10 repos, shallow).`,
    );
    process.exit(1);
  }
  return readdirSync(CORPUS)
    .filter((name) => statSync(join(CORPUS, name)).isDirectory())
    .sort();
}

/** Source files worth formatting: no builds, no bundled output, no .d.ts. */
export function sourceFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) sourceFiles(path, out, depth + 1);
    else if (
      /\.(m?[jt]sx?)$/.test(name) &&
      !/\.d\.ts$/.test(name) &&
      stat.size < 400000
    )
      out.push(path);
  }
  return out;
}

/** Every nth file, capped — enough coverage without a ten-minute run. */
export function sample(files, max) {
  const step = Math.max(1, Math.floor(files.length / max));
  return files.filter((_, i) => i % step === 0).slice(0, max);
}

/** The width the repository itself is formatted to, so churn means something. */
export function printWidth(dir) {
  const read = (name) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  for (const name of [
    '.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml',
    '.prettierrc.yml', '.prettierrc.js', '.prettierrc.mjs',
    'prettier.config.js', 'prettier.config.mjs', '.editorconfig',
  ]) {
    const text = read(name);
    const match = text?.match(/(?:printWidth|max_line_length)"?\s*[:=]\s*"?(\d+)/);
    if (match) return Number(match[1]);
  }
  const pkg = read('package.json');
  if (pkg) {
    const match = pkg.match(/"printWidth"\s*:\s*(\d+)/);
    if (match) return Number(match[1]);
    if (/"xo"\s*:/.test(pkg)) return 100; // XO formats at 100
  }
  return 80;
}

/** AST comparison that ignores position and survives BigInt literals. */
export const stripLocations = (node) =>
  JSON.stringify(node, (key, value) => {
    if (
      key === 'range' || key === 'loc' || key === 'start' ||
      key === 'end' || key === 'parent'
    )
      return undefined;
    return typeof value === 'bigint' ? `${value}n` : value;
  });
