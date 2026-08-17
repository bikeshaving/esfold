import { SourceCode } from 'eslint';
import * as espree from 'espree';
import { format, applyEdits } from '../src/format.js';

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  loc: true,
  range: true,
  tokens: true,
  comment: true,
  ecmaFeatures: { jsx: true },
};

export function parse(code) {
  return espree.parse(code, PARSE_OPTIONS);
}

export function makeSourceCode(code) {
  return new SourceCode({ text: code, ast: parse(code) });
}

/** Run the pure core over a string, bypassing ESLint entirely (§2.4). */
export function formatText(code, options = {}) {
  return applyEdits(code, format(makeSourceCode(code), options));
}

/** Deep AST comparison ignoring location data (§8 test 1). */
export function stripLocations(node) {
  if (Array.isArray(node)) return node.map(stripLocations);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      if (key === 'range' || key === 'loc' || key === 'start' || key === 'end')
        continue;
      if (key === 'parent') continue;
      out[key] = stripLocations(node[key]);
    }
    return out;
  }
  return node;
}
