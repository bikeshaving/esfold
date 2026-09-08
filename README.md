# eslint-plugin-esfold

An ESLint plugin which breaks lines when they exceed a specified width, using
ESLint’s `--fix` option.

```sh
npm install --save-dev eslint-plugin-esfold
```

`eslint.config.js`

```js
import esfold from 'eslint-plugin-esfold';

export default [
  {
    plugins: { esfold },
    rules: { 'esfold/breaks': ['error'] },
  },
];
```

## What it does

At `maxWidth: 80`, this line measured at 90 columns

```js
const result = computeThing(firstArgument, secondArgument, thirdArgument, fourthArgument);
```

becomes

```js
const result = computeThing(
  firstArgument,
  secondArgument,
  thirdArgument,
  fourthArgument
);
```

Pair it with `@stylistic/comma-dangle` if you want a trailing comma.

## Fix types

- **`overWidth`** — the line exceeds `maxWidth` and contains valid potential
  breaks.
- **`necessaryBreak`** — a line contains syntax which must be followed by a
  break regardless of width, e.g. blocks, classes, interface bodies,
  statement boundaries or nested JSX elements.
- **`inconsistentGroup`** — a group has line breaks applied inconsistently,
  e.g. an array which does not have breaks for each elements.
- **`joinable`** — with `join: true`, a fully broken group fits on one line.
- **`moved`** — a line inside something that moved, such as the body of a
  function whose call came apart or hugged again, takes the same shift.

## Options

| Option | Default | |
|---|---|---|
| `maxWidth` | `80` | Columns a line may occupy. |
| `tabWidth` | `2` | Columns a tab advances to. Matters only for tab-indented files. |
| `join` | `false` | Also join a fully broken group back onto one line when it fits. |

```js
import esfold from 'eslint-plugin-esfold';

export default [
  {
    plugins: { esfold },
    rules: { 'esfold/breaks': ['error', { maxWidth: 80, tabWidth: 2 }] },
  },
];
```

## Usage with other rules

The fold plugin attempts to coexist with other rules. Indentation, brace
spacing and other settings are inferred from the file. The plugin also
respects newline preferences encoded in other rules like
`@stylistic/operator-linebreak`, `dot-location` and `comma-style`, so that
the rules jointly resolve within a single `--fix` run.

Fold sets the indentation of the lines it adds, and moves the lines inside an
item along with it, but leaves the indentation of every other line to an
indent rule. Without `join`, it also preserves line breaks which are
consistently applied.

A call in the shape of a test case, such as `it("title", () => {`, keeps its
title and callback on one line whatever the width, as Prettier does.

## Joining lines

With `join: true`, width alone decides the layout. Every break a group owns
is taken out first, then put back only where the width needs it, so the same
code lands on the same layout no matter how it was broken before.

```js
const point = {
  x: 1,
  y: 2,
};
```

becomes

```js
const point = { x: 1, y: 2 };
```

A dangling comma goes with the breaks, and a leading `|` or `&` in a broken
union or intersection type goes too. A blank line or an own-line comment
between a group's items pins that group's layout, as does anything that must
break, like a block or an interface body. Rules that force breaks, such as
`@stylistic/array-element-newline: always`, fight with `join` and should not
be combined with it. Pair `join` with `@stylistic/comma-dangle` if trailing
commas should come back when a joined list breaks again.

## Requirements

ESLint 9 or later.

## License

MIT
