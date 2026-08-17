import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from './helpers.js';

// Remaining optional-break categories (§3.3 #6–13, build-order step 9).

test('#6: function parameters break as call arguments', () => {
  const code =
    'function combine(firstParameter, secondParameter, thirdParameter) {\n' +
    '  return 1;\n' +
    '}\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'function combine(\n' +
      '  firstParameter,\n' +
      '  secondParameter,\n' +
      '  thirdParameter\n' +
      ') {\n' +
      '  return 1;\n' +
      '}\n',
  );
});

test('#6: single destructured parameter hugs', () => {
  const code =
    'function setup({ optionOne, optionTwo, optionThree }) {\n  return 1;\n}\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'function setup({\n' +
      '  optionOne,\n' +
      '  optionTwo,\n' +
      '  optionThree\n' +
      '}) {\n' +
      '  return 1;\n' +
      '}\n',
  );
});

test('#7: long if condition breaks inside the parens', () => {
  const code =
    'if (firstCondition && secondCondition && thirdCondition) {\n  act();\n}\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'if (\n' +
      '  firstCondition &&\n' +
      '    secondCondition &&\n' +
      '    thirdCondition\n' +
      ') {\n' +
      '  act();\n' +
      '}\n',
  );
});

test('#7: a hand-broken condition is preserved (§5, never joined)', () => {
  const code = 'if (\n  ready\n) {\n  act(); // go\n}\n';
  assert.equal(formatText(code, { maxWidth: 80 }), code);
});

test('#8: for clauses break at the semicolons', () => {
  const code =
    'for (let index = initialValue; index < upperBound; index += stepSize) {\n' +
    '  act(index);\n' +
    '}\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'for (let index = initialValue;\n' +
      '  index < upperBound;\n' +
      '  index += stepSize) {\n' +
      '  act(index);\n' +
      '}\n',
  );
});

test('#9: import specifier list breaks as an object literal', () => {
  const code =
    "import { firstExport, secondExport, thirdExport } from './somewhere.js';\n";
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'import {\n' +
      '  firstExport,\n' +
      '  secondExport,\n' +
      '  thirdExport\n' +
      "} from './somewhere.js';\n",
  );
});

test('#10: destructuring pattern breaks as an object literal', () => {
  const code =
    'const { alphaValue, betaValue, gammaValue, deltaValue } = payload;\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const {\n' +
      '  alphaValue,\n' +
      '  betaValue,\n' +
      '  gammaValue,\n' +
      '  deltaValue\n' +
      '} = payload;\n',
  );
});

test('#11: ternary breaks before ? and before :', () => {
  const code =
    'const label = isEnabled ? enabledDisplayLabel : disabledDisplayLabel;\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const label = isEnabled\n' +
      '  ? enabledDisplayLabel\n' +
      '  : disabledDisplayLabel;\n',
  );
});

test('#12: JSX attributes break like object properties', () => {
  const code =
    'const el = <section className={styles.wrapper} onClick={handleClick} role="main" />;\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'const el = <section\n' +
      '  className={styles.wrapper}\n' +
      '  onClick={handleClick}\n' +
      '  role="main"\n' +
      '/>;\n',
  );
});

test('#13: variable declarator list breaks after the comma', () => {
  const code = 'let firstVariable = 1, secondVariable = 2, thirdVariable = 3;\n';
  assert.equal(
    formatText(code, { maxWidth: 40 }),
    'let firstVariable = 1,\n' +
      '  secondVariable = 2,\n' +
      '  thirdVariable = 3;\n',
  );
});

test('a partially broken ternary is completed, not joined', () => {
  const code = 'const label = isEnabled\n  ? yes : no;\n';
  assert.equal(
    formatText(code, { maxWidth: 80 }),
    'const label = isEnabled\n  ? yes\n  : no;\n',
  );
});
