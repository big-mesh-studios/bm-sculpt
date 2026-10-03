/**
 * Zones, drawn as wireframe boxes.
 *
 * ## Why this exists
 *
 * A zone is a box that reports the player entering and leaving it, and it is **the whole of a
 * place's reactivity** — there are no entities in v1, so a world-building place has nothing
 * else to react to. Which means a zone the player cannot see is a box that might or might not
 * be there, and a place's author has no way to tell whether their door is in the right place
 * or their zone is not being tested.
 *
 * So this is not decoration. It is the instrument that makes a zone debuggable, and it is the
 * only thing in the place layer that draws.
 *
 * ## One mesh for every zone, not one per zone
 *
 * Every zone's twelve edges go into **one** `LineSegmentsGeometry`, and the whole lot is one
 * draw call. The alternative — a mesh per zone — is a draw call per zone, and a place may hold
 * `MAX_ZONES` of them (256), so a place that used its whole allowance would cost 256 draws for
 * boxes a player can count on their fingers.
 *
 * The cost is that adding a zone rewrites every zone's vertices, which is 24 floats each. At
 * the cap that is six thousand floats, which is nothing, and it happens when a zone is added
 * rather than per frame.
 *
 * ## It is added after the terrain
 *
 * rmsl has no render-order key — draw order is scene traversal order (ADR 0014) — so this
 * goes into the scene *after* the session's terrain, which is what the sky's own comment is
 * about. A wireframe box that drew behind the terrain would be a zone that only showed through
 * the gaps, which is the one thing a debug overlay must never do.
 */

import {
  Color,
  LineSegments2,
  LineSegmentsGeometry,
  Line2NodeMaterial,
  type Scene,
} from "@random-mesh/rmsl/scene";

import type { Zone } from "./host";

/** Six floats per edge, twelve edges per box. */
const FLOATS_PER_EDGE = 6;
const EDGES_PER_BOX = 12;

/**
 * The colour a zone's edges are drawn in.
 *
 * A cool blue rather than the terrain's palette, because these are not world geometry: they
 * are an overlay, and an overlay that shares the world's colours reads as part of the world.
 * Bright enough to survive the terrain's own shading — they are unlit, so it is the fog that
 * matters, and fog is exponential and closes at the window.
 */
const ZONE_COLOR = new Color(0.45, 0.85, 1);

/** How wide the edges are, in device pixels. */
const ZONE_WIDTH = 2;

export interface ZoneLines {
  /** Rebuilds the geometry from the zones given. Cheap; call it when they change. */
  update(zones: readonly Zone[]): void;
  /** How many boxes are currently drawn. */
  readonly count: number;
  dispose(): void;
}

/**
 * Builds the overlay, **and adds it to the scene.**
 *
 * The sky's comment is the reason this says so rather than returning an object to add: adding
 * it in the wrong order is the kind of mistake that looks like a depth problem.
 */
export const createZoneLines = (scene: Scene): ZoneLines => {
  const geometry = new LineSegmentsGeometry();
  const material = new Line2NodeMaterial();
  material.color = ZONE_COLOR;
  material.linewidth = ZONE_WIDTH;
  material.transparent = true;
  material.opacity = 0.85;
  // Depth *test* on, depth *write* off: the box is behind a wall it should not draw through,
  // but two boxes crossing each other must not have whichever drew first win.
  material.depthTest = true;
  material.depthWrite = false;

  const lines = new LineSegments2(geometry, material);
  scene.add(lines);

  let count = 0;

  return {
    update(zones: readonly Zone[]): void {
      count = zones.length;
      if (count === 0) {
        geometry.setPositions([]);
        return;
      }
      geometry.setPositions(edgePositions(zones));
      // The dash shader needs accumulated lengths, which `computeLineDistances` computes from
      // the positions just set. Not dashed today, and called anyway — a material with
      // `dashed` turned on later would otherwise draw one unbroken line.
      lines.computeLineDistances();
    },

    get count(): number {
      return count;
    },

    dispose(): void {
      // The material is not disposed, because `Line2NodeMaterial` has no `dispose` — which is
      // true of the sky's and the terrain's materials too, and is why nothing in this
      // repository disposes one. Said here because a reader will otherwise look for the call
      // and assume the author forgot it.
      scene.remove(lines);
      geometry.dispose();
    },
  };
};

/**
 * The twelve edges of every box, as `xyz xyz` pairs.
 *
 * **Written out rather than built by a loop over corner indices**, which is the sort of thing
 * that looks clever and is checked once. Twelve lines of coordinates are the whole format, and
 * the loop that could have generated them would be the thing to get wrong.
 *
 * Exported because it is the part that can be wrong without looking wrong: a mistyped corner
 * still produces twelve well-formed edges, a plausible `Float32Array`, and a box on screen with
 * one corner in the wrong place — which no amount of "did it draw" will catch, and which the
 * test checks by proving every edge joins two corners of the box and every corner is used.
 */
export const edgePositions = (zones: readonly Zone[]): Float32Array => {
  const out = new Float32Array(zones.length * EDGES_PER_BOX * FLOATS_PER_EDGE);
  let at = 0;

  for (const zone of zones) {
    const [x0, y0, z0] = zone.min;
    const [x1, y1, z1] = zone.max;

    // Four edges along x, four along y, four along z. Twelve, once each.
    const edge = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
    ): void => {
      out[at++] = ax;
      out[at++] = ay;
      out[at++] = az;
      out[at++] = bx;
      out[at++] = by;
      out[at++] = bz;
    };

    // Along x: the four edges of the two z faces and the two y faces that are not already
    // drawn along z or y.
    edge(x0, y0, z0, x1, y0, z0);
    edge(x0, y1, z0, x1, y1, z0);
    edge(x0, y0, z1, x1, y0, z1);
    edge(x0, y1, z1, x1, y1, z1);
    // Along y.
    edge(x0, y0, z0, x0, y1, z0);
    edge(x1, y0, z0, x1, y1, z0);
    edge(x0, y0, z1, x0, y1, z1);
    edge(x1, y0, z1, x1, y1, z1);
    // Along z.
    edge(x0, y0, z0, x0, y0, z1);
    edge(x1, y0, z0, x1, y0, z1);
    edge(x0, y1, z0, x0, y1, z1);
    edge(x1, y1, z0, x1, y1, z1);
  }

  return out;
};

/**
 * The wireframe's own format, for the test that counts edges.
 *
 * **Exported rather than left as two private numbers** because the count is the thing a reader
 * wants to check — "twelve edges" — and a test that recomputes twelve from a loop is testing
 * the loop, not the format.
 */
export const EDGE_FORMAT = {
  floatsPerEdge: FLOATS_PER_EDGE,
  edgesPerBox: EDGES_PER_BOX,
} as const;
