import { test, expect } from '@b9g/libuild/test';
import { fold, parse } from './fold.js';
import { stripLocations } from './support.js';

/**
 * Comments attach to no node, force breaks when they are line comments, and
 * sit inside the very gaps this rule edits. Rather than hand-pick cases,
 * insert a comment at *every* token boundary of several programs and assert
 * the invariants at each one.
 */

const BASES = [
  'foo(alphaArgument, betaArgument, gammaArgument);',
  'const o = { alpha: 1, beta: 2, gamma: 3 };',
  'const v = alphaValue && betaValue || gammaValue;',
  'function f(alpha, beta) { return alpha + beta; }',
  'promise.then(a).catch(b).finally(c);',
  'if (alpha && beta) { doThing(); } else { other(); }',
  'const t = cond ? alphaValue : betaValue;',
  'for (let i = 0; i < n; i++) { body(i); }',
];

const COMMENTS = [
  { text: '/*c*/', find: '/*c*/' },
  { text: '/* multi\nline */', find: '/* multi' },
  { text: '//line\n', find: '//line' },
];

for (const base of BASES) {
  test(base, () => {
    const ast: any = parse(base);
    for (const token of ast.tokens) {
      for (const comment of COMMENTS) {
        const code =
          base.slice(0, token.range[0]) +
          comment.text +
          ' ' +
          base.slice(token.range[0]);

        // Some placements are simply not parseable; those are not our case.
        const before = parse(code);
        if (!before) continue;

        for (const maxWidth of [30, 80]) {
          const out = fold(code, { maxWidth });
          expect(stripLocations(parse(out))).toEqual(stripLocations(before));
          expect(out).toContain(comment.find);
          expect(fold(out, { maxWidth })).toBe(out);
        }
      }
    }
  });
}
