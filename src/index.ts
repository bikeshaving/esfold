import type { Rule, Linter, ESLint } from 'eslint';
import type { TSESTree } from '@typescript-eslint/types';
import type { TSESLint } from '@typescript-eslint/utils';

type Node = TSESTree.Node;
type Token = TSESTree.Token;
type Comment = TSESTree.Comment;
type Position = TSESTree.Position;
type Range = [number, number];

interface TokenOptions {
  includeComments?: boolean;
  filter?: (token: Token) => boolean;
}

type Source = TSESLint.SourceCode;

/** Whitespace between two tokens, and what a collapsed break becomes there. */
interface Gap {
  start: number;
  end: number;
  kind: 'item' | 'close' | 'same';
  join?: string;
  // Operator gaps carry the other side here: a newline on either side counts.
  alt?: { start: number; end: number };
}

type GroupKind =
  | 'chain'
  | 'arrow'
  | 'params'
  | 'operator'
  | 'ternary'
  // Set for description only; nothing branches on these.
  | 'assign'
  | 'condition';

/** A set of gaps that break together, all or none. */
interface Group {
  node: Node;
  gaps: Gap[];
  kind?: GroupKind;
  items?: (Node | null)[];
  range?: Range;
  // Excluded from the addition pass, but still completed for consistency.
  addable?: boolean;
  complete?: boolean;
  // Consulted only when a line has no other candidate.
  fallback?: boolean;
  flat?: boolean;
  hug?: Range;
  // Broken unconditionally rather than only when the line is too long.
  necessary?: boolean;
}

type MessageId = 'overWidth' | 'necessaryBreak' | 'inconsistentGroup';

interface Edit {
  range: Range;
  text: string;
  loc: { start: Position; end: Position };
  messageId: MessageId;
  data?: Record<string, string>;
}

/** A source range plus the indent it will carry once edits apply. */
interface VLine {
  indent: string;
  start: number;
  end: number;
}

type OperatorSide = 'before' | 'after';

// 2 matches Prettier's default. The one input Fold cannot read off the file:
// a tab's width is a viewer preference, not a property of the source.
const DEFAULT_TAB_WIDTH = 2;

// Mirrors @stylistic/max-len's computeLineLength, quirks included; the two
// disagreeing about which lines are too long is worse than sharing a quirk.
function measureLine(text: string, tabWidth: number): number {
  let extra = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\t') continue;
    extra += tabWidth - ((i + extra) % tabWidth) - 1;
  }
  let codePoints = 0;
  for (const _ of text) codePoints++;
  return codePoints + extra;
}

function inferIndentUnit(lines: string[]): string {
  const counts = new Map();
  let prev = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const ws = /^[ \t]*/.exec(line)![0];
    if (prev !== null && ws.length > prev.length && ws.startsWith(prev)) {
      const delta = ws.slice(prev.length);
      // Mixed deltas like '\t ' come from continuation alignment, not a
      // nesting step; repeating one emits the tab/space mixture linters flag.
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

function looksLikeOperandEnd(token: Token | null): boolean {
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

function isForbiddenBreak(sourceCode: Source, gap: Gap): boolean {
  const boundary = sourceCode.getTokenByRangeStart(gap.end, {
    includeComments: true,
  });
  if (!boundary) return true;

  // Comments take no part in ASI, so look past them. Including them lets
  // `return /* c */ <break> value` through, silently returning undefined.
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
  // Token type is unreliable here: espree calls `yield` a Keyword but `await`
  // and `async` Identifiers. Match on value.
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

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    const isNode = (v: unknown): v is Node =>
      !!v && typeof (v as Node).type === 'string';
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

// The real ECMAScript precedence table. Lower binds looser and breaks first.
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

// `join` is what a collapsed break becomes: '' for bracket and dot gaps, ' '
// for comma and operator gaps. Necessary gaps carry none.
function gapAfter(sourceCode: Source, tokenOrNode: Node | Token, join = ''): Gap {
  const next = sourceCode.getTokenAfter(tokenOrNode, { includeComments: true });
  return { start: tokenOrNode.range[1], end: next!.range[0], kind: 'item', join };
}

function gapBefore(
  sourceCode: Source,
  token: Node | Token,
  kind: Gap['kind'],
  join = '',
): Gap {
  const prev = sourceCode.getTokenBefore(token, { includeComments: true });
  return { start: prev!.range[1], end: token.range[0], kind, join };
}

// Narrows to the punctuator subtype, not to Token: "not this punctuator" must
// leave an ordinary token still typed as a token.
function isPunct(
  token: Token | null | undefined,
  value: string,
): token is TSESTree.PunctuatorToken {
  return !!token && token.type === 'Punctuator' && token.value === value;
}

function listGaps(
  sourceCode: Source,
  open: Token,
  close: Token,
  items: (Node | null)[],
  separators: string[] = [','],
): Gap[] | null {
  if (items.length === 0) return null;
  if (items.some((item) => item == null)) return null; // sparse array
  const isSeparator = (t: Token) => separators.some((value) => isPunct(t, value));
  const gaps: Gap[] = [gapAfter(sourceCode, open)];
  for (let i = 0; i < items.length - 1; i++) {
    // A TSPropertySignature's range covers its own `;`, so the next separator
    // found belongs to the following member and breaking there lands inside it.
    const separator = sourceCode.getTokenAfter(items[i]!, {
      filter: isSeparator,
    });
    const comma =
      separator && separator.range[0] < items[i + 1]!.range[0]
        ? separator
        : items[i]!;
    if (comma!.range[0] >= close.range[0]) return null;
    // Comma-first layouts count as broken too: the newline may sit on either
    // side of the comma.
    if (comma === items[i]) {
      gaps.push(gapAfter(sourceCode, comma!, ' '));
    } else {
      const beforeComma = sourceCode.getTokenBefore(comma!, {
        includeComments: true,
      });
      gaps.push({
        ...gapAfter(sourceCode, comma!, ' '),
        alt: { start: beforeComma!.range[1], end: comma!.range[0] },
      });
    }
  }
  // A dangling comma sits on either side of the close break (`b: 2,\n}` or
  // `\n,}`); the alt side stops Fold and comma-style trading it forever.
  const closeGap = gapBefore(sourceCode, close, 'close');
  const dangling = sourceCode.getTokenBefore(close, { includeComments: true });
  if (dangling && isSeparator(dangling)) {
    const beforeDangling = sourceCode.getTokenBefore(dangling, {
      includeComments: true,
    });
    closeGap.alt = {
      start: beforeDangling!.range[1],
      end: dangling.range[0],
    };
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

function isHuggable(node: Node): boolean {
  if (
    node.type === 'ObjectExpression' ||
    node.type === 'ArrayExpression' ||
    // The pattern equivalents, for parameter lists: a lone destructured
    // parameter hugs like an options object.
    node.type === 'ObjectPattern' ||
    node.type === 'ArrayPattern'
  ) {
    return true;
  }
  if (
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    // Structural on purpose: keying this on whether the argument is currently
    // multiline feeds back on itself and the call explodes and re-hugs forever.
    return (
      BRACKET_HUG_BODIES.has(node.body.type) ||
      (node.type === 'ArrowFunctionExpression' &&
        ARROW_BREAK_BODIES.has(node.body.type))
    );
  }
  return false;
}

// The break after an arrow's `=>`, for bodies that can use the line it opens.
// A member path gains nothing there, so it lets the call break instead.
function arrowBodyGroup(sourceCode: Source, node: TSESTree.FunctionLike): Group | null {
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

function callGroup(
  sourceCode: Source,
  node: TSESTree.CallExpression | TSESTree.NewExpression,
): Group | null {
  const args = node.arguments;
  if (!args || args.length === 0) return null;
  const close = sourceCode.getLastToken(node)!;
  if (!isPunct(close, ')')) return null; // `new Foo` without parens
  // The call's open paren is the first `(` after the callee (or its type
  // arguments) — argument-level parens all start after it.
  // `typeParameters` is what typescript-eslint called these before v8.
  const withOldName = node as { typeParameters?: Node };
  const after = node.typeArguments ?? withOldName.typeParameters ?? node.callee;
  let open = sourceCode.getTokenAfter(after);
  while (open && !isPunct(open, '(')) {
    open = sourceCode.getTokenAfter(open);
  }
  if (!open || open.range[0] >= args[0].range[0]) return null;
  const gaps = listGaps(sourceCode, open, close, args);
  if (!gaps) return null;
  // A trailing function argument keeps the author's layout: the hugged form
  // reads as partially broken though it is deliberate.
  const last = args[args.length - 1];
  const trailingFunction =
    last.type === 'FunctionExpression' ||
    last.type === 'ArrowFunctionExpression';

  // With exactly one huggable argument first or last, the call never breaks at
  // the call level — the hug target's own group absorbs the break.
  const huggable = args.filter(isHuggable);
  if (
    huggable.length === 1 &&
    (huggable[0] === args[0] || huggable[0] === args[args.length - 1])
  ) {
    return { node, gaps, items: args, addable: false, hug: huggable[0].range };
  }
  return { node, gaps, items: args, complete: !trailingFunction };
}

function bracketGroup(
  sourceCode: Source,
  node: Node,
  items: (Node | null)[],
  openValue: string,
  closeValue: string,
): Group | null {
  const open = sourceCode.getFirstToken(node)!;
  if (!isPunct(open, openValue)) return null;
  if (items.length === 0 || items.some((item) => item == null)) return null;
  // From the last item, not the node: a TS pattern's range covers its type
  // annotation, so `{a, b}: {c: D}` would put the closing break inside it.
  const close = sourceCode.getTokenAfter(items[items.length - 1]!, {
    filter: (t) => isPunct(t, closeValue),
  });
  if (!close) return null;
  const gaps = listGaps(sourceCode, open, close, items);
  return (
    gaps && {
      node,
      range: [open.range[0], close.range[1]] as Range,
      gaps,
      items,
    }
  );
}

function statementListGaps(sourceCode: Source, statements: Node[]): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < statements.length; i++) {
    const first = sourceCode.getFirstToken(statements[i]);
    const prev = sourceCode.getTokenBefore(first!);
    // A leading `;` guards ASI in semicolon-less code — `;(node).x = 1`. The
    // parser attaches it to the previous statement; breaking here strands it.
    if (prev && isPunct(prev, ';')) {
      const beforeSemi = sourceCode.getTokenBefore(prev);
      if (!beforeSemi || beforeSemi.loc.end.line < prev.loc.start.line) continue;
    }
    gaps.push(gapBefore(sourceCode, first!, 'same'));
  }
  return gaps;
}

function blockGaps(sourceCode: Source, node: Node, body: Node[]): Gap[] | null {
  const open = sourceCode.getFirstToken(node)!;
  const close = sourceCode.getLastToken(node)!;
  if (!isPunct(open, '{') || !isPunct(close, '}')) return null;
  if (body.length === 0) return null;
  return [
    gapAfter(sourceCode, open),
    ...statementListGaps(sourceCode, body),
    gapBefore(sourceCode, close, 'close'),
  ];
}

function necessaryGroup(sourceCode: Source, node: Node): Group | null {
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
      const close = sourceCode.getLastToken(node)!;
      const open = sourceCode.getTokenBefore(
        sourceCode.getFirstToken(node.cases[0])!,
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
      // `case X: {` keeps its brace on the case line
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
                  sourceCode.getFirstToken(node.consequent[0])!,
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

function isBlockBodyFunction(node: Node): boolean {
  return (
    (node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression') &&
    node.body.type === 'BlockStatement'
  );
}

function methodChainGroup(
  sourceCode: Source,
  node: Node,
  absorbed: Set<Node>,
): Group | null {
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
      // A parenthesized head is one unit: `(a.b.c).d().e()` breaks at .d and
      // .e, never at the dots inside the parens.
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
  const gaps: Gap[] = dots
    .map((dot) => {
      const next = sourceCode.getTokenAfter(dot, { includeComments: true });
      return {
        ...gapBefore(sourceCode, dot, 'item'),
        alt: { start: dot.range[1], end: next!.range[0] },
      };
    })
    .sort((a, b) => a.start - b.start);
  return { node, gaps, kind: 'chain' };
}

function paramsGroup(
  sourceCode: Source,
  node: TSESTree.FunctionLike | TSESTree.TSFunctionType | TSESTree.TSConstructorType,
): Group | null {
  const params = node.params;
  if (!params || params.length === 0) return null;
  const anchor = node.typeParameters ?? ('id' in node ? node.id : null) ?? null;
  let open: Token | null = anchor
    ? sourceCode.getTokenAfter(anchor)
    : sourceCode.getFirstToken(node);
  while (open && !isPunct(open, '(') && open.range[0] < params[0]!.range[0]) {
    open = sourceCode.getTokenAfter(open as Token);
  }
  if (!isPunct(open, '(') || open.range[0] >= params[0]!.range[0]) return null;
  const close = sourceCode.getTokenAfter(params[params.length - 1]!, {
    filter: (t) => isPunct(t, ')'),
  });
  if (!close) return null;
  const gaps = listGaps(sourceCode, open, close, params);
  if (!gaps) return null;
  const range: Range = [open.range[0], close.range[1]];
  const huggable = params.filter(isHuggable);
  if (
    huggable.length === 1 &&
    (huggable[0] === params[0] || huggable[0] === params[params.length - 1])
  ) {
    return { node, gaps, range, kind: 'params', addable: false, hug: huggable[0].range };
  }
  return { node, gaps, range, kind: 'params', items: params };
}

function conditionGroup(
  sourceCode: Source,
  node: Node,
  openAnchor: Node | Token,
  close: Token | null,
): Group | null {
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

function forGroup(sourceCode: Source, node: TSESTree.ForStatement): Group | null {
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
  const close = sourceCode.getTokenBefore(sourceCode.getFirstToken(node.body)!, {
    filter: (t) => isPunct(t, ')'),
  });
  if (!close) return null;
  return {
    node,
    range: [node.init.range[0], close.range[1]],
    gaps: [gapAfter(sourceCode, semi1, ' '), gapAfter(sourceCode, semi2, ' ')],
  };
}

function specifierGroup(
  sourceCode: Source,
  node: TSESTree.ImportDeclaration | TSESTree.ExportNamedDeclaration,
  kinds: string[],
): Group | null {
  const named = (node.specifiers ?? []).filter((s) => kinds.includes(s.type));
  // A lone specifier stays inline however long: the module path is what makes
  // the line long, and no break inside the braces shortens it.
  if (named.length < 2) return null;
  const open = sourceCode.getTokenBefore(sourceCode.getFirstToken(named[0]!)!, {
    filter: (t) => isPunct(t, '{'),
  });
  const close = sourceCode.getTokenAfter(named[named.length - 1]!, {
    filter: (t) => isPunct(t, '}'),
  });
  if (!open || !close) return null;
  const gaps = listGaps(sourceCode, open, close, named);
  return gaps && { node, gaps, range: [open.range[0], close.range[1]], items: named };
}

function ternaryGroup(
  sourceCode: Source,
  node: TSESTree.ConditionalExpression,
): Group | null {
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

function jsxChildrenGroup(
  sourceCode: Source,
  node: TSESTree.JSXElement | TSESTree.JSXFragment,
  opening: Node,
  closing: Node,
): Group | null {
  if (!closing) return null; // self-closing: no children
  const children = node.children ?? [];
  const isBlank = (c: Node) => c.type === 'JSXText' && c.value.trim() === '';
  const content = children.filter((c) => !isBlank(c));
  if (content.length === 0) return null;
  const unsafe = children.some(
    (c) => c.type === 'JSXText' && (!isBlank(c) || !/[\r\n]/.test(c.value)),
  );
  if (unsafe) return null;

  const open = sourceCode.getLastToken(opening);
  const close = sourceCode.getFirstToken(closing);
  if (!open || !close) return null;

  const isSpaceMarker = (child: Node) =>
    child.type === 'JSXExpressionContainer' &&
    child.expression?.type === 'Literal' &&
    typeof child.expression.value === 'string' &&
    child.expression.value.trim() === '';

  const gaps: Gap[] = [
    { start: open.range[1], end: content[0].range[0], kind: 'item', join: '' },
  ];
  for (let i = 1; i < content.length; i++) {
    if (isSpaceMarker(content[i])) continue;
    gaps.push({
      start: content[i - 1].range[1],
      end: content[i].range[0],
      kind: 'item',
      join: '',
    });
  }
  gaps.push({
    start: content[content.length - 1].range[1],
    end: close.range[0],
    kind: 'close',
    join: '',
  });
  const nested = content.some(
    (child) => child.type === 'JSXElement' || child.type === 'JSXFragment',
  );
  return { node, gaps, items: content, necessary: nested };
}

function jsxGroup(
  sourceCode: Source,
  node: TSESTree.JSXOpeningElement,
): Group | null {
  const attrs = node.attributes;
  // A lone attribute stays on the tag line however long it is: breaking it
  // spends three lines to move one item, and the tag is no shorter for it.
  // Two or more break normally. Prettier draws the line in the same place.
  if (!attrs || attrs.length < 2) return null;
  const last = sourceCode.getLastToken(node)!;
  const beforeLast = sourceCode.getTokenBefore(last!);
  const closeToken =
    node.selfClosing && isPunct(beforeLast, '/') ? beforeLast : last;
  return {
    node,
    items: attrs,
    gaps: [
      ...attrs.map((attr) =>
        gapBefore(sourceCode, sourceCode.getFirstToken(attr)!, 'item', ' '),
      ),
      gapBefore(sourceCode, closeToken, 'close', node.selfClosing ? ' ' : ''),
    ],
  };
}

function typeListGroup(
  sourceCode: Source,
  node: TSESTree.TSTypeParameterInstantiation | TSESTree.TSTypeParameterDeclaration,
): Group | null {
  const items = node.params;
  if (!items || items.length === 0) return null;
  const open = sourceCode.getFirstToken(node)!;
  const close = sourceCode.getLastToken(node)!;
  if (!isPunct(open, '<') || !isPunct(close, '>')) return null;
  const gaps = listGaps(sourceCode, open, close, items);
  return (
    gaps && {
      node,
      gaps,
      items,
      range: [open.range[0], close.range[1]],
    }
  );
}

function typeMembersGroup(
  sourceCode: Source,
  node: Node,
  members: Node[],
): Group | null {
  if (!members || members.length === 0) return null;
  const open = sourceCode.getFirstToken(node)!;
  const close = sourceCode.getLastToken(node)!;
  if (!isPunct(open, '{') || !isPunct(close, '}')) return null;
  const gaps = listGaps(sourceCode, open, close, members, [';', ',']);
  return gaps && { node, gaps, items: members };
}

function tupleTypeGroup(sourceCode: Source, node: TSESTree.TSTupleType): Group | null {
  const items = node.elementTypes;
  if (!items || items.length === 0) return null;
  const open = sourceCode.getFirstToken(node)!;
  const close = sourceCode.getLastToken(node)!;
  if (!isPunct(open, '[') || !isPunct(close, ']')) return null;
  const gaps = listGaps(sourceCode, open, close, items);
  return gaps && { node, gaps, items };
}

function typeOperatorGroup(
  sourceCode: Source,
  node: TSESTree.TSUnionType | TSESTree.TSIntersectionType,
  operator: string,
): Group | null {
  const types = node.types;
  if (!types || types.length < 2) return null;
  const gaps: Gap[] = [];
  for (let i = 1; i < types.length; i++) {
    const token = sourceCode.getTokenBefore(types[i], {
      filter: (t) => isPunct(t, operator),
    });
    if (!token) return null;
    const prev = sourceCode.getTokenBefore(token, { includeComments: true });
    const next = sourceCode.getTokenAfter(token, { includeComments: true });
    gaps.push({
      start: prev!.range[1],
      end: token.range[0],
      alt: { start: token.range[1], end: next!.range[0] },
      kind: 'item',
      join: ' ',
    });
  }
  return { node, gaps, kind: 'operator' };
}

function conditionalTypeGroup(
  sourceCode: Source,
  node: TSESTree.TSConditionalType,
): Group | null {
  const question = sourceCode.getTokenAfter(node.extendsType, {
    filter: (t) => isPunct(t, '?'),
  });
  const colon = sourceCode.getTokenAfter(node.trueType, {
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

function implementsGroup(
  sourceCode: Source,
  node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
): Group | null {
  const items = node.implements;
  if (!items || items.length < 2) return null;
  const keyword = sourceCode.getTokenBefore(items[0], {
    filter: (t) => t.value === 'implements',
  });
  if (!keyword) return null;
  const gaps: Gap[] = [];
  for (let i = 1; i < items.length; i++) {
    const comma = sourceCode.getTokenAfter(items[i - 1], {
      filter: (t) => isPunct(t, ','),
    });
    if (!comma) return null;
    gaps.push(gapAfter(sourceCode, comma, ' '));
  }
  return {
    node,
    gaps,
    range: [items[0].range[0], items[items.length - 1].range[1]],
  };
}

const ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=',
  '<<=', '>>=', '>>>=', '&=', '|=', '^=',
  '&&=', '||=', '??=',
]);

// A value with no interior structure. Moving one to its own line never pays:
// it is as long wherever it goes. Prettier declines these too.
function isUnbreakableLeaf(node: Node): boolean {
  return (
    node.type === 'Literal' ||
    node.type === 'TemplateLiteral' ||
    node.type === 'JSXText'
  );
}

function colonGroup(
  sourceCode: Source,
  node: TSESTree.Property | TSESTree.TSPropertySignature,
  value: Node | null | undefined,
): Group | null {
  if (!value || isUnbreakableLeaf(value)) return null;
  const colon = sourceCode.getTokenBefore(value, {
    filter: (t) => isPunct(t, ':'),
  });
  // The backwards search is unbounded, so a shorthand method `test({ x }) {}`
  // finds the colon of the property above and breaks an unrelated line.
  const keyEnd = node.key ? node.key.range[1] : node.range[0];
  if (!colon || colon.range[0] < keyEnd || colon.range[1] > value.range[0])
    return null;
  return {
    node,
    kind: 'assign',
    fallback: true,
    gaps: [gapAfter(sourceCode, colon, ' ')],
  };
}

function assignmentGroup(
  sourceCode: Source,
  node: TSESTree.AssignmentExpression | TSESTree.VariableDeclarator,
): Group | null {
  const right = node.type === 'AssignmentExpression' ? node.right : node.init;
  if (!right || isUnbreakableLeaf(right)) return null;
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

function declaratorGroup(
  sourceCode: Source,
  node: TSESTree.VariableDeclaration,
): Group | null {
  const decls = node.declarations;
  if (!decls || decls.length < 2) return null;
  const gaps: Gap[] = [];
  for (let i = 0; i < decls.length - 1; i++) {
    const comma = sourceCode.getTokenAfter(decls[i], {
      filter: (t) => isPunct(t, ','),
    });
    if (!comma) return null;
    gaps.push(gapAfter(sourceCode, comma, ' '));
  }
  return { node, gaps };
}

function precedenceOf(node: Node): number | null {
  if (node.type === 'AssignmentExpression') return 2;
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression')
    return BINARY_PRECEDENCE[node.operator] ?? null;
  return null;
}

function nextOperand(node: Node): Node {
  const binary = node as { operator?: string; left: Node; right: Node };
  if (node.type === 'AssignmentExpression' || binary.operator === '**')
    return binary.right;
  return binary.left;
}

// A parenthesized operand is one unit and does not join the enclosing run.
function isParenthesized(sourceCode: Source, node: Node): boolean {
  const before = sourceCode.getTokenBefore(node);
  const after = sourceCode.getTokenAfter(node);
  return isPunct(before, '(') && isPunct(after, ')');
}

// `a = b = c` hands one value to several targets; `a = b += c` parses as
// `a = (b += c)`, nested rather than peer. Equal precedence is not enough.
function sameAssignmentOperator(current: Node, node: Node): boolean {
  return (
    current === node ||
    current.type !== 'AssignmentExpression' ||
    (current as { operator: string }).operator ===
      (node as { operator: string }).operator
  );
}

function chainGroup(
  sourceCode: Source,
  node: Node,
  absorbed: Set<Node>,
  operatorSide: OperatorSide,
): Group | null {
  const precedence = precedenceOf(node);
  const members = [];
  let current = node;
  while (
    precedenceOf(current) === precedence &&
    sameAssignmentOperator(current, node) &&
    (current === node || !isParenthesized(sourceCode, current))
  ) {
    members.push(current);
    current = nextOperand(current);
  }
  if (node.type === 'AssignmentExpression' && members.length < 2) return null;
  for (const member of members) absorbed.add(member);
  const gaps: Gap[] = members.map((member) => {
    const operator = sourceCode.getTokenAfter((member as { left: Node }).left, {
      filter: (t: Token) => t.value === (member as { operator: string }).operator,
    });
    const prev = sourceCode.getTokenBefore(operator!, { includeComments: true });
    const next = sourceCode.getTokenAfter(operator!, { includeComments: true });
    const before = { start: prev!.range[1], end: operator!.range[0] };
    const after = { start: operator!.range[1], end: next!.range[0] };
    const main = operatorSide === 'before' ? before : after;
    const alt = operatorSide === 'before' ? after : before;
    return { start: main.start, end: main.end, alt, kind: 'item', join: ' ' };
  });
  gaps.sort((a, b) => a.start - b.start);
  return { node, gaps, kind: 'operator' };
}

function collectGroups(sourceCode: Source, operatorSide: OperatorSide = 'after') {
  const candidates: Group[] = [];
  const necessary: Group[] = [];
  const absorbed = new Set<Node>();
  const statementStarts = new Set<number>();
  const flatTernaries = new Set<Node>();
  walk(sourceCode.ast, (node) => {
    // A bracket-less group starting a statement indents its continuation
    // lines; one starting elsewhere already sits on a continuation line.
    if (/(Statement|Declaration)$/.test(node.type)) {
      statementStarts.add(node.range[0]);
    }
    if (
      node.type === 'ConditionalExpression' &&
      node.alternate.type === 'ConditionalExpression'
    ) {
      // `a ? b : c ? d : e` is one construct, not nested ones, so the chain
      // shares a single indent level.
      flatTernaries.add(node.alternate);
    }
    const need = necessaryGroup(sourceCode, node);
    if (need) necessary.push(need);
    switch (node.type) {
      case 'CallExpression':
      case 'NewExpression':
      case 'MemberExpression': {
        // Chain first: when a call is both a chain root and an argument list,
        // the chain-level break wins, and the selection sort is stable.
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
        // Assignment breaks as a chain (`a = b = c`); a lone `=` is only a
        // fallback, since the right-hand side's own structure breaks first.
        if (node.type === 'AssignmentExpression') {
          const assign = assignmentGroup(sourceCode, node);
          if (assign) candidates.push(assign);
        }
        break;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        // Body first: for `f(x => g(a, b))` the body break is preferred over
        // the parameter list, which outermost-first would not choose.
        const body = arrowBodyGroup(sourceCode, node);
        if (body) candidates.push(body);
        const group = paramsGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'IfStatement': {
        const close = sourceCode.getTokenBefore(
          sourceCode.getFirstToken(node.consequent)!,
          { filter: (t) => isPunct(t, ')') },
        );
        const group = conditionGroup(
          sourceCode,
          node,
          sourceCode.getFirstToken(node)!,
          close,
        );
        if (group) candidates.push(group);
        break;
      }
      case 'WhileStatement': {
        const close = sourceCode.getTokenBefore(
          sourceCode.getFirstToken(node.body)!,
          { filter: (t) => isPunct(t, ')') },
        );
        const group = conditionGroup(
          sourceCode,
          node,
          sourceCode.getFirstToken(node)!,
          close,
        );
        if (group) candidates.push(group);
        break;
      }
      case 'DoWhileStatement': {
        const whileKeyword = sourceCode.getTokenAfter(node.body, {
          filter: (t) => t.value === 'while',
        });
        const last = sourceCode.getLastToken(node)!;
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
          conditionGroup(sourceCode, node, sourceCode.getFirstToken(node)!, close);
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
      case 'JSXElement':
      case 'JSXFragment': {
        const group = jsxChildrenGroup(
          sourceCode,
          node,
          node.type === 'JSXElement' ? node.openingElement : node.openingFragment,
          node.type === 'JSXElement'
            ? node.closingElement!
            : node.closingFragment,
        );
        if (group) (group.necessary ? necessary : candidates).push(group);
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
      case 'Property': {
        if (!node.shorthand) {
          const group = colonGroup(sourceCode, node, node.value);
          if (group) candidates.push(group);
        }
        break;
      }
      case 'TSPropertySignature': {
        const group = colonGroup(
          sourceCode,
          node,
          node.typeAnnotation?.typeAnnotation,
        );
        if (group) candidates.push(group);
        break;
      }

      case 'TSTypeParameterInstantiation':
      case 'TSTypeParameterDeclaration': {
        const group = typeListGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'TSTypeLiteral': {
        const group = typeMembersGroup(sourceCode, node, node.members);
        if (group) candidates.push(group);
        break;
      }
      case 'TSInterfaceBody': {
        const group = typeMembersGroup(sourceCode, node, node.body);
        if (group) candidates.push(group);
        break;
      }
      case 'TSTupleType': {
        const group = tupleTypeGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'TSUnionType':
      case 'TSIntersectionType': {
        const group = typeOperatorGroup(
          sourceCode,
          node,
          node.type === 'TSUnionType' ? '|' : '&',
        );
        if (group) candidates.push(group);
        break;
      }
      case 'TSFunctionType':
      case 'TSConstructorType': {
        const group = paramsGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'TSConditionalType': {
        const group = conditionalTypeGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const group = implementsGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'TSTypeAliasDeclaration': {
        const right = node.typeAnnotation;
        const operator =
          right &&
          sourceCode.getTokenBefore(right, { filter: (t) => isPunct(t, '=') });
        if (operator) {
          candidates.push({
            node,
            kind: 'assign',
            fallback: true,
            gaps: [gapAfter(sourceCode, operator, ' ')],
          });
        }
        break;
      }
    }
  });

  // A trailing arrow's `=>` break and the call's closing paren are one
  // decision, so the close gap joins the arrow's group rather than the call's.
  const arrowGroups = new Map(
    candidates.filter((g) => g.kind === 'arrow').map((g) => [g.node, g]),
  );
  for (const group of candidates) {
    if (!group.items || group.items.length === 0) continue;
    if (group.kind === 'params' || group.kind === 'arrow') continue;
    const last = group.items[group.items.length - 1];
    const arrow = last ? arrowGroups.get(last) : undefined;
    if (!arrow) continue;
    const closeGap = group.gaps[group.gaps.length - 1];
    if (closeGap && closeGap.kind === 'close') arrow.gaps.push(closeGap);
  }

  // A hugged argument's signature belongs to the call's head. Without this,
  // `it("...", function (done) {` breaks as `function (\n  done\n) {`.
  const hugged = new Set(
    candidates.filter((g) => g.hug).map((g) => g.hug!.join(':')),
  );
  for (const group of candidates) {
    if (group.kind === 'params' && hugged.has(group.node.range.join(':'))) {
      group.addable = false;
    }
  }

  // Never fold inside a template literal: splitting a value across an
  // interpolation reads worse than the long line.
  const templateRanges: Range[] = [];
  walk(sourceCode.ast, (node) => {
    if (node.type === 'TemplateLiteral') templateRanges.push(node.range);
  });
  for (const group of candidates) {
    const [start, end] = group.range ?? group.node.range;
    if (!templateRanges.some((range) => range[0] < start && end <= range[1]))
      continue;
    group.addable = false;
  }

  return { candidates, necessary, statementStarts };
}

const DEFAULT_MAX_WIDTH = 80;

const indentCache = new WeakMap();

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

function physicalLines(text: string): VLine[] {
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

function lineWidth(text: string, vline: VLine, tabWidth: number): number {
  return measureLine(vline.indent + text.slice(vline.start, vline.end), tabWidth);
}

function lineIndent(text: string, vline: VLine): string {
  return vline.indent + /^[ \t]*/.exec(text.slice(vline.start, vline.end))![0];
}

// A bare '\n' in a CRLF file leaves mixed endings: a diff on every touched
// line, and a fight with @stylistic/linebreak-style.
function inferNewline(text: string): string {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (text[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

// Only side-unambiguous operators are sampled: '+', '-' and '*' may be unary
// or a generator star, which would pollute the count.
const INFER_OPS = new Set([
  '&&', '||', '??', '==', '===', '!=', '!==', '<=', '>=',
  '<<', '>>', '>>>', '%', '**', '&', '|', '^',
  '=', '+=', '-=', '*=', '/=', '%=', '&&=', '||=', '??=',
]);

function inferOperatorSide(sourceCode: Source): OperatorSide {
  const tokens = sourceCode.ast.tokens ?? [];
  let leading = 0;
  let trailing = 0;
  for (let i = 1; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token.type !== 'Punctuator' || !INFER_OPS.has(token.value)) continue;
    if (tokens[i - 1].loc.end.line < token.loc.start.line) leading++;
    else if (token.loc.end.line < tokens[i + 1].loc.start.line) trailing++;
  }
  // 'after' matches @stylistic/operator-linebreak's default, so a file with
  // no signal agrees with the ecosystem default.
  return leading > trailing ? 'before' : 'after';
}

// Advances one character at a time; re-measuring the whole prefix at each
// step would be quadratic in the overflow column.
function overflowStart(
  text: string,
  vline: VLine,
  maxWidth: number,
  tabWidth: number,
): number {
  const indentWidth = measureLine(vline.indent, tabWidth);
  if (indentWidth > maxWidth) return vline.start;
  let width = indentWidth;
  let offset = vline.start;
  for (const char of text.slice(vline.start, vline.end)) {
    width += char === '\t' ? tabWidth - (width % tabWidth) : 1;
    if (width > maxWidth) return offset;
    offset += char.length;
  }
  return vline.end;
}

function format(
  sourceCode: Source,
  options: { maxWidth?: number; tabWidth?: number } = {},
): Edit[] {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const tabWidth = options.tabWidth ?? DEFAULT_TAB_WIDTH;
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
  const edits: Edit[] = [];
  const consumedGaps = new Set<Gap>();
  const joined = new Set<VLine>();

  const rangeHasBreak = (range: { start: number; end: number }) => {
    LINE_BREAK.lastIndex = 0;
    return LINE_BREAK.test(text.slice(range.start, range.end));
  };

  // An operator gap counts as broken when either side carries the newline, so
  // Fold never fights an existing break over which side the operator sits on.
  const hasBreak = (gap: Gap) =>
    rangeHasBreak(gap) || (gap.alt !== undefined && rangeHasBreak(gap.alt));

  const findLine = (offset: number) => {
    const index = vlines.findIndex(
      (vl) => vl.start <= offset && offset < vl.end,
    );
    return index === -1
      ? vlines.findIndex((vl) => vl.start <= offset && offset <= vl.end)
      : index;
  };

  function breakGroup(group: Group, messageId: MessageId) {
    const groupStart = (group.range ?? group.node.range)[0];
    const openLine = vlines[findLine(groupStart)];
    const baseIndent = lineIndent(text, openLine);
    const bracketless = group.kind === 'operator' || group.kind === 'ternary';
    const startsLine = text.slice(openLine.start, groupStart).trim() === '';
    // No staircase: a bracket-less group starting a continuation line takes
    // that indent as its level, or its first operand ends up a level shallower.
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

  for (const group of necessary) {
    breakGroup(group, 'necessaryBreak');
  }

  const groupRange = (group: Group): Range =>
    (group.range ?? group.node.range) as Range;
  const BLANK_LINE = /(\r?\n)[ \t]*(\r?\n)/;

  // A partially broken group is an editing artifact rather than a layout, so
  // it is re-decided by width: joined if it fits, completed if it does not. A
  // fully broken group is already consistent and never reaches here, which is
  // what keeps a deliberate layout safe. Two kinds are exempt:
  function completeGroup(group: Group) {
    if (group.addable === false) return;
    // A chain broken at some dots is a deliberate head/tail split;
    // completing it would pull `Object.keys(value)` apart.
    if (group.kind === 'chain') return;
    // An arrow's gaps are not peers, so completing them would break the `=>`
    // of every arrow sitting in an already-broken call.
    if (group.kind === 'arrow') return;
    if (group.complete === false) return;
    const gaps = group.gaps;
    const broken = gaps.filter(hasBreak);
    if (broken.length === 0) return;
    const breakable = gaps.filter((gap) => !isForbiddenBreak(sourceCode, gap));
    if (broken.length >= breakable.length) return; // already consistent

    // A blank line or a comment inside means the author grouped something
    // deliberately, and Fold cannot know what.
    const [rangeStart, rangeEnd] = groupRange(group);
    if (BLANK_LINE.test(text.slice(rangeStart, rangeEnd))) return;
    if (
      sourceCode
        .getCommentsInside(group.node)
        .some((c) => rangeStart <= c.range[0] && c.range[1] <= rangeEnd)
    )
      return;

    // A group that fits on one line is joined rather than completed: a list
    // broken at one comma is more likely a stray newline than a layout. When
    // it does not fit, completing it is the only consistent option.
    const inline = collapsedText(group);
    if (inline !== null && joinedFits(group, inline)) {
      joinGroup(group);
      return;
    }
    breakGroup(group, 'inconsistentGroup');
  }

  /** The whitespace actually holding the newline; operator gaps have two. */
  const brokenRange = (gap: Gap) => (rangeHasBreak(gap) ? gap : gap.alt!);

  /**
   * The group with its own breaks collapsed, or null when a break inside it
   * belongs to something else — joining then would not produce one line.
   */
  function collapsedText(group: Group): string | null {
    const [start, end] = groupRange(group);
    const ranges = group.gaps
      .filter(hasBreak)
      .map((gap) => ({ range: brokenRange(gap), join: gap.join ?? '' }))
      .filter(({ range }) => range.start >= start && range.end <= end)
      .sort((a, b) => a.range.start - b.range.start);

    let out = '';
    let cursor = start;
    for (const { range, join } of ranges) {
      out += text.slice(cursor, range.start) + join;
      cursor = range.end;
    }
    out += text.slice(cursor, end);
    LINE_BREAK.lastIndex = 0;
    return LINE_BREAK.test(out) ? null : out;
  }

  /** Whether the line the joined group would land on stays within maxWidth. */
  function joinedFits(group: Group, inline: string): boolean {
    const [start, end] = groupRange(group);
    const first = vlines[findLine(start)]!;
    const last = vlines[findLine(end)] ?? first;
    const head = first.indent + text.slice(first.start, start);
    const tail = text.slice(end, last.end);
    return measureLine(head + inline + tail, tabWidth) <= maxWidth;
  }

  function joinGroup(group: Group) {
    const [start, end] = groupRange(group);
    for (const gap of group.gaps) {
      consumedGaps.add(gap);
      if (!hasBreak(gap)) continue;
      const range = brokenRange(gap);
      if (range.start < start || range.end > end) continue;
      const loc = sourceCode.getLocFromIndex(range.end);
      edits.push({
        range: [range.start, range.end],
        text: gap.join ?? '',
        loc: { start: loc, end: loc },
        messageId: 'inconsistentGroup',
      });
    }
    // The projection still describes the unjoined text, so leave these lines
    // to the next fix pass rather than measuring them wrong now.
    for (let i = findLine(start); i <= findLine(end); i++) joined.add(vlines[i]!);
  }

  const outermostFirst = [...candidates].sort(
    (a, b) => groupRange(a)[0] - groupRange(b)[0] || groupRange(b)[1] - groupRange(a)[1],
  );
  for (const group of outermostFirst) {
    completeGroup(group);
  }

  // Gap position index. Without it every over-width line scans every candidate
  // group in the file, making the addition pass quadratic in file size.
  const gapIndex: { gap: Gap; group: Group }[] = [];
  for (const group of candidates) {
    for (const gap of group.gaps) gapIndex.push({ gap, group });
  }
  gapIndex.sort((a, b) => a.gap.start - b.gap.start);
  const gapStarts = gapIndex.map((entry) => entry.gap.start);

  function groupsOnLine(vl: VLine) {
    let lo = 0;
    let hi = gapStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gapStarts[mid] < vl.start) lo = mid + 1;
      else hi = mid;
    }
    const found = new Set<Group>();
    for (let i = lo; i < gapIndex.length && gapStarts[i] <= vl.end; i++) {
      if (gapIndex[i].gap.end <= vl.end) found.add(gapIndex[i].group);
    }
    return found;
  }

  // A line over width only because of a trailing comment is unbreakable: the
  // code fits, and moving the comment down is a vertical-spacing change.
  const comments = sourceCode.getAllComments();
  function overflowIsTrailingComment(vl: VLine) {
    for (const comment of comments) {
      const [start, end] = comment.range;
      if (start < vl.start || start >= vl.end) continue;
      if (end < vl.end) continue; // not the tail of the line
      const code = vl.indent + text.slice(vl.start, start).trimEnd();
      if (measureLine(code, tabWidth) <= maxWidth) return true;
    }
    return false;
  }

  // Break the outermost group holding the overflow. The cursor does not
  // advance; breakGroup consumes a group's gaps, so this ends by exhaustion.
  for (let cursor = 0; cursor < vlines.length; ) {
    const vl = vlines[cursor];
    if (
      joined.has(vl) ||
      lineWidth(text, vl, tabWidth) <= maxWidth ||
      overflowIsTrailingComment(vl)
    ) {
      cursor++;
      continue;
    }
    const overflow = overflowStart(text, vl, maxWidth, tabWidth);
    // A lone atomic item already too wide cannot be helped: it lands on its
    // own line at the width it had. Two or more items do shorten the line.
    const cannotHelp = (group: Group) => {
      if (!group.items || group.items.length !== 1) return false;
      const item = group.items[0];
      if (!item || !item.range) return false;
      const [itemStart, itemEnd] = item.range;
      // Excluding the group's own gaps: they sit exactly on the item's edges,
      // and are zero-width when the source has no spaces there.
      const hasInnerCandidate = gapIndex.some(
        ({ gap }) =>
          !group.gaps.includes(gap) &&
          itemStart <= gap.start &&
          gap.end <= itemEnd &&
          !consumedGaps.has(gap) &&
          !hasBreak(gap) &&
          !isForbiddenBreak(sourceCode, gap),
      );
      if (hasInnerCandidate) return false;
      const indent = lineIndent(text, vl) + unit;
      return measureLine(indent + text.slice(itemStart, itemEnd), tabWidth) > maxWidth;
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
    // Last resort, and only when both halves fit: a 200-character string is
    // still 200 characters one line further down.
    const breakable = onLine.filter((group) => !group.fallback);
    if (breakable.length === 0) {
      const rescue = onLine.filter(
        (group) =>
          group.fallback &&
          group.gaps.some((gap) => {
            if (consumedGaps.has(gap) || hasBreak(gap)) return false;
            const head = text.slice(vl.start, gap.start).trimEnd();
            const tail = text.slice(gap.end, vl.end);
            return (
              measureLine(vl.indent + head, tabWidth) <= maxWidth &&
              measureLine(lineIndent(text, vl) + unit + tail, tabWidth) <=
                maxWidth
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

    // Prefer a group spanning the overflow, then one that reaches it:
    // `assertEqual<A, B>(v)` overflows inside the type arguments, not at `(`.
    const spanning = breakable.filter(
      (group) => groupRange(group)[1] > overflow,
    );
    const reaching = spanning.filter((group) =>
      group.gaps.some(
        (gap) =>
          gap.start < overflow && !consumedGaps.has(gap) && !hasBreak(gap),
      ),
    );
    const usable =
      reaching.length > 0
        ? reaching
        : spanning.length > 0
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

type Options = [{ maxWidth?: number; tabWidth?: number }?];

const breaks: TSESLint.RuleModule<MessageId, Options> = {
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
          tabWidth: { type: 'integer', minimum: 1 },
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
    defaultOptions: [
      { maxWidth: DEFAULT_MAX_WIDTH, tabWidth: DEFAULT_TAB_WIDTH },
    ],
  },

  create(context) {
    const maxWidth = context.options[0]?.maxWidth ?? DEFAULT_MAX_WIDTH;
    const tabWidth = context.options[0]?.tabWidth ?? DEFAULT_TAB_WIDTH;

    return {
      'Program:exit'() {
        for (const edit of format(context.sourceCode, { maxWidth, tabWidth })) {
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

// No `configs`. One rule is not a set to curate, so a preset would only save
// registering the plugin — and it could not carry `maxWidth`, which is the
// reason to configure this at all.
const plugin: ESLint.Plugin = {
  meta: {
    name: 'eslint-plugin-fold',
    version: '0.1.0',
  },
  // ESLint types rules against ESTree; this one is typed against TSESTree so
  // it can walk TypeScript nodes. The shapes are identical at runtime.
  rules: { breaks: breaks as unknown as Rule.RuleModule },
};

export default plugin;
