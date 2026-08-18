import ts from 'typescript';
import { test, expect } from '@b9g/libuild/test';
import { fold } from './fold.js';

/**
 * JSX is the one place in the grammar where whitespace between tokens is
 * content, so "a newline never changes meaning" has to be earned here rather
 * than assumed. AST identity is the wrong test: a break legitimately adds
 * text nodes that render as nothing. TypeScript's own JSX emit is the oracle
 * instead — comparing the generated `createElement` calls is a statement
 * about what renders, not a restatement of the whitespace rule the
 * implementation already assumes.
 */
const emit = (code: string) =>
  ts
    .transpileModule(code, {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext },
    })
    .outputText.replace(/\s+/g, ' ')
    .trim();

function foldJSX(code: string, maxWidth: number) {
  const out = fold(code, { maxWidth, ts: true });
  expect(emit(out)).toBe(emit(code));
  return out;
}

test('element children go one per line', () => {
  expect(
    foldJSX(
      'const el = <section className="wrapper"><span>Some text here</span><b>more</b></section>;\n',
      60,
    ),
  ).toBe(
    'const el = <section className="wrapper">\n' +
      '  <span>Some text here</span>\n' +
      '  <b>more</b>\n' +
      '</section>;\n',
  );
});

test('a space between children is content, so the element is declined', () => {
  // JSX deletes a whitespace run containing a newline, so breaking here would
  // drop the space. Prettier emits `{" "}` to keep it; Fold only ever inserts
  // newlines, so it declines rather than guessing.
  const out = foldJSX('const el = <p><span>alpha</span> <span>beta</span></p>;\n', 30);
  expect(out).not.toMatch(/alpha<\/span>\n/);
});

test('text children are declined — rewrapping would split a token', () => {
  const code =
    'const el = <p>A sentence of prose that is quite long and will not fit.</p>;\n';
  expect(fold(code, { maxWidth: 40, ts: true })).toBe(code);
});

test('already-broken children are left exactly alone', () => {
  const code =
    'const el = (\n  <div>\n    <span>a</span>\n    <b>c</b>\n  </div>\n);\n';
  expect(fold(code, { maxWidth: 60, ts: true })).toBe(code);
});

test('fragments break like elements', () => {
  expect(
    foldJSX('const el = <><FirstComponent /><SecondComponent /><ThirdComponent /></>;\n', 40),
  ).toBe(
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
    for (const maxWidth of [20, 40, 80]) foldJSX(code, maxWidth);
  }
});

test('a nested element breaks at any width', () => {
  // Structural rather than width-driven: nobody writes `<td><input /></td>` on
  // one line, and Prettier breaks it at any width too.
  expect(foldJSX('const a = <td><input /></td>;\n', 80)).toBe(
    'const a = <td>\n  <input />\n</td>;\n',
  );
});

test('text-only and expression-only children stay inline', () => {
  // Ordinary inline values, not nesting. They stay width-driven, so long ones
  // can still break.
  for (const code of [
    'const d = <b>bold text</b>;\n',
    'const e = <span>{value}</span>;\n',
    'const g = <Foo />;\n',
  ]) {
    expect(fold(code, { maxWidth: 80, ts: true })).toBe(code);
  }
});

test('nesting is declined when a break would eat a space', () => {
  // `hi ` carries a significant trailing space, so this element is not
  // breakable at all.
  const code = 'const h = <p>hi <b>y</b></p>;\n';
  expect(fold(code, { maxWidth: 80, ts: true })).toBe(code);
  foldJSX(code, 20);
});
