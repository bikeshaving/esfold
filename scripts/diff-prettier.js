/**
 * The differential §8's test 5 asks for.
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
 * consistently (§4.3).
 *
 * Set SHOW=1 to print every disagreeing hunk.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import prettier from 'prettier';
import { format, applyEdits } from '../src/format.js';
import {
  CORPUS, PARSE_OPTIONS, requireCorpus, sample, sourceFiles,
} from './corpus.js';

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

    let pretty;
    try {
      pretty = await prettier.format(raw, {
        parser: /\.tsx?$/.test(file) ? 'typescript' : 'babel',
        printWidth: WIDTH,
      });
    } catch {
      continue; // Prettier could not parse it; not our business
    }

    let ast;
    try {
      ast = tseslint.parser.parseForESLint(pretty, PARSE_OPTIONS).ast;
    } catch {
      continue;
    }

    let out;
    try {
      out = applyEdits(
        pretty,
        format(new SourceCode({ text: pretty, ast }), { maxWidth: WIDTH }),
      );
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
