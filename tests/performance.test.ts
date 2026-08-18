import { test, expect } from '@b9g/libuild/test';
import { fold } from './fold.js';

/**
 * A guard against reintroducing a superlinear scan. The rule runs on every
 * file, several times per `--fix`, so a quadratic addition pass turns a large
 * file into a multi-second editor stall.
 *
 * The size separates two regimes rather than measuring absolute speed: on
 * this input, scanning every candidate group per over-width line took ~4.9s
 * where the gap index takes well under one second.
 *
 * Timed as the best of several runs. Test files run in parallel and this one
 * shares a machine with the corpus suites, so a single timing measures
 * contention as much as complexity — the same work has read 5.6s under load
 * and 0.64s alone. A genuinely quadratic implementation cannot get under the
 * threshold on any of its attempts.
 */
test('a large file where every line needs breaking stays fast', () => {
  let code = '';
  for (let i = 0; i < 2000; i++) {
    code += `const resultValue${i} = computeSomething(alphaArgumentName, betaArgumentName, gammaArgumentName);\n`;
  }

  let best = Infinity;
  let output = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    output = fold(code, { maxWidth: 80 });
    best = Math.min(best, Date.now() - started);
  }

  expect(output).not.toBe(code);
  expect(best).toBeLessThan(8000);
});
