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
  break regardless of width, e.g. blocks, classes, statement boundaries or
  nested JSX elements.
- **`inconsistentGroup`** — a group has line breaks applied inconsistently,
  e.g. an array which does not have breaks for each elements.
- **`joinable`** — with `join: true`, a fully broken group fits on one line.

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

The fold plugin attempts to coexist with other rules. Indentation and other
settings are inferred from the file. The plugin also respects newline
preferences encoded in other rules like `@stylistic/operator-linebreak`,
`dot-location` and `comma-style`, so that the rules jointly resolve within a
single `--fix` run.

Fold does not attempt to provide a 1-to-1 canonical representation of the
program, and by default preserves line breaks which are consistently applied.

## Joining lines

With `join: true`, width alone decides the layout: a group broken one element
per line is joined back onto one line when it fits.

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
union or intersection type goes too. A group containing a blank line or a
comment keeps its layout, as do interface bodies and anything that must break,
like a block. Rules that force breaks, such as
`@stylistic/array-element-newline: always`, fight with `join` and should not
be combined with it.

## Requirements

ESLint 9 or later.

## License

MIT
