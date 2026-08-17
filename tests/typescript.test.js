import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import { format, applyEdits } from '../src/format.js';
import { stripLocations } from './helpers.js';

// Syntax parity (§2.4): Fold never parses anything itself, so whatever the
// configured parser handles it must handle. The rest of the suite runs on
// espree, which knows no TypeScript — these assert the invariants hold on
// TS and JSX constructs too.

const OPTS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  loc: true,
  range: true,
  tokens: true,
  comment: true,
  ecmaFeatures: { jsx: true },
};

function parse(code) {
  return tseslint.parser.parseForESLint(code, { ...OPTS, filePath: 'x.tsx' })
    .ast;
}

function run(code, maxWidth) {
  const ast = parse(code);
  return applyEdits(code, format(new SourceCode({ text: code, ast }), { maxWidth }));
}

const SNIPPETS = [
  'interface Foo { alpha: string; beta?: number; gamma(): void; }',
  'type Union = { kind: "a"; value: string } | { kind: "b"; value: number };',
  'function generic<T extends object, U = T>(input: T, other: U): T { return input; }',
  'const typed: Array<Record<string, number>> = [{ alpha: 1 }, { beta: 2 }];',
  'enum Color { Red = "RED", Green = "GREEN", Blue = "BLUE" }',
  'class Svc { constructor(private readonly dep: Dep, public other: Other) {} }',
  'abstract class A { abstract method(alpha: string, beta: number): void; }',
  'const assertion = value as unknown as SomeVeryLongTypeName<WithGenerics>;',
  'declare module "mod" { export function f(alpha: string): void; }',
  'const fn: (alpha: string, beta: number) => void = (alpha, beta) => {};',
  '@Component({ selector: "app", template: "<div></div>" }) class Cmp {}',
  'const satisfied = { alpha: 1, beta: 2 } satisfies Record<string, number>;',
  'type Cond<T> = T extends string ? "yes" : T extends number ? "num" : "no";',
  'const tuple: [first: string, second?: number, ...rest: boolean[]] = ["a"];',
  'call<TypeArg1, TypeArg2>(argumentOne, argumentTwo, argumentNumberThree);',
  'const el = <Component prop={value} other="literal" {...spread}>{child}</Component>;',
  'export type { Foo, Bar } from "./types.js";',
  'import type { Alpha, Beta } from "./types.js";',
  'function assertIs(v: unknown): asserts v is string {}',
  'const nonNull = maybe!.definitely!.value;',
  'class G { static #priv = 1; #method() { return G.#priv; } }',
];

for (const width of [20, 40, 80]) {
  test(`TypeScript/JSX invariants at maxWidth ${width}`, () => {
    for (const code of SNIPPETS) {
      const out = run(code, width);

      // Semantic preservation.
      assert.deepEqual(
        stripLocations(parse(out)),
        stripLocations(parse(code)),
        `AST changed for: ${code}\n  -> ${out}`,
      );

      // Idempotence.
      assert.equal(
        run(out, width),
        out,
        `not idempotent for: ${code}\n  -> ${out}`,
      );
    }
  });
}
