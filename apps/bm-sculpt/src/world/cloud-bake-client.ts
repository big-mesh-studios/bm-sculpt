/**
 * The main thread's side of the cloud bake: a worker, one request, and a promise.
 *
 * `bakeCloudField` is about two and a half seconds of arithmetic at the production
 * sizes, and it was being run inside `createClouds` — which is to say on the thread
 * that draws. A window with no clouds for those two and a half seconds is a window
 * that still moves, which is a far better trade than a page that freezes, so the
 * worker exists for the stall and not for the clouds.
 *
 * Nothing in `cloud-field.ts` changed to get here. It was already free of the DOM and
 * of the renderer, which is the property this move is entirely made of: a bake that
 * read a `DataTexture` or a `Scene` could not be run anywhere but the main thread and
 * would have to be untangled before it could.
 *
 * A controller rather than a bare promise, for one reason: a `Worker` that is never
 * terminated is a thread that is never joined. `dispose` is here so the caller can stop
 * it — and the tests drive the whole thing against a fake, because the failures that
 * matter at a thread boundary are all about *when* the answer arrives, and a fake that
 * answered immediately could express none of them.
 */

import { bakeCloudField, type CloudField } from "./cloud-field";
import type {
  BakeReadyMessage,
  FromBakeWorker,
  ToBakeWorker,
} from "./cloud-bake-protocol";
import { isFromBakeWorker } from "./cloud-bake-protocol";

/**
 * A bake worker, as a module worker.
 *
 * The structural shape rather than `Worker` itself, for the reason the mesher pool has
 * the same one: `Worker`'s own overloads are wider than what this uses, and a type
 * naming `Worker` could not be stood in for by a fake — which is the only reason the
 * interface is worth having. The event is `unknown` because the two events listened
 * for are different things: a `MessageEvent` with a `data`, and an `ErrorEvent` with
 * none.
 */
export interface BakeWorker {
  /**
   * Sends a message. No transfer list, because nothing is sent: a request is a seed and
   * two optional sizes, and the whole megabyte moves the other way.
   */
  post(message: ToBakeWorker): void;
  addEventListener(
    type: "message" | "error",
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: "message" | "error",
    listener: (event: unknown) => void,
  ): void;
  terminate(): void;
}

/** Builds a bake worker. Injected so the whole client is testable off a browser. */
export type BakeWorkerFactory = () => BakeWorker;

/** How long to wait for a worker before baking here instead, in milliseconds. */
export const BAKE_TIMEOUT_MS = 8000;

/** Which thread produced the field. */
export type CloudBakeSource = "worker" | "main thread" | "not yet";

/** What a caller gets back: the field, and a way to stop caring about it. */
export interface CloudBake {
  /**
   * The baked field.
   *
   * **Never rejects and never hangs**, which is two decisions rather than one omission.
   * Three things can go wrong here — no worker can be built, the worker reports a
   * failure, the worker dies outright — and all three are answered the same way: bake it
   * here instead. A fourth, which is worse than all three together, is a worker that
   * neither answers nor fails: it loads, it takes its message, and nothing comes back.
   * That one is covered by `BAKE_TIMEOUT_MS`, because a promise that never settles is
   * a world with no weather in it and no error anywhere.
   *
   * So this is the arrangement to be suspicious of: a bake that could not be reached
   * here does not report why. A caller that must know gets `CloudBake.fallback`, which
   * settles in every case including the worker working perfectly — that is what the
   * status in the readout is built on.
   */
  readonly field: Promise<CloudField>;
  /**
   * The same field, computed here if the worker could not produce it.
   *
   * Settles once, whichever route got there first. There is no way to ask which — and
   * deliberately so: a caller that branched on it would branch on whether the platform
   * has workers, which is not a thing a sky should have an opinion about.
   */
  readonly fallback: Promise<CloudField>;
  /**
   * Which thread produced the field, and `"not yet"` while neither has.
   *
   * The two routes give byte-identical fields, so nothing about the field itself says
   * which one ran — and the difference is the whole point of the worker: a fallback on
   * the main thread is a second of frozen page per load. A caller that shows a status
   * wants this rather than inferring it from a frame rate.
   */
  source(): CloudBakeSource;
  /**
   * Terminates the worker, drops the listener and cancels the wait.
   *
   * Deliberately does **not** settle `field`, because it cannot settle it
   * honestly: the answer is gone with the worker, and baking here to fill the gap would
   * spend two and a half seconds on the main thread inside a teardown, which is the one
   * moment nobody is waiting for one. A caller that disposed of a bake and still wants
   * a field reads `fallback`, which is what that promise is for.
   */
  dispose(): void;
}

/** A bake worker, as the bundler has to emit it: its own chunk, no renderer in it. */
const createBakeWorker: BakeWorkerFactory = () => {
  const worker = new Worker(
    new URL("./cloud-bake-worker.ts", import.meta.url),
    {
      type: "module",
      name: "bm-sculpt-cloud-bake",
    },
  );
  return {
    post: (message) => worker.postMessage(message),
    addEventListener: (type, listener) =>
      worker.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      worker.removeEventListener(type, listener as EventListener),
    terminate: () => worker.terminate(),
  };
};

/**
 * Bakes a cloud field on a worker, falling back to this thread if it cannot.
 *
 * @param seed - The world's seed. The field is a pure function of it.
 * @param create - How to build the worker. The default is the bundler's module worker;
 *   the tests pass a fake, and passing a factory that throws is how the fallback is
 *   tested at all.
 * @param timeoutMs - How long to wait for a worker before baking here. The default is
 *   generous, because the cost of waiting is a sky that is late and the cost of giving
 *   up is a second of frozen page — and eight seconds is past the point at which anyone
 *   has stopped noticing the sky arriving at all.
 * @returns The field as a promise, and a `dispose` for the worker behind it.
 */
export const bakeCloudFieldOffThread = (
  seed: number,
  create: BakeWorkerFactory = createBakeWorker,
  timeoutMs: number = BAKE_TIMEOUT_MS,
): CloudBake => {
  let resolveField: (field: CloudField) => void = () => {};
  let resolveFallback: (field: CloudField) => void = () => {};
  const field = new Promise<CloudField>((resolve) => {
    resolveField = resolve;
  });
  const fallback = new Promise<CloudField>((resolve) => {
    resolveFallback = resolve;
  });

  // Once, because a worker disposed of and then answering anyway — a race the browser
  // is entitled to produce — would otherwise bake twice, and a second resolution is
  // taken silently, so the cost would never be visible.
  let done = false;
  let disposed = false;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  let source: CloudBakeSource = "not yet";

  const settleBoth = (baked: CloudField, from: CloudBakeSource): void => {
    done = true;
    source = from;
    if (waiting !== undefined) clearTimeout(waiting);
    waiting = undefined;
    resolveField(baked);
    resolveFallback(baked);
  };
  const answerHere = (): void => {
    if (done) return;
    settleBoth(bakeCloudField(seed), "main thread");
  };

  let worker: BakeWorker;
  try {
    worker = create();
  } catch {
    // No worker: a browser without module workers, a page served from `file://`, or a
    // policy that forbids them. The field is the same field, a moment later, and the
    // only visible difference is that the frame does not stall while it arrives.
    answerHere();
    return { field, fallback, source: () => source, dispose: () => {} };
  }

  const onMessage = (event: unknown): void => {
    const message: unknown = (event as { data?: unknown } | null)?.data;
    if (!isFromBakeWorker(message)) return;
    if (message.seed !== seed) return;
    if (!isBakeAnswer(message)) {
      console.warn(
        `cloud field for seed ${seed} failed to bake — baking here instead:`,
        message.reason,
      );
      answerHere();
      return;
    }
    if (!carriesAField(message)) {
      // The one answer that would be worse than no answer, because it looks like one.
      // A field whose buffers arrived detached is a field of zero texels, and a sky made
      // of a zero-texel volume is transparent: no clouds, no warning, nothing to look
      // at. It is cheap to refuse and worth refusing.
      console.warn(
        `cloud field for seed ${seed} arrived empty — baking here instead`,
      );
      answerHere();
      return;
    }
    if (done) return;
    // The two `PackedField`s arrived by transfer, so their buffers belong to this
    // thread now and are handed straight to `createClouds`.
    settleBoth({ shape: message.shape, weather: message.weather }, "worker");
  };

  const onError = (event: unknown): void => {
    // The event that matters is the one that arrives with no `data` at all: a worker
    // that cannot even load its module. Nothing follows it, so without this the promise
    // would never settle and the world's sky would be a loading state for ever.
    console.warn(
      "cloud bake worker failed — baking on the main thread:",
      event,
    );
    answerHere();
  };

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);

  // The fourth failure, and the one with no event to wait for: a worker that takes its
  // message and says nothing at all. It has happened, and the symptom was a sky that
  // never arrived and a log that never said why — which is a fault measured in hours
  // rather than minutes. Baking here after eight seconds turns it into a stall.
  waiting = setTimeout(() => {
    waiting = undefined;
    if (done) return;
    console.warn(
      `cloud field for seed ${seed} did not arrive within ${timeoutMs} ms — baking here instead`,
    );
    answerHere();
  }, timeoutMs);

  worker.post({ kind: "bakeCloudField", seed });

  return {
    field,
    fallback,
    source: () => source,
    dispose: () => {
      // Guarded because a teardown can reach this twice — a scene effect whose cleanup
      // runs and then a `dispose` held elsewhere — and terminating a worker twice is
      // harmless while removing a listener twice is not: the second call passes a
      // different closure, so the first one stays on the scope holding a reference to a
      // promise nobody will ever settle.
      if (disposed) return;
      disposed = true;
      if (waiting !== undefined) clearTimeout(waiting);
      waiting = undefined;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.terminate();
    },
  };
};

/**
 * Whether a message is the field rather than the failure.
 *
 * A narrowing guard rather than a bare comparison, because this is the one judgement at
 * the boundary that nothing downstream makes: a failure taken for a field would upload
 * two one-texel textures and draw a sky with no weather in it, and nothing would throw.
 */
export const isBakeAnswer = (
  message: FromBakeWorker,
): message is BakeReadyMessage => message.kind === "cloudFieldReady";

/**
 * Whether a ready message's field has any bytes in it at all.
 *
 * Detached, empty and zero-length all mean the same thing here, and none of them can be
 * detected further along: `createClouds` uploads whatever `Uint8Array` it is handed, and
 * a volume of zero texels is a transparent sky.
 */
const carriesAField = (message: BakeReadyMessage): boolean =>
  message.shape.data.length > 0 && message.weather.data.length > 0;
