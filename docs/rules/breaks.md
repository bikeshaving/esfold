# fold/breaks

Insert and remove line breaks to fit a maximum width. This is the plugin's
only rule, and `maxWidth` is its only option.

```js
'fold/breaks': 'error'                      // maxWidth defaults to 80
'fold/breaks': ['error', { maxWidth: 100 }]
```

## What gets reported

- `Line exceeds N characters.` — on the token where a break is inserted.
- `This group is partially broken; break every element or none.` — on a
  group being completed to one item per line.
- `Missing line break.` — on block/statement content being moved to its own
  line (block bodies, class bodies, and switch cases are always multi-line;
  statement boundaries are always breaks).

Every report carries a fix; `eslint --fix` applies them. Each break is its own
report and its own fix, so they interleave with other rules' fixes instead of
clobbering them — which is why one over-width line can produce several
reports, one per break point.

A line that is too long but has no legal break position (a long string
literal, a regex, a trailing comment, a single long member path) is left alone
and *not* reported — reporting unfixable long lines is
`@stylistic/max-len`'s job.

## Inferred from the file, not configured

The indent unit (tabs or n spaces), the line ending (a CRLF file gets CRLF
breaks), and which side of an operator to break on are all read from the file
being formatted, so they cannot disagree with whatever already formatted it.
A tab scores as 2 columns when measuring width, matching Prettier's default
`tabWidth`; `@stylistic/max-len` defaults to 4, so set its `tabWidth` to 2 if
you run both.

## Break decisions (fixed, not configurable)

1. Outermost structure first; recurse only while a line is still too long.
2. Lists (arguments, elements, properties) are all-or-nothing: entirely
   inline or one element per line.
3. Binary/logical chains break at the operator, lowest precedence first, per
   the ECMAScript precedence table. Which side of the operator is inferred
   from the file, defaulting to line-end.
4. Method chains break before the dot — unless the chain's calls take
   block-bodied function arguments, in which case the chain stays flat and
   the blocks provide the structure.
5. A lone object/array/function argument in first or last position hugs the
   call: `fetchData(url, {` rather than an exploded argument list. For an
   arrow, what the body can do decides the shape: a bracketed body keeps its
   bracket on the call line; a body that can break further (a call, ternary,
   JSX, template, or nested arrow) takes the line after the `=>`; a body
   that can do neither — a member path, an arithmetic expression — stays
   put and the call breaks around it.
6. Fold never joins lines — a break you wrote is preserved. What it does
   enforce is consistency: a broken element list is completed to one item
   per line. A group with a comment inside, or a blank line inside, is
   frozen entirely, and a method chain is never completed — a chain broken
   at some dots is a deliberate head/tail split.
7. No staircases: an operator chain or ternary takes its level from the line
   it begins, so its parts sit at one depth. Ternaries chained through the
   alternate share that level.
8. Nothing inside a template literal is ever folded.
9. A line pushed past the limit only by a trailing comment is left alone —
   the comment cannot be shortened, and moving it changes vertical layout.
10. A lone import/export specifier stays inline: the module path is what
    makes the line long, and no break inside the braces shortens it.
11. A hugged argument's signature is part of the call's head and is never
    broken, and a call whose last argument is a function keeps whatever
    layout it was given.
12. A leading `;` — the ASI guard in semicolon-less style — stays with the
    statement it guards.
13. A break that cannot help is not made: a one-item group whose item is
    atomic and already wider than the limit is left inline, since breaking
    would put that item on a line of its own at exactly the width it had.
14. As a last resort — when a line has no other candidate — an assignment's
    value moves to its own line. Only when both halves fit, and only when
    nothing inside the value could be broken instead.
15. TypeScript type syntax breaks like its value counterpart: type arguments
    as an argument list, type literals as objects, unions as operator
    chains, conditional types as ternaries.
16. A JSX element nesting another element always breaks, at any width. Text
    and expression children stay inline unless the line is too long. Nothing
    breaks where JSX would swallow a meaningful space.

ASI-hazard positions (after `return`, `throw`, `yield`, before `++`/`--`)
and semantic units (`async function`, `new X`, unary operators, after a dot)
are never broken.

Fold never deletes a newline, so it can only ever make a file taller. If you
want lines joined back up, that's your editor's join command, not a linter's
decision.
