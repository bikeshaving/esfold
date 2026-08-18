type Small = { a: number };
type U = A | B;
function f<T>(x: T): T {
  return x;
}
