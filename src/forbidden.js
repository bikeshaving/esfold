/**
 * Forbidden breaks (§3.2). A gap is forbidden when inserting a newline there
 * would be an ASI hazard or would split a semantic unit. Candidate
 * construction already avoids most of these by design; this table is the
 * backstop every gap passes through before a break is inserted.
 */

const KEYWORD_NO_BREAK_AFTER = new Set([
  'return',
  'throw',
  'break',
  'continue',
  'yield',
  'async',
  'function',
  'new',
]);

const ALWAYS_UNARY = new Set(['!', '~', 'typeof', 'void', 'delete', 'await']);

function looksLikeOperandEnd(token) {
  if (!token) return false;
  if (token.type === 'Identifier' || token.type === 'PrivateIdentifier')
    return true;
  if (
    token.type === 'Numeric' ||
    token.type === 'String' ||
    token.type === 'Boolean' ||
    token.type === 'Null' ||
    token.type === 'RegularExpression'
  )
    return true;
  if (token.type === 'Template') return token.value.endsWith('`');
  if (token.type === 'Punctuator')
    return token.value === ')' || token.value === ']' || token.value === '}';
  if (token.type === 'Keyword')
    return token.value === 'this' || token.value === 'super';
  return false;
}

export function isForbiddenBreak(sourceCode, gap) {
  const next = sourceCode.getTokenByRangeStart(gap.end, {
    includeComments: true,
  });
  if (!next) return true;
  const prev = sourceCode.getTokenBefore(next, { includeComments: true });
  if (!prev) return false;

  // ASI hazards: after return / throw / yield / break / continue.
  // Semantic units: after async / function / new.
  if (prev.type === 'Keyword' && KEYWORD_NO_BREAK_AFTER.has(prev.value))
    return true;
  if (prev.type === 'Identifier' && prev.value === 'yield') return true;
  if (prev.type === 'Identifier' && prev.value === 'async') return true;

  // `yield *` / `function *`: no break after the star either.
  if (prev.type === 'Punctuator' && prev.value === '*') {
    const beforeStar = sourceCode.getTokenBefore(prev);
    if (
      beforeStar &&
      (beforeStar.value === 'yield' || beforeStar.value === 'function')
    )
      return true;
  }

  // Between a unary operator and its operand.
  if (prev.type === 'Punctuator' && ALWAYS_UNARY.has(prev.value)) return true;
  if (
    prev.type === 'Keyword' &&
    (prev.value === 'typeof' ||
      prev.value === 'void' ||
      prev.value === 'delete' ||
      prev.value === 'await')
  )
    return true;
  if (prev.type === 'Punctuator' && (prev.value === '+' || prev.value === '-')) {
    // Unary if the thing before the operator is not an operand end.
    const beforeOp = sourceCode.getTokenBefore(prev);
    if (!looksLikeOperandEnd(beforeOp)) return true;
  }

  // ASI hazard: before a ++ / -- (postfix). Conservatively also skips the
  // prefix case — no candidate produces it anyway.
  if (next.type === 'Punctuator' && (next.value === '++' || next.value === '--'))
    return true;

  // Break before the dot, never after it.
  if (prev.type === 'Punctuator' && (prev.value === '.' || prev.value === '?.'))
    return true;

  return false;
}
