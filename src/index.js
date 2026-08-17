/**
 * eslint-plugin-fold — `fold/breaks`, the rule that decides where the
 * newlines go. See docs/design.md; the § references throughout point at it.
 *
 * One file on purpose. The pieces below were once six modules, but nothing
 * imported them except each other and the tests, they are meaningless
 * separately, and the build bundles them back into one file regardless.
 * The sections run from the primitives outward: measurement, then the break
 * grammar, then the algorithm that uses it, then the ESLint adapter.
 *
 * No ESLint imports (§2.4) — `sourceCode` is consumed structurally, so the
 * core is testable without spinning up a linter.
 */

// ===============
// = Measurement =
// ===============

/**
 * Line-width measurement (§7.1).
 *
 * A tab advances to the next 2-column tab stop. 2 matches Prettier's default
 * `tabWidth`, which is what tab-indented codebases are overwhelmingly
 * formatted against; scoring a tab as 4 made Fold reflow deeply-indented
 * lines those projects already considered fine. `@stylistic/max-len` defaults
 * to 4 instead, so a project running both should set `max-len`'s `tabWidth`
 * to 2 to keep them agreeing. Not configurable.
 */
export const TAB_WIDTH = 2;

/**
 * Visual width of a line of text.
 *
 * This deliberately reproduces `@stylistic/max-len`'s `computeLineLength`
 * rather than being independently "correct": the goal is that the two rules
 * never disagree about which lines are too long, and disagreement is worse
 * than a shared quirk. The quirk is that the total counts *code points*
 * while each tab stop is computed from the *UTF-16* offset, so a line
 * holding both an astral character (emoji, rare CJK) and a tab measures
 * differently than either convention alone would suggest.
 *
 * Consequences shared with max-len: a full-width CJK character or an emoji
 * counts as one column though it occupies two, and a decomposed accent
 * counts as two though it renders as one.
 */
export function measureLine(text) {
  let extra = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\t') continue;
    extra += TAB_WIDTH - ((i + extra) % TAB_WIDTH) - 1;
  }
  let codePoints = 0;
  for (const _ of text) codePoints++;
  return codePoints + extra;
}

// ====================
// = Indent inference =
// ====================

/**
 * Indent inference (§7). The indent unit is read from the file, never
 * configured: the most common leading-whitespace delta between
 * consecutively-nested lines. Falls back to two spaces for a file with no
 * nesting. Tab files naturally infer '\t' because that's the dominant delta.
 */
export function inferIndentUnit(lines) {
  const counts = new Map();
  let prev = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const ws = /^[ \t]*/.exec(line)[0];
    if (prev !== null && ws.length > prev.length && ws.startsWith(prev)) {
      const delta = ws.slice(prev.length);
      // Only homogeneous deltas are usable as a unit. A mixed one like
      // '\t ' comes from continuation-line alignment, not from a nesting
      // step, and repeating it would emit exactly the tab/space mixture
      // `no-mixed-spaces-and-tabs` exists to flag.
      if (delta === '\t'.repeat(delta.length) || delta === ' '.repeat(delta.length)) {
        counts.set(delta, (counts.get(delta) ?? 0) + 1);
      }
    }
    prev = ws;
  }
  let best = null;
  let bestCount = 0;
  for (const [delta, count] of counts) {
    if (count > bestCount) {
      best = delta;
      bestCount = count;
    }
  }
  return best ?? '  ';
}

// ===========================
// = Forbidden breaks (§3.2) =
// ===========================

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
  const boundary = sourceCode.getTokenByRangeStart(gap.end, {
    includeComments: true,
  });
  if (!boundary) return true;

  // Comments do not participate in ASI, so the hazard is decided by the
  // nearest *code* tokens on either side. Resolving these with comments
  // included lets `return /* c */ <break> value` through — the token before
  // the gap is the comment rather than `return`, and the break quietly turns
  // the statement into `return undefined`.
  const prev = sourceCode.getTokenBefore(boundary, { includeComments: false });
  const next =
    boundary.type === 'Line' || boundary.type === 'Block'
      ? sourceCode.getTokenAfter(boundary, { includeComments: false })
      : boundary;
  if (!prev) return false;

  // ASI hazard: `ArrowParameters [no LineTerminator here] =>`.
  if (next && next.type === 'Punctuator' && next.value === '=>') return true;

  // ASI hazards: after return / throw / yield / break / continue.
  // Semantic units: after async / function / new.
  if (prev.type === 'Keyword' && KEYWORD_NO_BREAK_AFTER.has(prev.value))
    return true;
  // Token *type* is unreliable for the contextual keywords: espree reports
  // `yield` as a Keyword but `await` as an Identifier, and `async` is always
  // an Identifier. Match on value.
  if (
    prev.value === 'yield' ||
    prev.value === 'async' ||
    prev.value === 'await'
  )
    return true;

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
  if (
    next &&
    next.type === 'Punctuator' &&
    (next.value === '++' || next.value === '--')
  )
    return true;

  // Break before the dot, never after it.
  if (prev.type === 'Punctuator' && (prev.value === '.' || prev.value === '?.'))
    return true;

  return false;
}

// =====================================
// = Break candidates (§3.1, §3.3, §4) =
// =====================================

/**
 * Break candidates. Two shapes so far:
 *
 * - Bracketed item lists (§3.3 categories 1–3): call arguments, array
 *   elements, object properties. Gaps: after the open bracket ('item'),
 *   after each separating comma ('item'), before the close bracket
 *   ('close'). 'item' gaps indent one unit past the base; 'close' gaps
 *   return to the base.
 *
 * - Operator chains (§3.3 category 4, §4.2): binary/logical runs of equal
 *   precedence, plus assignment chains. Gaps: before each operator, all
 *   'item'. A chain candidate exists only at the root of its precedence run,
 *   so lower precedence (the outermost node) breaks first, and a
 *   higher-precedence subchain breaks only via recursion when a line is
 *   still too long — §4.2's "one precedence level at a time" falls out of
 *   outermost-first.
 *
 * Gaps run from the end of the previous token-or-comment to the start of the
 * next token-or-comment, so a gap is always pure whitespace. A gap containing
 * a newline is already broken; breaking a group only fills in its unbroken
 * gaps (all-or-nothing, §4.3).
 */

/** Generic parser-agnostic AST walk: recurse into anything node-shaped. */
export function walk(node, visit) {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === 'string') walk(item, visit);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

// The real ECMAScript precedence table (§4.2), assignment through
// exponentiation. Lower binds looser and breaks earlier.
const BINARY_PRECEDENCE = {
  '??': 4,
  '||': 4,
  '&&': 5,
  '|': 6,
  '^': 7,
  '&': 8,
  '==': 9,
  '!=': 9,
  '===': 9,
  '!==': 9,
  '<': 10,
  '>': 10,
  '<=': 10,
  '>=': 10,
  in: 10,
  instanceof: 10,
  '<<': 11,
  '>>': 11,
  '>>>': 11,
  '+': 12,
  '-': 12,
  '*': 13,
  '/': 13,
  '%': 13,
  '**': 14,
};

// `join` is the text a collapsed break becomes (§5): '' for bracket and dot
// gaps, ' ' for comma and operator gaps. Necessary gaps are never collapsed
// and carry no join.
function gapAfter(sourceCode, tokenOrNode, join = '') {
  const next = sourceCode.getTokenAfter(tokenOrNode, { includeComments: true });
  return { start: tokenOrNode.range[1], end: next.range[0], kind: 'item', join };
}

function gapBefore(sourceCode, token, kind, join = '') {
  const prev = sourceCode.getTokenBefore(token, { includeComments: true });
  return { start: prev.range[1], end: token.range[0], kind, join };
}

function isPunct(token, value) {
  return token && token.type === 'Punctuator' && token.value === value;
}

/**
 * Build the gap list for a bracketed item list. Returns null when the group
 * can't be treated uniformly (empty list, sparse array elision).
 */
function listGaps(sourceCode, open, close, items, separators = [',']) {
  if (items.length === 0) return null;
  if (items.some((item) => item == null)) return null; // sparse array
  const isSeparator = (t) => separators.some((value) => isPunct(t, value));
  const gaps = [gapAfter(sourceCode, open)];
  for (let i = 0; i < items.length - 1; i++) {
    // The item node's range excludes any parens wrapping it, so the
    // separator is the nearest one after the item, skipping close-parens.
    // Type members may be separated by `;` as well as `,`.
    const comma = sourceCode.getTokenAfter(items[i], {
      filter: isSeparator,
    });
    if (!comma || comma.range[0] >= close.range[0]) return null;
    // Breaks insert after the comma, but a comma-first layout
    // (@stylistic/comma-style "first") counts as broken too: the newline may
    // sit on either side of the comma, and collapse joins whichever side
    // holds it (leading side joins to '', no space before the comma).
    const beforeComma = sourceCode.getTokenBefore(comma, {
      includeComments: true,
    });
    gaps.push({
      ...gapAfter(sourceCode, comma, ' '),
      alt: { start: beforeComma.range[1], end: comma.range[0] },
      altJoin: '',
    });
  }
  // The close gap is normally between the last token and the bracket — but
  // a dangling comma can sit on either side of that break: comma-last puts
  // it before the newline (`b: 2,\n}`), comma-first after it (`\n,}`). Treat
  // the position before the dangling comma as the alt side, so a
  // comma-first layout reads as already broken instead of the two rules
  // pushing the same comma back and forth forever.
  const closeGap = gapBefore(sourceCode, close, 'close');
  const dangling = sourceCode.getTokenBefore(close, { includeComments: true });
  if (dangling && isSeparator(dangling)) {
    const beforeDangling = sourceCode.getTokenBefore(dangling, {
      includeComments: true,
    });
    closeGap.alt = {
      start: beforeDangling.range[1],
      end: dangling.range[0],
    };
    closeGap.altJoin = '';
  }
  gaps.push(closeGap);
  return gaps;
}

// Bodies that hug by keeping their opening bracket on the call's line.
const BRACKET_HUG_BODIES = new Set([
  'BlockStatement',
  'ObjectExpression',
  'ArrayExpression',
]);

// Bodies that instead take the break after the `=>`.
const ARROW_BREAK_BODIES = new Set([
  'CallExpression',
  'NewExpression',
  'ConditionalExpression',
  'TemplateLiteral',
  'TaggedTemplateExpression',
  'JSXElement',
  'JSXFragment',
  'ArrowFunctionExpression',
]);

function isHuggable(node) {
  if (
    node.type === 'ObjectExpression' ||
    node.type === 'ArrayExpression' ||
    // The pattern equivalents, for parameter lists (§3.3 #6 "as call
    // arguments" — a lone destructured parameter hugs like an options
    // object).
    node.type === 'ObjectPattern' ||
    node.type === 'ArrayPattern'
  ) {
    return true;
  }
  if (
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    // §4.5 hugs an argument "with its own internal structure", which is what
    // absorbs the break. Two shapes qualify, and they absorb it differently:
    // a bracketed body keeps its opening bracket on the call line, while the
    // bodies in ARROW_BREAK_BODIES take a break after the `=>` instead
    // (§3.3 #15). Bodies in neither set — a member path, an arithmetic
    // expression, an assignment — have nowhere to put a break, so the call
    // itself breaks and the arrow rides along on one line.
    //
    // This test is structural on purpose. Keying it on whether the argument
    // currently spans several lines would feed back on itself: breaking
    // inside the body makes it multiline, which flips the decision on the
    // next pass, and the call explodes and re-hugs forever.
    return (
      BRACKET_HUG_BODIES.has(node.body.type) ||
      (node.type === 'ArrowFunctionExpression' &&
        ARROW_BREAK_BODIES.has(node.body.type))
    );
  }
  return false;
}

/**
 * The break after an arrow's `=>` (§3.3 #15). It exists only for bodies that
 * can use the line it opens: a call or ternary that will break further, a
 * JSX element, a template, or another arrow in a chain. For a member path or
 * a binary expression there is nothing to gain — the body would sit alone on
 * the new line at the same width — so those let the enclosing call break
 * instead.
 */
function arrowBodyGroup(sourceCode, node) {
  if (node.type !== 'ArrowFunctionExpression') return null;
  if (!ARROW_BREAK_BODIES.has(node.body.type)) return null;
  const arrow = sourceCode.getTokenBefore(node.body, {
    filter: (t) => isPunct(t, '=>'),
  });
  if (!arrow) return null;
  return {
    node,
    kind: 'arrow',
    gaps: [gapAfter(sourceCode, arrow, ' ')],
  };
}

function callGroup(sourceCode, node) {
  const args = node.arguments;
  if (!args || args.length === 0) return null;
  const close = sourceCode.getLastToken(node);
  if (!isPunct(close, ')')) return null; // `new Foo` without parens
  // The call's open paren is the first `(` after the callee (or its type
  // arguments) — argument-level parens all start after it.
  const after = node.typeArguments ?? node.typeParameters ?? node.callee;
  let open = sourceCode.getTokenAfter(after);
  while (open && !isPunct(open, '(')) {
    open = sourceCode.getTokenAfter(open);
  }
  if (!open || open.range[0] >= args[0].range[0]) return null;
  const gaps = listGaps(sourceCode, open, close, args);
  if (!gaps) return null;
  // Hugging (§4.5): with exactly one huggable argument in first or last
  // position, the call never breaks at the call level — the hug target's own
  // group absorbs the break instead. The call group stays available to the
  // removal pass (an author-broken un-hugged form still collapses), with the
  // hug target's interior exempted from the inlining requirement.
  // A call whose last argument is a function keeps whatever layout the
  // author gave it. The hugged form leaves the open paren unbroken and the
  // close paren on its own line —
  //
  //   promise.then(() =>
  //     compute(value),
  //   );
  //
  // which reads as "partially broken" to the consistency pass, though it is
  // a deliberate and very common shape rather than an untidy list.
  const last = args[args.length - 1];
  const trailingFunction =
    last.type === 'FunctionExpression' ||
    last.type === 'ArrowFunctionExpression';

  const huggable = args.filter(isHuggable);
  if (
    huggable.length === 1 &&
    (huggable[0] === args[0] || huggable[0] === args[args.length - 1])
  ) {
    return { node, gaps, items: args, addable: false, hug: huggable[0].range };
  }
  return { node, gaps, items: args, complete: !trailingFunction };
}

function bracketGroup(sourceCode, node, items, openValue, closeValue) {
  const open = sourceCode.getFirstToken(node);
  if (!isPunct(open, openValue)) return null;
  if (items.length === 0 || items.some((item) => item == null)) return null;
  // Derived from the last item, not from the node: a TypeScript pattern
  // carries its type annotation inside its own range, so `{a, b}: {c: D}`
  // ends at the *annotation's* brace. Taking the node's last token would
  // put the closing break inside the annotation.
  const close = sourceCode.getTokenAfter(items[items.length - 1], {
    filter: (t) => isPunct(t, closeValue),
  });
  if (!close) return null;
  const gaps = listGaps(sourceCode, open, close, items);
  return gaps && { node, range: [open.range[0], close.range[1]], gaps, items };
}

/**
 * Necessary breaks (§3.1): block bodies, class bodies, switch cases, and
 * statement boundaries are always broken, even when the result would fit.
 * Gap kinds: 'item' indents one unit past the group's base line, 'close'
 * returns to it, 'same' keeps the indentation of the line being split
 * (statement boundaries — the new line sits at its sibling's depth).
 */
function statementListGaps(sourceCode, statements) {
  const gaps = [];
  for (let i = 1; i < statements.length; i++) {
    const first = sourceCode.getFirstToken(statements[i]);
    // A leading `;` guards ASI in semicolon-less code — `;(node).x = 1` —
    // and belongs to the line of the statement it guards, even though the
    // parser attaches it to the previous one. Breaking at this boundary
    // would strand it on a line of its own and destroy the idiom.
    const prev = sourceCode.getTokenBefore(first);
    if (prev && isPunct(prev, ';')) {
      const beforeSemi = sourceCode.getTokenBefore(prev);
      if (!beforeSemi || beforeSemi.loc.end.line < prev.loc.start.line) continue;
    }
    gaps.push(gapBefore(sourceCode, first, 'same'));
  }
  return gaps;
}

function blockGaps(sourceCode, node, body) {
  const open = sourceCode.getFirstToken(node);
  const close = sourceCode.getLastToken(node);
  if (!isPunct(open, '{') || !isPunct(close, '}')) return null;
  if (body.length === 0) return null;
  return [
    gapAfter(sourceCode, open),
    ...statementListGaps(sourceCode, body),
    gapBefore(sourceCode, close, 'close'),
  ];
}

function necessaryGroup(sourceCode, node) {
  switch (node.type) {
    case 'BlockStatement':
    case 'StaticBlock': {
      const gaps = blockGaps(sourceCode, node, node.body);
      return gaps && { node, gaps };
    }
    case 'ClassBody': {
      const gaps = blockGaps(sourceCode, node, node.body);
      return gaps && { node, gaps };
    }
    case 'SwitchStatement': {
      if (node.cases.length === 0) return null;
      const close = sourceCode.getLastToken(node);
      const open = sourceCode.getTokenBefore(
        sourceCode.getFirstToken(node.cases[0]),
        { filter: (t) => isPunct(t, '{') },
      );
      if (!open || !isPunct(close, '}')) return null;
      return {
        node,
        gaps: [
          gapAfter(sourceCode, open),
          ...statementListGaps(sourceCode, node.cases),
          gapBefore(sourceCode, close, 'close'),
        ],
      };
    }
    case 'SwitchCase': {
      if (node.consequent.length === 0) return null;
      // `case X: {` keeps its brace on the case line, the same way a
      // function body keeps `{` on the signature line — the block's own
      // necessary breaks already supply the structure.
      const braced =
        node.consequent.length === 1 &&
        node.consequent[0].type === 'BlockStatement';
      return {
        node,
        gaps: [
          ...(braced
            ? []
            : [
                gapBefore(
                  sourceCode,
                  sourceCode.getFirstToken(node.consequent[0]),
                  'item',
                ),
              ]),
          ...statementListGaps(sourceCode, node.consequent),
        ],
      };
    }
    case 'Program': {
      const gaps = statementListGaps(sourceCode, node.body);
      return gaps.length > 0 ? { node, gaps } : null;
    }
  }
  return null;
}

function isBlockBodyFunction(node) {
  return (
    (node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression') &&
    node.body.type === 'BlockStatement'
  );
}

/**
 * Method-chain candidate (§3.3 #5, §4.4): break before every dot on the
 * callee/object spine. Only a real chain qualifies — at least two
 * method-call links — and a chain whose calls take a block-bodied function
 * argument is never broken at the chain level (§4.4): the necessary breaks
 * inside those blocks already provide the structure. The whole spine is
 * absorbed either way so sub-chains don't break independently.
 */
function methodChainGroup(sourceCode, node, absorbed) {
  const dots = [];
  let callLinks = 0;
  let hasBlockBody = false;
  let current = node;
  let fromCall = false;
  while (true) {
    if (
      current.type === 'CallExpression' ||
      current.type === 'NewExpression'
    ) {
      if (current.arguments.some(isBlockBodyFunction)) hasBlockBody = true;
      absorbed.add(current);
      fromCall = current.type === 'CallExpression';
      // A parenthesized head is one unit: `(a.b.c).d().e()` breaks at .d
      // and .e, never at the dots inside the parens, which sit at a
      // different bracket depth than the rest of the chain.
      if (isParenthesized(sourceCode, current.callee)) break;
      current = current.callee;
    } else if (current.type === 'MemberExpression') {
      absorbed.add(current);
      if (!current.computed) {
        const dot = sourceCode.getTokenAfter(current.object, {
          filter: (t) => isPunct(t, '.') || isPunct(t, '?.'),
        });
        if (dot) {
          dots.push(dot);
          if (fromCall) callLinks++;
        }
      }
      fromCall = false;
      if (isParenthesized(sourceCode, current.object)) break;
      current = current.object;
    } else {
      break;
    }
  }
  if (callLinks < 2 || hasBlockBody) return null;
  // Breaks insert before the dot (§3.2), but a trailing-dot layout
  // (@stylistic/dot-location "object") counts as broken too.
  const gaps = dots
    .map((dot) => {
      const next = sourceCode.getTokenAfter(dot, { includeComments: true });
      return {
        ...gapBefore(sourceCode, dot, 'item'),
        alt: { start: dot.range[1], end: next.range[0] },
        altJoin: '',
      };
    })
    .sort((a, b) => a.start - b.start);
  return { node, gaps, kind: 'chain' };
}

/**
 * Remaining optional-break categories (§3.3 #6–13). Each group may carry an
 * explicit `range` (defaulting to node.range in the consumer): for paren
 * spans it keeps the removal pass from freezing a condition because of
 * comments or blocks in the statement body.
 */

/** #6: function/arrow parameters, as call arguments — hugging included. */
function paramsGroup(sourceCode, node) {
  const params = node.params;
  if (!params || params.length === 0) return null;
  const anchor = node.typeParameters ?? node.id ?? null;
  let open = anchor
    ? sourceCode.getTokenAfter(anchor)
    : sourceCode.getFirstToken(node);
  while (open && !isPunct(open, '(') && open.range[0] < params[0].range[0]) {
    open = sourceCode.getTokenAfter(open);
  }
  if (!isPunct(open, '(') || open.range[0] >= params[0].range[0]) return null;
  const close = sourceCode.getTokenAfter(params[params.length - 1], {
    filter: (t) => isPunct(t, ')'),
  });
  if (!close) return null;
  const gaps = listGaps(sourceCode, open, close, params);
  if (!gaps) return null;
  const range = [open.range[0], close.range[1]];
  const huggable = params.filter(isHuggable);
  if (
    huggable.length === 1 &&
    (huggable[0] === params[0] || huggable[0] === params[params.length - 1])
  ) {
    return { node, gaps, range, kind: 'params', addable: false, hug: huggable[0].range };
  }
  return { node, gaps, range, kind: 'params', items: params };
}

/** #7: inside the parens of if / while / do-while / switch. */
function conditionGroup(sourceCode, node, openAnchor, close) {
  const open = sourceCode.getTokenAfter(openAnchor, {
    filter: (t) => isPunct(t, '('),
  });
  if (!open || !isPunct(close, ')') || open.range[0] >= close.range[0])
    return null;
  return {
    node,
    range: [open.range[0], close.range[1]],
    kind: 'condition',
    gaps: [gapAfter(sourceCode, open), gapBefore(sourceCode, close, 'close')],
  };
}

/** #8: for clauses, at the semicolons. */
function forGroup(sourceCode, node) {
  if (!node.init || !node.test || !node.update) return null;
  const semi1 = sourceCode.getTokenAfter(node.init, {
    filter: (t) => isPunct(t, ';'),
  });
  const semi2 = sourceCode.getTokenAfter(node.test, {
    filter: (t) => isPunct(t, ';'),
  });
  if (!semi1 || !semi2) return null;
  // The head's own `)` — not the first `)` after the update clause, which is
  // that clause's own closing paren when it is parenthesized.
  const close = sourceCode.getTokenBefore(sourceCode.getFirstToken(node.body), {
    filter: (t) => isPunct(t, ')'),
  });
  if (!close) return null;
  return {
    node,
    range: [node.init.range[0], close.range[1]],
    gaps: [gapAfter(sourceCode, semi1, ' '), gapAfter(sourceCode, semi2, ' ')],
  };
}

/** #9: import/export specifier lists, as object literal. */
function specifierGroup(sourceCode, node, kinds) {
  const named = (node.specifiers ?? []).filter((s) => kinds.includes(s.type));
  // A lone specifier stays inline however long the line: what makes these
  // lines long is the module path, and no break inside the braces shortens
  // that. Two or more break normally. (Prettier draws the line in the same
  // place, so import blocks come out identical.)
  if (named.length < 2) return null;
  const open = sourceCode.getTokenBefore(sourceCode.getFirstToken(named[0]), {
    filter: (t) => isPunct(t, '{'),
  });
  const close = sourceCode.getTokenAfter(named[named.length - 1], {
    filter: (t) => isPunct(t, '}'),
  });
  if (!open || !close) return null;
  const gaps = listGaps(sourceCode, open, close, named);
  return gaps && { node, gaps, range: [open.range[0], close.range[1]], items: named };
}

/** #11: ternaries, before ? and before :. */
function ternaryGroup(sourceCode, node) {
  const question = sourceCode.getTokenAfter(node.test, {
    filter: (t) => isPunct(t, '?'),
  });
  const colon = sourceCode.getTokenAfter(node.consequent, {
    filter: (t) => isPunct(t, ':'),
  });
  if (!question || !colon) return null;
  return {
    node,
    kind: 'ternary',
    gaps: [
      gapBefore(sourceCode, question, 'item', ' '),
      gapBefore(sourceCode, colon, 'item', ' '),
    ],
  };
}

/** #12: JSX attributes, as object properties. (Children are out of scope.) */
function jsxGroup(sourceCode, node) {
  const attrs = node.attributes;
  if (!attrs || attrs.length === 0) return null;
  const last = sourceCode.getLastToken(node);
  const beforeLast = sourceCode.getTokenBefore(last);
  const closeToken =
    node.selfClosing && isPunct(beforeLast, '/') ? beforeLast : last;
  return {
    node,
    items: attrs,
    gaps: [
      ...attrs.map((attr) =>
        gapBefore(sourceCode, sourceCode.getFirstToken(attr), 'item', ' '),
      ),
      gapBefore(sourceCode, closeToken, 'close', node.selfClosing ? ' ' : ''),
    ],
  };
}

// Assignment operators, for the break after them (§3.3 #16).
const ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=',
  '<<=', '>>=', '>>>=', '&=', '|=', '^=',
  '&&=', '||=', '??=',
]);

/**
 * #16: the break after an assignment's operator, putting the right-hand
 * side on its own line.
 *
 * Marked `fallback`, so it is only reached when a line has no other
 * candidate at all. When the right-hand side can break — a call, an object,
 * a ternary — breaking *it* is better, and that is what already happens.
 * This exists for the case where nothing inside the value can be split: a
 * member path, a template, a cast. Those lines were simply left long.
 */
function assignmentGroup(sourceCode, node) {
  const right = node.right ?? node.init;
  if (!right) return null;
  const operator = sourceCode.getTokenBefore(right, {
    filter: (t) => t.type === 'Punctuator' && ASSIGN_OPS.has(t.value),
  });
  if (!operator || operator.range[1] > right.range[0]) return null;
  return {
    node,
    kind: 'assign',
    fallback: true,
    gaps: [gapAfter(sourceCode, operator, ' ')],
  };
}

/** #13: variable declarator lists, after the comma. */
function declaratorGroup(sourceCode, node) {
  const decls = node.declarations;
  if (!decls || decls.length < 2) return null;
  const gaps = [];
  for (let i = 0; i < decls.length - 1; i++) {
    const comma = sourceCode.getTokenAfter(decls[i], {
      filter: (t) => isPunct(t, ','),
    });
    if (!comma) return null;
    gaps.push(gapAfter(sourceCode, comma, ' '));
  }
  return { node, gaps };
}

function precedenceOf(node) {
  if (node.type === 'AssignmentExpression') return 2;
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression')
    return BINARY_PRECEDENCE[node.operator] ?? null;
  return null;
}

/** Right-associative operators chain through the right operand. */
function nextOperand(node) {
  if (node.type === 'AssignmentExpression' || node.operator === '**')
    return node.right;
  return node.left;
}

function isParenthesized(sourceCode, node) {
  const before = sourceCode.getTokenBefore(node);
  const after = sourceCode.getTokenAfter(node);
  return isPunct(before, '(') && isPunct(after, ')');
}

/**
 * An operator chain candidate rooted at `node`: every operator in the run of
 * equal precedence (§3.3 #4, §4.2). Members of the run are recorded in
 * `absorbed` so they don't produce their own candidates.
 *
 * Which side of the operator breaks is `operatorSide` — inferred from the
 * file, 'after' fallback. Each gap carries the other side as `alt`: a
 * newline on either side counts as broken, so Fold never fights
 * `@stylistic/operator-linebreak` regardless of how it's configured — worst
 * case it inserts on the wrong side once and the fix loop settles (§2.2).
 */
function chainGroup(sourceCode, node, absorbed, operatorSide) {
  const precedence = precedenceOf(node);
  const members = [];
  let current = node;
  while (
    precedenceOf(current) === precedence &&
    (current === node || !isParenthesized(sourceCode, current))
  ) {
    members.push(current);
    current = nextOperand(current);
  }
  // Assignment breaks only as a chain (`a = b = c`, §4.2); a lone `=` is not
  // a break candidate — the right-hand side's own structure breaks instead.
  if (node.type === 'AssignmentExpression' && members.length < 2) return null;
  for (const member of members) absorbed.add(member);
  const gaps = members.map((member) => {
    const operator = sourceCode.getTokenAfter(member.left, {
      filter: (t) => t.value === member.operator,
    });
    const prev = sourceCode.getTokenBefore(operator, { includeComments: true });
    const next = sourceCode.getTokenAfter(operator, { includeComments: true });
    const before = { start: prev.range[1], end: operator.range[0] };
    const after = { start: operator.range[1], end: next.range[0] };
    const main = operatorSide === 'before' ? before : after;
    const alt = operatorSide === 'before' ? after : before;
    return { start: main.start, end: main.end, alt, kind: 'item', join: ' ' };
  });
  gaps.sort((a, b) => a.start - b.start);
  // `kind: 'operator'` marks a group with no bracket of its own. When such a
  // group already starts its line, the continuation indent is the nesting
  // signal, so its operands align to that line instead of stepping in again
  // (see the indent choice in format.js).
  return { node, gaps, kind: 'operator' };
}

/**
 * Collect break candidates. Returns:
 *  - candidates: width-gated optional-break groups, in walk order
 *  - necessary: §3.1 groups, broken unconditionally
 *
 * When a call is both a chain root and an argument-list group, the chain
 * candidate is pushed first: for the same node, the chain-level break is
 * preferred, and the selection sort is stable.
 */
export function collectGroups(sourceCode, operatorSide = 'after') {
  const candidates = [];
  const necessary = [];
  const absorbed = new Set();
  // Offsets where a statement begins. A bracket-less group starting one of
  // these is a statement's own first token, so its continuation lines
  // indent; a bracket-less group starting anywhere else already sits on a
  // continuation line and must not step in again (see format.js).
  const statementStarts = new Set();
  // Ternaries chained through the alternate (`a ? b : c ? d : e`) are one
  // construct, not nested ones, so they share a single indent level.
  const flatTernaries = new Set();
  walk(sourceCode.ast, (node) => {
    if (/(Statement|Declaration)$/.test(node.type)) {
      statementStarts.add(node.range[0]);
    }
    if (
      node.type === 'ConditionalExpression' &&
      node.alternate.type === 'ConditionalExpression'
    ) {
      flatTernaries.add(node.alternate);
    }
    const need = necessaryGroup(sourceCode, node);
    if (need) necessary.push(need);
    switch (node.type) {
      case 'CallExpression':
      case 'NewExpression':
      case 'MemberExpression': {
        if (!absorbed.has(node)) {
          const chain = methodChainGroup(sourceCode, node, absorbed);
          if (chain) candidates.push(chain);
        }
        if (node.type !== 'MemberExpression') {
          const call = callGroup(sourceCode, node);
          if (call) candidates.push(call);
        }
        break;
      }
      case 'ArrayExpression': {
        const group = bracketGroup(sourceCode, node, node.elements, '[', ']');
        if (group) candidates.push(group);
        break;
      }
      case 'ObjectExpression': {
        const group = bracketGroup(sourceCode, node, node.properties, '{', '}');
        if (group) candidates.push(group);
        break;
      }
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'AssignmentExpression': {
        if (!absorbed.has(node)) {
          const chain = chainGroup(sourceCode, node, absorbed, operatorSide);
          if (chain) candidates.push(chain);
        }
        if (node.type === 'AssignmentExpression') {
          const assign = assignmentGroup(sourceCode, node);
          if (assign) candidates.push(assign);
        }
        break;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        // The body break comes first: for `f(x => g(a, b))` it is preferred
        // over breaking the parameter list, and outermost-first would
        // otherwise pick whichever starts earlier.
        const body = arrowBodyGroup(sourceCode, node);
        if (body) candidates.push(body);
        const group = paramsGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'IfStatement': {
        const close = sourceCode.getTokenBefore(
          sourceCode.getFirstToken(node.consequent),
          { filter: (t) => isPunct(t, ')') },
        );
        const group = conditionGroup(
          sourceCode,
          node,
          sourceCode.getFirstToken(node),
          close,
        );
        if (group) candidates.push(group);
        break;
      }
      case 'WhileStatement': {
        const close = sourceCode.getTokenBefore(
          sourceCode.getFirstToken(node.body),
          { filter: (t) => isPunct(t, ')') },
        );
        const group = conditionGroup(
          sourceCode,
          node,
          sourceCode.getFirstToken(node),
          close,
        );
        if (group) candidates.push(group);
        break;
      }
      case 'DoWhileStatement': {
        const whileKeyword = sourceCode.getTokenAfter(node.body, {
          filter: (t) => t.value === 'while',
        });
        const last = sourceCode.getLastToken(node);
        const close = isPunct(last, ';')
          ? sourceCode.getTokenBefore(last)
          : last;
        const group =
          whileKeyword && conditionGroup(sourceCode, node, whileKeyword, close);
        if (group) candidates.push(group);
        break;
      }
      case 'SwitchStatement': {
        const brace = sourceCode.getTokenAfter(node.discriminant, {
          filter: (t) => isPunct(t, '{'),
        });
        const close = brace && sourceCode.getTokenBefore(brace);
        const group =
          close &&
          conditionGroup(sourceCode, node, sourceCode.getFirstToken(node), close);
        if (group) candidates.push(group);
        break;
      }
      case 'ForStatement': {
        const group = forGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'ImportDeclaration': {
        const group = specifierGroup(sourceCode, node, ['ImportSpecifier']);
        if (group) candidates.push(group);
        break;
      }
      case 'ExportNamedDeclaration': {
        const group = specifierGroup(sourceCode, node, ['ExportSpecifier']);
        if (group) candidates.push(group);
        break;
      }
      case 'ObjectPattern': {
        const group = bracketGroup(sourceCode, node, node.properties, '{', '}');
        if (group) candidates.push(group);
        break;
      }
      case 'ArrayPattern': {
        const group = bracketGroup(sourceCode, node, node.elements, '[', ']');
        if (group) candidates.push(group);
        break;
      }
      case 'ConditionalExpression': {
        const group = ternaryGroup(sourceCode, node);
        if (group) {
          if (flatTernaries.has(node)) group.flat = true;
          candidates.push(group);
        }
        break;
      }
      case 'JSXOpeningElement': {
        const group = jsxGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'VariableDeclaration': {
        const group = declaratorGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'VariableDeclarator': {
        const assign = assignmentGroup(sourceCode, node);
        if (assign) candidates.push(assign);
        break;
      }
    }
  });
  // When a trailing arrow takes the break after its `=>`, the call's closing
  // paren goes on its own line as well:
  //
  //   promise.then((response) =>
  //     transformTheResponse(response, options, extra)
  //   );
  //
  // The two breaks are one decision, so the close gap joins the arrow's
  // group rather than staying with the call — whose own gaps do not break,
  // since the arrow is hugging it.
  const arrowGroups = new Map(
    candidates.filter((g) => g.kind === 'arrow').map((g) => [g.node, g]),
  );
  for (const group of candidates) {
    if (!group.items || group.items.length === 0) continue;
    if (group.kind === 'params' || group.kind === 'arrow') continue;
    const arrow = arrowGroups.get(group.items[group.items.length - 1]);
    if (!arrow) continue;
    const closeGap = group.gaps[group.gaps.length - 1];
    if (closeGap && closeGap.kind === 'close') arrow.gaps.push(closeGap);
  }

  // A hugged argument's signature is part of the call's head: the break is
  // absorbed by its body, so its parameter list must not become the next
  // candidate. Without this, `it("...", function (done) {` breaks as
  // `function (\n  done\n) {` — the call level is off the table, so the
  // params are all that is left.
  const hugged = new Set(
    candidates.filter((g) => g.hug).map((g) => g.hug.join(':')),
  );
  for (const group of candidates) {
    if (group.kind === 'params' && hugged.has(group.node.range.join(':'))) {
      group.addable = false;
    }
  }

  // Never fold inside a template literal (§3.3 #14 was to be a last
  // resort; in practice the results — a method chain split across an
  // interpolation — read worse than a long line, and the line is usually
  // long because of the template's *text*, which no break can shorten).
  // Marking these un-addable also stops the consistency pass touching them,
  // so a hand-written layout inside an interpolation is left exactly alone.
  const templateRanges = [];
  walk(sourceCode.ast, (node) => {
    if (node.type === 'TemplateLiteral') templateRanges.push(node.range);
  });
  for (const group of candidates) {
    const [start, end] = group.range ?? group.node.range;
    if (
      templateRanges.some((range) => range[0] < start && end <= range[1])
    ) {
      group.addable = false;
    }
  }

  return { candidates, necessary, statementStarts };
}

// =======================
// = The core (§2.4, §6) =
// =======================

/**
 * The pure core (§2.4): format(sourceCode, options) → Edit[].
 *
 * An Edit is:
 *   {
 *     range: [start, end],   // source offsets; text in this range is replaced
 *     text: string,          // replacement (newline + indent)
 *     loc: { start, end },   // where the rule reports it — the real token
 *     messageId: string,     // 'overWidth' | 'necessaryBreak' |
 *                            //   'inconsistentGroup'
 *     data?: object,         // message interpolation data
 *   }
 *
 * Only `range` and `text` affect the output text; the rest is reporting
 * metadata for the rule adapter. Edits are returned sorted descending by
 * position (§2.5) so the test harness can apply them to a string without
 * offset bookkeeping.
 *
 * The algorithm works over a *projection* (§6): virtual lines. A virtual
 * line is a contiguous source range plus the indent text that will precede
 * it once edits apply. Breaking a group splits the virtual lines its gaps
 * live on; nothing is applied to the text until ESLint applies the fixes.
 */

export const DEFAULT_MAX_WIDTH = 80;

const indentCache = new WeakMap();

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

function physicalLines(text) {
  const lines = [];
  let start = 0;
  LINE_BREAK.lastIndex = 0;
  let match;
  while ((match = LINE_BREAK.exec(text))) {
    lines.push({ indent: '', start, end: match.index });
    start = match.index + match[0].length;
  }
  lines.push({ indent: '', start, end: text.length });
  return lines;
}

function lineWidth(text, vline) {
  return measureLine(vline.indent + text.slice(vline.start, vline.end));
}

/** Leading whitespace the line will have once edits apply. */
function lineIndent(text, vline) {
  return vline.indent + /^[ \t]*/.exec(text.slice(vline.start, vline.end))[0];
}

/**
 * The file's line ending, inferred like the indent unit (§7). Inserting a
 * bare '\n' into a CRLF file would leave mixed endings behind — a diff on
 * every touched line for Windows projects, and a fight with
 * `@stylistic/linebreak-style`.
 */
function inferNewline(text) {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (text[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Which side of a binary operator the file breaks on, inferred like the
 * indent unit (§7): count existing operator-adjacent newlines. Only
 * side-unambiguous operator tokens are sampled — '+', '-', '*' and friends
 * could be unary or generator stars. Fallback is 'after', matching
 * `@stylistic/operator-linebreak`'s default, so a file with no signal agrees
 * with the ecosystem default.
 */
const INFER_OPS = new Set([
  '&&', '||', '??', '==', '===', '!=', '!==', '<=', '>=',
  '<<', '>>', '>>>', '%', '**', '&', '|', '^',
  '=', '+=', '-=', '*=', '/=', '%=', '&&=', '||=', '??=',
]);

function inferOperatorSide(sourceCode) {
  const tokens = sourceCode.ast.tokens ?? [];
  let leading = 0;
  let trailing = 0;
  for (let i = 1; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token.type !== 'Punctuator' || !INFER_OPS.has(token.value)) continue;
    if (tokens[i - 1].loc.end.line < token.loc.start.line) leading++;
    else if (token.loc.end.line < tokens[i + 1].loc.start.line) trailing++;
  }
  return leading > trailing ? 'before' : 'after';
}

/** First source offset on the line where the width crosses maxWidth. */
function overflowStart(text, vline, maxWidth) {
  const indentWidth = measureLine(vline.indent);
  if (indentWidth > maxWidth) return vline.start;
  // Advance one character at a time rather than re-measuring the whole
  // prefix at each step, which would be quadratic in the overflow column.
  let width = indentWidth;
  let offset = vline.start;
  for (const char of text.slice(vline.start, vline.end)) {
    width += char === '\t' ? TAB_WIDTH - (width % TAB_WIDTH) : 1;
    if (width > maxWidth) return offset;
    offset += char.length;
  }
  return vline.end;
}

export function format(sourceCode, options = {}) {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const text = sourceCode.text;

  let inferred = indentCache.get(sourceCode);
  if (inferred === undefined) {
    inferred = {
      unit: inferIndentUnit(sourceCode.lines),
      operatorSide: inferOperatorSide(sourceCode),
      newline: inferNewline(sourceCode.text),
    };
    indentCache.set(sourceCode, inferred);
  }
  const { unit, operatorSide, newline } = inferred;

  const { candidates, necessary, statementStarts } = collectGroups(
    sourceCode,
    operatorSide,
  );
  const vlines = physicalLines(text);
  const edits = [];
  const consumedGaps = new Set();

  const rangeHasBreak = (range) => {
    LINE_BREAK.lastIndex = 0;
    return LINE_BREAK.test(text.slice(range.start, range.end));
  };

  // A gap with an `alt` range (operator gaps) counts as broken when either
  // side of the operator carries the newline — Fold never fights an existing
  // break over which side the operator sits on.
  const hasBreak = (gap) =>
    rangeHasBreak(gap) || (gap.alt !== undefined && rangeHasBreak(gap.alt));

  // Half-open [start, end): a split leaves a zero-width boundary shared by
  // two lines, and an offset there belongs to the line that starts at it.
  const findLine = (offset) => {
    const index = vlines.findIndex(
      (vl) => vl.start <= offset && offset < vl.end,
    );
    return index === -1
      ? vlines.findIndex((vl) => vl.start <= offset && offset <= vl.end)
      : index;
  };

  function breakGroup(group, messageId) {
    const groupStart = (group.range ?? group.node.range)[0];
    const openLine = vlines[findLine(groupStart)];
    const baseIndent = lineIndent(text, openLine);
    // No staircases. An operator chain or ternary has no bracket of its
    // own, so when it already begins a continuation line, that line's
    // indent *is* its nesting level — stepping in again would leave its
    // first part a level shallower than the rest:
    //
    //   call(
    //     a &&
    //       b &&      <- the staircase a second step produces
    //   );
    //
    // A bracket-less group that begins a *statement* is different: nothing
    // has indented it yet, so its continuation lines do step in. Ternaries
    // chained through the alternate share one level for the same reason —
    // `a ? b : c ? d : e` is one construct, not nested ones.
    const bracketless = group.kind === 'operator' || group.kind === 'ternary';
    const startsLine = text.slice(openLine.start, groupStart).trim() === '';
    const align =
      group.flat === true ||
      (bracketless && startsLine && !statementStarts.has(groupStart));
    const itemIndent = align ? baseIndent : baseIndent + unit;

    for (const gap of group.gaps) {
      consumedGaps.add(gap);
      if (hasBreak(gap)) continue;
      if (isForbiddenBreak(sourceCode, gap)) continue;
      const index = vlines.findIndex(
        (vl) => vl.start <= gap.start && gap.end <= vl.end,
      );
      if (index === -1) continue;
      const vl = vlines[index];
      const newIndent =
        gap.kind === 'close'
          ? baseIndent
          : gap.kind === 'same'
            ? lineIndent(text, vl)
            : itemIndent;
      vlines.splice(
        index,
        1,
        { indent: vl.indent, start: vl.start, end: gap.start },
        { indent: newIndent, start: gap.end, end: vl.end },
      );
      const loc = sourceCode.getLocFromIndex(gap.end);
      edits.push({
        range: [gap.start, gap.end],
        text: newline + newIndent,
        loc: { start: loc, end: loc },
        messageId,
        data: { maxWidth: String(maxWidth) },
      });
    }
  }

  // Necessary breaks (§3.1) are unconditional: block bodies, class bodies,
  // switch cases, and statement boundaries are always on their own lines,
  // even when the one-liner would fit.
  for (const group of necessary) {
    breakGroup(group, 'necessaryBreak');
  }

  const groupRange = (group) => group.range ?? group.node.range;
  const BLANK_LINE = /(\r?\n)[ \t]*(\r?\n)/;

  // Consistency pass (§5). Fold never joins lines: a break the author put
  // there is a decision, and undoing it is what makes formatters
  // adversarial (an FP `compose()` pipeline has no recourse). What Fold
  // does enforce is §4.3 — a group is entirely inline or entirely broken —
  // so a *partially* broken group gets completed to one item per line.
  //
  // Frozen, same taxonomy as before: a blank line inside (§3.4) or a
  // comment inside means the author grouped something deliberately and
  // Fold can't know what.
  function completeGroup(group) {
    if (group.addable === false) return; // hug level never breaks (§4.5)
    // Method chains are exempt. A chain the author broke at some dots but
    // not others is a deliberate head/tail split — `Object.keys(value)`
    // kept whole, then `.filter(...)` and `.map(...)` on their own lines —
    // and completing it would pull the head apart. §4.3's all-or-nothing is
    // about element lists, where a half-broken list is just untidy.
    if (group.kind === 'chain') return;
    // An arrow group's gaps are not a list of peers: the break after `=>`
    // and the enclosing call's closing paren are one decision, and the
    // closing paren is broken by every ordinary call break too. Treating
    // them as a group to "complete" would break the `=>` of every arrow
    // sitting in an already-broken call.
    if (group.kind === 'arrow') return;
    if (group.complete === false) return;
    const gaps = group.gaps;
    const broken = gaps.filter(hasBreak);
    if (broken.length === 0) return; // untouched — nothing to be consistent with
    const breakable = gaps.filter((gap) => !isForbiddenBreak(sourceCode, gap));
    if (broken.length >= breakable.length) return; // already consistent

    const [rangeStart, rangeEnd] = groupRange(group);
    if (BLANK_LINE.test(text.slice(rangeStart, rangeEnd))) return;
    if (
      sourceCode
        .getCommentsInside(group.node)
        .some((c) => rangeStart <= c.range[0] && c.range[1] <= rangeEnd)
    )
      return;

    breakGroup(group, 'inconsistentGroup');
  }

  const outermostFirst = [...candidates].sort(
    (a, b) => groupRange(a)[0] - groupRange(b)[0] || groupRange(b)[1] - groupRange(a)[1],
  );
  for (const group of outermostFirst) {
    completeGroup(group);
  }

  // Gap position index. Without it, every over-width line would scan every
  // candidate group in the file, making the addition pass quadratic in file
  // size — seconds per pass on a large file, times ten fix passes.
  const gapIndex = [];
  for (const group of candidates) {
    for (const gap of group.gaps) gapIndex.push({ gap, group });
  }
  gapIndex.sort((a, b) => a.gap.start - b.gap.start);
  const gapStarts = gapIndex.map((entry) => entry.gap.start);

  /** Candidate groups holding at least one gap that lies within `vl`. */
  function groupsOnLine(vl) {
    let lo = 0;
    let hi = gapStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gapStarts[mid] < vl.start) lo = mid + 1;
      else hi = mid;
    }
    const found = new Set();
    for (let i = lo; i < gapIndex.length && gapStarts[i] <= vl.end; i++) {
      if (gapIndex[i].gap.end <= vl.end) found.add(gapIndex[i].group);
    }
    return found;
  }

  /**
   * Is this line over width only because of a comment at the end of it?
   * §7.1 calls that unbreakable: the code fits, and the comment cannot be
   * shortened or moved — moving it to its own line is a vertical-spacing
   * change, which §3.4 forbids. Breaking the code to make room for a
   * comment reformats the wrong thing.
   */
  const comments = sourceCode.getAllComments();
  function overflowIsTrailingComment(vl) {
    for (const comment of comments) {
      const [start, end] = comment.range;
      if (start < vl.start || start >= vl.end) continue;
      if (end < vl.end) continue; // not the tail of the line
      const code = vl.indent + text.slice(vl.start, start).trimEnd();
      if (measureLine(code) <= maxWidth) return true;
    }
    return false;
  }

  // Addition pass (§6 step 6): repeatedly break the outermost group that
  // contains an over-width line's overflow, until every line either fits or
  // has no legal candidate (§7.1: unbreakable lines get silence).
  //
  // The cursor does not advance after a break: the line was split, so the
  // first half is re-examined in case it is still too long. Termination is
  // by exhaustion — breakGroup consumes every gap of the group it breaks,
  // so a group can be chosen at most once.
  for (let cursor = 0; cursor < vlines.length; ) {
    const vl = vlines[cursor];
    if (lineWidth(text, vl) <= maxWidth || overflowIsTrailingComment(vl)) {
      cursor++;
      continue;
    }
    const overflow = overflowStart(text, vl, maxWidth);
    /**
     * A one-item group whose item is atomic and already wider than the
     * limit cannot be helped by breaking: the item lands on a line of its
     * own at exactly the width it had. That is two extra lines bought for
     * nothing —
     *
     *   <a
     *     href="https://…107 characters…"
     *   >
     *
     * Only the single-item case is excluded. With two or more items,
     * splitting them apart shortens the line even when one of them stays
     * over the limit.
     */
    const cannotHelp = (group) => {
      if (!group.items || group.items.length !== 1) return false;
      const item = group.items[0];
      if (!item || !item.range) return false;
      const [itemStart, itemEnd] = item.range;
      const hasInnerCandidate = gapIndex.some(
        ({ gap }) =>
          // The group's own boundary gaps sit exactly on the item's edges
          // (and are zero-width when the source has no spaces there), so
          // they would otherwise look like candidates inside the item.
          !group.gaps.includes(gap) &&
          itemStart <= gap.start &&
          gap.end <= itemEnd &&
          !consumedGaps.has(gap) &&
          !hasBreak(gap) &&
          !isForbiddenBreak(sourceCode, gap),
      );
      if (hasInnerCandidate) return false;
      const indent = lineIndent(text, vl) + unit;
      return measureLine(indent + text.slice(itemStart, itemEnd)) > maxWidth;
    };

    const onLine = [...groupsOnLine(vl)].filter(
      (group) =>
        group.addable !== false &&
        !cannotHelp(group) &&
        group.gaps.some(
          (gap) =>
            !consumedGaps.has(gap) &&
            !hasBreak(gap) &&
            vl.start <= gap.start &&
            gap.end <= vl.end &&
            !isForbiddenBreak(sourceCode, gap),
        ),
    );
    // Fallback groups (§3.3 #16, the break after an assignment operator) are
    // last resort by construction: whenever anything inside the value can be
    // split, splitting that reads better. They are only consulted when the
    // line has nothing else, and only when the head they would leave behind
    // actually fits — otherwise the break buys nothing.
    const breakable = onLine.filter((group) => !group.fallback);
    if (breakable.length === 0) {
      const rescue = onLine.filter(
        (group) =>
          group.fallback &&
          group.gaps.some((gap) => {
            if (consumedGaps.has(gap) || hasBreak(gap)) return false;
            // Both halves have to fit, or the break achieves nothing: a
            // 200-character string moved onto its own line is still a
            // 200-character line, one line further down.
            const head = text.slice(vl.start, gap.start).trimEnd();
            const tail = text.slice(gap.end, vl.end);
            return (
              measureLine(vl.indent + head) <= maxWidth &&
              measureLine(lineIndent(text, vl) + unit + tail) <= maxWidth
            );
          }),
      );
      if (rescue.length === 0) {
        cursor++;
        continue;
      }
      rescue.sort(
        (a, b) =>
          groupRange(a)[0] - groupRange(b)[0] || groupRange(b)[1] - groupRange(a)[1],
      );
      breakGroup(rescue[0], 'overWidth');
      continue;
    }

    // Prefer a group that spans the overflow: breaking one that ends before
    // it (`foo(a) + bar(oversized...)`) would split the wrong thing. But
    // when nothing spans it — a line pushed over by a trailing `;` or `)`
    // that belongs to no group — fall back to any group with a gap before
    // the overflow, which still moves that tail down. Without the fallback
    // such a line is silently left long even though it has a legal break.
    const spanning = breakable.filter(
      (group) => groupRange(group)[1] > overflow,
    );
    const usable =
      spanning.length > 0
        ? spanning
        : breakable.filter((group) =>
            group.gaps.some((gap) => gap.start < overflow),
          );
    if (usable.length === 0) {
      cursor++;
      continue;
    }
    usable.sort(
      (a, b) =>
        groupRange(a)[0] - groupRange(b)[0] || groupRange(b)[1] - groupRange(a)[1],
    );
    breakGroup(usable[0], 'overWidth');
  }

  edits.sort((a, b) => b.range[0] - a.range[0]);
  return edits;
}

/** Apply an edit list (as returned by format: sorted descending) to text. */
export function applyEdits(text, edits) {
  let result = text;
  for (const edit of edits) {
    result =
      result.slice(0, edit.range[0]) + edit.text + result.slice(edit.range[1]);
  }
  return result;
}

// =========================
// = The rule (§2.1, §2.3) =
// =========================

/**
 * fold/breaks — decides where the newlines go.
 *
 * The rule is an adapter (§2.4): call the pure format() core, emit each Edit
 * as its own surgical fix (§2.3). All decisions live in format().
 */
export const breaks = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Insert and remove line breaks to fit a maximum width.',
    },
    fixable: 'whitespace',
    schema: [
      {
        type: 'object',
        properties: {
          maxWidth: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      overWidth: 'Line exceeds {{maxWidth}} characters.',
      necessaryBreak: 'Missing line break.',
      inconsistentGroup:
        'This group is partially broken; break every element or none.',
    },
    defaultOptions: [{ maxWidth: DEFAULT_MAX_WIDTH }],
  },

  create(context) {
    const maxWidth = context.options[0]?.maxWidth ?? DEFAULT_MAX_WIDTH;

    return {
      'Program:exit'() {
        for (const edit of format(context.sourceCode, { maxWidth })) {
          context.report({
            loc: edit.loc,
            messageId: edit.messageId,
            data: edit.data,
            fix: (fixer) => fixer.replaceTextRange(edit.range, edit.text),
          });
        }
      },
    };
  },
};

// ==============================
// = The plugin (§2.1) =
// ==============================

const plugin = {
  meta: {
    name: 'eslint-plugin-fold',
    version: '0.1.0',
  },
  rules: { breaks },
  configs: {},
};

// Self-referential, so the config object has to be attached after the
// plugin exists. `name` shows up in flat-config error messages and
// `--inspect-config`.
plugin.configs.recommended = {
  name: 'fold/recommended',
  plugins: { fold: plugin },
  rules: { 'fold/breaks': 'error' },
};

export default plugin;
