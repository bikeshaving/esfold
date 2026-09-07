it("responds", function (done) {
  request(app)
    .get("/users")
    .expect(/^\[{"name":"tj"},{"name":"ciaran"},{"name":"aaron"},{"name":"guillermo"}\]/, done);
});
