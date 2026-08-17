/**
 * Line-width measurement (§7.1).
 *
 * A tab advances to the next 4-column tab stop. 4 matches
 * `@stylistic/max-len`'s default `tabWidth`, so a project running both rules
 * never disagrees about which lines are too long. Not configurable.
 */
export const TAB_WIDTH = 4;

/** Visual width of a line of text. */
export function measureLine(text) {
  let width = 0;
  for (const ch of text) {
    if (ch === '\t') {
      width += TAB_WIDTH - (width % TAB_WIDTH);
    } else {
      width += 1;
    }
  }
  return width;
}
