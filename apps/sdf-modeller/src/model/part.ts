/**
 * The model: a flat list of placed primitives.
 *
 * ## Why a flat list, and what that gives up
 *
 * **One list of parts, unioned.** Every part is one placed primitive, and the model is
 * the union of all of them. That is the whole of it, and it is the smallest thing that
 * renders: no hierarchy to resolve, no pivot arithmetic, no rest pose.
 *
 * What it gives up is worth writing down, because these are the features a figure modeller
 * is assumed to have and this one does not:
 *
 * - **No hierarchy.** A part cannot be a child of another part, so moving a shoulder does
 *   not move the arm hanging off it.
 * - **No pivots.** A part's transform is its own; there is no offset from a parent's
 *   origin.
 * - **No motions.** Nothing is keyed over time, because there is no timeline.
 * - **No extrusion or revolution.** The primitives are the nine closed forms in
 *   `@big-mesh-studios/sdf` and nothing derives a tenth (ADR 0025).
 *
 * Each of those is a real piece of work rather than a setting, which is why they are
 * absent rather than disabled.
 *
 * ## Why the transform is a position and an orientation, and not a matrix
 *
 * **Because `Operation` already is exactly that, and because it is already persisted.**
 * `origin: Vec3` and `orientation: Quat` are the transform of every CSG operation in this
 * repository, `operationDistance` evaluates the shape in the primitive's own frame by
 * rotating the sample by the cached conjugate, and the file format writes both. Using
 * anything else here would mean a second transform representation and a conversion at the
 * seam — and the second one would be where a part's rotation quietly stopped being a
 * rotation.
 *
 * **Every axial primitive runs along Y** (ADR 0025), so `orientation` is what turns a
 * capsule from a limb into a pipe. It is not decorative, and the modeller exposes it.
 *
 * ## Why parts are not operations
 *
 * **A part is a thing a person put in the model; an operation is a thing the CSG folds.**
 * Each part becomes one operation, but they are kept apart because the two will not stay
 * coincided. The file format (a later phase) has to record a part's name, its primitive,
 * its transform and its boolean; `Operation` has an `index` that means a position in a
 * fold, and no name at all. Merging them now would make that migration a rewrite.
 */
import type { Quat, Rgb8, Vec3 } from "@big-mesh-studios/core";
import type { Combine } from "@big-mesh-studios/csg";
import {
  primitiveHalfExtents,
  type OperationShape,
} from "@big-mesh-studios/sdf";

/** A primitive placed in the model. */
export interface Part {
  /**
   * A caller-chosen id, unique within the model and never reused.
   *
   * **Never reused, even after the part is deleted.** An id that comes back round means a
   * selection, an undo entry or a save file that refers to two different things at two
   * different times, and the difference between them is not something a name can carry.
   */
  readonly id: string;
  readonly shape: OperationShape;
  /** The primitive's own origin, in world units. */
  readonly origin: Vec3;
  /** Which way the primitive's own axes point. Identity is unrotated. */
  readonly orientation: Quat;
  /**
   * How this part joins the ones before it: `Add` unions, `Subtract` removes.
   *
   * **Required rather than defaulting to `Add`, because it is no longer decorative.**
   * A union-only list folds the same however it is ordered, so a part's position in the
   * list was bookkeeping. A list containing a subtraction does not: `A` then `B` then a
   * difference of `C` is a different solid from the same three parts in another order, so
   * the order is now part of what the model *is*. Making every construction site state it
   * is the cheapest way to keep that visible.
   *
   * `Paint` is deliberately absent. A `Paint` operation adds no material — it only
   * colours — and since an operation's colour began counting whatever the operation does
   * to the geometry (ADR 0028), a coloured `Add` already expresses it. Offering `Paint`
   * here would be a third option that does strictly less than `Add`.
   */
  readonly combine: Exclude<Combine, "Paint">;
  /**
   * How far the boolean blends, in world units. Zero is a hard edge.
   *
   * **Above zero it is a soft union or a soft difference**, chosen by `combine` — the
   * same two cases `Operation` folds, and the same formula the landscape has always used:
   * a polynomial smooth minimum, `min(a,b) - max(k - |a-b|, 0)² / 4k`, with `k` four
   * times this number.
   *
   * Bounded by `MAX_SOFTNESS`, and the bound is not a style choice: the candidate cache
   * is sized for a blend of that width, so a larger one would make the cache too small
   * and a sample could miss an operation that reaches the point after all.
   */
  readonly softness: number;
  /**
   * The colour this part is painted, or `undefined` for a part that takes the default.
   *
   * **`undefined` rather than a default colour, because a part with no colour is a
   * different statement from a part painted the default.** An operation's colour is what
   * decides the colour of the surface there whatever the operation does to the geometry, so
   * "no colour" means the surface falls through to whatever is underneath — which is what
   * makes a difference read as a cut rather than as a differently-coloured solid.
   */
  readonly colour?: Rgb8;
  /** How opaque this part is, `0..1`. Only read where `colour` is set. */
  readonly opacity?: number;
}

/** The identity rotation, named because it is asked for constantly. */
export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * A rotation of `radians` about one axis.
 *
 * **Half the angle, because a quaternion stores half.** Quaternions double-cover the
 * rotation group: `q` and `-q` are the same rotation, and the half-angle form is the one
 * with no `cos(θ/2)` argument in sight. Writing `radians / 2` here is the only place in
 * this application where the two conventions meet, so it is the only place that has to
 * remember which is which.
 */
export const axisAngle = (
  x: number,
  y: number,
  z: number,
  radians: number,
): Quat => {
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length === 0) return IDENTITY;
  const half = radians / 2;
  const s = Math.sin(half) / length;
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(half) };
};

/** Euler angles in radians, as Y-then-X-then-Z, which is what a transform gizmo shows. */
export const fromEuler = (yaw: number, pitch: number, roll: number): Quat => {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  // Y * X * Z, expanded. Written out rather than multiplied because the general form is
  // four more temporaries and this is evaluated on every frame of a drag.
  return {
    x: sp * cy * cr + cp * sy * sr,
    y: cp * sy * cr - sp * cy * sr,
    z: cp * cy * sr - sp * sy * cr,
    w: cp * cy * cr + sp * sy * sr,
  };
};

/**
 * A quaternion as the three Euler angles a gizmo shows, in degrees.
 *
 * **Read out of the quaternion rather than kept alongside it.** The alternative — storing
 * Euler angles and building a quaternion from them — is what a transform panel usually
 * does, and it has the property that the two representations disagree after any sequence
 * of rotations that does not commute, so the number in the panel stops being the number in
 * the model. Here the model holds the quaternion and the panel asks it what it is.
 */
export const toEuler = (
  q: Quat,
): { yaw: number; pitch: number; roll: number } => {
  // Clamped, because `asin` of a value a hair outside [-1, 1] is NaN, and a NaN reaching
  // a slider's `value` blanks the input it is bound to.
  const sinPitch = 2 * (q.w * q.x - q.y * q.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, sinPitch)));
  const yaw = Math.atan2(
    2 * (q.w * q.y + q.x * q.z),
    1 - 2 * (q.x * q.x + q.y * q.y),
  );
  const roll = Math.atan2(
    2 * (q.w * q.z + q.x * q.y),
    1 - 2 * (q.x * q.x + q.z * q.z),
  );
  const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
  return {
    yaw: toDegrees(yaw),
    pitch: toDegrees(pitch),
    roll: toDegrees(roll),
  };
};

/**
 * The world-space half-diagonal of a part: the largest distance from its origin to any
 * point of the primitive, whatever its rotation.
 *
 * **A half-diagonal rather than a box, and not for laziness.** It is the smallest
 * axis-aligned bound on a rotated shape that can be computed without rotating anything,
 * and it is what an AABB that is only ever a rejection test wants. Anything tighter needs
 * the eight corners rotated and re-bounded, which is what `operationBounds` does — for the
 * BVH, where the box is stored and the tightness is worth having. Here it is recomputed
 * from the primitive table on demand, and the looseness costs one comparison.
 */
export const partHalfDiagonal = (part: Part): number => {
  const half = primitiveHalfExtents(part.shape);
  return Math.hypot(half.x, half.y, half.z);
};

/** The axis-aligned bounds of a part, padded outward by `padding`. */
export const partBounds = (
  part: Part,
  padding = 0,
): { min: Vec3; max: Vec3 } => {
  const reach = partHalfDiagonal(part) + padding;
  return {
    min: {
      x: part.origin.x - reach,
      y: part.origin.y - reach,
      z: part.origin.z - reach,
    },
    max: {
      x: part.origin.x + reach,
      y: part.origin.y + reach,
      z: part.origin.z + reach,
    },
  };
};

/**
 * The bounds of a whole model, or `undefined` when it has no parts.
 *
 * **`undefined` rather than an empty box at the origin**, because a model with no parts has
 * no bounds and a box at the origin is a claim that something is there. A caller meshing
 * the result would otherwise sample a cube in empty space and call the result air.
 */
export const modelBounds = (
  parts: readonly Part[],
  padding = 0,
): { min: Vec3; max: Vec3 } | undefined => {
  if (parts.length === 0) return undefined;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const part of parts) {
    const bounds = partBounds(part, padding);
    min.x = Math.min(min.x, bounds.min.x);
    min.y = Math.min(min.y, bounds.min.y);
    min.z = Math.min(min.z, bounds.min.z);
    max.x = Math.max(max.x, bounds.max.x);
    max.y = Math.max(max.y, bounds.max.y);
    max.z = Math.max(max.z, bounds.max.z);
  }
  return { min, max };
};

/**
 * A part's own extent in world units, for a panel or a handle.
 *
 * **The primitive's half-extents turned into a full size**, which is what a control reads
 * better than a half-extent. Exported through here so that the table lookup happens in
 * one place: a panel that asked `PRIMITIVES` itself would be a second place to update when
 * a primitive is added, which is what ADR 0025 exists to stop.
 */
export const partSize = (shape: OperationShape): Vec3 => {
  const half = primitiveHalfExtents(shape);
  return { x: half.x * 2, y: half.y * 2, z: half.z * 2 };
};

/**
 * A part that unions, with a hard edge and no rotation.
 *
 * **The defaults live here rather than on the type**, so that a caller who means "just
 * add this" says it in one word, and a caller who means anything else has to name it —
 * while a bare object literal still has to state `combine` and `softness` outright.
 */
export const placedPart = (
  id: string,
  shape: OperationShape,
  origin: Vec3,
  overrides: {
    readonly orientation?: Quat;
    readonly combine?: Exclude<Combine, "Paint">;
    readonly softness?: number;
    readonly colour?: Rgb8;
    readonly opacity?: number;
  } = {},
): Part => ({
  id,
  shape,
  origin,
  orientation: overrides.orientation ?? IDENTITY,
  combine: overrides.combine ?? "Add",
  softness: overrides.softness ?? 0,
  colour: overrides.colour,
  opacity: overrides.opacity,
});
