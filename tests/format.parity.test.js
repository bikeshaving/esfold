import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

/**
 * Cases found by running Fold over Prettier-formatted third-party code and
 * diffing (§8 test 5). Each was a real disagreement; each is now settled the
 * way Prettier settles it, because the alternative was worse rather than
 * merely different.
 */

test('a line pushed over only by a trailing comment is left alone (§7.1)', () => {
  // The code is 48 columns. Breaking it to make room for a comment
  // reformats the wrong thing, and the comment cannot be shortened.
  const code =
    "const headers = { AuThOrIzAtIoN: 'Bearer 1234' }; // wonky casing on purpose\n";
  assert.equal(formatText(code, { maxWidth: 60 }), code);
});

test('code that is itself too long still breaks, comment or not', () => {
  const code =
    'const headers = computeAll(firstArgumentName, secondArgumentName, third); // c\n';
  assert.equal(
    formatText(code, { maxWidth: 60 }),
    'const headers = computeAll(\n' +
      '  firstArgumentName,\n' +
      '  secondArgumentName,\n' +
      '  third\n' +
      '); // c\n',
  );
});

test('a lone import specifier stays inline however long the line', () => {
  // What makes these lines long is the module path, which no break inside
  // the braces shortens.
  const code =
    "import { transformStyle } from '../../../compiler-dom/src/transforms/transformStyle';\n";
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('two or more specifiers break normally', () => {
  const code =
    "import { transformStyle, transformOther } from '../../../compiler-dom/x';\n";
  assert.equal(
    formatText(code, { maxWidth: 60 }),
    'import {\n' +
      '  transformStyle,\n' +
      '  transformOther\n' +
      "} from '../../../compiler-dom/x';\n",
  );
});

test('a hugged function signature is never broken', () => {
  // Hugging means the body absorbs the break, so the signature is part of
  // the call's head. Without this the parameter list is all that is left to
  // break: `function (\n  done\n) {`.
  const code =
    'it("should ignore X-Forwarded-Proto if socket addr is not trusted", function (done) {\n' +
    '  run();\n' +
    '});\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a call with a trailing function keeps the layout it was given', () => {
  // The hugged form leaves the open paren unbroken and the close paren on
  // its own line. That reads as "partially broken" but is deliberate.
  const code = 'promise.then(() =>\n  computeSomething(value),\n);\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a leading semicolon stays with the statement it guards', () => {
  // Semicolon-less style: `;` prefixes a line starting with `(` or `[` to
  // stop ASI joining it to the previous line. The parser attaches it to the
  // previous statement, so the statement boundary falls right after it.
  const code = 'function f() {\n  const a = 1\n  ;(node).inPattern = true\n}\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('ordinary statement boundaries still break', () => {
  assert.equal(
    formatText('doFirst(); doSecond();\n', { maxWidth: 80 }),
    'doFirst();\ndoSecond();\n',
  );
});
