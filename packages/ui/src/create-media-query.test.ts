// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";

import { createMediaQuery } from "./create-media-query";

/**
 * `matchMedia` in jsdom.
 *
 * **jsdom does not implement `matchMedia` at all.** The sibling monorepo hit the same
 * wall and worked around it with a stub in whichever test happened to need one; this
 * is a stub for all of them, and it is faithful in the one respect that matters:
 *
 * **`addEventListener` honours `options.signal`.** The real `MediaQueryList` does, and
 * that is the entire mechanism this module uses for cleanup — the listener is
 * registered with an `AbortSignal` and `onCleanup` aborts it, rather than a matching
 * `removeEventListener` that has to be written correctly to match. A stub that ignored
 * the signal would have let the cleanup test pass for the wrong reason, or fail for
 * one, and either way it would not have been testing the thing.
 */

interface FakeMediaQueryList {
  matches: boolean;
  listeners: Set<(event: { matches: boolean }) => void>;
}

const lists = new Map<string, FakeMediaQueryList>();

/** Sets every open query's match state and tells their listeners. */
const dispatchAll = (matches: boolean): void => {
  for (const list of lists.values()) {
    list.matches = matches;
    for (const listener of [...list.listeners]) listener({ matches });
  }
};

/** How many listeners are attached across every query, for the cleanup assertion. */
const listenerCount = (): number =>
  [...lists.values()].reduce((total, list) => total + list.listeners.size, 0);

const stubMatchMedia = (
  initial: Partial<Record<string, boolean>> = {},
): void => {
  vi.stubGlobal("matchMedia", (query: string): unknown => {
    const list: FakeMediaQueryList = {
      matches: initial[query] ?? false,
      listeners: new Set(),
    };
    lists.set(query, list);
    return {
      get matches() {
        return list.matches;
      },
      addEventListener: (
        _: string,
        listener: (event: { matches: boolean }) => void,
        options?: AddEventListenerOptions | boolean,
      ) => {
        list.listeners.add(listener);
        // The part the cleanup path depends on.
        // `options` is `boolean | AddEventListenerOptions` in the DOM types, and both
        // `true` and `false` have no `signal`, so the boolean cases are ruled out
        // before `.signal` is read. This is the shape of every `signal:` in the DOM
        // and the reason they are typed the way they are.
        const signal =
          typeof options === "object" && !(options instanceof AbortSignal)
            ? options.signal
            : options instanceof AbortSignal
              ? options
              : undefined;
        signal?.addEventListener(
          "abort",
          () => list.listeners.delete(listener),
          {
            once: true,
          },
        );
      },
      removeEventListener: (
        _: string,
        listener: (event: { matches: boolean }) => void,
      ) => list.listeners.delete(listener),
    };
  });
};

beforeEach(() => {
  lists.clear();
  stubMatchMedia();
});

afterEach(() => vi.unstubAllGlobals());

describe("a media query as a signal", () => {
  it("reports what the query matched when it was created", () => {
    stubMatchMedia({ "(max-width: 500px)": true });
    const read = createRoot(() => createMediaQuery("(max-width: 500px)"));
    expect(read()).toBe(true);
  });

  it("reports a query that does not match", () => {
    const read = createRoot(() => createMediaQuery("(max-width: 500px)"));
    expect(read()).toBe(false);
  });

  it("follows the query as it changes, and back again", () => {
    const read = createRoot(() => createMediaQuery("(pointer: coarse)"));
    expect(read()).toBe(false);
    dispatchAll(true);
    expect(read(), "reads the new value").toBe(true);
    dispatchAll(false);
    expect(read(), "and back again").toBe(false);
  });

  it("returns the signal itself, so a caller can pass it wherever a boolean goes", () => {
    // **Not a wrapper.** `narrow()` rather than `narrow.current()` or
    // `narrow.matches()`, because every caller writes `narrow()` and a wrapper would
    // make each of them carry the unwrapping.
    const read = createRoot(() => createMediaQuery("(pointer: coarse)"));
    expect(typeof read).toBe("function");
    expect(read()).toBe(false);
  });

  it("asks for the query it was given, rather than guessing", () => {
    createRoot(() => createMediaQuery("(any-pointer: coarse)"));
    expect([...lists.keys()]).toEqual(["(any-pointer: coarse)"]);
  });

  it("removes its listener when the owner is disposed", () => {
    // **Cleanup is the reason this returns a signal rather than a number.** A
    // `matchMedia` listener that outlives its component keeps that component's closure
    // — and its signal — alive for as long as the page lives, and there is one
    // `MediaQueryList` per query per page.
    const dispose = createRoot((dispose) => {
      createMediaQuery("(pointer: coarse)");
      return dispose;
    });
    expect(listenerCount(), "one listener while mounted").toBe(1);
    dispose();
    expect(listenerCount(), "none once disposed").toBe(0);
  });

  it("does not leave the listener behind when the query never changes", () => {
    // The path that never exercises `removeEventListener`, so it is the one most
    // likely to leak quietly.
    const dispose = createRoot((dispose) => {
      createMediaQuery("(orientation: landscape)");
      return dispose;
    });
    dispose();
    expect(listenerCount()).toBe(0);
  });
});
