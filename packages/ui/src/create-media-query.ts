/**
 * A media query as a signal.
 *
 * **The only layout gate in the package, and deliberately the smallest thing that
 * works.** Everything mobile in here is either CSS or this: CSS answers "how is this
 * element shaped" with a container query, and this answers "what kind of device is
 * this" with `matchMedia`.
 *
 * Two details are load-bearing:
 *
 * - **It returns the signal itself**, not a wrapper. Callers write
 *   `const narrow = createMediaQuery("(max-width: 500px)")` and read `narrow()`,
 *   which is what a Solid reader expects and what makes the query usable as a plain
 *   value wherever a boolean is wanted.
 * - **Cleanup is an `AbortController` passed as the listener's options**, not a
 *   matching `removeEventListener`. `AbortSignal` is a member of
 *   `AddEventListenerOptions`, so one abort removes the listener, and there is no
 *   second call to get wrong.
 */
import { createSignal, onCleanup } from "solid-js";

/** Whether a media query currently matches, and keeps up as it changes. */
export const createMediaQuery = (query: string): (() => boolean) => {
  const mediaQuery = window.matchMedia(query);
  const controller = new AbortController();
  const [matches, setMatches] = createSignal(mediaQuery.matches);

  const update = (event: MediaQueryList | MediaQueryListEvent): boolean =>
    event.matches;

  mediaQuery.addEventListener("change", (event) => setMatches(update(event)), {
    signal: controller.signal,
  });

  onCleanup(() => controller.abort());

  return matches;
};
