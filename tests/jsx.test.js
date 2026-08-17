import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import ts from 'typescript';
import { format, applyEdits } from '../src/index.js';

/**
 * JSX children (§3.3 #23).
 *
 * JSX is the one place in the grammar where whitespace between tokens is
 * *content*, so "a newline never changes meaning" has to be earned here
 * rather than assumed — and AST identity is the wrong test, since a break
 * legitimately adds text nodes that render as nothing.
 *
 * The oracle below is TypeScript's own JSX emit. Comparing the generated
 * `createElement` calls is a direct statement about what renders, rather
 * than a restatement of the whitespace rule the implementation already
 * assumes.
 */

const OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  loc: true,
  range: true,
  tokens: true,
  comment: true,
  ecmaFeatures: { jsx: true },
  filePath: 'file.tsx',
};

const emit = (code) =>
  ts
    .transpileModule(code, {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext },
    })
    .outputText.replace(/\s+/g, ' ')
    .trim();

function formatJSX(code, maxWidth) {
  const ast = tseslint.parser.parseForESLint(code, OPTIONS).ast;
  return applyEdits(
    code,
    format(new SourceCode({ text: code, ast }), { maxWidth }),
  );
}

/** Formatting must never change what the element renders. */
function assertRenderPreserved(code, maxWidth) {
  const out = formatJSX(code, maxWidth);
  assert.equal(emit(out), emit(code), `render changed:\n${code}\n->\n${out}`);
  return out;
}

test('element children go one per line', () => {
  assert.equal(
    assertRenderPreserved(
      'const el = <section className="wrapper"><span>Some text here</span><b>more</b></section>;\n',
      60,
    ),
    'const el = <section className="wrapper">\n' +
      '  <span>Some text here</span>\n' +
      '  <b>more</b>\n' +
      '</section>;\n',
  );
});

test('a space between children is content, so the element is declined', () => {
  // JSX deletes a whitespace run containing a newline, so breaking here
  // would drop the space. Prettier emits `{" "}` to keep it; Fold only ever
  // inserts newlines, so it declines instead of guessing.
  const code =
    'const el = <p><span>alpha</span> <span>beta</span></p>;\n';
  const out = formatJSX(code, 30);
  assert.ok(
    !/alpha<\/span>\n/.test(out),
    `must not break at the meaningful space:\n${out}`,
  );
  assert.equal(emit(out), emit(code));
});

test('text children are declined — rewrapping would split a token', () => {
  const code =
    'const el = <p>A sentence of prose that is quite long and will not fit.</p>;\n';
  assert.equal(formatJSX(code, 40), code);
});

test('already-broken children are left exactly alone', () => {
  const code =
    'const el = (\n  <div>\n    <span>a</span>\n    <b>c</b>\n  </div>\n);\n';
  assert.equal(formatJSX(code, 60), code);
});

test('fragments break like elements', () => {
  const out = assertRenderPreserved(
    'const el = <><FirstComponent /><SecondComponent /><ThirdComponent /></>;\n',
    40,
  );
  assert.equal(
    out,
    'const el = <>\n' +
      '  <FirstComponent />\n' +
      '  <SecondComponent />\n' +
      '  <ThirdComponent />\n' +
      '</>;\n',
  );
});

test('render is preserved across a range of shapes and widths', () => {
  const shapes = [
    'const el = <p><a>x</a><b>y</b></p>;\n',
    'const el = <p><a>x</a> <b>y</b></p>;\n',
    'const el = <p>hi <b>y</b></p>;\n',
    'const el = <p>{value}<b>y</b></p>;\n',
    'const el = <p>{first}{second}</p>;\n',
    'const el = <div><Alpha prop={1} /><Beta prop={2} /><Gamma prop={3} /></div>;\n',
    'const el = <div>\n  <Alpha />\n  text between\n  <Beta />\n</div>;\n',
    'const el = <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>;\n',
  ];
  for (const code of shapes) {
    for (const maxWidth of [20, 40, 80]) {
      assertRenderPreserved(code, maxWidth);
    }
  }
});
