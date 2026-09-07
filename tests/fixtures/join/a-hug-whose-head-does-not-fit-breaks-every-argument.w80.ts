function f() {
  const close = sourceCode.getTokenBefore(sourceCode.getFirstToken(node.body)!, {
    filter: (t) => isPunct(t, ")"),
  });
}
