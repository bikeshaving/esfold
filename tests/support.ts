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

/** Deep AST comparison value, ignoring position data. */
export function stripLocations(node: any): any {
  if (Array.isArray(node)) {
    return node.filter((item) => !isDroppedByJsx(item)).map(stripLocations);
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node)) {
      if (IGNORED.has(key)) continue;
      out[key] = stripLocations(node[key]);
    }
    return out;
  }
  return node;
}
