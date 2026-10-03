/**
 * Several refs, as one ref.
 *
 * **Because a callback ref and a variable ref cannot both be what an element wants.**
 * The pattern is a `for` loop over the refs, calling each that is a function and
 * assigning to each that is an object, and it is five lines that get written by hand
 * at every site with more than one thing to point at. Both copies of this in the
 * sibling were byte-identical, which is the argument for it being a package at all:
 * identical code in two places is code that will diverge.
 */

/**
 * A ref as either form Solid accepts.
 *
 * **The callback form takes the element.** Typing it `() => T` — which is what it
 * returns rather than what it receives — makes `combineRefs` call it with an argument
 * its own type says it cannot take, and the mistake is only visible at the call.
 */
export type Ref<T> = ((element: T) => void) | { current: T } | undefined | null;

/** Calls every callback ref and assigns every object ref. */
export const combineRefs =
  <T>(...refs: Ref<T>[]) =>
  (value: T): void => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value);
      else if (ref !== undefined && ref !== null) ref.current = value;
    }
  };
