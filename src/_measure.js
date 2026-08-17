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
