/**
 * One pointer, whatever is doing the pointing.
 *
 * ## Why this exists, and why it is not a wrapper around `addEventListener`
 *
 * **Because a mouse, a finger and a pen raise different events, and code that
 * handles all three by hand handles all three badly.** rm-stacker learned this by
 * having two drag implementations that had drifted; this is the one it settled on,
 * and the reason it settled on `PointerEvent` is worth keeping in one place:
 *
 * - **`TouchEvent` is not used anywhere, and that is the decision.** A `touchmove`
 *   has three lists — `touches`, `targetTouches`, `changedTouches` — and choosing the
 *   right one is a per-handler judgement that is wrong somewhere in every large
 *   codebase. `PointerEvent` has one pointer and an id, so the question does not arise.
 * - **`setPointerCapture` on the element the press started on**, so every later move
 *   arrives even once the pointer has left the element. Without it a drag that
 *   outruns its own target silently stops halfway, which on a phone means a drag
 *   that dies exactly when the finger moves fastest.
 * - **A module-level map of which pointers are down on which element.** This is the
 *   entire multi-touch mechanism: `getPointerSize(element)` is how a caller tells
 *   one finger orbiting from two pinching, without a `TouchEvent` in sight.
 * - **`pointercancel` ends the drag.** The browser takes a pointer back when it
 *   decides the gesture is its own — a page zoom, a native scroll — and the promise
 *   resolves rather than hanging forever. This is the reason `touch-action: none` is
 *   not optional on anything using this: it is what stops the take-back happening.
 */

/** A two-component vector, local to this package so it needs no maths dependency. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

const vec2 = (x: number, y: number): Vec2 => ({ x, y });

/** What a caller is handed on every move, and once more when the drag ends. */
export interface PointerDrag<T extends HTMLElement> {
  /** Movement since the previous event. */
  readonly delta: Vec2;
  /** Movement since the press, accumulated. Not present in the sibling's first version. */
  readonly totalDelta: Vec2;
  readonly event: PointerEvent & { currentTarget: T };
  /** Milliseconds since the press that started this drag. */
  readonly timespan: number;
  /** Every pointer currently down on the element, by id. */
  readonly pointers: ReadonlyMap<number, PointerEvent>;
}

/**
 * Which pointers are down on which element, so a second finger's events can be told
 * from this drag's.
 *
 * **Module-level on purpose.** It is per-element state that outlives any one drag —
 * a second finger landing mid-drag has to be visible to the first drag's handler —
 * and putting it on the element would mean the map is lost the moment the element is
 * replaced, which is exactly when a pinch is in progress.
 */
const POINTERS = new Map<HTMLElement, Map<number, PointerEvent>>();

/** How many pointers are down on this element. Zero means no drag is running. */
export const getPointerSize = (element: HTMLElement): number =>
  POINTERS.get(element)?.size ?? 0;

/** The pointers down on this element, for a caller measuring their positions. */
export const getPointers = (
  element: HTMLElement,
): ReadonlyMap<number, PointerEvent> | undefined => POINTERS.get(element);

/**
 * Follows a pointer from the event that started a drag until the drag ends.
 *
 * The element the initial event came from captures the pointer, so its moves keep
 * arriving while the pointer is outside that element.
 *
 * @param initialEvent the pointerdown event that started the drag
 * @param callback called on every pointermove, and once more when the drag ends.
 *   Omitted when the caller only wants to await the drag's end.
 * @param options.signal aborts the drag, resolving the promise with whatever the
 *   last event held. A component unmounting mid-drag should pass one.
 *
 *   **Cancellation is the caller's, through this signal, and not a `onCleanup`
 *   inside.** `pointer` is called from a DOM event handler, and whether that handler
 *   still has a reactive owner depends on who created it — so registering a cleanup
 *   here would make this function fail, or warn, for a caller that did nothing wrong.
 *   The listeners are all on `controller`, so one abort removes every one of them.
 * @returns A promise resolved on pointerup, or on pointercancel when the browser
 *   takes the pointer over for a gesture of its own.
 */
export const pointer = <T extends HTMLElement>(
  initialEvent: PointerEvent & { currentTarget: T },
  callback?: (drag: PointerDrag<T>) => void,
  options?: { readonly signal?: AbortSignal },
): Promise<PointerDrag<T>> => {
  const { promise, resolve } = Promise.withResolvers<PointerDrag<T>>();
  const element = initialEvent.currentTarget;
  const pointerId = initialEvent.pointerId;
  const controller = new AbortController();

  let totalDelta = vec2(0, 0);
  let previous = vec2(initialEvent.clientX, initialEvent.clientY);
  const startTime = performance.now();

  const pointers = POINTERS.get(element) ?? new Map<number, PointerEvent>();
  POINTERS.set(element, pointers);
  pointers.set(pointerId, initialEvent);

  element.setPointerCapture(pointerId);

  /**
   * The drag as it stood at the last event, which is what a caller is handed on a
   * move and what a cancellation resolves with.
   *
   * **Kept rather than rebuilt, because `totalDelta` and `timespan` only exist in
   * terms of the events that have actually arrived** — a cancellation that invented a
   * zero delta would be indistinguishable from a press that never moved.
   */
  let last: PointerDrag<T> | undefined;

  const handleEvent = (event: PointerEvent): PointerDrag<T> => {
    const now = vec2(event.clientX, event.clientY);
    const delta = vec2(now.x - previous.x, now.y - previous.y);
    previous = now;
    totalDelta = vec2(totalDelta.x + delta.x, totalDelta.y + delta.y);
    pointers.set(event.pointerId, event);
    last = {
      delta,
      totalDelta,
      event: event as PointerEvent & { currentTarget: T },
      timespan: performance.now() - startTime,
      pointers,
    };
    return last;
  };

  /**
   * Everything a drag has to give back, whether it ended or was cancelled.
   *
   * **One function called from two places, because the capture and the map are both
   * state the element holds on the drag's behalf and releasing only one leaks the
   * other.** The sibling's version released them on `pointerup` alone, so an aborted
   * drag — a component unmounting mid-gesture — left the element holding a pointer
   * capture and an entry in `POINTERS` for a pointer that was never coming back. A
   * capture held for a dead pointer keeps receiving that pointer's later events, so the
   * *next* drag on the same element would start already owned and `getPointerSize`
   * would never return to zero.
   */
  const release = (): void => {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    pointers.delete(pointerId);
    if (pointers.size === 0) POINTERS.delete(element);
  };

  const handleFinalEvent = (event: PointerEvent): void => {
    const result = handleEvent(event);
    // The same pointer can be followed by more than one caller at a time, and the
    // first of them to finish is the one that gives the capture back.
    release();
    callback?.(result);
    resolve(result);
    controller.abort();
  };

  /**
   * A cancellation, which resolves rather than hanging.
   *
   * **A promise that never settles is the worst thing this function could do**, and
   * the caller that unmounts mid-drag is exactly the one left waiting on one. So an
   * abort resolves with the drag as it last stood — and does *not* call the callback,
   * because a cancelled drag moved nothing and a delta applied to a component that is
   * no longer mounted is a delta applied to nothing.
   *
   * A press that was cancelled before a single event arrived still has to resolve, so
   * that degenerate case is assembled from the press itself rather than left pending.
   */
  const handleAbort = (): void => {
    controller.abort();
    release();
    if (last !== undefined) {
      resolve(last);
      return;
    }
    resolve({
      delta: vec2(0, 0),
      totalDelta,
      event: initialEvent,
      timespan: performance.now() - startTime,
      pointers,
    });
  };

  /**
   * A second finger on the same element raises its own events here. They belong to
   * whichever call is following that pointer, so anything that is not this one has to
   * be passed over rather than mistaken for this drag moving or ending.
   */
  const forThisPointer =
    (handle: (event: PointerEvent) => void) =>
    (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      handle(event);
    };

  // Registered last, so it cannot be attached before `handleAbort` is defined — and
  // after the POINTERS bookkeeping, so an already-aborted signal still runs the
  // release rather than leaving a capture and a map entry behind.
  options?.signal?.addEventListener("abort", handleAbort, { once: true });
  if (options?.signal?.aborted === true) handleAbort();

  if (callback !== undefined) {
    element.addEventListener(
      "pointermove",
      forThisPointer((event) => callback(handleEvent(event))),
      controller,
    );
  }
  element.addEventListener(
    "pointercancel",
    forThisPointer(handleFinalEvent),
    controller,
  );
  element.addEventListener(
    "pointerup",
    forThisPointer(handleFinalEvent),
    controller,
  );

  return promise;
};
