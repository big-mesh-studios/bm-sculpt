/**
 * The meshing worker's entry point.
 *
 * This file is the whole of the adapter between a `Worker` and the pure logic in
 * `worker.ts`: hold the state, call `handleMeshMessage`, post what comes back. It is
 * kept to that on purpose — everything worth testing is one layer down and is tested
 * there, because a `Worker` cannot be inspected, cannot be asked questions, and cannot
 * be stood up in a test without a browser.
 *
 * It is the module a bundler points a `new Worker(...)` at, and it is the only file in
 * the project that touches `self`. If that turns out to be inconvenient — a worker that
 * also had to be a render target, say — the cost is moving this file, not untangling the
 * logic.
 */

import { meshersFor } from "./model-field";
import { emptyWorkerState, handleMeshMessage } from "./worker";
import { meshTransferables } from "./protocol";

/**
 * The scope a worker runs in.
 *
 * Declared rather than using `self` directly, so this module can be imported by a test
 * with a fake scope and driven end to end without a browser. `DedicatedWorkerGlobalScope`
 * is the honest type and `Window` satisfies enough of it structurally to stand in.
 */
interface Scope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

/**
 * Runs a worker loop against a scope, and returns a function that stops it.
 *
 * Split out from the module's side effects so the loop can be driven with a fake scope:
 * the message handling is already pure, but the wiring — that a reply is posted back
 * with the right buffers transferred — is not, and is exactly the part that fails
 * silently.
 */
export const runWorker = (scope: Scope): (() => void) => {
  let state = emptyWorkerState();

  const listener = (event: { data: unknown }): void => {
    const handled = handleMeshMessage(state, event.data, meshersFor);
    state = handled.state;
    if (handled.reply !== undefined) {
      scope.postMessage(handled.reply, meshTransferables(handled.reply));
    }
  };

  scope.addEventListener("message", listener);
  return () => {
    /* The scope has no removeEventListener in the structural type, and a terminating
     * worker discards its listeners with itself. */
  };
};

// Only start the loop when actually running inside a worker. Importing this module —
// which the tests do, to reach `runWorker` — must not try to take over a page's `self`.
if (
  typeof self !== "undefined" &&
  typeof (self as { document?: unknown }).document === "undefined"
) {
  runWorker(self as unknown as Scope);
}
