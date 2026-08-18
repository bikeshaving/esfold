const process = compose(
  parseInput,
  validate,
  transform,
  serialize
);
