const ok =
  p.type === NodeTypes.DIRECTIVE && p.name === "bind" && (!p.arg || // v-bind="obj"
    p.arg.type !== NodeTypes.SIMPLE_EXPRESSION || // v-bind:[_ctx.foo]
    !p.arg.isStatic); // v-bind:[foo]
