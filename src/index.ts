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
  // A break Fold removes but never adds: the dot after a short chain head.
  joinOnly?: boolean;
}

type GroupKind = | 'chain'
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
  // Where the group's influence ends, when past its range: an overflow up to
  // here is this group's to fix.
  reach?: number;
  // A leading operator (`=\n  | A`) that goes with the breaks when joined.
  lead?: { start: number; end: number };
  // The call whose close gap a trailing arrow's group borrowed.
  host?: Group;
}

type MessageId = 'overWidth'
  | 'necessaryBreak'
  | 'inconsistentGroup'
  | 'joinable'
  | 'moved';

interface Edit {
  range: Range;
  text: string;
  loc: { start: Position; end: Position };
  messageId: MessageId;
  data?: Record<string, string>;
}

type OperatorSide = 'before' | 'after';

// 2 matches Prettier's default. The one input Fold cannot read off the file:
// a tab's width is a viewer preference, not a property of the source.
const DEFAULT_TAB_WIDTH = 2;
const DEFAULT_JOIN = false;

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
      if (
        delta === '\t'.repeat(delta.length) ||
        delta === ' '.repeat(delta.length)
      ) {
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
  const next = boundary.type === 'Line' || boundary.type === 'Block'
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
    prev.value === 'yield' || prev.value === 'async' || prev.value === 'await'
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

  // Between a unary operator and its operand. A `!` after an operand is a
  // non-null assertion, which ends the operand rather than starting one.
  if (prev.type === 'Punctuator' && ALWAYS_UNARY.has(prev.value)) {
    const before = sourceCode.getTokenBefore(prev);
    if (prev.value !== '!' || !looksLikeOperandEnd(before)) return true;
  }
  if (
    prev.type === 'Keyword' &&
    (prev.value === 'typeof' ||
      prev.value === 'void' ||
      prev.value === 'delete' ||
      prev.value === 'await')
  )
    return true;
  if (
    prev.type === 'Punctuator' && (prev.value === '+' || prev.value === '-')
  ) {
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
// A line comment on the same line stays on it: nothing can follow it there,
// so whitespace after a token begins past any such comment.
function pastLineComments(
  sourceCode: Source,
  tokenOrNode: Node | Token,
): { start: number; next: Token | TSESTree.Comment | null } {
  let start = tokenOrNode.range[1];
  let next = sourceCode.getTokenAfter(tokenOrNode, { includeComments: true });
  while (
    next &&
    next.type === 'Line' &&
    next.loc.start.line === tokenOrNode.loc.end.line
  ) {
    start = next.range[1];
    next = sourceCode.getTokenAfter(next, { includeComments: true });
  }
  return { start, next };
}

function gapAfter(
  sourceCode: Source,
  tokenOrNode: Node | Token,
  join = ''
): Gap {
  const { start, next } = pastLineComments(sourceCode, tokenOrNode);
  return { start, end: next!.range[0], kind: 'item', join };
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

// Whether this file puts a space inside braces, read off the braces it
// already has on one line. Ties and files without any go with the space.
const braceSpaceCache = new WeakMap<Source, string>();
function braceSpaceFor(sourceCode: Source): string {
  let cached = braceSpaceCache.get(sourceCode);
  if (cached !== undefined) return cached;
  let spaced = 0;
  let tight = 0;
  const tokens = sourceCode.ast.tokens ?? [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const open = tokens[i]!;
    const next = tokens[i + 1]!;
    if (!isPunct(open, '{') || isPunct(next, '}')) continue;
    if (open.loc.end.line !== next.loc.start.line) continue;
    // JSX braces are always tight and say nothing about object spacing.
    const owner = sourceCode.getNodeByRangeIndex(open.range[0]);
    if (owner && owner.type.startsWith('JSX')) continue;
    if (next.range[0] > open.range[1]) spaced++;
    else tight++;
  }
  cached = tight > spaced ? '' : ' ';
  braceSpaceCache.set(sourceCode, cached);
  return cached;
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
  const isSeparator = (t: Token) =>
    separators.some((value) => isPunct(t, value));
  // Braces keep a space inside when joined (`{ a, b }`) unless the file
  // writes them closed up; brackets and parens close up (`[a, b]`, `f(a, b)`).
  const bracketJoin = isPunct(open, '{') ? braceSpaceFor(sourceCode) : '';
  const gaps: Gap[] = [gapAfter(sourceCode, open, bracketJoin)];
  for (let i = 0; i < items.length - 1; i++) {
    // A TSPropertySignature's range covers its own `;`, so the next separator
    // found belongs to the following member and breaking there lands inside it.
    const separator = sourceCode.getTokenAfter(items[i]!, {
      filter: isSeparator,
    });
    const comma = separator && separator.range[0] < items[i + 1]!.range[0]
        ? separator
        : items[i]!;
    if (comma!.range[0] >= close.range[0]) return null;
    // Comma-first layouts count as broken too: the newline may sit on either
    // side of the comma. Members with no separator at all (type members split
    // by newlines) get one back when joined.
    if (comma === items[i]) {
      const last = sourceCode.getLastToken(items[i]!);
      const join = last && isSeparator(last) ? ' ' : `${separators[0]} `;
      gaps.push(gapAfter(sourceCode, comma!, join));
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
  const closeGap = gapBefore(sourceCode, close, 'close', bracketJoin);
  const dangling = sourceCode.getTokenBefore(close, { includeComments: true });
  if (dangling && isSeparator(dangling)) {
    const beforeDangling = sourceCode.getTokenBefore(dangling, {
      includeComments: true,
    });
    closeGap.alt = { start: beforeDangling!.range[1], end: dangling.range[0] };
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

const TEST_CALL_NAMES = new Set([
  'it',
  'test',
  'describe',
  'xit',
  'xtest',
  'xdescribe',
  'fit',
  'ftest',
  'fdescribe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'before',
  'after',
]);

// `it("title", () => {` and its relatives, the way Prettier singles them out.
function isTestCall(node: Node): boolean {
  if (node.type !== 'CallExpression') return false;
  let callee: Node = node.callee;
  while (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    /^(only|skip|each|concurrent|todo|sequential)$/.test(callee.property.name)
  ) {
    callee = callee.object;
  }
  if (callee.type === 'CallExpression') callee = callee.callee;
  if (callee.type !== 'Identifier' || !TEST_CALL_NAMES.has(callee.name)) {
    return false;
  }
  const args = node.arguments;
  if (args.length < 1 || args.length > 3) return false;
  const last = args[args.length - 1]!;
  if (
    last.type !== 'FunctionExpression' &&
    last.type !== 'ArrowFunctionExpression'
  ) {
    return false;
  }
  if (last.params.length > 1) return false;
  if (args.length === 1) return true;
  const first = args[0]!;
  return (
    (first.type === 'Literal' && typeof first.value === 'string') ||
    first.type === 'TemplateLiteral'
  );
}

function isHuggable(node: Node): boolean {
  if (node.type === 'ObjectExpression' ||
    node.type === 'ArrayExpression' ||
    // The pattern equivalents, for parameter lists: a lone destructured
    // parameter hugs like an options object.
    node.type === 'ObjectPattern' ||
    node.type === 'ArrayPattern') {
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
function arrowBodyGroup(
  sourceCode: Source,
  node: TSESTree.FunctionLike
): Group | null {
  if (node.type !== 'ArrowFunctionExpression') return null;
  if (!ARROW_BREAK_BODIES.has(node.body.type)) return null;
  const arrow = sourceCode.getTokenBefore(node.body, {
    filter: (t) => isPunct(t, '=>'),
  });
  if (!arrow) return null;
  return { node, kind: 'arrow', gaps: [gapAfter(sourceCode, arrow, ' ')] };
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
  // From the paren, not the callee: a call on a chain continuation line
  // indents its arguments from that line, not from the statement's first.
  const range: Range = [open.range[0], close.range[1]];
  // A trailing function argument keeps the author's layout: the hugged form
  // reads as partially broken though it is deliberate.
  const last = args[args.length - 1];
  const trailingFunction = last.type === 'FunctionExpression' ||
    last.type === 'ArrowFunctionExpression';

  // With exactly one huggable argument first or last, the call never breaks at
  // the call level — the hug target's own group absorbs the break.
  const huggable = args.filter(isHuggable);
  if (
    huggable.length === 1 &&
    (huggable[0] === args[0] || huggable[0] === args[args.length - 1])
  ) {
    return {
      node,
      gaps,
      range,
      items: args,
      addable: false,
      hug: huggable[0].range
    };
  }
  return { node, gaps, range, items: args, complete: !trailingFunction };
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
    gaps &&
    { node, range: [open.range[0], close.range[1]] as Range, gaps, items }
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
      if (
        !beforeSemi || beforeSemi.loc.end.line < prev.loc.start.line
      ) continue;
    }
    gaps.push(gapBefore(sourceCode, first!, 'same'));
  }
  return gaps;
}

// Parens wrapping a whole return value break like an `if` head: at the
// parens first, before anything inside them.
function returnParensGroup(
  sourceCode: Source,
  node: TSESTree.ReturnStatement,
): Group | null {
  const value = node.argument;
  if (!value) return null;
  const open = sourceCode.getTokenAfter(sourceCode.getFirstToken(node)!);
  if (!isPunct(open, '(') || open.range[1] > value.range[0]) return null;
  // The pair around the whole value: `return (/** cast */ (x))` opens twice.
  let depth = 0;
  for (
    let token: Token | null = open;
    token && token.range[0] < value.range[0];
    token = sourceCode.getTokenAfter(token)
  ) {
    if (!isPunct(token, '(')) return null;
    depth++;
  }
  let close = sourceCode.getTokenAfter(value);
  for (let i = 1; i < depth; i++) {
    if (!isPunct(close, ')')) return null;
    close = sourceCode.getTokenAfter(close);
  }
  if (!isPunct(close, ')')) return null;
  return {
    node,
    range: [open.range[0], close.range[1]],
    kind: 'condition',
    gaps: [gapAfter(sourceCode, open), gapBefore(sourceCode, close, 'close')],
  };
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
      const braced = node.consequent.length === 1 &&
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

// A factory-like head keeps its first call: `Object.keys(x)` and
// `this.store.get()` read as one name, and a lone `Object` on a line says
// nothing. A short name does too, but only in a statement of its own, where
// nothing else competes for the first line. Prettier draws both lines there.
function isShortHead(head: Node, root: Node, tabWidth: number): boolean {
  if (head.type === 'ThisExpression' || head.type === 'Super') return true;
  if (head.type !== 'Identifier') return false;
  if (/^[A-Z_$]/.test(head.name)) return true;
  return (
    head.name.length <= tabWidth && root.parent?.type === 'ExpressionStatement'
  );
}

function methodChainGroup(
  sourceCode: Source,
  node: Node,
  absorbed: Set<Node>,
  tabWidth: number,
): Group | null {
  const dots: Token[] = [];
  let headDot: Token | null = null;
  let headObject: Node | null = null;
  let callLinks = 0;
  let hasBlockBody = false;
  let current = node;
  let fromCall = false;
  while (true) {
    if (current.type === 'CallExpression' || current.type === 'NewExpression') {
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
          if (fromCall) callLinks++;
          // A link runs from the dot after a call to the next call:
          // `.to.have.property('x')` breaks before `.to`, the way Prettier
          // groups it. The dot after the head is decided once the head is known.
          const object = current.object;
          if (
            object.type === 'CallExpression' || object.type === 'NewExpression'
          ) {
            dots.push(dot);
          } else {
            headDot = dot;
            headObject = object;
          }
        }
      }
      fromCall = false;
      current = current.object;
      if (isParenthesized(sourceCode, current)) break;
    } else {
      break;
    }
  }
  if (callLinks < 2 || hasBlockBody) return null;
  // The dot after the head: `fs.readFileSync(...)` breaks there like any
  // link, unless the head is one that keeps its first call. A dot inside a
  // run of plain members, `.to.have`, is no link at all.
  if (headObject !== current) headDot = null;
  const joinOnly = headDot !== null && isShortHead(current, node, tabWidth);
  if (headDot) dots.push(headDot);
  const gaps: Gap[] = dots
    .map((dot) => {
      const { start, next } = pastLineComments(sourceCode, dot);
      return {
        ...gapBefore(sourceCode, dot, 'item'),
        alt: { start, end: next!.range[0] },
        ...(dot === headDot && joinOnly ? { joinOnly: true } : {}),
      };
    })
    .sort((a, b) => a.start - b.start);
  return { node, gaps, kind: 'chain' };
}

function paramsGroup(
  sourceCode: Source,
  node: TSESTree.FunctionLike
    | TSESTree.TSFunctionType
    | TSESTree.TSConstructorType,
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
  // The return type is part of the signature: an overflow inside it is fixed
  // by breaking the parameters, not the type.
  const reach = node.returnType?.range[1];
  const huggable = params.filter(isHuggable);
  if (
    huggable.length === 1 &&
    (huggable[0] === params[0] || huggable[0] === params[params.length - 1])
  ) {
    return {
      node,
      gaps,
      range,
      reach,
      kind: 'params',
      addable: false,
      hug: huggable[0].range
    };
  }
  return { node, gaps, range, reach, kind: 'params', items: params };
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

function forGroup(
  sourceCode: Source,
  node: TSESTree.ForStatement
): Group | null {
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
  const close = sourceCode.getTokenBefore(
    sourceCode.getFirstToken(node.body)!,
    { filter: (t) => isPunct(t, ')') }
  );
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
  return gaps &&
    { node, gaps, range: [open.range[0], close.range[1]], items: named };
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
  const closeToken = node.selfClosing && isPunct(beforeLast, '/')
    ? beforeLast
    : last;
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
  node: TSESTree.TSTypeParameterInstantiation
    | TSESTree.TSTypeParameterDeclaration,
): Group | null {
  const items = node.params;
  if (!items || items.length === 0) return null;
  const open = sourceCode.getFirstToken(node)!;
  const close = sourceCode.getLastToken(node)!;
  if (!isPunct(open, '<') || !isPunct(close, '>')) return null;
  const gaps = listGaps(sourceCode, open, close, items);
  return (
    gaps && { node, gaps, items, range: [open.range[0], close.range[1]] }
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

function tupleTypeGroup(
  sourceCode: Source,
  node: TSESTree.TSTupleType
): Group | null {
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
    const { start, next } = pastLineComments(sourceCode, token);
    gaps.push({
      start: prev!.range[1],
      end: token.range[0],
      alt: { start, end: next!.range[0] },
      kind: 'item',
      join: ' ',
    });
  }
  const group: Group = { node, gaps, kind: 'operator' };
  const before = sourceCode.getTokenBefore(types[0], { includeComments: true });
  if (isPunct(before, operator)) {
    const prev = sourceCode.getTokenBefore(before, { includeComments: true });
    if (prev) {
      group.lead = { start: prev.range[1], end: types[0].range[0] };
      // The node's range starts at the leading operator, which a join removes.
      group.range = [types[0].range[0], types[types.length - 1]!.range[1]];
    }
  }
  return group;
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

// `class A extends B implements C` breaks before each keyword, one level in.
// The clause's own list breaks after, nested under the keyword.
function heritageGroup(
  sourceCode: Source,
  node: TSESTree.ClassDeclaration
    | TSESTree.ClassExpression
    | TSESTree.TSInterfaceDeclaration,
): Group | null {
  const heads: Node[] = [];
  if (node.type === 'TSInterfaceDeclaration') {
    if (node.extends.length > 0) heads.push(node.extends[0]);
  } else {
    if (node.superClass) heads.push(node.superClass);
    if (node.implements && node.implements.length > 0) heads.push(
      node.implements[0]
    );
  }
  if (heads.length === 0) return null;
  const gaps: Gap[] = [];
  for (const head of heads) {
    const keyword = sourceCode.getTokenBefore(head, {
      filter: (t) => t.value === 'extends' || t.value === 'implements',
    });
    if (!keyword) return null;
    gaps.push(gapBefore(sourceCode, keyword, 'item', ' '));
  }
  const brace = sourceCode.getFirstToken(node.body)!;
  return { node, gaps, range: [node.range[0], brace.range[0]] };
}

function implementsGroup(
  sourceCode: Source,
  node: TSESTree.ClassDeclaration
    | TSESTree.ClassExpression
    | TSESTree.TSInterfaceDeclaration,
): Group | null {
  const items = node.type === 'TSInterfaceDeclaration'
    ? node.extends
    : node.implements;
  if (!items || items.length < 2) return null;
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
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
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
      filter: (t: Token) => t.value ===
        (member as { operator: string }).operator,
    });
    const prev = sourceCode.getTokenBefore(operator!, {
      includeComments: true
    });
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

function collectGroups(
  sourceCode: Source,
  operatorSide: OperatorSide = 'after',
  tabWidth: number = DEFAULT_TAB_WIDTH,
) {
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
          const chain = methodChainGroup(sourceCode, node, absorbed, tabWidth);
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
      case 'ReturnStatement': {
        const group = returnParensGroup(sourceCode, node);
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
        const group = whileKeyword &&
          conditionGroup(sourceCode, node, whileKeyword, close);
        if (group) candidates.push(group);
        break;
      }
      case 'SwitchStatement': {
        const brace = sourceCode.getTokenAfter(node.discriminant, {
          filter: (t) => isPunct(t, '{'),
        });
        const close = brace && sourceCode.getTokenBefore(brace);
        const group = close &&
          conditionGroup(
            sourceCode,
            node,
            sourceCode.getFirstToken(node)!,
            close
          );
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
          node.type === 'JSXElement'
          ? node.openingElement
          : node.openingFragment,
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
        // A declaration, laid out like a class body.
        const group = typeMembersGroup(sourceCode, node, node.body);
        if (group) necessary.push(group);
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
      case 'ClassExpression':
      case 'TSInterfaceDeclaration': {
        const heritage = heritageGroup(sourceCode, node);
        if (heritage) candidates.push(heritage);
        const group = implementsGroup(sourceCode, node);
        if (group) candidates.push(group);
        break;
      }
      case 'TSTypeAliasDeclaration': {
        const right = node.typeAnnotation;
        const operator = right &&
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
    if (closeGap && closeGap.kind === 'close') {
      arrow.gaps.push(closeGap);
      arrow.host = group;
    }
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
  const lines: VLine[] = [];
  let start = 0;
  LINE_BREAK.lastIndex = 0;
  let match;
  while ((match = LINE_BREAK.exec(text))) {
    lines.push(physicalLine(text, start, match.index));
    start = match.index + match[0].length;
  }
  lines.push(physicalLine(text, start, text.length));
  return lines;
}

function physicalLine(text: string, start: number, end: number): VLine {
  const own = /^[ \t]*/.exec(text.slice(start, end))![0];
  return { pieces: [[start, end]], own };
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
  '&&',
  '||',
  '??',
  '==',
  '===',
  '!=',
  '!==',
  '<=',
  '>=',
  '<<',
  '>>',
  '>>>',
  '%',
  '**',
  '&',
  '|',
  '^',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&&=',
  '||=',
  '??=',
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
/** A projected line: pieces of source, with the text joins put between them. */
interface VLine {
  pieces: (Range | string)[];
  // The leading whitespace the source gave the line; '' for a line a break
  // made, whose text starts at a token.
  own: string;
  // Where the line's indentation is measured from: a source offset. However
  // far the line holding that offset ends up from where the source had it,
  // this line moves the same way. A line a break made instead indents from
  // the anchor's line by `extra`.
  anchor?: number;
  extra?: string;
  fresh?: boolean;
}

function vlStart(vline: VLine): number {
  for (const piece of vline.pieces) {
    if (typeof piece !== 'string') return piece[0];
  }
  return 0;
}

function vlEnd(vline: VLine): number {
  for (let i = vline.pieces.length - 1; i >= 0; i--) {
    const piece = vline.pieces[i]!;
    if (typeof piece !== 'string') return piece[1];
  }
  return 0;
}

function lineText(text: string, vline: VLine): string {
  let out = '';
  for (const piece of vline.pieces) {
    out += typeof piece === 'string' ? piece : text.slice(piece[0], piece[1]);
  }
  return out;
}

/** The line's text between two source offsets, joins included. */
function sliceLine(
  text: string,
  vline: VLine,
  from: number,
  to: number
): string {
  let out = '';
  let pending = '';
  let contributed = false;
  for (const piece of vline.pieces) {
    if (typeof piece === 'string') {
      if (contributed) pending += piece;
      continue;
    }
    const start = Math.max(piece[0], from);
    const end = Math.min(piece[1], to);
    if (start > end || (start === end && piece[0] !== piece[1])) {
      if (piece[0] >= to) break;
      continue;
    }
    out += pending + text.slice(start, end);
    pending = '';
    contributed = true;
  }
  return out;
}

function overflowStart(
  text: string,
  vline: VLine,
  lead: string,
  maxWidth: number,
  tabWidth: number,
): number {
  const indentWidth = measureLine(lead, tabWidth);
  if (indentWidth > maxWidth) return vlStart(vline);
  let width = indentWidth;
  let lastOffset = vlStart(vline);
  // The line's own leading whitespace is already counted in the indent.
  let atStart = true;
  for (const piece of vline.pieces) {
    if (typeof piece === 'string') {
      for (const char of piece) {
        width += char === '\t' ? tabWidth - (width % tabWidth) : 1;
      }
      if (width > maxWidth) return lastOffset;
      continue;
    }
    let offset = piece[0];
    for (const char of text.slice(piece[0], piece[1])) {
      if (atStart && (char === ' ' || char === '\t')) {
        offset += 1;
        continue;
      }
      atStart = false;
      width += char === '\t' ? tabWidth - (width % tabWidth) : 1;
      if (width > maxWidth) return offset;
      offset += char.length;
    }
    lastOffset = piece[1];
  }
  return vlEnd(vline);
}

function format(
  sourceCode: Source,
  options: { maxWidth?: number; tabWidth?: number; join?: boolean } = {},
): Edit[] {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const tabWidth = options.tabWidth ?? DEFAULT_TAB_WIDTH;
  const join = options.join ?? DEFAULT_JOIN;
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
    tabWidth,
  );
  // The layout being decided, as lines of source pieces. Every decision
  // reshapes the projection; the edits are read off it at the end as the
  // difference from the source.
  const vlines = physicalLines(text);
  const consumedGaps = new Set<Gap>();

  // Groups can hold distinct gaps over the same whitespace (the last `=` of
  // `a = b = c` is a chain gap and a lone assignment's), so a decided gap is
  // recorded by position as well as by identity.
  const decided = new Set<string>();
  const rangeKey = (range: { start: number; end: number }) =>
    `${range.start}:${range.end}`;
  const isDecided = (gap: Gap) =>
    consumedGaps.has(gap) ||
    decided.has(rangeKey(gap)) ||
    (gap.alt !== undefined && decided.has(rangeKey(gap.alt)));
  const decide = (gap: Gap) => {
    consumedGaps.add(gap);
    claim(gap);
  };
  // A joined gap is claimed so no other group joins the same whitespace, but
  // stays open to the width pass, which may put the break right back.
  const claim = (gap: Gap) => {
    decided.add(rangeKey(gap));
    if (gap.alt) decided.add(rangeKey(gap.alt));
  };

  const rangeHasBreak = (range: { start: number; end: number }) => {
    LINE_BREAK.lastIndex = 0;
    return LINE_BREAK.test(text.slice(range.start, range.end));
  };

  // An operator gap counts as broken when either side carries the newline, so
  // Fold never fights an existing break over which side the operator sits on.
  const textHasBreak = (gap: Gap) =>
    rangeHasBreak(gap) || (gap.alt !== undefined && rangeHasBreak(gap.alt));

  /** The whitespace actually holding the newline; operator gaps have two. */
  const brokenRange = (gap: Gap) =>
    rangeHasBreak(gap) || !gap.alt ? gap : gap.alt;

  /**
   * What a join replaces. A close gap's `alt` sits on the other side of a
   * dangling separator, and the separator goes with the break: `a, b,\n)`
   * joins to `a, b)`, not `a, b,)`.
   */
  const joinRange = (gap: Gap) =>
    gap.kind === 'close' && gap.alt
      ? { start: gap.alt.start, end: gap.end }
      : brokenRange(gap);

  // What has been decided about each gap so far, by position. A gap with no
  // entry is as the source has it.
  interface Decision {
    broken: boolean;
    gap: Gap;
    messageId: MessageId;
    line?: VLine;
  }
  const decisions = new Map<string, Decision>();
  const decisionFor = (gap: Gap) =>
    decisions.get(rangeKey(gap)) ??
    (gap.alt !== undefined ? decisions.get(rangeKey(gap.alt)) : undefined);
  const record = (decision: Decision) => {
    decisions.set(rangeKey(decision.gap), decision);
    if (decision.gap.alt) decisions.set(rangeKey(decision.gap.alt), decision);
  };
  const hasBreak = (gap: Gap) =>
    decisionFor(gap)?.broken ?? textHasBreak(gap);

  // Lines stay in source order through every splice, so the line holding an
  // offset is a binary search.
  const findLine = (offset: number) => {
    let lo = 0;
    let hi = vlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vlStart(vlines[mid]!) <= offset) lo = mid + 1;
      else hi = mid;
    }
    const index = lo - 1;
    if (index < 0) return vlines.length > 0 ? 0 : -1;
    if (offset <= vlEnd(vlines[index]!)) return index;
    return index + 1 < vlines.length ? index + 1 : index;
  };
  /** The rendered line up to an offset: its indentation, then its text. */
  const prefixTo = (vl: VLine, to: number) =>
    leading(vl) + sliceLine(text, vl, vlStart(vl), to).replace(/^[ \t]*/, '');
  const onLine = (vl: VLine, gap: Gap) =>
    vlStart(vl) <= gap.start && gap.end <= vlEnd(vl);
  const lineOf = (gap: Gap) => {
    const index = findLine(gap.start);
    return index !== -1 && onLine(vlines[index]!, gap) ? index : -1;
  };

  /** The leading whitespace of the source line holding an offset. */
  function sourceLeadingAt(offset: number): string {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    return /^[ \t]*/.exec(text.slice(lineStart, lineStart + 400))![0];
  }

  /** The leading whitespace a line will carry once edits apply. */
  function leading(vl: VLine, depth = 0): string {
    if (vl.anchor === undefined || depth > 64) return vl.own;
    const index = findLine(vl.anchor);
    const anchorLine = index === -1 ? undefined : vlines[index];
    if (!anchorLine || anchorLine === vl) return vl.own;
    const anchorLeading = leading(anchorLine, depth + 1);
    if (vl.fresh) return anchorLeading + (vl.extra ?? '');
    // The source indented this line so far beyond (or short of) the anchor's
    // line; keep that difference from wherever the anchor's line is now.
    const anchorSrc = sourceLeadingAt(vl.anchor);
    if (vl.own.startsWith(anchorSrc)) {
      return anchorLeading + vl.own.slice(anchorSrc.length);
    }
    if (anchorSrc.startsWith(vl.own)) {
      const short = anchorSrc.length - vl.own.length;
      return anchorLeading.slice(0, Math.max(0, anchorLeading.length - short));
    }
    return vl.own;
  }
  const lineIndent = (_text: string, vl: VLine) => leading(vl);
  const lineWidth = (_text: string, vl: VLine, tab: number) =>
    measureLine(leading(vl) + lineText(text, vl).replace(/^[ \t]*/, ''), tab);

  /** The pieces of a line before a cut and after it, the cut itself dropped. */
  function splitPieces(
    pieces: (Range | string)[],
    cutStart: number,
    cutEnd: number,
  ): { before: (Range | string)[]; after: (Range | string)[] } {
    const before: (Range | string)[] = [];
    const after: (Range | string)[] = [];
    let past = false;
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        (past ? after : before).push(piece);
        continue;
      }
      if (piece[1] <= cutStart) {
        before.push(piece);
      } else if (piece[0] >= cutEnd) {
        past = true;
        after.push(piece);
      } else {
        past = true;
        if (piece[0] < cutStart) before.push([piece[0], cutStart]);
        if (piece[1] > cutEnd) after.push([cutEnd, piece[1]]);
      }
    }
    while (
      before.length > 0 && typeof before[before.length - 1] === 'string'
    ) before.pop();
    while (after.length > 0 && typeof after[0] === 'string') after.shift();
    return { before, after };
  }

  /**
   * Put a break at a gap in the projection. The new line indents from `base`
   * plus `extra`. The line being split keeps its identity, so decisions that
   * point at it stay current.
   */
  function breakAt(
    gap: Gap,
    anchors: { fresh: number; kept: number },
    extra: string,
  ): VLine | null {
    const index = lineOf(gap);
    if (index === -1) return null;
    const vl = vlines[index]!;
    const wasBroken = textHasBreak(gap);
    const anchor = wasBroken ? anchors.kept : anchors.fresh;
    const cut = wasBroken ? joinRange(gap) : gap;
    const { before, after } = splitPieces(vl.pieces, cut.start, cut.end);
    // A dangling separator dropped by a join comes back with the break.
    if (wasBroken && gap.kind === 'close' && gap.alt) {
      before.push(text.slice(gap.alt.end, gap.start));
    }
    if (before.length === 0 || after.length === 0) return null;
    // A break the source already had keeps the indentation the source gave
    // its line, relative to the anchor; a new break indents by the group's
    // rule. Either way the line follows the anchor from here on.
    const line: VLine = wasBroken
      ? { pieces: after, own: sourceLeadingAt(cut.end), anchor }
      : { pieces: after, own: '', anchor, extra, fresh: true };
    vl.pieces = before;
    vlines.splice(index + 1, 0, line);
    return line;
  }

  const groupRange = (group: Group): Range =>
    (group.range ?? group.node.range) as Range;

  /** Pull the lines on either side of a broken gap together. */
  function joinAt(gap: Gap, joinText: string) {
    return joinCut(joinRange(gap), joinText);
  }

  function joinCut(cut: { start: number; end: number }, joinText: string) {
    const first = findLine(cut.start);
    const last = findLine(cut.end);
    if (first === -1 || last === -1 || last < first) return false;
    const head = vlines[first]!;
    const tail = vlines[last]!;
    const { before } = splitPieces(head.pieces, cut.start, cut.end);
    const { after } = splitPieces(tail.pieces, cut.start, cut.end);
    if (before.length === 0 || after.length === 0) return false;
    head.pieces = [...before, joinText, ...after];
    vlines.splice(first + 1, last - first);
    return true;
  }

  const BODY_OF_PARENT = new Set([
    'BlockStatement',
    'ClassBody',
    'TSInterfaceBody',
    'TSModuleBlock',
    'TSEnumBody',
  ]);
  const STANDALONE_PARENTS = new Set([
    'Program',
    'BlockStatement',
    'SwitchCase'
  ]);
  // What a group's lines hang from: the bracket that opens it; for a
  // bracket-less group the start of the line it opens on; for a body, the
  // start of the statement or function it belongs to, so `for (...) {`
  // breaking its head does not carry the body along.
  const statementStartList = [...statementStarts].sort((a, b) => a - b);
  function statementStartBefore(offset: number): number {
    let lo = 0;
    let hi = statementStartList.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (statementStartList[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? statementStartList[lo - 1]! : offset;
  }
  // A line a break adds to a bracket-less group indents from the line the
  // group opens on, wherever that is; a line the source already had keeps
  // its place relative to the statement, which no join can merge away.
  function anchorOf(group: Group, groupStart: number, fresh = false): number {
    if (group.kind === 'operator' || group.kind === 'ternary') {
      return fresh
        ? vlStart(vlines[findLine(groupStart)]!)
        : statementStartBefore(groupStart);
    }
    if (BODY_OF_PARENT.has(group.node.type)) {
      const parent = group.node.parent;
      if (
        parent && !STANDALONE_PARENTS.has(parent.type)
      ) return parent.range[0];
    }
    return groupStart;
  }

  function breakGroup(group: Group, messageId: MessageId) {
    const groupStart = (group.range ?? group.node.range)[0];
    const openLine = vlines[findLine(groupStart)]!;
    const bracketless = group.kind === 'operator' || group.kind === 'ternary';
    const startsLine = sliceLine(
      text,
      openLine,
      vlStart(openLine),
      groupStart
    ).trim() ===
      '';
    // No staircase: a bracket-less group starting a continuation line takes
    // that indent as its level, or its first operand ends up a level shallower.
    const align = group.flat === true ||
      (bracketless && startsLine && !statementStarts.has(groupStart));
    const itemExtra = align ? '' : unit;
    const anchors = {
      fresh: anchorOf(group, groupStart, true),
      kept: anchorOf(group, groupStart),
    };
    // A close gap an arrow borrowed closes the call, and lines up with it.
    const closeAnchors = group.host
      ? { fresh: groupRange(group.host)[0], kept: groupRange(group.host)[0] }
      : anchors;

    for (const gap of group.gaps) {
      consumedGaps.add(gap);
      if (hasBreak(gap) || gap.joinOnly) continue;
      if (isForbiddenBreak(sourceCode, gap)) continue;
      const index = lineOf(gap);
      if (index === -1) continue;
      const vl = vlines[index]!;
      const line = gap.kind === 'same'
          ? breakAt(gap, { fresh: vlStart(vl), kept: vlStart(vl) }, '')
          : gap.kind === 'close'
            ? breakAt(gap, closeAnchors, '')
            : breakAt(gap, anchors, itemExtra);
      if (!line) continue;
      record({ broken: true, gap, messageId, line });
    }
  }

  // Every source line hangs from the innermost group around it: when that
  // group's anchor moves, the line moves with it.
  {
    const anchors = [...candidates, ...necessary]
      .map((group) => {
        const [start, end] = groupRange(group);
        return { start, end, anchor: anchorOf(group, start) };
      })
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const open: { start: number; end: number; anchor: number }[] = [];
    let next = 0;
    for (const vl of vlines) {
      const at = vlStart(vl);
      while (open.length > 0 && open[open.length - 1]!.end <= at) open.pop();
      while (next < anchors.length && anchors[next]!.start <= at) {
        if (anchors[next]!.end > at) open.push(anchors[next]!);
        next++;
      }
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i]!.anchor < at) {
          vl.anchor = open[i]!.anchor;
          break;
        }
      }
    }
  }

  for (const group of necessary) {
    breakGroup(group, 'necessaryBreak');
  }

  const BLANK_LINE = /(\r?\n)[ \t]*(\r?\n)/;

  // The close gap a trailing arrow borrowed is the call's own whenever the
  // call is broken anywhere else, so the arrow decides only its `=>` break.
  function ownGaps(group: Group): Gap[] {
    const host = group.host;
    if (!host || !host.gaps.some((g) => g.kind !== 'close' && hasBreak(g))) {
      return group.gaps;
    }
    return group.gaps.filter((gap) => gap.kind !== 'close');
  }

  // A blank line or a comment between a group's items means the author
  // grouped something deliberately, and Fold cannot know what. A comment
  // belongs to the innermost group around it; the groups outside say nothing.
  // A block comment sharing its line with code, like a JSDoc cast, travels
  // with that code and pins nothing.
  const ownsLine = (comment: TSESTree.Comment) => {
    if (comment.type === 'Line') return true;
    const lineStart = text.lastIndexOf('\n', comment.range[0] - 1) + 1;
    let lineEnd = text.indexOf('\n', comment.range[1]);
    if (lineEnd === -1) lineEnd = text.length;
    return (
      text.slice(lineStart, comment.range[0]).trim() === '' &&
      text.slice(comment.range[1], lineEnd).trim() === ''
    );
  };
  const pinnedBy = new Map<TSESTree.Comment, Group>();
  for (const group of [...candidates, ...necessary]) {
    const [rangeStart, rangeEnd] = groupRange(group);
    for (const comment of sourceCode.getCommentsInside(group.node)) {
      if (
        comment.range[0] < rangeStart || comment.range[1] > rangeEnd
      ) continue;
      if (!ownsLine(comment)) continue;
      const current = pinnedBy.get(comment);
      if (!current) {
        pinnedBy.set(comment, group);
        continue;
      }
      const [currentStart, currentEnd] = groupRange(current);
      if (rangeEnd - rangeStart < currentEnd - currentStart) {
        pinnedBy.set(comment, group);
      }
    }
  }
  function holdsAuthorLayout(group: Group): boolean {
    for (const gap of group.gaps) {
      if (BLANK_LINE.test(text.slice(gap.start, gap.end))) return true;
      if (gap.alt && BLANK_LINE.test(text.slice(gap.alt.start, gap.alt.end)))
        return true;
    }
    for (const owner of pinnedBy.values()) if (owner === group) return true;
    return false;
  }

  // Leading operators removed with a join. Not gaps: nothing puts them back.
  const leadJoins: {
    range: { start: number; end: number };
    messageId: MessageId
  }[] = [];

  /** Remove every break a group owns from the projection. */
  function joinGroup(group: Group, messageId: MessageId) {
    const gaps = ownGaps(group).filter((gap) => !isDecided(gap));
    let joinedAny = false;
    for (const gap of gaps) {
      if (!hasBreak(gap) || !textHasBreak(gap)) {
        claim(gap);
        continue;
      }
      if (!joinAt(gap, gap.join ?? '')) continue;
      claim(gap);
      joinedAny = true;
      record({ broken: false, gap, messageId });
    }
    if (joinedAny && group.lead && joinCut(group.lead, ' ')) {
      leadJoins.push({ range: group.lead, messageId });
    }
  }

  /**
   * The text a join rewrites: the group, extended over any gap it borrowed
   * (a trailing arrow's group holds the call's close gap).
   */
  function joinSpan(group: Group): Range {
    let [start, end] = groupRange(group);
    for (const gap of ownGaps(group)) {
      if (!hasBreak(gap)) continue;
      const range = joinRange(gap);
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    }
    if (group.lead) start = Math.min(start, group.lead.start);
    return [start, end];
  }

  /**
   * The group with its own breaks collapsed, or null when a break inside it
   * belongs to something else — joining then would not produce one line.
   */
  function collapsedText(group: Group): string | null {
    const [start, end] = joinSpan(group);
    const first = findLine(start);
    const last = findLine(end);
    if (first === -1 || last === -1) return null;
    const ranges = ownGaps(group)
      .filter(hasBreak)
      .map((gap) => ({ range: joinRange(gap), join: gap.join ?? '' }))
      .sort((a, b) => a.range.start - b.range.start);
    if (group.lead) ranges.unshift({ range: group.lead, join: ' ' });
    // Any line boundary inside the span that no own gap accounts for is
    // someone else's break.
    for (let i = first; i < last; i++) {
      const boundary = vlEnd(vlines[i]!);
      if (
        !ranges.some(
          (r) => r.range.start <= boundary && boundary <= r.range.end
        )
      ) {
        return null;
      }
    }
    let out = '';
    let cursor = start;
    for (const { range, join: joinText } of ranges) {
      out += sliceLines(text, first, last, cursor, range.start) + joinText;
      cursor = range.end;
    }
    out += sliceLines(text, first, last, cursor, end);
    return out;
  }

  /** The projected text between two offsets, across the lines holding them. */
  function sliceLines(
    source: string,
    first: number,
    last: number,
    from: number,
    to: number,
  ): string {
    let out = '';
    for (let i = first; i <= last; i++) {
      out += sliceLine(source, vlines[i]!, from, to);
    }
    return out;
  }

  /** Whether the line the joined group would land on stays within maxWidth. */
  function joinedFits(group: Group, inline: string): boolean {
    const [start, end] = joinSpan(group);
    const first = vlines[findLine(start)]!;
    const last = vlines[findLine(end)] ?? first;
    const head = prefixTo(first, start);
    const tail = sliceLine(text, last, end, vlEnd(last));
    return measureLine(head + inline + tail, tabWidth) <= maxWidth;
  }

  // A partially broken group is an editing artifact rather than a layout, so
  // it is re-decided by width: joined if it fits, completed if it does not. A
  // fully broken group is already consistent and is left alone, which is what
  // keeps a deliberate layout safe by default.
  function completeGroup(group: Group) {
    // A gap an enclosing group has decided is left to it.
    const gaps = ownGaps(group).filter((gap) => !isDecided(gap));
    const broken = gaps.filter(hasBreak);
    if (broken.length === 0) return;
    const breakable = gaps.filter(
      (gap) => !gap.joinOnly && !isForbiddenBreak(sourceCode, gap),
    );
    if (broken.length >= breakable.length) return;
    if (group.addable === false || group.complete === false) return;
    // A chain broken at some dots is a deliberate head/tail split; completing
    // it would pull `Object.keys(value)` apart. An arrow's gaps are not peers,
    // so completing them would break the `=>` of every arrow sitting in an
    // already-broken call.
    if (group.kind === 'chain' || group.kind === 'arrow') return;
    if (holdsAuthorLayout(group)) return;

    // A group that fits on one line is joined rather than completed: a list
    // broken at one comma is more likely a stray newline than a layout. When
    // it does not fit, completing it is the only consistent option.
    const inline = collapsedText(group);
    if (inline !== null && joinedFits(group, inline)) {
      joinGroup(group, 'inconsistentGroup');
      return;
    }
    breakGroup(group, 'inconsistentGroup');
  }

  // With `join`, layout is decided from scratch: every break a group owns
  // comes out of the projection first, and the width pass below puts back
  // only the ones the text needs. What the author wrote is not consulted,
  // so the same code always lands on the same layout — except where a blank
  // line or comment marks a grouping Fold cannot see.
  function collapseGroup(group: Group) {
    const gaps = ownGaps(group).filter((gap) => !isDecided(gap));
    const broken = gaps.filter(hasBreak);
    if (broken.length === 0) return;
    const breakable = gaps.filter(
      (gap) => !gap.joinOnly && !isForbiddenBreak(sourceCode, gap),
    );
    const consistent = broken.length >= breakable.length;
    if (!consistent && (group.addable === false || group.complete === false))
      return;
    if (!consistent && (group.kind === 'chain' || group.kind === 'arrow'))
      return;
    if (holdsAuthorLayout(group)) return;
    joinGroup(group, consistent ? 'joinable' : 'inconsistentGroup');
  }

  const outermostFirst = [...candidates].sort(
    (a, b) =>
      groupRange(a)[0] - groupRange(b)[0] ||
      groupRange(b)[1] - groupRange(a)[1],
  );
  for (const group of outermostFirst) {
    if (join) collapseGroup(group);
    else completeGroup(group);
  }

  // A group holding an item that spans lines breaks around it: `{ a: {` and
  // `render(<div>` hug nothing, and the closers would pile up on one line.
  // Parens around a multi-line return value do the same.
  for (const group of outermostFirst) {
    const wrapsValue = group.node.type === 'ReturnStatement' &&
      group.kind === 'condition';
    // A hug, or a trailing function, holds a multi-line item on purpose.
    const holdsItems = group.items !== undefined &&
      group.addable !== false &&
      group.complete !== false &&
      group.kind !== 'chain';
    if (!wrapsValue && !holdsItems) continue;
    if (group.gaps.some(hasBreak)) continue;
    const [start, end] = groupRange(group);
    if (findLine(start) !== findLine(end)) {
      breakGroup(group, 'inconsistentGroup');
    }
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
    const start = vlStart(vl);
    const end = vlEnd(vl);
    let lo = 0;
    let hi = gapStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gapStarts[mid]! < start) lo = mid + 1;
      else hi = mid;
    }
    const found = new Set<Group>();
    for (let i = lo; i < gapIndex.length && gapStarts[i]! <= end; i++) {
      if (gapIndex[i]!.gap.end <= end) found.add(gapIndex[i]!.group);
    }
    return found;
  }

  // A line over width only because of a trailing comment is unbreakable: the
  // code fits, and moving the comment down is a vertical-spacing change.
  const comments = sourceCode.getAllComments();
  function overflowIsTrailingComment(vl: VLine) {
    const lineStart = vlStart(vl);
    const lineEnd = vlEnd(vl);
    for (const comment of comments) {
      const [start, end] = comment.range;
      if (start < lineStart || start >= lineEnd) continue;
      if (end < lineEnd) continue; // not the tail of the line
      const code = prefixTo(vl, start).trimEnd();
      if (measureLine(code, tabWidth) <= maxWidth) return true;
    }
    return false;
  }

  // Break the outermost group holding the overflow. The cursor does not
  // advance; breakGroup consumes a group's gaps, so this ends by exhaustion.
  for (let cursor = 0; cursor < vlines.length; ) {
    const vl = vlines[cursor]!;
    if (
      lineWidth(text, vl, tabWidth) <= maxWidth || overflowIsTrailingComment(vl)
    ) {
      cursor++;
      continue;
    }
    const overflow = overflowStart(
      text,
      vl,
      lineIndent(text, vl),
      maxWidth,
      tabWidth
    );
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
      return (
        measureLine(
          indent + sliceLine(text, vl, itemStart, itemEnd),
          tabWidth
        ) >
        maxWidth
      );
    };

    // A hug holds only while the head fits through the hugged bracket. Past
    // that, the call breaks like any other rather than something inside an
    // earlier argument.
    const hugFails = (group: Group) => {
      const hug = group.hug;
      if (!hug || hug[0] < vlStart(vl) || hug[0] > vlEnd(vl)) return false;
      // A test case keeps its title and callback together whatever the
      // width, as Prettier does: `it("...", () => {` is one line of a suite.
      if (isTestCall(group.node)) return false;
      // The hugged line runs to the bracket that opens the body: for a
      // function, its `{`; for an expression-bodied arrow, its `=>`.
      const item = group.items?.find((i) => i && i.range[0] === hug[0]);
      let headEnd = hug[0] + 1;
      if (
        item &&
        (item.type === 'FunctionExpression' ||
          item.type === 'ArrowFunctionExpression')
      ) {
        headEnd = item.body.type === 'BlockStatement'
          ? item.body.range[0] + 1
          : (sourceCode.getTokenBefore(item.body, {
              filter: (t) => isPunct(t, '=>'),
            })?.range[1] ?? headEnd);
      }
      return measureLine(prefixTo(vl, headEnd), tabWidth) > maxWidth;
    };

    const onThisLine = [...groupsOnLine(vl)].filter(
      (group) =>
        (group.addable !== false || hugFails(group)) &&
        !cannotHelp(group) &&
        group.gaps.some(
          (gap) =>
            !gap.joinOnly &&
            !consumedGaps.has(gap) &&
            !hasBreak(gap) &&
            onLine(vl, gap) &&
            !isForbiddenBreak(sourceCode, gap),
        ),
    );
    // Last resort, and only when both halves fit: a 200-character string is
    // still 200 characters one line further down.
    const breakable = onThisLine.filter((group) => !group.fallback);
    if (breakable.length === 0) {
      const rescue = onThisLine.filter((group) =>
          group.fallback && group.gaps.some((gap) => {
            if (consumedGaps.has(gap) || hasBreak(gap)) return false;
            const head = prefixTo(vl, gap.start).trimEnd();
            const tail = sliceLine(text, vl, gap.end, vlEnd(vl));
            return (
              measureLine(head, tabWidth) <= maxWidth &&
              measureLine(lineIndent(text, vl) + unit + tail, tabWidth) <=
                maxWidth
            );
          }));
      if (rescue.length === 0) {
        cursor++;
        continue;
      }
      rescue.sort(
        (a, b) =>
          groupRange(a)[0] - groupRange(b)[0] ||
          groupRange(b)[1] - groupRange(a)[1],
      );
      breakGroup(rescue[0]!, 'overWidth');
      continue;
    }

    // Prefer a group spanning the overflow, then one that reaches it:
    // `assertEqual<A, B>(v)` overflows inside the type arguments, not at `(`.
    // A group ending exactly at the overflow spans it too: breaking its close
    // gap moves the overflowing tail to the next line.
    const groupEnd = (group: Group) =>
      Math.max(
        group.reach ?? 0,
        groupRange(group)[1],
        ...group.gaps.map((gap) => gap.end),
      );
    const spanning = breakable.filter((group) => groupEnd(group) >= overflow);
    const reaching = spanning.filter((group) =>
      group.gaps.some(
        (gap) =>
          !gap.joinOnly &&
          gap.start <= overflow &&
          !consumedGaps.has(gap) &&
          !hasBreak(gap)
      )
    );
    const usable = reaching.length > 0
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
        groupRange(a)[0] - groupRange(b)[0] ||
        groupRange(b)[1] - groupRange(a)[1],
    );
    breakGroup(usable[0]!, 'overWidth');
  }

  // Children never share a line with a tag that spans several: `>{x}` after
  // a broken attribute list is a shape no JSX rule accepts. Decided last,
  // once the width pass has settled the tag.
  for (const group of outermostFirst) {
    if (group.node.type !== 'JSXElement' || !group.items) continue;
    if (group.gaps.some(hasBreak)) continue;
    const tag = group.node.openingElement.range;
    if (findLine(tag[0]) !== findLine(tag[1])) {
      breakGroup(group, 'inconsistentGroup');
    }
  }

  // The edits are where the projection differs from the source.
  const edits: Edit[] = [];
  const joins: Edit[] = [];
  const emitted = new Set<string>();
  for (const decision of decisions.values()) {
    const { gap, broken, messageId } = decision;
    const key = rangeKey(gap);
    if (emitted.has(key)) continue;
    emitted.add(key);
    if (broken === textHasBreak(gap)) continue;
    if (broken) {
      const loc = sourceCode.getLocFromIndex(gap.end);
      edits.push({
        range: [gap.start, gap.end],
        text: newline + (decision.line ? leading(decision.line) : ''),
        loc: { start: loc, end: loc },
        messageId,
        data: { maxWidth: String(maxWidth) },
      });
    } else {
      const range = joinRange(gap);
      const loc = sourceCode.getLocFromIndex(range.end);
      joins.push({
        range: [range.start, range.end],
        text: gap.join ?? '',
        loc: { start: loc, end: loc },
        messageId,
      });
    }
  }
  for (const { range, messageId } of leadJoins) {
    const loc = sourceCode.getLocFromIndex(range.end);
    joins.push({
      range: [range.start, range.end],
      text: ' ',
      loc: { start: loc, end: loc },
      messageId,
    });
  }
  // A lead covers the gap after the `=` before it; the wider edit does both.
  for (const edit of joins) {
    const inside = joins.some(
      (other) =>
        other !== edit &&
        other.range[0] <= edit.range[0] &&
        edit.range[1] <= other.range[1] &&
        (other.range[0] < edit.range[0] || edit.range[1] < other.range[1]),
    );
    if (!inside) edits.push(edit);
  }

  // A source line whose anchor moved takes its indentation along. Text
  // inside a block comment, a template or JSX text is left alone.
  const allComments = sourceCode.getAllComments();
  for (const vl of vlines) {
    if (vl.fresh || vl.anchor === undefined) continue;
    const start = vlStart(vl);
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const ws = /^[ \t]*/.exec(text.slice(lineStart, lineStart + 400))![0];
    const content = lineStart + ws.length;
    if (content < start) continue;
    // A blank line stays blank.
    if (
      content >= text.length || text[content] === '\n' || text[content] === '\r'
    ) continue;
    const want = leading(vl);
    if (want === ws) continue;
    if (
      allComments.some((c) => c.range[0] < content && content < c.range[1])
    ) continue;
    const node = sourceCode.getNodeByRangeIndex(content);
    if (
      node &&
      (node.type === 'TemplateElement' ||
        node.type === 'TemplateLiteral' ||
        node.type === 'JSXText')
    )
      continue;
    const loc = sourceCode.getLocFromIndex(content);
    edits.push({
      range: [lineStart, content],
      text: want,
      loc: { start: loc, end: loc },
      messageId: 'moved',
    });
  }

  edits.sort((a, b) => b.range[0] - a.range[0]);
  return edits;
}

type Options = [{ maxWidth?: number; tabWidth?: number; join?: boolean }?];

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
          join: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      overWidth: 'Line exceeds {{maxWidth}} characters.',
      necessaryBreak: 'Missing line break.',
      inconsistentGroup:
        'This group is partially broken; break every element or none.',
      joinable: 'This group fits on one line.',
      moved: 'Indentation follows the line this moved with.',
    },
    defaultOptions: [
      {
        maxWidth: DEFAULT_MAX_WIDTH,
        tabWidth: DEFAULT_TAB_WIDTH,
        join: DEFAULT_JOIN
      },
    ],
  },

  create(context) {
    const maxWidth = context.options[0]?.maxWidth ?? DEFAULT_MAX_WIDTH;
    const tabWidth = context.options[0]?.tabWidth ?? DEFAULT_TAB_WIDTH;
    const join = context.options[0]?.join ?? DEFAULT_JOIN;

    return {
      'Program:exit'() {
        for (const edit of format(context.sourceCode, {
          maxWidth,
          tabWidth,
          join
        })) {
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
  meta: { name: 'eslint-plugin-esfold', version: '0.1.3' },
  // ESLint types rules against ESTree; this one is typed against TSESTree so
  // it can walk TypeScript nodes. The shapes are identical at runtime.
  rules: { breaks: breaks as unknown as Rule.RuleModule },
};

export default plugin;
