/**
 * The planet bake's wire format.
 *
 * Separate from both ends because neither should know about the other's transport: the worker posts
 * maps with buffers transferred, the client receives them the same way, and both reach the same
 * conclusion about what a reply *is* by importing this.
 *
 * ## Why the request carries the size
 *
 * The resolution is a property of the request rather than a constant in the worker, so the cost of a
 * bake is visible in the place that decides to ask for it. 1024×512 is 564ms and 512×256 is about
 * 140ms; the caller picks and the worker obeys.
 */

import type { PlanetParams } from "@big-mesh-studios/csg";

export interface PlanetBakeRequest {
  /** The world to bake. Sent whole because the worker has no model of its own. */
  readonly params: PlanetParams;
  readonly width: number;
  readonly height: number;
}

export interface PlanetBakeReply {
  /**
   * The maps.
   *
   * **Transferred, so both buffers arrive owned by the receiver and are detached here.** That is the
   * whole reason the reply is not `null`-able and has no error case: the worker either produced two
   * maps or it threw, and a throw does not transfer anything. A failure the worker cannot report is
   * handled by the client's timeout instead.
   */
  readonly maps: {
    readonly albedo: Uint8Array;
    readonly height: Uint8Array;
    readonly width: number;
    readonly height_: number;
    readonly seaRadius: number;
    readonly relief: number;
  };
}

/** Whether a reply came back in the shape the protocol says, checked before it is believed. */
export const isPlanetBakeReply = (value: unknown): value is PlanetBakeReply => {
  if (typeof value !== "object" || value === null) return false;
  const maps = (value as { maps?: unknown }).maps;
  if (typeof maps !== "object" || maps === null) return false;
  const m = maps as Record<string, unknown>;
  return (
    m.albedo instanceof Uint8Array &&
    m.height instanceof Uint8Array &&
    typeof m.width === "number" &&
    typeof m.height_ === "number" &&
    typeof m.seaRadius === "number" &&
    typeof m.relief === "number"
  );
};
