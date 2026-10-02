/**
 * The cloud-bake worker's entry point.
 *
 * The same shape as `src/mesh/mesh-worker.ts` and for the same reason: this file is the
 * whole of the adapter between a `Worker` and the pure logic in `cloud-bake-handler.ts`
 * — hold the state, call the handler, post what comes back with its buffers
 * transferred. Everything worth testing is one layer down and is tested there, because a
 * `Worker` cannot be inspected, cannot be asked questions, and cannot be stood up in a
 * test without a browser.
 *
 * It imports `cloud-field.ts` and nothing else that is not pure. That is the property
 * the whole move depends on, and it is why the bake could be taken off the main thread
 * without changing a line of it: no DOM, no renderer, no material.
 */

import { bakeCloudField } from "./cloud-field";
import { emptyBakeWorkerState, handleBakeMessage } from "./cloud-bake-handler";
import { bakeTransferables } from "./cloud-bake-protocol";

/**
 * The scope a worker runs in.
 *
 * Declared rather than using `self`, so this module can be imported by a test with a
 * fake scope and driven end to end without a browser — which is how the transfer list,
 * the one thing that fails silently, gets tested.
 */
interface Scope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

/**
 * Runs a bake worker loop against a scope, and returns a function that stops it.
 *
 * Split out from the module's side effects so the loop can be driven with a fake scope:
 * the baking is already pure, but the wiring — that a reply is posted back with the
 * two buffers transferred rather than copied — is not, and is exactly the part that
 * fails silently. A copied field still arrives; it is a megabyte of memcpy per load
 * that nobody would ever notice.
 */
export const runBakeWorker = (scope: Scope): (() => void) => {
  let state = emptyBakeWorkerState();

  const listener = (event: { data: unknown }): void => {
    const handled = handleBakeMessage(state, event.data, bakeCloudField);
    state = handled.state;
    if (handled.reply !== undefined) {
      scope.postMessage(handled.reply, bakeTransferables(handled.reply));
    }
  };

  scope.addEventListener("message", listener);
  return () => {
    /* The scope has no removeEventListener in the structural type, and a terminating
     * worker discards its listeners with itself. */
  };
};

// Only start the loop when actually running inside a worker. Importing this module —
// which the tests do, to reach `runBakeWorker` — must not try to take over a page's `self`.
if (
  typeof self !== "undefined" &&
  typeof (self as { document?: unknown }).document === "undefined"
) {
  runBakeWorker(self as unknown as Scope);
}
