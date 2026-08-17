import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText, parse, stripLocations } from './helpers.js';

/**
 * Comments are where formatters go wrong: they are attached to no node, they
 * force breaks (line comments), and they sit inside the gaps Fold edits. So
 * rather than hand-pick cases, insert a comment at *every* token boundary of
 * several programs and assert the invariants hold each time — the AST is
 * preserved, the comment survives, and the result is idempotent.
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
  test(`comment at every token boundary of: ${base.slice(0, 40)}`, () => {
    const tokens = parse(base).tokens;
    for (const token of tokens) {
      for (const comment of COMMENTS) {
        const code =
          base.slice(0, token.range[0]) +
          comment.text +
          ' ' +
          base.slice(token.range[0]);

        let ast;
        try {
          ast = parse(code);
        } catch {
          continue; // comment placement made it unparseable; not our case
        }

        for (const maxWidth of [30, 80]) {
          const out = formatText(code, { maxWidth });

          assert.deepEqual(
            stripLocations(parse(out)),
            stripLocations(ast),
            `AST changed\n  in:  ${JSON.stringify(code)}\n  out: ${JSON.stringify(out)}`,
          );
          assert.ok(
            out.includes(comment.find),
            `comment lost\n  in:  ${JSON.stringify(code)}\n  out: ${JSON.stringify(out)}`,
          );
          assert.equal(
            formatText(out, { maxWidth }),
            out,
            `not idempotent\n  in: ${JSON.stringify(code)}`,
          );
        }
      }
    }
  });
}
