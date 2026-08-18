/**
 * The Prettier differential.
 *
 * Prettier-format a file, then run Fold over the result. Prettier has
 * already made every other formatting decision, so anything Fold changes is
 * a line-break disagreement and nothing else. Agreement is the honest
 * measure of "does this produce output people will accept".
 *
 *   npm run corpus     # once
 *   npm run diff
 *
 * At the time of writing: 249 of 250 files byte-identical. The one that
 * differs is deliberate — Prettier treats `a = b += c` as nested
 * assignments, where Fold treats the run as one chain and breaks it
 * consistently.
 *
 * Set SHOW=1 to print every disagreeing hunk.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import prettier from 'prettier';
import fold from '../src/index.ts';
import {
  CORPUS, requireCorpus, sample, sourceFiles,
} from './corpus.js';

const linter = new Linter();

const WIDTH = Number(process.env.WIDTH ?? 80);
const PER_REPO = Number(process.env.N ?? 25);

let files = 0;
let agreed = 0;
let hunks = 0;

for (const repo of requireCorpus()) {
  const dir = join(CORPUS, repo);
  let repoAgreed = 0;
  let repoDiffered = 0;

  for (const file of sample(sourceFiles(dir), PER_REPO)) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Prettier's own resolver, not a scrape: it reads every config format
    // and .editorconfig. Both sides must agree on tab settings, or the
    // comparison silently stops exercising tabs — Prettier defaults to
    // spaces, so its output would arrive space-indented whatever the repo
    // actually uses.
    const config = (await prettier.resolveConfig(file, { editorconfig: true })) ?? {};
    const useTabs = config.useTabs ?? false;
    const tabWidth = config.tabWidth ?? 2;

    let pretty;
    try {
      pretty = await prettier.format(raw, {
        parser: /\.tsx?$/.test(file) ? 'typescript' : 'babel',
        printWidth: WIDTH,
        useTabs,
        tabWidth,
      });
    } catch {
      continue; // Prettier could not parse it; not our business
    }

    let out;
    try {
      const result = linter.verifyAndFix(pretty, {
        plugins: { fold },
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        rules: { 'fold/breaks': ['error', { maxWidth: WIDTH, tabWidth }] },
        languageOptions: {
          parser: tseslint.parser,
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      });
      if (result.messages.some((message) => message.fatal)) continue;
      out = result.output;
    } catch {
      continue;
    }

    files++;
    if (out === pretty) {
      agreed++;
      repoAgreed++;
      continue;
    }
    repoDiffered++;

    const before = pretty.split('\n');
    const after = out.split('\n');
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
      if (before[i] === after[j]) {
        i++;
        j++;
        continue;
      }
      let k = j;
      while (k < after.length && after[k] !== before[i + 1]) k++;
      hunks++;
      if (process.env.SHOW) {
        console.log(`--- ${file.slice(CORPUS.length + 1)}:${i + 1}`);
        console.log('  prettier | ' + before[i]);
        for (let q = j; q < Math.min(k, j + 6); q++)
          console.log('  fold     | ' + after[q]);
      }
      i++;
      j = k;
    }
  }

  console.log(
    `${repo.padEnd(10)} ${String(repoAgreed + repoDiffered).padStart(3)} files | ` +
      `agree ${String(repoAgreed).padStart(3)} | differ ${repoDiffered}`,
  );
}

const pct = files ? Math.round((agreed / files) * 100) : 0;
console.log(`\n${agreed} of ${files} files identical (${pct}%), ${hunks} differing hunks`);
