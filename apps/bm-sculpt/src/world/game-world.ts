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
 * surface outside air. `getGroundDistanceAt` is the only subtle one: because a distance is
 * a *directionless* quantity, "the surface to stand on" is found by walking away
 * from the material — up if the feet are inside it, down if they are over it — and
 * the caller clamps the answer to a step so a stride onto a ledge is told from a
 * wall.
 *
 * ## What changed when up became a function of position
 *
 * - **`getSolidAt` and `getInWaterAt` take a point**, not three numbers. Three scalars were a
 *   tuple with no name, and every one of them was reaching for `.y` to mean "up".
 * - **`getGroundDistanceAt` reports a distance along a supplied `up`**, replacing
 *   `getGroundHeightAt`'s height. "The column at `(x, z)`" is not a thing on a world whose
 *   ground is not level, and the trace has to follow the same ray the player is standing on or
 *   it finds a different surface than the one under their feet.
 * - **`seaLevel` became `seaRadius`.** One number, two meanings, named for the frame in use: an
 *   altitude for a flat world, a distance from the centre for a spherical one. Two fields would
 *   have been worse — there is never a world that has both.
 * - **`heightAt` is gone.** Spawn placement now asks the same question the physics asks, so a
 *   world whose surface has no closed form still spawns the player on it rather than at a
 *   height read from somewhere else.
 *
 * The field is read through a getter rather than held, because `SculptSession`
 * rebuilds it on every committed edit: a cached field would collide the player
 * against a model they have already changed.
 */

import type { Vec3 } from "@big-mesh-studios/core";
import { add, scale } from "@big-mesh-studios/core";
import { VOXEL_SIZE } from "../constants";
import type { PickField } from "@big-mesh-studios/picking";
import { flatFrame, type Frame } from "./up";
import type { Medium, PlayerWorld } from "../player/player";

/** The live field, as this adapter reads it. `Field` from the CSG satisfies it. */
export type GameField = PickField;

export interface GameWorldOptions {
  /** The field, read fresh, so an edit is collided against on the next frame. */
  readonly field: () => GameField;
  /**
   * Which way is up, and where the body's centre is.
   *
   * **Flat by default**, which is the world this application has today. Supplying
   * `sphericalFrame(centre)` is all it takes for the physics, the water and the world bound to
   * become a planet's, with no other change here.
   */
  readonly frame?: Frame;
  /**
   * Where water begins: an altitude for a flat frame, a distance from the centre for a
   * spherical one.
   *
   * **Used only when no `waterAt` is supplied**, and it is the older, looser rule: below the
   * level and outside whatever the *edited* model says is solid. See `waterAt` for why that
   * is not good enough for a world whose water is a meshed surface.
   */
  readonly seaRadius?: number;
  /**
   * Where water actually is, as a function of position.
   *
   * **Supplied by a caller whose water is meshed, and preferred over `seaRadius` because the
   * two rules disagree exactly where it matters.** `seaRadius` alone answers "below the level
   * and not inside the model", so a shaft dug down through a hill is reported as flooded:
   * the shaft is below sea level, the model says it is air, and the player swims down it in
   * slow motion with nothing around them but rock. The meshed sea is gated on the
   * *landscape* rather than the model — see `mesh/water-mesher.ts` — so the predicate has to
   * be the landscape's too, or the physics and the picture disagree.
   *
   * `undefined` means "use `seaRadius`", which is what an operations-only world with no water
   * wants: there is no sea there at all, and neither rule should claim otherwise.
   */
  readonly waterAt?: (p: Vec3) => boolean;
  /**
   * Half the extent, in world units. Large by default: the field is a
   * function of position and is defined everywhere, so the world does not run out.
   *
   * Applied as a sphere when the frame has a centre and a cube when it does not — see
   * `PlayerWorld.centre`.
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
  readonly mediumAt?: (p: Vec3) => Medium | undefined;
}

/** How close a step counts as reaching the surface, in world units. */
const SURFACE_EPSILON = VOXEL_SIZE * 1e-3;

/**
 * How many steps a surface search may take before giving up. Bounds the
 * cost of a search over genuinely empty space; a real terrain surface is found in
 * a handful, because the step size is the distance to it.
 */
const SURFACE_MAX_STEPS = 256;

export class GameWorld implements PlayerWorld {
  readonly frame: Frame;
  readonly centre: Vec3 | undefined;
  readonly halfExtent: number;
  private readonly field: () => GameField;
  private readonly seaRadius: number | undefined;
  private readonly waterAt: ((p: Vec3) => boolean) | undefined;

  constructor(options: GameWorldOptions) {
    this.field = options.field;
    this.frame = options.frame ?? flatFrame;
    this.centre = this.frame.centre;
    this.seaRadius = options.seaRadius;
    // `waterAt` is read once here rather than per query, so the predicate a caller supplied
    // is the predicate every frame runs — the same reason the samplers are arrow properties.
    this.waterAt = options.waterAt;
    this.halfExtent = options.halfExtent ?? 1e9;
    // **`undefined` stays `undefined`.** Assigning a reader that always answered "none" would make
    // every world's `getMediumAt` defined, and the physics would pay an optional call and a null
    // check on every frame of every world in exchange for telling it nothing.
    this.getMediumAt =
      options.mediumAt === undefined
        ? undefined
        : (p) => options.mediumAt!(p) ?? null;
  }

  /**
   * The samplers are arrow properties rather than methods because the physics
   * takes them off the world and calls them detached — `boxHitsSolid` receives
   * `getSolidAt` as a bare function. A prototype method called that way has an
   * undefined `this`, and reading the field off it throws on the first frame.
   * A property that closes over `this` cannot be detached from itself.
   */

  /** Whether a point is inside material. Water is not material. */
  readonly getSolidAt = (p: Vec3): boolean =>
    this.field().distance(p.x, p.y, p.z) < 0;

  /**
   * The field standing at a point, or null where none does — **absent entirely when the world was
   * given no reader.**
   *
   * Assigned in the constructor rather than as a property initializer because it depends on
   * `options`. It is an own property rather than a method that always returned null, so the
   * physics's optional chaining (`world.getMediumAt?.(...)`) reads honestly: absent means this
   * world has no fields at all, which is not the same claim as "none here".
   */
  readonly getMediumAt: ((p: Vec3) => Medium | null) | undefined;

  /**
   * The surface to stand on below `feet`, as a distance along `up`.
   *
   * Walks to the material's boundary: outward when the sample is inside it, so a step's top is
   * reported and the player can climb rather than be buried; inward when it is over it, so the
   * first surface below is the ground. The search is bounded so a ray with no surface costs a
   * fixed budget.
   *
   * **The ray is `feet + up·t`, not "down".** On a flat world the two are the same line; on a
   * sphere they are not, and tracing along the wrong one finds a surface somewhere else entirely
   * — a player at a pole would be standing on whatever happens to be below the origin.
   *
   * **The raw distance, not the stepping one.** `distanceForStepping` is scaled
   * down by the field's Lipschitz bound so a *ray* cannot step through a slope it
   * crosses obliquely. A march along the local up does not need that, and the scaling is
   * actively wrong here: it makes the search stop at a fraction of a unit *below*
   * the surface on a climb, which the player's collision then reads as a corner
   * still buried in the ground, so a walk up any slope is refused as a step into a
   * wall. On a height field the raw distance is the exact vertical distance, so
   * the surface is reached in one step and returned on it; on operations it is the
   * Euclidean distance, which is a lower bound and cannot overshoot.
   */
  readonly getGroundDistanceAt = (feet: Vec3, up: Vec3): number => {
    const field = this.field();
    const inside = field.distance(feet.x, feet.y, feet.z) < 0;
    const sign = inside ? 1 : -1;
    let travelled = 0;
    let p = feet;

    for (let step = 0; step < SURFACE_MAX_STEPS; step++) {
      const d = field.distance(p.x, p.y, p.z);
      // A non-finite distance is a ray with no surface in either direction.
      if (!Number.isFinite(d)) return -Infinity;
      // Outside the material on the way out, or at/through it on the way in.
      if (inside ? d >= 0 : d <= 0) return travelled;
      const advance = sign * Math.max(Math.abs(d), SURFACE_EPSILON);
      travelled += advance;
      p = add(feet, scale(up, travelled));
    }
    return -Infinity;
  };

  /**
   * Whether the point is underwater — as the water is actually drawn.
   *
   * **A supplied predicate is the whole answer when there is one**, and it has to be: a
   * player who is swimming in a shaft the sea is not in is a bug in one of the two, and it
   * is cheaper to give the physics the meshed rule than to try and reconcile them.
   *
   * Without one, this is the sea-level rule the plane water used: below the level and not
   * inside the model. That is right for a world with no meshed sea and wrong for one with,
   * which is why a caller with a sea supplies `waterAt` rather than leaving this to guess.
   */
  readonly getInWaterAt = (p: Vec3): boolean => {
    if (this.waterAt !== undefined) return this.waterAt(p);
    if (this.seaRadius === undefined) return false;
    const below = this.frame.spherical
      ? this.frame.radiusAt(p) < this.seaRadius
      : p.y < this.seaRadius;
    return below && !this.getSolidAt(p);
  };
}
