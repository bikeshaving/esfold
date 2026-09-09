function f() {
  const x = someLongCondition &&
    typeof someLongCondition === "object" &&
    "b" in someLongCondition
      ? 1
      : 2;
  const y = short ? 1 : 2;
}
