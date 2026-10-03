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
import type { Medium, PlayerWorld } from "../player/player";

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
  /**
   * The scripted field at a point, for `PlayerWorld.getMediumAt`.
   *
   * **Optional, and read once at construction rather than held as a live reference**, because
   * the host that owns the fields is built after this world is: `app.tsx` creates the session,
   * the session creates the world, and the place host comes later still. So the world is handed a
   * *reader* rather than the collection — a function that reaches into the host on every call, and
   * answers "none" until one exists.
   *
   * `undefined` rather than a function that always says "none", because the two are different
   * claims: the first is "this world has no fields", the second is "this world has fields and
   * there are none here". The physics reads both as null today and would not tomorrow.
   */
  readonly mediumAt?: (x: number, y: number, z: number) => Medium | undefined;
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
    // **`undefined` stays `undefined`.** Assigning a reader that always answered "none" would make
    // every world's `getMediumAt` defined, and the physics would pay an optional call and a null
    // check on every frame of every world in exchange for telling it nothing.
    this.getMediumAt =
      options.mediumAt === undefined
        ? undefined
        : (x, y, z) => options.mediumAt!(x, y, z) ?? null;
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
   * The field standing at a point, or null where none does — **absent entirely when the world was
   * given no reader.**
   *
   * Assigned in the constructor rather than as a property initializer because it depends on
   * `options`. It is an own property rather than a method that always returned null, so the
   * physics's optional chaining (`world.getMediumAt?.(...)`) reads honestly: absent means this
   * world has no fields at all, which is not the same claim as "none here".
   */
  readonly getMediumAt:
    ((x: number, y: number, z: number) => Medium | null) | undefined;

  /**
   * The surface to stand on at (`x`, `z`) nearest `y`.
   *
   * Walks to the material's boundary: upward when the sample is inside it, so a
   * step's top is reported and the player can climb rather than be buried; downward
   * when it is over it, so the first surface below is the ground. The search is
   * bounded so a column with no surface costs a fixed budget.
   *
   * **The raw distance, not the stepping one.** `distanceForStepping` is scaled
   * down by the field's Lipschitz bound so a *ray* cannot step through a slope it
   * crosses obliquely. A vertical march does not need that, and the scaling is
   * actively wrong here: it makes the search stop at a fraction of a unit *below*
   * the surface on a climb, which the player's collision then reads as a corner
   * still buried in the ground, so a walk up any slope is refused as a step into a
   * wall. On a height field the raw distance is the exact vertical distance, so
   * the surface is reached in one step and returned on it; on operations it is the
   * Euclidean distance, which is a lower bound and cannot overshoot.
   */
  readonly getGroundHeightAt = (x: number, y: number, z: number): number => {
    const field = this.field();
    const inside = field.distance(x, y, z) < 0;
    const direction = inside ? 1 : -1;
    let yy = y;

    for (let step = 0; step < SURFACE_MAX_STEPS; step++) {
      const d = field.distance(x, yy, z);
      // A non-finite distance is a column with no surface in either direction.
      if (!Number.isFinite(d)) return -Infinity;
      // Inside the material on the way up, or at/through it on the way down.
      if (inside ? d >= 0 : d <= 0) return yy;
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
