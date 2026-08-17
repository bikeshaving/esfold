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
function listGaps(sourceCode, open, close, items) {
  if (items.length === 0) return null;
  if (items.some((item) => item == null)) return null; // sparse array
  const gaps = [gapAfter(sourceCode, open)];
  for (let i = 0; i < items.length - 1; i++) {
    // The item node's range excludes any parens wrapping it, so the
    // separator is the nearest comma after the item, skipping close-parens.
    const comma = sourceCode.getTokenAfter(items[i], {
      filter: (t) => isPunct(t, ','),
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
  if (isPunct(dangling, ',')) {
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
    // absorbs the break: a block, or a body that is itself a bracketed
    // group. A body with none — `(resolve) => (r.onstop = ...)` — cannot
    // absorb anything, and hugging it only takes the call level off the
    // table, leaving the arrow's *parameter list* as the next candidate.
    //
    // This test is structural on purpose. Keying it on whether the argument
    // currently spans several lines would feed back on itself: breaking
    // inside the body makes it multiline, which flips the decision on the
    // next pass, and the call explodes and re-hugs forever.
    return (
      node.body.type === 'BlockStatement' ||
      node.body.type === 'ObjectExpression' ||
      node.body.type === 'ArrayExpression' ||
      node.body.type === 'CallExpression' ||
      node.body.type === 'NewExpression'
    );
  }
  return false;
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
    return { node, gaps, addable: false, hug: huggable[0].range };
  }
  return { node, gaps, complete: !trailingFunction };
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
  return gaps && { node, range: [open.range[0], close.range[1]], gaps };
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
  return { node, gaps, range, kind: 'params' };
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
  return gaps && { node, gaps, range: [open.range[0], close.range[1]] };
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
    gaps: [
      ...attrs.map((attr) =>
        gapBefore(sourceCode, sourceCode.getFirstToken(attr), 'item', ' '),
      ),
      gapBefore(sourceCode, closeToken, 'close', node.selfClosing ? ' ' : ''),
    ],
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
        break;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
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
    }
  });
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
