function check(x: number, y: number) {
  // esfold-ignore
  if (
    x > 0 &&
    y > 0
  ) {
    return true;
  }
  if (
    x < 0 &&
    y < 0
  ) {
    return false;
  }
  return false;
}
