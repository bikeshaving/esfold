# eslint-plugin-fold — design

A single ESLint rule, `fold/breaks`, that decides one thing: where the newlines
go.

This began as an implementation handoff and is now the record of why the tool
behaves as it does. The code comments cite its section numbers, so it is worth
keeping accurate. Where a decision was revised after contact with real code,
the section says so rather than quietly presenting the new answer — the
reasoning that failed is usually the more useful half.

---

## 1. Why this exists

**The problem with Prettier is scope, not aesthetics.**

Prettier re-prints the entire file from the AST. To do that it must have an
opinion about everything — semicolons, quote style, spacing, trailing commas,
indentation, line breaks. But ESLint already has rules for nearly all of those,
so the two tools inevitably contradict each other. The resolution is
`eslint-config-prettier`: a package whose entire job is to **turn off dozens of
ESLint rules** so Prettier can win.

That's the tell. Adopting a formatter should not require disabling your linter.
The conflict exists because the formatter claimed territory that was already
occupied — and it claimed that territory only because re-printing from the AST
forces it to.

Notice what's actually missing. Of everything Prettier decides, `@stylistic`
covers all of it except one thing: **it can't insert a line break.** It enforces
how a continuation line is indented, never that a line should be split at all.
That is the whole gap, and it's the only reason Prettier gets installed.

So fill exactly that gap. `fold/breaks` inserts line breaks and does nothing
else — it never removes one (§5). It has no opinion on semicolons, quotes, or
spacing, so it conflicts with nothing, so there is no `eslint-config-fold` and
never will be. You add a rule; you don't disable anything.

This also means it composes rather than replaces. Your `@stylistic` config keeps
working. Your custom rules keep working. Team disagreements about quote style stay
where they belong, in the config, instead of being settled by a tool that had to
pick one to function.

### Secondary: determinism

Since we're here anyway — Prettier's break decisions are also hard to reason
about. Its function-composition detection originally keyed off hard-coded names
(`pipe`, `compose`, `flow`), so renaming a function changed its formatting; PR
#6033 replaced the name list with a heuristic counting function literals in
argument position, which is better but still a guess about intent. And because
the printer re-derives the whole file, a change anywhere can move breaks
anywhere.

Fold inverts this. The grammar decides where breaks are *legal*, JavaScript's own
operator precedence decides which legal break is *preferred*, and the source text
is otherwise untouched. No intent-guessing, no name lists, no global
optimization.

> **Amendment, after implementation.** The two sentences above were true of
> the design and are no longer the whole truth about the code. Grammar and
> precedence decide most of it, but a body of *structural preferences* has
> accumulated that neither derives from: which argument shapes hug (§4.5),
> which arrow bodies take the break after `=>` (§4.6), that a lone import
> specifier stays inline, that a bracket-less group beginning a continuation
> line does not indent again (§4.7), and four exemptions from the
> consistency pass (§5). Most were settled by checking Prettier's behaviour
> case by case rather than by reasoning from first principles.
>
> The claims that survive intact, and that are the ones worth defending, are
> narrower: **no name-based heuristics** — nothing keys off an identifier, so
> renaming a function never changes its formatting — and **no global
> optimizer**, so a change in one place cannot move a break somewhere else.
> The preferences are a fixed table, not a search.
>
> Anyone reading §1 and then `groups.js` will notice the difference; better
> that they read it here first.

**Knuth-Plass was considered and rejected.** Global badness-minimization is right
for prose, where every break point is interchangeable. Code break points are not
— breaking at `||` and breaking at `.method()` are semantically different acts,
and a badness function that trades them off produces output nobody can predict.
If a tiebreaker between equally-ranked candidates is ever needed, a bounded local
cost function is acceptable; a global optimizer is not.

### The one-line pitch

> ESLint dropped its formatting rules and told everyone to use a formatter.
> `@stylistic` picked them back up, and covers everything except line breaks.
> `fold/breaks` is the missing rule.

---

## 2. Architecture

### 2.1 It is one ESLint rule. There is no CLI.

The whole tool is `eslint-plugin-fold`, exposing a single rule,
`fold/breaks`. Users add a rule; they do not add a tool.

```js
// eslint.config.js
import fold from 'eslint-plugin-fold';

export default [
  { plugins: { fold }, rules: { 'fold/breaks': ['error', { maxWidth: 80 }] } },
];
```

`eslint --fix` is the entire interface. `--check` is `eslint` without `--fix`.
Editor format-on-save is the existing ESLint LSP integration. Ignoring a line is
`// eslint-disable-next-line fold/breaks`. All of that is free; a standalone
binary would have had to reinvent every piece of it, badly.

### 2.2 How a rule can know the final line width

The obvious objection: ESLint dispatches per AST visitor, not per rule, so every
rule's `Program:exit` fires at the same moment. Fold measures pre-`@stylistic`
line widths while `@stylistic/semi` and `@stylistic/quotes` are concurrently
producing fixes that change those widths. Rule *name* does not affect ordering —
the `zzz-` prefix trick does not work. So within a single pass, Fold is
guessing.

It doesn't need to be right in a single pass. **`--fix` is a multipass loop**
(`MAX_AUTOFIX_PASSES`, currently 10 — verify against the source you're building
against). Every pass re-runs every rule against the already-fixed text. Fold
does not need to see the final width in pass 1; it needs to **converge**.

It converges because its edits are **monotone**: Fold only ever adds breaks
(§5), and an added break is never revisited — the position is spent. There is
no cycle to enter, so the loop settles as soon as the other rules do.

The cost of monotonicity is that a pass-1 break made on a mis-measured width
is permanent: Fold may split a line that, once quotes and semicolons settle,
would have fit. In practice this only touches lines within a few characters of
the limit, and the output is a break slightly earlier than strictly necessary
— not wrong, just not minimal. That is the accepted price of never overruling
an author's line break; see §5's cost list.

**This makes idempotence load-bearing, not nice-to-have.** A standalone tool that
oscillates produces a weird diff. A rule that oscillates burns all 10 passes and
leaves the user with whatever pass 10 happened to say. §8's test 2 is the thing
that makes this architecture legal.

### 2.3 Fixes must be surgical

Emit each newline insert and delete as its own `fixer` operation on a single
position or a minimal range. Never a whole-file `replaceTextRange`.

ESLint resolves overlapping fixes by taking one and discarding the rest for that
pass. A whole-file fix overlaps *everything*, so it silently drops every other
rule's fix in the pass. That is precisely the `eslint-plugin-prettier` failure
mode, and precisely why it requires `eslint-config-prettier` to disable anything
that might conflict. Fold's fixes are point edits, so they interleave with
`@stylistic`'s fixes rather than clobbering them, and no companion "turn off the
other rules" config is needed.

### 2.4 Core is a pure function; the rule is an adapter

```
format(sourceCode, options) → Edit[]     // Edit = { range, text }
```

No ESLint imports beyond types. The rule is `Program:exit` → call `format` → emit
each `Edit` as a fix. Sixty lines at most.

This is a seam, not a file boundary. The whole plugin is one file,
`src/index.js`: measurement, the break grammar, the algorithm, and the ESLint
adapter, in that order. It was six modules for a while, but nothing imported
them except each other and the tests, they mean nothing apart, and the build
bundles them back into one file regardless — the split was costing a
`_`-prefix convention and buying nothing.

This keeps the interesting logic testable without spinning up a linter, and lets
the test harness in §8 run over a corpus directly. It is not a hedge toward
shipping a CLI later — it's so the break-priority code can be tested as the pure
data transform it is.

Parsing comes free with the rule: `context.sourceCode` is already the user's
configured parser, so **whatever syntax ESLint handles, Fold handles** —
TypeScript, JSX, decorators, Flow, proposals — with no config resolution code and
no parser dependency of our own. `SourceCode` gives token navigation
(`getTokenBefore` / `getTokenAfter` / `getAllTokens`), comment attachment,
`getIndexFromLoc`, and `lines`.

> Implementer's note: rule-API details have moved across ESLint 8 → 9 → 10.
> `context.sourceCode` vs `context.getSourceCode()`, fix-pass constants, meta
> shape. Check what current ESLint actually exports rather than trusting any
> snippet here. Target current ESLint, flat config only.

### 2.5 Output is text edits, not codegen

There is no standard ESTree code generator, and we don't want one — regenerating
would throw away the exact spacing `@stylistic` just established. Fold only
**inserts and deletes newlines (plus the indentation whitespace attached to
them)**.

Apply all edits **from the end of the file backwards**, so earlier positions stay
valid and no offset bookkeeping is needed. Compute the full edit list first, sort
descending by position, then apply.

---

## 3. The grammar

Three categories of break position.

### 3.1 Necessary breaks — always present

- Block bodies: function bodies, `if`/`else`/`for`/`while`/`try`/`catch` blocks,
  class bodies, switch cases
- Statement boundaries
- Line comments (`//` forces a break after)

These are never collapsed, even if the result would fit in `maxWidth`.

### 3.2 Forbidden breaks — never inserted

Some legal break positions are simply insane, and two are dangerous.

**ASI hazards (correctness, not taste):**

- After `return`
- After `throw`
- After `yield` (and `yield*`)
- After `break` / `continue` with a label
- Before a `++` / `--` postfix operator

If a `return` argument is too long, wrap it in parens and break inside them, or
break at a lower-precedence point within the expression. Never bare-break after
the keyword.

**Semantic units (taste, but not negotiable):**

- Between `async` and `function` / `(`
- Between `function` and `*`
- Between `new` and the constructor
- Between a unary operator and its operand (`!x`, `typeof x`, `void x`, `await`
  is a judgement call — treat as forbidden)
- Between a member expression's object and its `.` — break *before* the dot, not
  after
- Between a callee and its opening `(`
- Between an object and its opening `[` in computed access

When a forbidden position is the only local candidate, escalate: break at a
higher node in the expression tree instead.

### 3.3 Optional breaks — the working set

All of these are implemented except #14, which was cut — see below.

| # | Position | Break style |
|---|----------|-------------|
| 1 | Function-call arguments | after `(`, between args, before `)` |
| 2 | Array literal elements | after `[`, between elements, before `]` |
| 3 | Object literal properties | after `{`, between properties, before `}` |
| 4 | Binary / logical operators | at the operator, side inferred (§4.2) |
| 5 | Method chains | **before** the `.` |
| 6 | Function/arrow parameters | as call arguments |
| 7 | Control-flow conditions | inside the parens of `if` / `while` / `switch` |
| 8 | `for` clauses | at the semicolons |
| 9 | Import/export specifier lists | as object literal |
| 10 | Destructuring patterns | as object/array literal |
| 11 | Ternaries | before `?` and before `:` |
| 12 | JSX attributes and children | attributes as object properties |
| 13 | Variable declarator lists | after the comma |
| 14 | ~~Template literal `${}` interiors~~ | **cut** — see below |
| 15 | Arrow function bodies | after the `=>` (§4.6) |
| 16 | Assignment values | after the operator — last resort (§4.9) |
| 17–22 | TypeScript type syntax | as their value counterparts (§3.5) |
| 23 | JSX children | one per line, where whitespace allows (§3.6) |

**#14 was cut, not deferred.** Splitting a method chain across an
interpolation reads worse than the long line, and such lines are usually long
because of the template's *text*, which no break can shorten. Nothing inside a
template literal is folded now, including ordinary groups that happen to sit
inside a `${}`.

**#15 was added.** It is absent from the original table because that table was
derived from the grammar, and this position only became obviously necessary
against real code: without it, hugging reached *into* an arrow's body and
split arguments that were never the problem.

**#16 was added**, and is the clearest example of a blind spot this table can
hide. §4.2 covered assignment *chains* — `a = b = c` — but never a single
assignment, so `const x = someObject.deeply.nested.path` had no candidate at
all: not a chain, nothing inside a member path to break. Such lines were
classified "genuinely unbreakable" and left long, and the width test (§8 test
4) passed on them *vacuously*, because it only flags lines that have an
unused candidate. Across the corpus, 80 of the 1,328 over-width lines with
no candidate were of this kind — about 6%. The lesson generalises: "no
candidate" means either "nothing can fix this" or "we never implemented the
thing that would," and only the first is acceptable.

Everything not on this list — tagged templates, computed property names, dynamic
`import()`, decorator positioning, sequence expressions — is **out of scope**. If
a user wants a break there they add it by hand, and Fold preserves it.
"Just because you can break there doesn't mean you should."

---

### 3.4 Blank lines are out of scope

Fold has no opinion about vertical spacing. It never decides that two statements
should be separated by a blank line, or that three blank lines should be one.
That axis belongs to `@stylistic/no-multiple-empty-lines`,
`padding-line-between-statements`, and `lines-between-class-members`.

Two invariants enforce this, and both are easy to violate by accident:

**Never insert more than one newline at a candidate position.** A break is `\n` +
indentation. Never `\n\n`. If Fold could emit blank lines,
`no-multiple-empty-lines` would delete them on the next fix pass and Fold would
re-add them on the pass after — a two-rule oscillation that burns the fix budget
and leaves output depending on which pass the loop happened to stop at (§2.2).

**Never delete a newline at all.** Fold has no removal pass (§5), so this
invariant is now free: there is no code path that consumes a newline, blank
line or otherwise. What remains is the group-level freeze — a blank line
anywhere inside a group means Fold leaves that group entirely alone, including
the consistency completion it would otherwise do:

```js
// Fold does not touch this, even though the group is only partly broken
foo(
  a, b,

  c
);
```

A blank line inside a group is a signal the author grouped something
deliberately, and Fold has no way to know what.

**Consequence for measuring.** Blank lines are zero-width and never trigger the
addition pass.

---

### 3.5 The TypeScript type layer

Positions #17–#22. The original table was derived from the ESTree grammar,
so it described the JavaScript layer exactly and the type layer not at all.
Type syntax always parsed safely and was never corrupted — but nothing in it
was a break candidate, so a long union or type-argument list had no legal
position and was left over width. "Whatever your parser handles, Fold
handles" was a true claim about *safety* and a false one about coverage.

Each position reuses the shape of its value-level counterpart, so there is
nothing new to reason about: type arguments and parameters break like an
argument list, a type literal or interface body like an object, a tuple like
an array, a union or intersection like an operator chain, a conditional type
like a ternary, a function type's parameters like a parameter list.

Two things this exposed are worth keeping:

- A `TSPropertySignature`'s range **includes** its trailing `;`, so "the next
  separator after this member" lands on the *following* member's semicolon.
  The list builder handles three shapes now: items that exclude their
  separator, items wrapped in parens, and items that swallow it.
- A group whose gaps all sit past the overflow cannot shorten the line.
  `assertEqual<A, B>(value)` overflows inside the type arguments, so breaking
  at the call's parenthesis leaves the head exactly as long as it was.
  Selection prefers, among groups spanning the overflow, one with a gap it
  can actually reach. That is a general rule, not a TypeScript one.

---

### 3.6 JSX children, and where the whitespace guarantee has to be earned

Position #23. JSX is the one place in the grammar where whitespace between
tokens is *content*, so "a newline never changes meaning" cannot be assumed
here — and AST identity is the wrong test, since a legal break adds text
nodes that render as nothing.

Checked against TypeScript's own JSX emit, four of the six ways to break
children are transparent and two are not. Both exceptions are the same
thing: a break landing on a space that separates content, which JSX then
deletes because the run now contains a newline.

```jsx
<p><a/><b/></p>       // breaking between them: no space to lose
<p><a/> <b/></p>      // the space IS content; breaking deletes it
<p>hi <b/></p>        // same, with the space inside the text node
```

Prettier solves the second case by emitting `{" "}`. Fold cannot: it only
ever inserts newlines. So the rule is conservative — an element is breakable
only when every text child is whitespace that already contains a newline, or
there are none at all. That covers element-only children, the common React
shape, and declines the rest rather than guessing. `{" "}` itself stays
attached to the line it belongs to, by the same convention Prettier follows.

Prose rewrapping is out for a different reason: it would mean splitting a
`JSXText` **token**, and Fold only ever edits the whitespace *between*
tokens.

Two consequences worth stating plainly:

- **The corpus comparison had to learn JSX.** It now drops exactly the text
  nodes JSX drops — whitespace containing a newline — and only those, since
  a blank text node without one is a real space.
- **The parentheses are not ours.** Prettier writes `const el = (\n  <div>`;
  Fold produces valid JSX without them, and `@stylistic/jsx-wrap-multilines`
  already owns paren placement and is fixable. Adding them would put Fold
  back in the business of fighting rules that already exist.

---

## 4. Break priority

When a line exceeds `maxWidth`, choose among legal candidates in this order.

### 4.1 Outermost first

Break at the highest node in the expression tree that contains the overflow.

```js
// too long
foo(bar(x, y), baz(a, b), qux(m, n))

// break the outer call, not the inner ones
foo(
  bar(x, y),
  baz(a, b),
  qux(m, n)
)
```

Recurse only if a resulting line is still too long.

### 4.2 Binary operators break at lowest precedence first

Use the real ECMAScript precedence table, not an invented one. Lower precedence
binds looser, so it breaks earlier.

```
comma (0) < assignment (2, right-assoc) < ternary (3) < ?? (4) <
|| (4) < && (5) < | (6) < ^ (7) < & (8) < equality (9) < relational (10) <
shift (11) < additive (12) < multiplicative (13) < ** (14, right-assoc) <
unary (15) < postfix (16) < call/member (17)
```

Break at the operator, at one precedence level at a time, descending only if
still too long. Arithmetic is tight and should be the last thing that ever
splits. Assignment chains (`a = b = c = v`) are right-associative and break at
the `=`s.

```js
// break at || before touching &&
const check = condition1 && condition2 ||
  condition3 && condition4;
```

**Which side of the operator, like indentation, is inferred — not configured
and not hard-coded.** `@stylistic/operator-linebreak` owns this axis when
enabled, it *has* a fixer, and its default is `after` (except `?`/`:`). Fold
coordinates with it instead of fighting it:

- **Detection is side-agnostic.** A newline on *either* side of the operator
  counts as an existing break, so the addition pass never double-breaks and
  the consistency pass (§5) counts the group as broken there. This is the
  load-bearing half: whatever side `operator-linebreak` moves a break to,
  Fold accepts it, so the two can never oscillate.
- **Insertion side is inferred from the file** (sampled from
  side-unambiguous operator tokens), falling back to `after` — the
  `operator-linebreak` default — in a file with no signal. If Fold guesses
  wrong in pass 1, `operator-linebreak` flips the operator across the
  newline in pass 2 and detection makes pass 3 a no-op: the §2.2 convergence
  story, not a conflict. Test convergence with `operator-linebreak` at both
  `before` and `after`.

Method-chain dots and ternary `?`/`:` are always break-before — the JS
convention, and `operator-linebreak`'s own default for `?`/`:`.

### 4.3 All-or-nothing for lists

An array, object, or argument list is either entirely inline or entirely broken —
one element per line. No partial fills, no "fit as many as possible per line."
This is what makes diffs stable: adding an element changes one line.

### 4.4 Chains containing block bodies are not broken at the chain level

This is the rule that most distinguishes Fold's output. If a method chain's
arguments already contain block bodies, the necessary breaks inside those blocks
already provide the visual structure. Adding chain-level breaks just adds an
indentation level for nothing.

```js
// yes
promise.then(() => {
  return x;
}).catch(() => {
  return y;
});

// no
promise
  .then(() => {
    return x;
  })
  .catch(() => {
    return y;
  });
```

Chains *without* block bodies break before the dot normally.

### 4.5 Hugging

A trailing (or leading) argument with its own internal structure absorbs the
break rather than forcing the call to explode.

```js
// last-position options object — hug it
fetchData(url, {
  method: 'GET',
  cache: true,
});

// not this
fetchData(
  url,
  { method: 'GET', cache: true }
);

// first-position data array — hug it, keep the tail on the closing line
map([
  veryLongElement1,
  veryLongElement2,
], transformFn);

// single complex argument — never break at the call level
processData({
  field1: value1,
  field2: value2,
});
```

Hugging applies when the huggable argument is an object literal, array literal,
or a function whose body can absorb the break, and it is the only such argument
in the list, in first or last position. (In a parameter list the pattern
equivalents count, so a lone destructured parameter hugs like an options
object.)

This describes what Fold *produces* when it breaks a call — not a layout it
imposes on a call the author already broke. An author-written exploded form
stays exploded (§5).

**"A body that can absorb the break" is the load-bearing phrase**, and getting
it wrong is visible immediately. Hugging removes the call level from
consideration; if the body then has nowhere to put a break, the next candidate
is the function's own *parameter list*, which produces this:

```js
const stopP = new Promise((
  resolve
) => (r.onstop = () => resolve(undefined)));
```

So a bare expression body does not hug. A block, object, or array body hugs by
keeping its bracket on the call line; the bodies in §4.6 hug by taking the
break after the `=>` instead. A member path or an arithmetic expression does
neither, and the call breaks around the arrow.

Two further consequences, both found on real code rather than reasoned out:

- **A hugged argument's signature is never broken.** It is part of the call's
  head. Without this, `it("...", function (done) {` breaks as `function (\n
  done\n) {`.
- **The test must be structural.** Keying it on "is this argument already
  multiline" is the more natural question and does not work: breaking inside
  the body *makes* it multiline, which flips the answer on the next pass, and
  the call explodes and re-hugs forever. The corpus idempotence check caught
  this; nothing in the unit tests would have.

---

### 4.6 Arrow bodies break after the `=>`

Table position #15, added after implementation. Which of three shapes a call
containing a trailing arrow takes depends entirely on what the body can do
with a line of its own:

| body | shape |
|------|-------|
| block, object, array | hug — the bracket stays on the call line |
| call, `new`, ternary, template, JSX, nested arrow | break after the `=>` |
| member path, binary, assignment, identifier | neither; the call breaks around it |

```js
promise.then((response) =>
  transformTheResponse(response, options, extra)
);
```

The third row is the counter-intuitive one: a member path *could* go on the
line after the `=>`, but it would sit there at the same width, so breaking
there buys nothing and the call breaks instead. This table matches Prettier
row for row, arrived at by checking all seven body shapes against it.

When the arrow takes the break, the enclosing call's closing paren goes on its
own line too — the two are one decision, so the call's close gap joins the
arrow's group. That sharing needs one guard: an arrow group's gaps are not a
list of peers, and the closing paren is broken by every ordinary call break as
well, so the consistency pass (§5) must not treat "one of two gaps broken" as
a group to complete. It oscillated until arrow groups were exempted.

---

### 4.7 No staircases

A construct with no bracket of its own — an operator chain, a ternary — takes
its nesting level from the line it begins. When that line is already a
continuation, stepping in again leaves the group's first part a level
shallower than the rest:

```js
call(
  a &&
    b &&        // the staircase
    c
);
```

So a bracket-less group that begins a continuation line aligns its parts
instead. A bracket-less group that begins a *statement* is the exception —
nothing has indented it yet, so its continuation lines do step in, which is
why `firstTarget =\n  secondTarget =` still indents. Ternaries chained through
the alternate (`a ? b : c ? d : e`) are one construct, not nested ones, and
share a single level for the same reason.

Bracketed groups are unaffected: a bracket is its own nesting signal.

---

### 4.8 A break that cannot help is not made

A one-item group whose item is atomic and already wider than `maxWidth` is
left alone. Breaking would put that item on a line of its own at exactly the
width it had:

```js
<a
  href="https://…107 characters…"
>
```

Two lines bought for nothing. Only the single-item case is declined — with two
or more, separating them shortens the line even when one of them stays long,
which is why `f(longAtomicString, second)` still breaks.

The same reasoning covers a line pushed over only by a **trailing comment**
(§7.1 already said so; it went unimplemented until the differential found it).
The code fits, the comment cannot be shortened, and moving it to its own line
is a vertical-spacing change, which §3.4 forbids.

### 4.9 The assignment break is a last resort

Table position #16. When a line is over width and has **no other candidate at
all**, the value moves to its own line:

```js
const resultValue =
  someObject.deeply.nested.property.chain.valueHere;
```

It is deliberately last. Whenever anything inside the value can be split —
a call's arguments, an object's properties, a ternary's branches — splitting
*that* reads better, and already happens; this exists only for values with no
internal structure: a member path, a template, a cast.

Both halves must fit, or the break achieves nothing: a 200-character string
moved onto its own line is still a 200-character line, one line further down.
That condition is what keeps it from firing on the genuinely unfixable.

One consequence was not obvious in advance. The rescue also fires on a *head*
line left over width by an earlier break — `const check = firstLongCondition &&`
after the operator chain has broken — so it changes some output that already
had a primary candidate. In every case observed it made the result more
width-compliant rather than less, which is why it was kept.

---

## 5. Fold never joins lines

**A line break the author wrote is a decision, and Fold does not overrule it.**
Fold only ever *adds* breaks. There is no collapse pass, no "this would fit on
one line so I'll rewrite it."

This is a deliberate reversal of the original bidirectional design, and the
reasoning is worth keeping: most of the anger at Prettier comes from it
destroying deliberate layout — an FP `compose()` pipeline, a matrix literal, a
switch-like ternary ladder — with no recourse short of `// prettier-ignore`.
The value was never symmetric either. Joining lines is a keystroke (`J` in
Vim, and every editor has one); *finding* the over-width line and choosing
where to split it is the tedious part, and that's the part worth automating.

**What Fold does enforce is consistency within a group (§4.3).** A group is
entirely inline or entirely broken, one item per line. So:

- A group with no breaks: left alone (unless it's over width — then §4 breaks
  it).
- A group broken at every position: left alone. Already consistent.
- A group broken at *some* positions: **completed**, never joined. This is the
  only mutation the consistency pass makes.

```js
// in — author broke at one comma
foo(alpha,
  beta, gamma);

// out — completed, not collapsed
foo(
  alpha,
  beta,
  gamma
);
```

**Frozen — not even completed:**

- Any group containing a comment
- Any group whose interior contains a blank line (§3.4) — a blank line is a
  strong signal of deliberate semantic grouping, so the whole group is left
  exactly as written
- Hug levels (§4.5) and chains containing block bodies (§4.4), which are not
  break candidates at that level in the first place
- **Method chains.** A chain broken at some dots but not others is a
  deliberate head/tail split — `Object.keys(value)` kept whole, then
  `.filter(…)` on its own line — not an untidy list. Completing it pulls the
  head apart.
- **Calls whose last argument is a function.** The hugged form leaves the open
  paren unbroken and the close paren on its own line, which reads as partially
  broken but is a deliberate and very common shape.
- **Arrow groups** (§4.6), whose two gaps are not peers.

```js
// frozen: blank line inside signals intent
const options = {
  timeout: 5000,
  retries: 3,

  cache: true,
  ttl: 3600,
};
```

### A note on whether this pass earns its keep

Measured over ten third-party repositories, the consistency pass produced 38
edits against roughly 3,000 from the width pass — about 1%. In exchange it
has caused two oscillation bugs and two Prettier disagreements, and it now
carries the six exemptions above.

That ratio is worth watching. The pass is kept because "a group is entirely
inline or entirely broken" is a real property and §4.3 depends on it, but if
the exemption list grows again, the honest move is to drop completion
entirely and let Fold do exactly one thing: add breaks when a line is too
long.

### What this costs

Two things, both accepted:

- **No cleanup on width change.** Raise `maxWidth` from 80 to 120 and the old
  breaks stay. Fold will never re-flow a file to be tighter. That's `J`'s job.
- **§2.2's self-correction is weaker.** The convergence argument originally
  leaned on removal: a pass-1 break made on a mis-measured width got taken
  back out in pass 2 once `@stylistic` settled. Without removal, a pass-1
  guess is permanent. This only affects lines within a few characters of the
  limit and the result is benign (a break slightly earlier than strictly
  needed), but output is now mildly history-dependent rather than a pure
  function of content + `maxWidth`. Convergence itself is *stronger*, not
  weaker: Fold's edits are monotone, so the loop can't cycle.

### What this buys

The §7 conflict table mostly evaporates. Every `@stylistic` rule that
*forces* breaks (`array-element-newline: always`, `object-curly-newline`'s
`minProperties`, `object-property-newline`, `jsx-max-props-per-line`, even
`newline-per-chained-call`) now composes: it adds breaks, Fold respects them.
Only the `never` settings remain incompatible, and "never break" alongside a
maximum width is a self-contradictory config nobody runs.

---

## 6. Algorithm

```
1. `Program:exit` → take `context.sourceCode`. (No parsing, no config
   resolution — ESLint already did both with the user's parser.)
2. Read `maxWidth` from `context.options`; infer the indent unit from the
   source (§7), cached per SourceCode.
3. Walk the AST, building a break-candidate tree:
     for each node, its legal break positions, their category,
     and their precedence rank.
4. Necessary-break pass (§3.1): block bodies, class bodies, switch cases,
   statement boundaries — always broken, width irrelevant.
5. Consistency pass (§5): a group broken at some but not all of its
   positions is completed to one item per line. Never joined. Frozen if the
   group holds a comment or a blank line.
6. Addition pass: for each over-width line, walk from the outermost
   containing node inward, taking the first legal candidate set;
   apply §4 priority; emit insert edits (newline + indentation).
7. Recurse on any line still over width. Cap the recursion depth and
   bail loudly rather than looping.
8. Return the edit list, sorted descending by position.
9. Rule adapter: emit each edit as its own `context.report` fix.
```

All three passes only ever *add* newlines, so they can't undo each other.
Still compute over a *projection* — a virtual line list updated as breaks are
placed — rather than applying edits and re-measuring naively, since a later
pass must see the line widths the earlier ones produced.

Descending order matters even though ESLint applies the fixes, not us: it keeps
the pure function's own edit list consistent for the test harness, which applies
edits directly to a string.

**Report locations must be real.** Each fix gets the `loc` of the token it
attaches to, and a message naming what happened ("line exceeds 80 characters" /
"unnecessary line break"). This is the payoff for being a rule — errors point at
code — so don't report everything against `Program` out of convenience.

---

## 7. Configuration

**There is exactly one option: `maxWidth`.** Nothing else is configurable, ever.

```js
'fold/breaks': ['error', { maxWidth: 80 }]
'fold/breaks': 'error'                      // defaults to 80
```

Everything §4 and §5 describe — outermost-first, precedence ordering,
all-or-nothing lists, the chain exception, hugging, group completion — is fixed.
Not "defaults." Fixed. Every option is a way for two codebases to format
differently, which is the thing that produces `.prettierrc` bikeshedding and,
eventually, a config package whose job is turning off other people's rules. A
rule with one option can't grow a config ecosystem. Requests for
`hugLastArg: false` get closed, kindly, as working-as-intended.

**`respectExistingBreaks` is not an option because it is the behavior** (§5).
Fold never joins lines, so there is nothing to opt out of. Authors who want a
partially-broken group left exactly as written — no completion either — use a
blank line (§3.4) or a disable comment.

### Why we can't read other rules' config

The tempting design is to take width from `@stylistic/max-len` and indent from
`@stylistic/indent`, so a project declares each thing once. **This is not
possible.** ESLint gives a rule access to its own `context.options`,
`context.settings`, `context.sourceCode`, and `context.languageOptions` — and
nothing about sibling rules. There is no supported path to another rule's
configuration, and ESLint has been closing off the indirect ones (`parserPath`)
rather than opening new ones.

`context.settings` is the only shared channel, but routing config through
`settings.fold.maxWidth` is worse than an option: no `meta.schema` validation, no
per-glob override, and a second place to look. Use the option.

### Indent is inferred, not configured

Indent doesn't need config *or* sibling access, because the answer is in the
file. When Fold inserts a break, it needs two things:

1. **The indentation of the line the enclosing node starts on** — read directly
   from the source. No inference needed.
2. **One indent unit** — inferred from the file: scan existing lines for the most
   common leading-whitespace delta between consecutively-nested lines. Tabs if
   tabs dominate. Fall back to 2 spaces for a file with no nesting.

This is strictly better than reading `@stylistic/indent` even if we could. It
works with or without `@stylistic`, it can't disagree with whatever actually
formatted the file, and if a project's indent rule changes, Fold follows on the
next pass without being told.

Cache the inferred unit per `SourceCode` — it's stable across all the passes of a
single `--fix` run for a given file.

### Rules on the same axis

Because Fold only adds breaks (§5), it composes with almost every
`@stylistic` newline rule. Three groups:

- **Position rules — coordinate.** `operator-linebreak`, `dot-location`, and
  `comma-style` decide which *side* of a token a break sits on. Fold handles
  all three the same way: **side-agnostic detection** — a newline on either
  side of the operator / dot / comma counts as an existing break — with
  insertion on Fold's own side (inferred for operators per §4.2; before-dot
  and after-comma per §3.2/§3.3). If the user's setting disagrees with an
  insertion, their fixer moves it across the token once and detection accepts
  it thereafter.

  The same treatment is needed for the **dangling comma before a close
  bracket**: `comma-style: first` requires that comma to lead its bracket
  (`\n,}`), which is exactly the gap Fold breaks for comma-last (`,\n}`).
  Without an alt side there, the two rules push that comma back and forth
  until the fix budget runs out — a real oscillation, caught by the corpus
  convergence test. Give the close gap an alt side before the dangling comma.

  Test each of these rules at *both* settings under the real `--fix` loop.

- **Force-break rules — compose for free.** `array-element-newline`,
  `array-bracket-newline`, `object-curly-newline`, `object-property-newline`,
  `function-call-argument-newline`, `function-paren-newline`,
  `multiline-ternary`, `curly-newline`, `newline-per-chained-call`, and the
  JSX prop rules, in any mode that *adds* breaks (`always`, `multiline`,
  `consistent`, `minItems`/`minProperties`). They break, Fold respects it and
  completes the group. This is the payoff for §5.

- **`never` settings — incompatible.** The same rules configured to forbid
  breaks fight Fold's addition pass directly: Fold splits an over-width line,
  they join it back. Nothing can reconcile "never break" with a maximum
  width. Document it; nobody runs it.

Do **not** ship a disable-config — the moment one exists, §1's pitch is dead.

### No dependency on @stylistic

Fold doesn't import it, call it, or require it. `@stylistic` is where a user's
other formatting rules probably live, but Fold works identically next to a
hand-rolled config, a legacy `indent`, or nothing at all. Adding a dependency
would inherit `@stylistic` v4's ESM-only, flat-config-only, ESLint-9+ constraints
for no benefit. Not even a peer dependency.

Ship a `recommended` config export that enables the rule with no options.

---

### 7.1 Measurement: what counts as a line, and what can't be broken

Two questions have to be answered before `maxWidth` means anything, and
`@stylistic/max-len` has already answered both from the reporting side. Steal its
conclusions rather than rediscovering them.

**Tab width.**

If a file indents with tabs, "line length" depends on what a tab scores as.
`max-len` makes this an option (`tabWidth`, default 4). Fold can't — one option
only — so it must be decided once. **A tab counts as 2 columns.**

Fold's indent inference (§7) already tells it whether the file uses tabs; this
is the separate question of how wide to *score* one.

> **Revised from 4.** The original reasoning picked 4 to match `max-len`'s
> default, so a project running both would never disagree about which lines
> are too long. That was the wrong reference point: `max-len` only *reports*,
> while the code being measured was almost always laid out by Prettier, whose
> default `tabWidth` is 2. On a tab-indented Prettier codebase, scoring 4
> called 110 lines over-width where the project's own formatter called 27 —
> three quarters of the churn was a measurement disagreement rather than
> anything about line breaks.
>
> The cost of the change is that `max-len` now needs `tabWidth: 2` set
> explicitly to stay in step. That is a real, if small, crack in the
> "configure nothing" story, and the README says so.

Measurement otherwise reproduces `max-len`'s `computeLineLength` exactly,
quirks included: the total counts code points while each tab stop is derived
from the UTF-16 offset, so a line holding both an astral character and a tab
measures oddly. A shared oddity beats an independent answer, since the whole
point is that the two never disagree.

**Unbreakable lines.**

Some lines exceed `maxWidth` and cannot be fixed, because every position in them
is atomic. Fold must recognize these and **leave them entirely alone** — no
break, no report, no hunting for a break point that doesn't exist. `max-len`'s
ignore options are the worked-out taxonomy:

- **Long string literals** — no legal break inside a string. (Concatenating with
  `+` to fit would be a rewrite, not a fold. Out of scope.)
- **Template literals** — the text between `${}` is content, not code.
- **Regex literals** — atomic.
- **URLs**, typically in comments or string literals.
- **Trailing comments** — the code fits; the comment pushes it over. Moving the
  comment to its own line changes vertical layout, which §3.4 forbids.
- **A single long identifier or member path** with no legal break in it.

The test is structural, not heuristic: walk the line's break candidates, and if
the set is empty after applying §3.2's forbidden-break table, the line is
unbreakable. There's no need for `ignoreUrls`-style pattern matching — a URL
inside a string literal is already unbreakable because the string is.

**Silence, not reporting.** Fold is a fixer; reporting an unfixable problem is
`max-len`'s job, and a project that wants to be told about long URLs should
enable it. Fold reporting the same line would produce two errors for one
condition, only one of which is actionable.

This also fixes §8's test 4: width compliance is asserted over breakable lines
only, and "unbreakable" is a property the implementation can compute rather than
a list of excuses.

**Relationship to max-len.**

They compose without conflict, because **`max-len` has no fixer.** It reports;
Fold fixes. Running both at different widths (`max-len` at 100, Fold at 80) is
merely redundant — Fold reformats code `max-len` was content with, but nothing
oscillates, because `max-len` can't fix anything back. Worth a README note; not
worth engineering around.

---

## 8. Correctness requirements

These are the tests that matter. All five exist now; §9 says where. The
numbering is referenced from the code and from §9, so it stays.

1. **Semantic preservation.** Parse input and output, strip all location data,
   deep-compare ASTs. They must be identical. This catches every ASI hazard
   automatically and is the single most valuable test in the suite. Run it over a
   large corpus.
2. **Idempotence.** `format(format(x)) === format(x)`, for every input. A
   formatter that oscillates is worse than no formatter.
3. **Convergence under the real fix loop.** Run `eslint --fix` with the rule
   enabled *alongside a full `@stylistic` config*, over a corpus, and assert it
   settles well inside `MAX_AUTOFIX_PASSES` — then run `--fix` again and assert
   zero further changes. This is the test that validates §2.2. Anything that
   burns all 10 passes is a bug in the break-candidate table, or a bad indent
   inference — test specifically against configs using tabs, 4 spaces, and
   `@stylistic/indent` with `SwitchCase` and `MemberExpression` overrides, since
   those are where inference and enforcement are most likely to diverge.
4. **Width compliance.** Every output line ≤ `maxWidth`, except lines that
   cannot be helped. Assert the exception is *computed*, not tolerated: a line
   over width must either have been broken, or have no legal break position,
   or be one of the two cases where breaking achieves nothing — a trailing
   comment (§7.1) or a lone atomic item (§4.8). A line that had a usable
   candidate and wasn't broken is a bug.
5. **Differential corpus.** Prettier-format a file, then run Fold over the
   result: Prettier has already made every other formatting decision, so
   anything Fold changes is a line-break disagreement and nothing else. Not to
   match Prettier — to find where Fold is *worse*. It found six defects, and
   settled at 249 of 250 files byte-identical; the remaining one is §4.3
   applied to `a = b += c`, which Prettier treats as nested assignments.

---

## 9. How this is tested

The build order that used to live here is spent; what replaced it is worth
recording, because the balance between kinds of test turned out lopsided.

**The unit tests document decisions. The corpus harnesses find bugs.** Every
genuinely dangerous defect in this project was caught by running over real
code and checking a property — never by an example test:

- the hugging feedback loop, where breaking made an argument multiline, which
  flipped the hug decision, which exploded the call, forever (§4.5)
- the arrow-group oscillation against the consistency pass (§4.6)
- `comma-style: first` and Fold pushing the same dangling comma back and
  forth until the fix budget ran out (§7)

None had a failing unit test, and none would have been noticed by reading the
diff of a small fixture. Keep the harnesses running.

### The layers

| what | where | what it is for |
|------|-------|----------------|
| `RuleTester` | `tests/breaks.rule.test.js` | the adapter, and TS/JSX parity |
| behaviour by feature | `tests/format.*.test.js` | the decisions in §3–§5, as examples |
| §3.2 as a property | `tests/forbidden.test.js` | break every gap the table permits, reparse, compare |
| §8 tests 1–2 | `tests/corpus.test.js` | AST identity and idempotence over a corpus, at two widths |
| §8 test 3 | `tests/convergence.test.js` | the real `--fix` loop beside nine `@stylistic` configurations |
| §8 test 4 | `tests/width.test.js` | width compliance, with the exception *computed* |
| §8 test 5 | `scripts/diff-prettier.js` | Prettier-format, then Fold; anything that changes is a disagreement |
| all invariants at scale | `scripts/audit.js` | ten third-party repositories, each at its own print width |

`npm run corpus` clones the corpus; `npm run audit` and `npm run diff` use it.
CI runs all of it.

### Two traps worth knowing

**A corpus can stop exercising the thing it tests.** After tab width changed
to 2 (§7.1), the corpus was tab-indented code that already fitted 80 — so
Fold made zero edits and both the corpus and convergence tests were quietly
verifying nothing. They now run at a width that bites, and convergence
asserts that Fold specifically contributed reports.

**A width-compliance check must measure at the real indent.** Approximating
it as two spaces makes deeply nested items look like they would fit, so the
check disagrees with the rule it is checking and reports failures that are
not there.

---

## 10. Naming

Package: `eslint-plugin-fold`. Rule: `fold/breaks`. No binary.

A fold is a break that preserves the material — which is literally the
architecture: text edits, never regeneration. It's also short enough that a
second rule later (`fold/chains`, say) still reads well, and it scans in the
string users actually type:

```js
// eslint-disable-next-line fold/breaks
```

The collision with POSIX `fold(1)` is an asset rather than a problem — that
utility also inserts line breaks at a width, so anyone who recognizes the name
already knows roughly what the rule does.

Rejected along the way: `spaced`, `deterministic-breaks`, `crease`,
`eslint-crease`, `eslint-breaks`, `eslint-snap`, `karate` (collides with the
Karate API testing framework, and implies destructive force), `origami` (good
metaphor, longer, and the whimsy earns less now that this is one rule rather than
a tool). `eslint-plugin-origami` and `eslint-plugin-crease` are also unclaimed if
a change of heart is wanted.

**Revisited after implementation, and kept.** `origami` came up again; two
things decided it that were not knowable when this section was written.

First, §5's reversal made the metaphor stronger. "A fold is a break that
preserves the material" was a claim about the architecture — text edits, never
regeneration. It is now also a claim about the behaviour: Fold only ever adds
breaks and never takes one away, and folding paper does not remove material
either. Origami moved the other way. Origami is elaborate and constructive;
what this turned into is one decision made minimally, deferring to the author
and declining more than it touches. A single crease, not a crane.

Second, the name sits on a shelf with `crank`, `revise`, `repeater`, `shovel`,
`termdom`, and `libuild` — short, concrete, slightly oblique. `fold` belongs
there; `origami` would be the one decorative name among them.

The repository is `bikeshaving/fold`; the package keeps the
`eslint-plugin-` prefix that npm and ESLint expect, matching the split used
by `acrocase`.
