/**
 * Clone the differential corpus. Shallow, ~10 repositories, a few hundred MB.
 * Idempotent: existing clones are left alone.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CORPUS, REPOS } from './corpus.js';

mkdirSync(CORPUS, { recursive: true });

for (const repo of REPOS) {
  const dir = join(CORPUS, basename(repo));
  if (existsSync(dir)) {
    console.log(`${basename(repo).padEnd(10)} already present`);
    continue;
  }
  process.stdout.write(`${basename(repo).padEnd(10)} cloning… `);
  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--quiet', `https://github.com/${repo}.git`, dir],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    console.log('ok');
  } catch (error) {
    console.log(`failed: ${String(error.stderr ?? error).trim().slice(0, 80)}`);
  }
}

console.log(`\nCorpus at ${CORPUS}`);
