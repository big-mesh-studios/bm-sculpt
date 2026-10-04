/**
 * How much of the streaming window is rock, and where.
 *
 * ## The question
 *
 * The window is a solid ellipsoid of cells, 5 chunks in x and z and 2 in y, which is a shape chosen
 * for a height field: terrain on a plane varies in height, so the world is a slab and the window
 * is a slab. A planet's surface is a **shell** — every direction has terrain at roughly the same
 * radius — and a slab is the wrong shape for a shell in a way that depends on which way "up" is.
 *
 * The window is thin in **y**. The planet's shell is thin along **radial**. So:
 *
 * - where radial is `+Y`, the window's thin axis is the shell's thin axis, and it fits;
 * - where radial is `+X` or `±Z`, the two are perpendicular, and the window is spending its budget
 *   on cells that are above the sky and below the rock;
 * - in between, the shell cuts the window diagonally.
 *
 * So the waste is a function of latitude, and nobody should build a shell-shaped window on the
 * strength of an estimate. This file measures the estimate.
 *
 * ## What is measured
 *
 * For a focus on the surface at a range of latitudes, the window's cells are counted and each is
 * asked `couldHoldSurface`. That is the same question the mesher's gate asks, from the same field
 * the mesher would build — so a cell counted here as waste is a cell that will be requested,
 * occupy a slot, and be refused.
 */

import { describe, it } from "vitest";

import {
  DEFAULT_PLANET,
  baseFieldFor,
  isPlanetField,
} from "@big-mesh-studios/csg";
import type { Bounds } from "@big-mesh-studios/core";
import { BLOCK_WORLD } from "../constants";
import { cellCentre, sphereCells } from "../world";

const RADIUS = 5;
const Y_RADIUS = 2;

const field = baseFieldFor({ kind: "planet", params: DEFAULT_PLANET });
if (!isPlanetField(field)) throw new Error("expected a planet");

/** The AABB of one chunk, in the same terms `couldHoldSurface` is given. */
const boundsOf = (cell: { x: number; y: number; z: number }): Bounds => {
  const lo = cellCentre(cell);
  const half = BLOCK_WORLD / 2;
  return {
    min: { x: lo.x - half, y: lo.y - half, z: lo.z - half },
    max: { x: lo.x + half, y: lo.y + half, z: lo.z + half },
  };
};

/** A focus on the surface, `tilt` radians from the `+Y` axis. */
const focusAt = (tilt: number): { x: number; y: number; z: number } => {
  const s = Math.sin(tilt);
  const n = { x: s, y: Math.cos(tilt), z: 0 };
  const r = field.radiusAt(n);
  return cellCentre({
    x: Math.floor((n.x * r) / BLOCK_WORLD),
    y: Math.floor((n.y * r) / BLOCK_WORLD),
    z: Math.floor((n.z * r) / BLOCK_WORLD),
  });
};

describe("the window on a planet", () => {
  it("measures how much of it can hold surface, by latitude", () => {
    console.log(
      `\n  window ${RADIUS}/${Y_RADIUS} chunks = ` +
        `${sphereCells({ x: 0, y: 0, z: 0 }, RADIUS, Y_RADIUS).length} cells; ` +
        `planet band [${field.lowestRadius.toFixed(0)}, ${field.highestRadius.toFixed(0)}] ` +
        `= ${((field.highestRadius - field.lowestRadius) / BLOCK_WORLD).toFixed(2)} chunks thick`,
    );
    console.log("  tilt from +Y   window cells   can hold surface   usable");

    let worst = 1;
    let best = 0;
    for (let deg = 0; deg <= 90; deg += 10) {
      const focus = focusAt((deg * Math.PI) / 180);
      const centre = {
        x: Math.floor(focus.x / BLOCK_WORLD),
        y: Math.floor(focus.y / BLOCK_WORLD),
        z: Math.floor(focus.z / BLOCK_WORLD),
      };
      const cells = sphereCells(centre, RADIUS, Y_RADIUS);
      let usable = 0;
      for (const cell of cells) {
        if (field.couldHoldSurface(boundsOf(cell))) usable++;
      }
      const fraction = usable / cells.length;
      worst = Math.min(worst, fraction);
      best = Math.max(best, fraction);
      console.log(
        `  ${String(deg).padStart(3)}°${" ".repeat(10)}` +
          `${String(cells.length).padStart(10)}` +
          `${String(usable).padStart(18)}` +
          `${`${(fraction * 100).toFixed(1)}%`.padStart(9)}`,
      );
    }
    console.log(
      `\n  best ${(best * 100).toFixed(1)}%, worst ${(worst * 100).toFixed(1)}%, ` +
        `so a shell-shaped window would free up to ` +
        `${((1 - worst) * sphereCells({ x: 0, y: 0, z: 0 }, RADIUS, Y_RADIUS).length) | 0} slots ` +
        `at the worst latitude\n`,
    );
  });

  it("measures whether the shape survives growing to orbital scale", () => {
    // **The question the goal actually asks.** "Fly up and see a planet" means the window has to
    // cover a globe 8000 units across — about 25 chunks, so a radius near 13 — while the player is
    // 12 chunks above the surface looking down at the whole thing.
    //
    // A solid ellipsoid of that size is mostly deep rock: the shell is 1.8 chunks thick and the box
    // is 13. If the usable fraction keeps falling as the window grows, the shape cannot reach orbit
    // at any budget, and no amount of streaming capacity fixes it. If it flattens out, the window
    // can be scaled and the budget buys distance.
    console.log("\n  radius  yR   cells   usable@pole   usable@equator   eq%");
    for (const r of [5, 8, 13, 20, 30, 45]) {
      const y = Math.max(2, Math.round(r * 0.4));
      const count = (tilt: number): { cells: number; usable: number } => {
        const focus = focusAt(tilt);
        const centre = {
          x: Math.floor(focus.x / BLOCK_WORLD),
          y: Math.floor(focus.y / BLOCK_WORLD),
          z: Math.floor(focus.z / BLOCK_WORLD),
        };
        const cells = sphereCells(centre, r, y);
        let usable = 0;
        for (const cell of cells)
          if (field.couldHoldSurface(boundsOf(cell))) usable++;
        return { cells: cells.length, usable };
      };
      const pole = count(0);
      const equator = count(Math.PI / 2);
      console.log(
        `  ${String(r).padStart(6)}${String(y).padStart(5)}` +
          `${String(equator.cells).padStart(8)}` +
          `${`${pole.usable}`.padStart(13)}` +
          `${`${equator.usable}`.padStart(16)}` +
          `${`${((equator.usable / equator.cells) * 100).toFixed(1)}%`.padStart(7)}`,
      );
    }
    console.log(
      `\n  a window of radius 13 spans ${(13 * 2 * BLOCK_WORLD) / 1000}km across, against a ` +
        `planet ${(2 * field.highestRadius) / 1000}km across\n`,
    );
  });

  it("measures what a shell-shaped window would hold instead", () => {
    // The candidate shape: the same ellipsoid, intersected with the band of cells that can
    // actually hold surface. Counted two ways, because the second is the one that matters.
    console.log("\n  tilt   solid   shell   freed   freed%");
    for (let deg = 0; deg <= 90; deg += 15) {
      const focus = focusAt((deg * Math.PI) / 180);
      const centre = {
        x: Math.floor(focus.x / BLOCK_WORLD),
        y: Math.floor(focus.y / BLOCK_WORLD),
        z: Math.floor(focus.z / BLOCK_WORLD),
      };
      const cells = sphereCells(centre, RADIUS, Y_RADIUS);
      const shell = cells.filter((cell) =>
        field.couldHoldSurface(boundsOf(cell)),
      );
      const freed = cells.length - shell.length;
      console.log(
        `  ${String(deg).padStart(3)}°${String(cells.length).padStart(8)}` +
          `${String(shell.length).padStart(8)}${String(freed).padStart(8)}` +
          `${`${((freed / cells.length) * 100).toFixed(1)}%`.padStart(8)}`,
      );
    }
    console.log("");
  });
});
