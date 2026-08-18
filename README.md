# eslint-plugin-fold

An ESLint plugin which breaks lines when they exceed a specified width, using
ESLint’s `--fix` option.

```sh
npm install --save-dev eslint-plugin-fold
```

`eslint.config.js`

```js
import fold from 'eslint-plugin-fold';

export default [
  {
    plugins: { fold },
    rules: { 'fold/breaks': ['error'] },
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

## Options

| Option | Default | |
|---|---|---|
| `maxWidth` | `80` | Columns a line may occupy. |
| `tabWidth` | `2` | Columns a tab advances to. Matters only for tab-indented files. |

```js
import fold from 'eslint-plugin-fold';

export default [
  {
    plugins: { fold },
    rules: { 'fold/breaks': ['error', { maxWidth: 80, tabWidth: 2 }] },
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
program, and will always preserve line breaks which are consistently applied.

## Requirements

ESLint 9 or later.

## License

MIT
