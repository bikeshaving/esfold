import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceCode } from 'eslint';
import tseslint from 'typescript-eslint';
import { format, applyEdits } from '../src/index.js';

/**
 * The TypeScript type layer (§3.3 #17–#22).
 *
 * §3.3's table was derived from the ESTree grammar, so it described exactly
 * the JavaScript layer. Type syntax always parsed safely and was never
 * corrupted, but nothing in it was a break candidate — a long union or
 * type-argument list had no legal position and was simply left over width.
 * These use the same shapes as their value counterparts: a type-argument
 * list breaks like an argument list, a type literal like an object, a union
 * like an operator chain, a conditional type like a ternary.
 */

const OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  loc: true,
  range: true,
  tokens: true,
  comment: true,
  filePath: 'file.ts',
};

function formatTS(code, maxWidth) {
  const ast = tseslint.parser.parseForESLint(code, OPTIONS).ast;
  return applyEdits(
    code,
    format(new SourceCode({ text: code, ast }), { maxWidth }),
  );
}

test('#17: type arguments break like an argument list', () => {
  // The overflow is inside the type arguments, so the *call* must not be
  // what breaks — its parenthesis sits past the limit and moving it there
  // leaves the head exactly as long as it was.
  assert.equal(
    formatTS(
      'util.assertEqual<UnionedType, { a: string; b?: string | undefined }>(value);\n',
      60,
    ),
    'util.assertEqual<\n' +
      '  UnionedType,\n' +
      '  { a: string; b?: string | undefined }\n' +
      '>(value);\n',
  );
});

test('#17: type parameters break the same way', () => {
  assert.equal(
    formatTS(
      'function convert<TInput extends object, TOutput extends object>(x: TInput) {}\n',
      60,
    ),
    'function convert<\n' +
      '  TInput extends object,\n' +
      '  TOutput extends object\n' +
      '>(x: TInput) {}\n',
  );
});

test('#18: a type literal breaks like an object literal', () => {
  // Members are separated by `;`, and a TSPropertySignature's range covers
  // its own separator — so the break goes after the member, not after the
  // next separator found, which belongs to the following member.
  assert.equal(
    formatTS(
      'type Options = { timeout: number; retries: number; cacheEnabled: boolean };\n',
      60,
    ),
    'type Options = {\n' +
      '  timeout: number;\n' +
      '  retries: number;\n' +
      '  cacheEnabled: boolean\n' +
      '};\n',
  );
});

test('#18: an interface body breaks the same way', () => {
  assert.equal(
    formatTS(
      'interface Iface { alphaValue: string; betaValue: number; gamma: boolean }\n',
      60,
    ),
    'interface Iface {\n' +
      '  alphaValue: string;\n' +
      '  betaValue: number;\n' +
      '  gamma: boolean\n' +
      '}\n',
  );
});

test('#19: a tuple type breaks like an array', () => {
  assert.equal(
    formatTS(
      'type Tup = [FirstElementType, SecondElementType, ThirdElementTypeHere];\n',
      60,
    ),
    'type Tup = [\n' +
      '  FirstElementType,\n' +
      '  SecondElementType,\n' +
      '  ThirdElementTypeHere\n' +
      '];\n',
  );
});

test('#20: unions and intersections break at the operator', () => {
  assert.equal(
    formatTS(
      'type Handler = FirstHandlerType | SecondHandlerType | ThirdHandlerKind;\n',
      60,
    ),
    'type Handler = FirstHandlerType\n' +
      '  | SecondHandlerType\n' +
      '  | ThirdHandlerKind;\n',
  );
  assert.equal(
    formatTS(
      'type Both = FirstMixinType & SecondMixinType & ThirdMixinTypeHere;\n',
      60,
    ),
    'type Both = FirstMixinType\n' +
      '  & SecondMixinType\n' +
      '  & ThirdMixinTypeHere;\n',
  );
});

test('#21: a conditional type breaks like a ternary', () => {
  assert.equal(
    formatTS(
      'type Cond<T> = T extends StringLikeThing ? TrueBranchType : FalseBranch;\n',
      60,
    ),
    'type Cond<T> = T extends StringLikeThing\n' +
      '  ? TrueBranchType\n' +
      '  : FalseBranch;\n',
  );
});

test('function type parameters break like a parameter list', () => {
  assert.equal(
    formatTS(
      'type Fn = (alphaParam: string, betaParam: number) => ReturnHere;\n',
      40,
    ),
    'type Fn = (\n' +
      '  alphaParam: string,\n' +
      '  betaParam: number\n' +
      ') => ReturnHere;\n',
  );
});

test('a type alias with nothing breakable falls back to the `=`', () => {
  // §3.3 #16 reaches type aliases too, though they are neither an
  // assignment nor a declarator. Here the value is a single reference with
  // no internal structure at all.
  assert.equal(
    // 50, not 40: at 40 the value would not fit on its own line either, and
    // the rescue correctly declines rather than buying a line for nothing.
    formatTS('type Alias = SomeVeryLongImportedTypeNameFromElsewhere;\n', 50),
    'type Alias =\n  SomeVeryLongImportedTypeNameFromElsewhere;\n',
  );
});

test('type syntax that fits is left alone', () => {
  const code =
    'type Small = { a: number };\ntype U = A | B;\nfunction f<T>(x: T): T {\n  return x;\n}\n';
  assert.equal(formatTS(code, 80), code);
});
