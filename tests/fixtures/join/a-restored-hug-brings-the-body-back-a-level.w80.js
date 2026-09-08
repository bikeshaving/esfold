hash(
  { password: "foobar" },
  function (err, pass, salt, hash) {
    if (err) throw err;
    users.tj.salt = salt;
  }
);
