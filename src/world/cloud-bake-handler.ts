/**
 * What a bake worker knows, and what it does when told to bake.
 *
 * The pure layer under `cloud-bake-worker.ts`, exactly as `src/mesh/worker.ts` is the
 * pure layer under `src/mesh/mesh-worker.ts`. A `Worker` cannot be inspected, cannot
 * be asked questions and cannot be stood up in a test without a browser, so
 * `handleBakeMessage` is a function of state, message and an injected baker — and
 * everything worth asserting about the boundary can be asserted by calling it.
 *
 * The injected baker is the whole reason this is not a one-line `post(bakeCloudField)`.
 * A test that baked a real field would cost two seconds a time, and the failure worth
 * catching here — that a request which cannot be baked produces a *reply* rather than
 * silence — is about the shape of the message and not about the noise in it.
 */

import type { CloudField } from "./cloud-field";
import type {
  BakeFailedMessage,
  BakeReadyMessage,
  FromBakeWorker,
} from "./cloud-bake-protocol";
import { isToBakeWorker } from "./cloud-bake-protocol";

/**
 * Bakes a field for a request.
 *
 * Injected rather than imported so the message-handling logic — where the ordering
 * rules live — can be tested against a counting fake instead of against the noise
 * generator, which is a second and a half per call.
 */
export type Baker = (
  seed: number,
  shapeSize?: number,
  weatherSize?: number,
) => CloudField;

/** How a worker remembers what it has been asked for. */
export interface BakeWorkerState {
  /** Bakes completed, whether they produced a field or a failure. */
  readonly bakes: number;
  readonly failures: number;
}

/** A worker that has been told nothing yet. */
export const emptyBakeWorkerState = (): BakeWorkerState => ({
  bakes: 0,
  failures: 0,
});

/** What handling a message produced. */
export interface HandledBake {
  readonly state: BakeWorkerState;
  /** What to post back, if anything. */
  readonly reply: FromBakeWorker | undefined;
}

/**
 * Handles one message, returning the worker's new state and its reply.
 *
 * Never throws, for the reason `handleMeshMessage` does not: a worker that throws dies
 * silently, and the main thread's promise for that field then never settles — a
 * loading state that lasts for ever rather than an error that can be read.
 */
export const handleBakeMessage = (
  state: BakeWorkerState,
  message: unknown,
  bake: Baker,
): HandledBake => {
  if (!isToBakeWorker(message)) {
    // A message from another bundle. Ignoring it lets the worker start and carry on,
    // where throwing would take the whole bake down with it.
    return { state, reply: undefined };
  }

  const pending: BakeWorkerState = { ...state, bakes: state.bakes + 1 };

  try {
    const field = bake(message.seed, message.shapeSize, message.weatherSize);
    const reply: BakeReadyMessage = {
      kind: "cloudFieldReady",
      seed: message.seed,
      shape: field.shape,
      weather: field.weather,
    };
    return { state: pending, reply };
  } catch (reason) {
    const reply: BakeFailedMessage = {
      kind: "cloudFieldFailed",
      seed: message.seed,
      reason: reason instanceof Error ? reason.message : String(reason),
    };
    return {
      state: { ...pending, failures: pending.failures + 1 },
      reply,
    };
  }
};

/**
 * The request a worker is answering, recovered from the field it produced.
 *
 * Exists so the client's staleness check reads as a question about a seed rather than
 * as a comparison of two numbers, and so the test that a stale answer is dropped has
 * one thing to be about.
 */
export const bakedSeed = (message: FromBakeWorker): number => message.seed;
