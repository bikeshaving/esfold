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

test('the assignment break rescues a value nothing else can split', () => {
  // §3.3 #16. A member path has nothing inside it to break, so before this
  // position existed the line was simply left long.
  assert.equal(
    formatText(
      'const resultValue = someObject.deeply.nested.property.chain.valueHere;\n',
      { maxWidth: 60 },
    ),
    'const resultValue =\n  someObject.deeply.nested.property.chain.valueHere;\n',
  );
});

test('but not when the value can break on its own', () => {
  // Last resort means last: whenever something inside the value can be
  // split, splitting that reads better, so these must be untouched by #16.
  const call =
    'const resultValue = computeSomething(alphaArgument, betaArgument, gamma);\n';
  assert.equal(
    formatText(call, { maxWidth: 60 }),
    'const resultValue = computeSomething(\n' +
      '  alphaArgument,\n' +
      '  betaArgument,\n' +
      '  gamma\n' +
      ');\n',
  );
  const ternary =
    'const messageText = isEnabled ? enabledDisplayLabel : disabledLabelHere;\n';
  assert.equal(
    formatText(ternary, { maxWidth: 60 }),
    'const messageText = isEnabled\n' +
      '  ? enabledDisplayLabel\n' +
      '  : disabledLabelHere;\n',
  );
});

test('and not when the value would not fit anyway', () => {
  // Both halves have to fit. A 200-character string moved to its own line
  // is still a 200-character line.
  const code = `const s = '${'x'.repeat(200)}';\n`;
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a `:` gets the same last-resort break as an `=`', () => {
  // An object property binds a name to a value exactly as an assignment
  // does; treating one and not the other was arbitrary.
  assert.equal(
    formatText(
      'const o = { someKeyName: someObject.deeply.nested.property.valueHere };\n',
      { maxWidth: 50 },
    ),
    'const o = {\n' +
      '  someKeyName:\n' +
      '    someObject.deeply.nested.property.valueHere\n' +
      '};\n',
  );
});

test('nothing inside a template literal is folded, ever', () => {
  // Reopened once, on the observation that most long template lines are long
  // because of their expressions rather than their text. True, and not
  // decisive: Prettier declines these too, and splitting a value across an
  // interpolation reads worse than the long line.
  assert.equal(
    formatText(
      'report(`Unexpected text ${span.slice(index, match.index).trim()}`, spans);\n',
      { maxWidth: 60 },
    ),
    'report(\n' +
      '  `Unexpected text ${span.slice(index, match.index).trim()}`,\n' +
      '  spans\n' +
      ');\n',
  );
});

test('a shorthand method does not borrow the previous property\'s colon', () => {
  // `test(...) {}` has no colon of its own. An unbounded backwards search
  // finds the one belonging to `html:` and breaks that line on behalf of a
  // node two lines below it.
  const code =
    'export default test({\n' +
    '  html: "<div>content 0 3 3</div><div>content 1 2 2</div><div>content 2</div>",\n' +
    '\n' +
    '  test({ assert, target }) {\n' +
    '    assert.equal(target, null);\n' +
    '  },\n' +
    '});\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('a compound assignment is not a peer in an `=` chain', () => {
  // `a = b = c` hands one value to several targets, so breaking one operator
  // and not the other is inconsistent. `a = b += c` parses as `a = (b += c)`:
  // the mutation is nested, not a peer, and leaving it inline is correct.
  assert.equal(
    formatText(
      'someObject.longPropertyName.value = anotherObject.otherProperty.value += delta;\n',
      { maxWidth: 60 },
    ),
    'someObject.longPropertyName.value =\n' +
      '  anotherObject.otherProperty.value += delta;\n',
  );
  assert.equal(
    formatText(
      'someObject.longPropertyName.value = anotherObject.otherProperty.value = delta;\n',
      { maxWidth: 60 },
    ),
    'someObject.longPropertyName.value =\n' +
      '  anotherObject.otherProperty.value =\n' +
      '  delta;\n',
  );
});
