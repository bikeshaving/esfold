export default test({
  html: "<div>content 0 3 3</div><div>content 1 2 2</div><div>content 2</div>",

  test({ assert, target }) {
    assert.equal(target, null);
  },
});
