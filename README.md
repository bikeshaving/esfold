# eslint-plugin-fold

One ESLint rule, `fold/breaks`, that decides where the line breaks go.

It only ever inserts newlines. It does not reindent, requote, add semicolons,
or join lines you broke on purpose — so it has nothing to disagree with your
other rules about, and there is no `eslint-config-fold` to adopt.

```sh
npm install --save-dev eslint-plugin-fold
```

```js
// eslint.config.js
import fold from 'eslint-plugin-fold';

export default [
  fold.configs.recommended,
];
```

Or configure the rule directly:

```js
import fold from 'eslint-plugin-fold';

export default [
  {
    plugins: { fold },
    rules: { 'fold/breaks': ['error', { maxWidth: 100 }] },
  },
];
```

## What it does

At `maxWidth: 80`, this line is 90 columns:

```js
const result = computeThing(firstArgument, secondArgument, thirdArgument, fourthArgument);
```

and becomes:

```js
const result = computeThing(
  firstArgument,
  secondArgument,
  thirdArgument,
  fourthArgument
);
```

No trailing comma appears, because adding one would not be a line break.
Pair it with `@stylistic/comma-dangle` if you want it.

Three kinds of report, all fixable:

- **`overWidth`** — the line is longer than `maxWidth` and something on it can
  be broken. A long line with no legal break position is left alone silently
  rather than reported unfixably.
- **`necessaryBreak`** — a block body, class body, switch case, statement
  boundary, or nested JSX element, which go on their own lines at any width.
- **`inconsistentGroup`** — a list broken at some commas but not others. Fold
  completes it rather than collapsing it.

## Options

| Option | Default | |
|---|---|---|
| `maxWidth` | `80` | Columns a line may occupy. |
| `tabWidth` | `2` | Columns a tab advances to. Matters only for tab-indented files. |

Everything else is read from the file: the indent unit, the line ending, and
whether operators go at the end of a line or the start of the next. There is
nothing to keep in sync with your editor.

`tabWidth` is the exception because a tab's width is a property of how you
view a file, not of the file. If you also run `@stylistic/max-len`, set both
to the same value — it defaults to `4`.

## Coexisting with other rules

Fold treats a newline on *either* side of an operator, dot, or comma as a
break, so `@stylistic/operator-linebreak`, `dot-location` and `comma-style`
keep whatever side you configured and both rules settle in one `--fix` run.

Fold also never joins lines. A break you wrote is a decision it keeps, which
is what makes hand-laid-out code — a `compose()` pipeline, an aligned table of
constants — survive contact with it.

## Requirements

ESLint 9 or later, ESM. Any parser ESLint can use, including
`typescript-eslint` for TypeScript and JSX.

## License

MIT
