// JSX drops a whitespace run containing a newline, so breaking between element
// children adds text nodes that render as nothing. Those are the only text
// nodes Fold ever creates, so dropping exactly them is what makes AST
// comparison meaningful for JSX. A blank text node *without* a newline is a
// real space and stays.
const isDroppedByJsx = (node: any) =>
  node &&
  node.type === 'JSXText' &&
  node.value.trim() === '' &&
  /[\r\n]/.test(node.value);

const IGNORED = new Set(['range', 'loc', 'start', 'end', 'parent']);

// A join drops a dangling comma or semicolon and a leading `|` or `&`, and
// puts a separator between type members that had only a newline. Separators
// are structural, so the AST already checks them; the token list is compared
// without them.
const CLOSERS = new Set([')', ']', '}', '>']);
const isDroppedByJoin = (token: any, prev: any) =>
  token?.type === 'Punctuator' &&
  (token.value === ',' ||
    token.value === ';' ||
    ((token.value === '|' || token.value === '&') &&
      prev?.type === 'Punctuator' &&
      !CLOSERS.has(prev.value)));

/** Deep AST comparison value, ignoring position data. */
export function stripLocations(node: any): any {
  if (Array.isArray(node)) {
    return node.filter((item) => !isDroppedByJsx(item)).map(stripLocations);
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node)) {
      if (IGNORED.has(key)) continue;
      const value = node[key];
      out[key] =
        key === 'tokens' && Array.isArray(value)
          ? stripLocations(value.filter((t, i) => !isDroppedByJoin(t, value[i - 1])))
          : stripLocations(value);
    }
    return out;
  }
  return node;
}
