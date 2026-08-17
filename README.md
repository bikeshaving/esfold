# eslint-plugin-fold

A single ESLint rule, `fold/breaks`, that decides one thing: **where the
newlines go.**

> ESLint dropped its formatting rules and told everyone to use a formatter.
> `@stylistic` picked them back up, and covers everything except line breaks.
> `fold/breaks` is the missing rule.

## Why

Prettier re-prints the whole file, so it needs an opinion about everything —
semicolons, quotes, spacing — territory ESLint rules already occupy. That's
why adopting it means installing `eslint-config-prettier`, a package whose
entire job is turning off dozens of ESLint rules.

Of everything Prettier decides, `@stylistic` covers all of it but one thing:
it can't insert a line break. `fold/breaks` fills exactly that gap and does
nothing else, so there is no `eslint-config-fold` and never will be. You add
a rule; you don't disable anything.

## Usage

```js
// eslint.config.js
import fold from 'eslint-plugin-fold';

export default [
  { plugins: { fold }, rules: { 'fold/breaks': ['error', { maxWidth: 80 }] } },
];
```

`eslint --fix` is the entire interface — checking, editor format-on-save, and
`// eslint-disable-next-line fold/breaks` all come free with ESLint. Whatever
syntax your parser handles (TypeScript, JSX, decorators), Fold handles; it
never parses anything itself.

## Behavior

**It only ever adds line breaks.** A break you wrote is a decision, and Fold
won't overrule it — your `compose()` pipeline stays as you laid it out, no
ignore comment needed. Joining lines is one keystroke in your editor;
finding the over-width line and picking the split point is the tedious half,
and that's Fold's half.

Given an over-width line, it breaks the outermost structure first, one item
per line — arguments, array elements, object properties; operator chains at
the lowest precedence first; method chains before the dot, except when the
chain's arguments have block bodies and already provide the structure. A lone
object/array/function argument hugs the call rather than exploding it. A
group broken at *some* of its positions gets completed to all of them; a
group containing a comment or a blank line is left exactly as written.

Lines it can't fix — a long string, regex, URL, or trailing comment — it
leaves alone silently. Reporting those is `@stylistic/max-len`'s job.

See [docs/rules/breaks.md](docs/rules/breaks.md) for the full decision list.

## Configuration

One option, `maxWidth` (default 80). Nothing else, ever — every option is a
way for two codebases to format differently, which is what grows a
`.prettierrc` ecosystem.

Indentation is **inferred from the file** rather than configured, so it can't
disagree with whatever actually formatted it. A tab counts as 4 columns when
measuring, matching `@stylistic/max-len`'s default.

## Compatibility

Fold never reads another rule's config (ESLint doesn't expose it) and never
depends on `@stylistic`. Because it only adds breaks, it composes with
essentially all of `@stylistic`:

- **Position rules** — `operator-linebreak`, `dot-location`, `comma-style` —
  work at any setting. Fold counts a break on either side of the token as an
  existing break, so it never double-breaks or relocates one.
- **Force-break rules** (`array-element-newline`, `object-property-newline`,
  `newline-per-chained-call`, and friends) compose in any mode that *adds*
  breaks: they break, Fold keeps the group consistent.
- **`"never"` settings conflict.** "Never break here" contradicts "keep lines
  under 80 columns"; drop the `never`. No stock preset enables one.
- `max-len` has no fixer, so it only reports where Fold fixes.

## Name

A fold is a break that preserves the material — literally the architecture
here: text edits, never regeneration. POSIX `fold(1)` also inserts line
breaks at a width.

## License

MIT
