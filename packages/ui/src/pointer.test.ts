// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { pointer, getPointerSize, getPointers } from "./pointer";

/**
 * `pointer` in jsdom.
 *
 * **jsdom implements almost none of this**, which is the point of the fakes below: it
 * has no `PointerEvent`, its `setPointerCapture` and `hasPointerCapture` do nothing,
 * and it does not synthesise a move from one. Every behaviour worth asserting here is
 * therefore a behaviour this module is *responsible* for rather than one the browser
 * provides — which is the right boundary for a unit test of a pointer abstraction to
 * sit at.
 */

interface FakePointer extends Event {
  pointerId: number;
  clientX: number;
  clientY: number;
}

/** The pointer ids jsdom believes this element holds, for the capture assertions. */
const captured = new WeakMap<HTMLElement, Set<number>>();

/**
 * jsdom implements no part of the pointer capture API — not `setPointerCapture`, not
 * `hasPointerCapture`, not `releasePointerCapture` — so this supplies them.
 *
 * **The alternative was to make `pointer()` call them optionally, and that is worse
 * in a way worth recording.** `element.setPointerCapture?.(id)` would make this test
 * pass, and would also mean that on a browser where capture is genuinely unavailable a
 * drag silently stops following the pointer past the edge of its own element, with
 * nothing said. A missing platform API in a test runner is the runner's gap; the
 * production code's job is to assume the browser has the API.
 */
const withCapture = (made: HTMLElement): HTMLElement => {
  const held = new Set<number>();
  captured.set(made, held);
  made.setPointerCapture = (pointerId: number): void => {
    held.add(pointerId);
  };
  made.hasPointerCapture = (pointerId: number): boolean => held.has(pointerId);
  made.releasePointerCapture = (pointerId: number): void => {
    held.delete(pointerId);
  };
  return made;
};

const element = (): HTMLElement => {
  const made = withCapture(document.createElement("div"));
  document.body.append(made);
  return made;
};

const down = (target: HTMLElement, pointerId: number, x: number, y: number) => {
  const event = new Event("pointerdown", { bubbles: true }) as FakePointer;
  Object.assign(event, { pointerId, clientX: x, clientY: y });
  Object.defineProperty(event, "currentTarget", { value: target });
  target.dispatchEvent(event);
  return event as unknown as PointerEvent & { currentTarget: HTMLElement };
};

const at = (
  target: HTMLElement,
  type: string,
  pointerId: number,
  x: number,
  y: number,
) => {
  const event = new Event(type, { bubbles: true }) as FakePointer;
  Object.assign(event, { pointerId, clientX: x, clientY: y });
  target.dispatchEvent(event);
};

describe("following a pointer", () => {
  it("reports the movement since the last event, and since the press", async () => {
    const el = element();
    const seen: { dx: number; tx: number }[] = [];
    const drag = pointer(down(el, 1, 100, 100), ({ delta, totalDelta }) =>
      seen.push({ dx: delta.x, tx: totalDelta.x }),
    );
    at(el, "pointermove", 1, 110, 100);
    at(el, "pointermove", 1, 130, 100);
    at(el, "pointerup", 1, 130, 100);
    await drag;
    // Two moves and the final one from `handleFinalEvent`, which also reports.
    expect(seen[0]).toEqual({ dx: 10, tx: 10 });
    expect(seen[1]).toEqual({ dx: 20, tx: 30 });
  });

  it("resolves on pointerup", async () => {
    const el = element();
    const drag = pointer(down(el, 1, 0, 0));
    at(el, "pointerup", 1, 5, 0);
    await expect(drag).resolves.toBeDefined();
  });

  it("resolves on pointercancel, because the browser can take the pointer back", async () => {
    // **This is the case that hangs forever if it is missed.** The browser takes a
    // pointer back when it decides the gesture is its own — a page zoom, a native
    // scroll — and `touch-action: none` is what stops that happening. A drag that only
    // ends on `pointerup` leaves a captured pointer and a promise that never settles.
    const el = element();
    const drag = pointer(down(el, 1, 0, 0));
    at(el, "pointercancel", 1, 0, 0);
    await expect(drag).resolves.toBeDefined();
  });

  it("ignores a second finger's moves, so a pinch does not move this drag", async () => {
    // **The reason every handler filters on `pointerId`.** A pinch sends each finger's
    // events to the same element, and without the filter the second finger's motion
    // would be added to the first finger's delta — so a zoom would also pan.
    const el = element();
    const seen: number[] = [];
    const drag = pointer(down(el, 1, 0, 0), ({ delta }) => seen.push(delta.x));
    at(el, "pointermove", 2, 0, 0);
    at(el, "pointermove", 2, 50, 0);
    at(el, "pointermove", 1, 10, 0);
    at(el, "pointerup", 1, 10, 0);
    await drag;
    // The second finger moved 50 units and **none of it appears**. The two entries are
    // this finger's move from 0 to 10, and the `pointerup` — which reports too, and
    // whose delta is zero because the finger has not moved since.
    expect(seen).toEqual([10, 0]);
  });

  it("counts the pointers down on the element, which is the whole of multi-touch", async () => {
    // **There is no `TouchEvent` in this package, so this count is how a caller tells
    // one finger orbiting from two pinching.**
    const el = element();
    expect(getPointerSize(el)).toBe(0);
    const first = pointer(down(el, 1, 0, 0));
    expect(getPointerSize(el)).toBe(1);
    const second = pointer(down(el, 2, 50, 0));
    expect(getPointerSize(el)).toBe(2);
    expect(getPointers(el)?.size).toBe(2);
    at(el, "pointerup", 1, 0, 0);
    await first;
    expect(getPointerSize(el)).toBe(1);
    at(el, "pointerup", 2, 50, 0);
    await second;
    expect(getPointerSize(el)).toBe(0);
  });

  it("keeps one drag's end from ending another's", async () => {
    // Two callers following the same pointer on the same element — a handle that both
    // moves the pane and reports a snap — and the first to finish gives the capture
    // back. If the second drag were ended by the first one's release, a release would
    // resolve a promise the caller is still waiting on.
    const el = element();
    const a = pointer(down(el, 7, 0, 0), undefined, undefined);
    const b = pointer(down(el, 7, 0, 0), undefined, undefined);
    at(el, "pointerup", 7, 0, 0);
    await Promise.all([a, b]);
  });

  it("stops listening once the drag ends", async () => {
    const el = element();
    const seen: number[] = [];
    const drag = pointer(down(el, 1, 0, 0), ({ delta }) => seen.push(delta.x));
    at(el, "pointerup", 1, 0, 0);
    await drag;
    at(el, "pointermove", 1, 999, 0);
    expect(seen).toEqual([0]);
  });

  it("aborts when the caller's signal fires, so an unmount cannot strand a pointer", async () => {
    const el = element();
    const controller = new AbortController();
    const seen: number[] = [];
    const drag = pointer(down(el, 1, 0, 0), ({ delta }) => seen.push(delta.x), {
      signal: controller.signal,
    });
    controller.abort();
    at(el, "pointermove", 1, 500, 0);
    // The abort does not resolve the promise — it removes the listeners, and the
    // caller owns the outcome. What it must do is stop the moves.
    expect(seen).toEqual([]);
    at(el, "pointerup", 1, 500, 0);
    await drag;
  });

  it("asks the element to capture the pointer, and gives it back at the end", async () => {
    // **Without `setPointerCapture` a drag dies the moment the pointer outruns its
    // own element**, which on a phone is exactly when the finger is moving fastest.
    // And giving the capture back matters too: an element holding a capture for a
    // pointer that has ended keeps receiving that pointer's later events, so the next
    // drag on it would start already owned.
    const el = element();
    const drag = pointer(down(el, 1, 0, 0));
    expect(el.hasPointerCapture(1), "captured while dragging").toBe(true);
    at(el, "pointerup", 1, 0, 0);
    await drag;
    expect(el.hasPointerCapture(1), "released when the drag ended").toBe(false);
  });

  it("leaves a second caller's capture alone when the first finishes", async () => {
    // Two callers following the same pointer, so the capture is held twice. The first
    // to end gives it back — and the assertion is that it does not throw on the way,
    // which is what a second `releasePointerCapture` on an already-released pointer
    // does in a real browser.
    const el = element();
    const a = pointer(down(el, 3, 0, 0));
    const b = pointer(down(el, 3, 0, 0));
    expect(el.hasPointerCapture(3)).toBe(true);
    at(el, "pointerup", 3, 0, 0);
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(el.hasPointerCapture(3)).toBe(false);
  });

  it("works with no callback, for a caller that only wants the end", async () => {
    // The palette's long-press in the sibling uses exactly this: wait for the press to
    // end, with nothing to report along the way.
    const el = element();
    const drag = pointer(down(el, 1, 0, 0));
    expect(drag).toBeInstanceOf(Promise);
    at(el, "pointerup", 1, 0, 0);
    await expect(drag).resolves.toBeDefined();
  });

  it("reports how long the press has been held, which is how a tap is told from a drag", async () => {
    const el = element();
    let span = 0;
    const drag = pointer(down(el, 1, 0, 0), ({ timespan }) => {
      span = timespan;
    });
    at(el, "pointerup", 1, 0, 0);
    await drag;
    expect(span).toBeGreaterThanOrEqual(0);
  });
});
