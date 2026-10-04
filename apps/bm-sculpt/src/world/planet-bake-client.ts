/**
 * The main thread's side of the planet bake: a worker, one request, and a promise.
 *
 * ## Why there is a worker at all
 *
 * Measured, not assumed: a 1024×512 bake is 524,288 three-dimensional noise evaluations and comes to
 * **564ms** on this machine — which is a phone. The frame loop is already running when the world
 * starts, so on the main thread that is a third of a second of nothing, and it lands exactly when the
 * player is looking at an empty sky wondering whether the app worked.
 *
 * ## Why there is still a fallback
 *
 * A worker can fail to start — a browser that blocks it, a file:// page, a stripped-down webview — and
 * a 564ms hitch is much better than no planet at all. So the client bakes on the main thread if the
 * worker has not answered within {@link PLANET_BAKE_TIMEOUT_MS}, and says which one happened through
 * {@link PlanetBake.source}.
 *
 * This mirrors `cloud-bake-client.ts` deliberately. Two clients that both fall back and both report
 * their source is one design; two clients that each invent their own is two.
 */

import type { PlanetParams } from "@big-mesh-studios/csg";
import { bakePlanetMaps } from "@big-mesh-studios/csg";

import {
  isPlanetBakeReply,
  type PlanetBakeReply,
  type PlanetBakeRequest,
} from "./planet-bake-protocol";

export type PlanetBakeSource = "worker" | "main thread" | "not yet";

/**
 * How long to wait before giving up on the worker.
 *
 * **Fifteen seconds for roughly five seconds of work.** Generous, because the cost of being wrong in
 * one direction and the other are not the same: a worker that answers late has cost a blank planet
 * for longer than the bake ever would have, and a fallback that fires early just does the same work
 * twice. The 3072×1536 bake is about nine times the 1024×512 one, so the four seconds that fit the
 * old 564 ms no longer fit it. The worker is not aborted when the timeout fires — it is terminated —
 * so the two bakes do not race.
 */
export const PLANET_BAKE_TIMEOUT_MS = 15000;

export interface PlanetBakeFactory {
  post(message: PlanetBakeRequest): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  terminate(): void;
}

/** Testable seam: the client never names `Worker`, it names this. */
export type PlanetBakeWorkerFactory = () => PlanetBakeFactory;

const createBakeWorker: PlanetBakeWorkerFactory = () => {
  const worker = new Worker(
    new URL("./planet-bake-worker.ts", import.meta.url),
    {
      type: "module",
      name: "bm-sculpt-planet-bake",
    },
  );
  return {
    post: (message) => worker.postMessage(message),
    addEventListener: (type, listener) =>
      worker.addEventListener(type, listener as unknown as EventListener),
    removeEventListener: (type, listener) =>
      worker.removeEventListener(type, listener as unknown as EventListener),
    terminate: () => worker.terminate(),
  };
};

/**
 * The colours a main-thread fallback paints with.
 *
 * **Duplicated from the worker on purpose, and this is the one thing in the bake worth being uneasy
 * about.** It has to be duplicated: the fallback runs here and the worker runs in a scope that cannot
 * import from the renderer, so there is no module both can share without giving up the property that
 * made the move possible. What holds them together is the test that bakes both ways at the same
 * resolution and compares the bytes, which fails the moment they disagree.
 */
const FALLBACK_COLOUR = {
  colourAt: () => ({ colour: { r: 190, g: 186, b: 176 }, opacity: 1 }),
};

export interface PlanetBake {
  /** The maps, whenever they exist. Resolves once; a later resolution is impossible. */
  readonly maps: Promise<PlanetBakeReply["maps"]>;
  /** Which of the two bakes won. For the HUD, and for the test that compares the two. */
  readonly source: () => PlanetBakeSource;
  /** Whether the caller should still be interested: false after a teardown. */
  readonly disposed: () => boolean;
}

export const bakePlanetMapsOffThread = (
  params: PlanetParams,
  width: number,
  height: number,
  create: PlanetBakeWorkerFactory = createBakeWorker,
  timeoutMs: number = PLANET_BAKE_TIMEOUT_MS,
): PlanetBake => {
  let resolveMaps: (maps: PlanetBakeReply["maps"]) => void = () => {};
  const maps = new Promise<PlanetBakeReply["maps"]>((resolve) => {
    resolveMaps = resolve;
  });

  // **Once, and deliberately.** A worker disposed of and then answering anyway is a race the browser
  // is entitled to produce. Settling twice would be silently swallowed, so the second bake's cost
  // would never be visible anywhere.
  let done = false;
  let disposed = false;
  let source: PlanetBakeSource = "not yet";
  let worker: PlanetBakeFactory | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const onMainThread = (): void => {
    if (done) return;
    done = true;
    source = "main thread";
    stopTimer();
    worker?.terminate();
    worker = undefined;
    resolveMaps(bakePlanetMaps(params, FALLBACK_COLOUR, width, height));
  };

  try {
    const created = create();
    worker = created;
    const listener = (event: { data: unknown }): void => {
      // **Three guards before the reply is believed.** A message arriving after the fallback has
      // already baked (`done`), a message that is not a reply at all — a worker can be sent anything
      // by anything else on the page — and a reply whose shape does not match the protocol. Only the
      // last of those is a bug in *this* code; the first two are the browser being the browser.
      if (done) return;
      if (!isPlanetBakeReply(event.data)) return;
      done = true;
      source = "worker";
      stopTimer();
      created.removeEventListener("message", listener);
      worker = undefined;
      created.terminate();
      resolveMaps(event.data.maps);
    };
    created.addEventListener("message", listener);
    created.post({ params, width, height });
    timer = setTimeout(onMainThread, timeoutMs);
  } catch {
    // A worker that cannot even be constructed is not an error worth showing anybody: the bake runs
    // here instead and the source line says so.
    onMainThread();
  }

  return {
    maps,
    // **Read at call time, not captured.** The HUD asks this on every frame to decide what to draw,
    // and the answer changes once: from "not yet" to whichever of the two finished.
    source: () => source,
    disposed: () => disposed,
  };
};
