import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as espree from 'espree';
import { makeSourceCode, parse, stripLocations } from './helpers.js';
import { isForbiddenBreak } from '../src/forbidden.js';

// §3.2. A false negative here is a correctness bug: the formatter would
// silently change what the code does. Candidate construction avoids most of
// these by shape, but this table is the backstop every gap passes through,
// so it is tested on its own rather than only through what happens to reach
// it today.

const forbiddenAt = (code) => {
  const at = code.indexOf('  ');
  assert.notEqual(at, -1, `test snippet needs a double space: ${code}`);
  return isForbiddenBreak(makeSourceCode(code), { start: at, end: at + 2 });
};

test('forbidden positions (§3.2)', () => {
  const cases = [
    // ASI hazards after a restricted keyword.
    ['function f() { return  result; }', true],
    ['throw  error;', true],
    ['function* g() { yield  x; }', true],
    ['outer: for (;;) { break  outer; }', true],
    ['outer: for (;;) { continue  outer; }', true],
    // ASI hazard: no line terminator before => in an arrow.
    ['const f = (a)  => a + 1;', true],
    ['const f = a  => a;', true],
    ['const f = async (a)  => a;', true],
    // ASI hazard: before a postfix ++ / --.
    ['x  ++;', true],
    ['x  --;', true],
    // Semantic units.
    ['async  function f() {}', true],
    ['const c = new  Thing();', true],
    ['const b = !  flag;', true],
    ['const t = typeof  x;', true],
    ['const v = void  x;', true],
    ['async function f() { await  thing(); }', true],
    ['a.  b;', true],
    ['a?.  b;', true],
    // Legal break positions.
    ['const s = left  + right;', false],
    ['const v = a  && b;', false],
    ['foo(a,  b);', false],
    ['const o = {  a: 1 };', false],
    ['const t = c  ? a : b;', false],
  ];

  for (const [code, expected] of cases) {
    assert.equal(forbiddenAt(code), expected, `isForbiddenBreak for: ${code}`);
  }
});

test('a comment in the gap does not hide the hazard', () => {
  // The tokens on either side of the gap may be comments; comments take no
  // part in ASI, so the decision has to look past them to the real code.
  const cases = [
    ['function f() { return  /*c*/ value; }', true],
    ['function f() { return /*c*/  value; }', true],
    ['function f() { throw  /*c*/ new Error(x); }', true],
    ['function f() { throw /*c*/  new Error(x); }', true],
    ['function* g() { yield /*c*/  a; }', true],
    ['function* g() { yield /*c*/  * h(); }', true],
    ['outer: for (;;) { break /*c*/  outer; }', true],
    ['outer: for (;;) { continue /*c*/  outer; }', true],
    ['const f = async /*c*/  a => a;', true],
    ['let a = 1; a  /*c*/ ++;', true],
    ['let a = 1; a /*c*/  ++;', true],
    ['const f = (a) /*c*/  => a;', true],
    // Still legal with a comment in the way.
    ['foo(a /*c*/,  b);', false],
    ['const s = left /*c*/  + right;', false],
  ];

  for (const [code, expected] of cases) {
    assert.equal(forbiddenAt(code), expected, `isForbiddenBreak for: ${code}`);
  }
});

/**
 * The property the table exists to guarantee, checked directly: for every
 * inter-token gap the table calls legal, inserting a newline there must
 * leave the program parsing to the same AST.
 */
test('every gap the table permits is semantically safe', () => {
  const PROGRAMS = [
    'function f() { return a + b; }',
    'function f() { return; }',
    'function* g() { yield value; yield* other(); }',
    'outer: for (const x of xs) { if (x) continue outer; else break outer; }',
    'const f = (a) => a + 1;\nconst g = a => a;\nconst h = async (a) => await a;',
    'let i = 0; i++; --i; const n = -i + +j;',
    'function f() { throw new Error("x"); }',
    'const o = { a: 1, b: [2, 3], c: { d: 4 } };',
    'const v = a && b || c; const w = d ?? e;',
    'promise.then(x).catch(y).finally(z);',
    'const t = cond ? whenTrue : whenFalse;',
    'class K { get v() { return 1; } set v(x) {} static s = 1; #p = 2; }',
    'const r = a / b / c; const re = /ab+c/g.test(s);',
    'const s = `t ${value} u`; const tag = tagged`x ${y}`;',
    'do work(); while (cond);',
    'for (let i = 0; i < n; i++) { body(i); }',
    'const { a, b: { c } = {} } = obj; const [x, ...rest] = arr;',
    'new Thing(a, b); new a.b.C(); f()(); a[b].c(d);',
    'label: { break label; }',
    'const n = a.b?.c?.(d)?.[e];',
    'async function m() { for await (const c of s) use(c); }',
    'const big = 2 ** 3 ** 4; const mix = a in b && c instanceof D;',
  ];

  const OPTS = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    loc: true,
    range: true,
    tokens: true,
    comment: true,
  };

  let permitted = 0;
  for (const code of PROGRAMS) {
    const ast = parse(code);
    const sourceCode = makeSourceCode(code);
    const tokens = ast.tokens;

    for (let i = 0; i < tokens.length - 1; i++) {
      const gap = { start: tokens[i].range[1], end: tokens[i + 1].range[0] };
      if (isForbiddenBreak(sourceCode, gap)) continue;
      permitted++;

      const broken =
        code.slice(0, gap.start) + '\n' + code.slice(gap.end);
      const context = JSON.stringify(
        code.slice(Math.max(0, gap.start - 20), gap.end + 20),
      );

      let after;
      try {
        after = espree.parse(broken, OPTS);
      } catch (error) {
        assert.fail(
          `break made the program unparseable near ${context}: ${error.message}`,
        );
      }
      assert.deepEqual(
        stripLocations(after),
        stripLocations(ast),
        `break changed the AST near ${context}`,
      );
    }
  }
  assert.ok(permitted > 200, `only ${permitted} gaps exercised`);
});
