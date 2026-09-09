export const Portal = Symbol.for("crank.Portal") as unknown as Component<{root?: object}> & symbol;
export class CustomEventTarget<TParent extends CustomEventTarget<TParent> = any> implements EventTarget {
  x = 1;
}
