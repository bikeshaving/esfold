import { measureLine } from './measure.js';
import { inferIndentUnit } from './indent.js';
import { collectGroups } from './groups.js';
import { isForbiddenBreak } from './forbidden.js';

/**
 * The pure core (§2.4): format(sourceCode, options) → Edit[].
 *
 * An Edit is:
 *   {
 *     range: [start, end],   // source offsets; text in this range is replaced
 *     text: string,          // replacement ('\n' + indent for an insert)
 *     loc: { start, end },   // where the rule reports it — the real token
 *     messageId: string,     // 'overWidth' | 'unnecessaryBreak'
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
  let width = measureLine(vline.indent);
  if (width > maxWidth) return vline.start;
  for (let i = vline.start; i < vline.end; i++) {
    width = measureLine(vline.indent + text.slice(vline.start, i + 1));
    if (width > maxWidth) return i;
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
    };
    indentCache.set(sourceCode, inferred);
  }
  const { unit, operatorSide } = inferred;

  const { candidates, necessary } = collectGroups(sourceCode, operatorSide);
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
    const openLine = vlines[findLine((group.range ?? group.node.range)[0])];
    const baseIndent = lineIndent(text, openLine);
    const itemIndent = baseIndent + unit;

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
        text: '\n' + newIndent,
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

  // Addition pass (§6 step 6): repeatedly break the outermost group that
  // contains an over-width line's overflow, until every line either fits or
  // has no legal candidate (§7.1: unbreakable lines get silence).
  let changed = true;
  while (changed) {
    changed = false;
    for (const vl of [...vlines]) {
      if (lineWidth(text, vl) <= maxWidth) continue;
      const overflow = overflowStart(text, vl, maxWidth);
      const usable = candidates.filter(
        (group) =>
          group.addable !== false &&
          groupRange(group)[1] > overflow &&
          group.gaps.some(
            (gap) =>
              !consumedGaps.has(gap) &&
              !hasBreak(gap) &&
              vl.start <= gap.start &&
              gap.end <= vl.end &&
              !isForbiddenBreak(sourceCode, gap),
          ),
      );
      if (usable.length === 0) continue;
      usable.sort(
        (a, b) =>
          groupRange(a)[0] - groupRange(b)[0] || groupRange(b)[1] - groupRange(a)[1],
      );
      breakGroup(usable[0], 'overWidth');
      changed = true;
      break;
    }
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
