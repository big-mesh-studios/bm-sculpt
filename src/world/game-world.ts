/**
 * The field, answered as the four questions a player's physics asks.
 *
 * The player was written against a voxel world with `getSolidAt`/`getGroundHeightAt`
 * samplers. Here there is no grid: there is one signed distance function that the
 * mesher, the picker and this adapter all read, so the ground the player stands on
 * is the ground drawn on screen and the surface an edit digs into — ADR 0009's
 * invariant, extended from the pointer to the body.
 *
 * Two of the four are direct. `getSolidAt` is the sign. `getInWaterAt` is the sea
 * level above air. `getGroundHeightAt` is the only subtle one: because a distance is
 * a *directionless* quantity, "the surface to stand on" is found by walking away
 * from the material — up if the feet are inside it, down if they are over it — and
 * the caller clamps the answer to a step so a stride onto a ledge is told from a
 * wall.
 *
 * The field is read through a getter rather than held, because `SculptSession`
 * rebuilds it on every committed edit: a cached field would collide the player
 * against a model they have already changed.
 */

import { VOXEL_SIZE } from "../constants";
import type { PickField } from "../pick";
import type { PlayerWorld } from "../player/player";

/** The live field, as this adapter reads it. `Field` from the CSG satisfies it. */
export type GameField = PickField;

export interface GameWorldOptions {
  /** The field, read fresh, so an edit is collided against on the next frame. */
  readonly field: () => GameField;
  /** The terrain's own surface height, for spawn placement. */
  readonly heightAt?: (x: number, z: number) => number;
  /**
   * The world y water settles at, if the world has any. Below it and outside
   * solid, the player is swimming.
   */
  readonly seaLevel?: number;
  /**
   * Half the horizontal extent, in world units. Large by default: the field is a
   * function of position and is defined everywhere, so the world does not run out.
   */
  readonly halfExtent?: number;
}

/** How close a step counts as reaching the surface, in world units. */
const SURFACE_EPSILON = VOXEL_SIZE * 1e-3;

/**
 * How many steps a vertical surface search may take before giving up. Bounds the
 * cost of a search over genuinely empty space; a real terrain surface is found in
 * a handful, because the step size is the distance to it.
 */
const SURFACE_MAX_STEPS = 256;

export class GameWorld implements PlayerWorld {
  readonly halfExtent: number;
  private readonly field: () => GameField;
  private readonly heightAt: ((x: number, z: number) => number) | undefined;
  private readonly seaLevel: number | undefined;

  constructor(options: GameWorldOptions) {
    this.field = options.field;
    this.heightAt = options.heightAt;
    this.seaLevel = options.seaLevel;
    this.halfExtent = options.halfExtent ?? 1e9;
  }

  /**
   * The samplers are arrow properties rather than methods because the physics
   * takes them off the world and calls them detached — `boxHitsSolid` receives
   * `getSolidAt` as a bare function. A prototype method called that way has an
   * undefined `this`, and reading the field off it throws on the first frame.
   * A property that closes over `this` cannot be detached from itself.
   */

  /** Whether a point is inside material. Water is not material. */
  readonly getSolidAt = (x: number, y: number, z: number): boolean =>
    this.field().distance(x, y, z) < 0;

  /**
   * The surface to stand on at (`x`, `z`) nearest `y`.
   *
   * Walks to the material's boundary: upward when the sample is inside it, so a
   * step's top is reported and the player can climb rather than be buried; downward
   * when it is over it, so the first surface below is the ground. The step is the
   * field's own conservative distance, which cannot overshoot the boundary, and the
   * search is bounded so a column with no surface costs a fixed budget.
   */
  readonly getGroundHeightAt = (x: number, y: number, z: number): number => {
    const field = this.field();
    const inside = field.distance(x, y, z) < 0;
    const direction = inside ? 1 : -1;
    let yy = y;

    for (let step = 0; step < SURFACE_MAX_STEPS; step++) {
      const d =
        field.distanceForStepping !== undefined
          ? field.distanceForStepping(x, yy, z)
          : field.distance(x, yy, z);
      // A non-finite distance is a column with no surface in either direction.
      if (!Number.isFinite(d)) return -Infinity;
      // Inside the material on the way up, or at/through it on the way down.
      if (inside ? d >= -SURFACE_EPSILON : d <= SURFACE_EPSILON) return yy;
      yy += direction * Math.max(Math.abs(d), SURFACE_EPSILON);
    }
    return -Infinity;
  };

  /** The terrain surface height at a column, when the world has a height field. */
  readonly getHeightAt = (x: number, z: number): number => {
    if (this.heightAt !== undefined) return this.heightAt(x, z);
    // No analytic height, so read the surface off the field around the origin.
    return this.getGroundHeightAt(x, 0, z);
  };

  /**
   * Whether the point is underwater.
   *
   * v1 is a sea-level test: below the level and not inside solid. That means a dry
   * shaft dug below sea level reports as flooded, which is the simplification the
   * plane-water milestone records and a later water volume is what removes.
   */
  readonly getInWaterAt = (x: number, y: number, z: number): boolean => {
    if (this.seaLevel === undefined) return false;
    return y < this.seaLevel && !this.getSolidAt(x, y, z);
  };
}
