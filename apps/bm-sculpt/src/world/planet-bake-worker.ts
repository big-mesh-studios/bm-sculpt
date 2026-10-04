/**
 * The planet-bake worker's entry point.
 *
 * The same shape as `cloud-bake-worker.ts` and for the same reason: this file is the whole of the
 * adapter between a `Worker` and the pure logic in `@big-mesh/csg`. It holds no state worth having,
 * calls one pure function, and posts the two maps back **transferred**, because a copied pair of
 * maps is a megabyte of memcpy that would arrive looking identical and so would never be noticed.
 *
 * The bake measures 564ms at 1024×512 — a third of a second of nothing, at startup, while the frame
 * loop is already running. On the main thread that is a hitch the player feels as a world that
 * pauses. So it goes here, and `planet-bake-client.ts` has a main-thread fallback for when a worker
 * cannot be had.
 */

import type { PlanetMaps, PlanetParams } from "@big-mesh-studios/csg";
import { bakePlanetMaps } from "@big-mesh-studios/csg";

import type {
  PlanetBakeReply,
  PlanetBakeRequest,
} from "./planet-bake-protocol";

interface Scope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

/**
 * The buffers a reply owns, so the transfer list is built from the reply rather than remembered.
 *
 * Both maps are transferred and both are detached on this side, which is why the client cannot retry
 * with them: a bake that fails after transferring has nothing left to send. It is also why the
 * client bakes on the main thread if the worker never answers rather than asking twice.
 */
export const planetBakeTransferables = (
  reply: PlanetBakeReply,
): Transferable[] => [
  reply.maps.albedo.buffer as ArrayBuffer,
  reply.maps.height.buffer as ArrayBuffer,
];

/**
 * The colours the bake paints with.
 *
 * **The base field's own answer, not a painted one.** The bake runs before any model arrives and
 * before anything can be painted, and the alternative — waiting for the model — would mean no planet
 * until the first edit. A painted chunk next to an unpainted globe is the mismatch the swap could
 * show, and it is noted in `planet-maps.ts`; for now the two agree by both being uncoloured, which
 * is the honest version of "the same source".
 */
const BASE_COLOUR = {
  colourAt: () => ({
    colour: { r: 190, g: 186, b: 176 },
    opacity: 1,
  }),
};

export const runPlanetBakeWorker = (scope: Scope): (() => void) => {
  const listener = (event: { data: unknown }): void => {
    const request = event.data as PlanetBakeRequest;
    const maps: PlanetMaps = bakePlanetMaps(
      request.params as PlanetParams,
      BASE_COLOUR,
      request.width,
      request.height,
    );
    const reply: PlanetBakeReply = { maps };
    scope.postMessage(reply, planetBakeTransferables(reply));
  };

  scope.addEventListener("message", listener);
  return () => {
    /* The structural scope has no removeEventListener, and a terminating worker discards its
     * listeners with itself. */
  };
};

if (
  typeof self !== "undefined" &&
  typeof (self as { document?: unknown }).document === "undefined"
) {
  runPlanetBakeWorker(self as unknown as Scope);
}
