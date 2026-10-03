/**
 * An operation: one primitive, one boolean, one place on the model.
 *
 * This is the whole of the application's state. There is no voxel grid, no
 * baked field and no mesh that is not derived (ADR 0002), so an operation list is
 * what a file saves, what undo manipulates, and what a worker evaluates.
 *
 * An operation contributes to the field in one of two ways. `Add` and `Subtract`
 * change the distance, by the smooth or the hard version of the boolean. `Paint`
 * changes nothing about the distance and only says what colour the surface near it
 * should be — so a painted region only shows where there is a surface to paint,
 * and painting into empty space stores a colour that becomes visible if material
 * is added there later.
 *
 * Everything about an operation is plain numbers. That is not incidental: the list
 * is cloned into every meshing worker whenever it changes, and a class instance
 * would have to be revived there by hand.
 */

import {
  FAR_DISTANCE,
  type Bounds,
  type Quat,
  type Rgb8,
  MAX_SOFTNESS,
  SOFTNESS_REACH,
  type Vec3,
} from "@big-mesh-studios/core";
import {
  primitiveHalfExtents,
  sdShape,
  shapePadding,
  type OperationShape,
} from "@big-mesh-studios/sdf";

/** How an operation combines with the field the others have made. */
export type Combine = "Add" | "Subtract" | "Paint";

/**
 * A surface's colour, as an operation pair states it: a byte triple and an opacity.
 *
 * **Opacity is a float between 0 and 1 and the colour is bytes**, because that is
 * what an `Operation` holds and what the file format writes. The pair is only
 * combined here so that nothing has to remember to carry the two together — a
 * function returning an `Rgb8` had to be asked a second time for the opacity, which
 * meant walking the operation list twice per vertex.
 */
export interface SurfaceColour {
  readonly colour: Rgb8;
  /** 0 to 1, where 1 is opaque. */
  readonly opacity: number;
}

/** The combine modes, as the numbers the file format writes. */
export const COMBINE = {
  Add: 0,
  Subtract: 1,
  Paint: 2,
} as const;

export interface Operation {
  /**
   * Position in the list, and the order colour is resolved in: a later paint
   * wins over an earlier one at the same point. Monotonically increasing and
   * never reused, so removing an operation does not reorder the ones after it.
   */
  index: number;
  origin: Vec3;
  orientation: Quat;
  shape: OperationShape;
  /**
   * How far the boolean blends. Zero is a hard edge — which is what a hard brush
   * wants, and what makes a hard stroke a single operation rather than one per
   * dab (ADR 0002).
   */
  softness: number;
  combine: Combine;
  /** The colour a `Paint` operation applies. Meaningless otherwise. */
  colour?: { r: number; g: number; b: number };
  /**
   * A paint operation's strength, 0 to 1. Carried in the file format because a
   * future soft blend needs it, but not read by the field: a paint either applies
   * or does not, and a partially transparent paint over an unknown underlying
   * colour would need an answer this design does not have.
   */
  opacity: number;
}

/** An operation and the things derived from it once, when it is added. */
export interface IndexedOperation {
  operation: Operation;
  /**
   * The world-space box inside which this operation can change the field,
   * including the reach of its own softness. Everything that skips an operation
   * early uses this.
   */
  bounds: Bounds;
  /**
   * The conjugate of the operation's rotation, so a world point is transformed
   * into the shape's frame by a rotation rather than by an inverse solve. Computed
   * once on add because it is needed once per sample.
   */
  inverseRotation: Quat;
}

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Derives the index entries for one operation. */
export const indexOperation = (operation: Operation): IndexedOperation => ({
  operation,
  bounds: operationBounds(operation),
  inverseRotation: conjugate(operation.orientation),
});

/**
 * The world-space box inside which an operation can change the field.
 *
 * The shape is put at its origin, its three extents are taken in its own rotated
 * frame, and the corners of that box are rotated into world space. Taking eight
 * corners and their bounding box is not the tightest box obtainable, but it is the
 * tightest one obtainable without solving a rotated-box minimum, and it is only
 * ever used to reject candidates.
 */
export const operationBounds = (operation: Operation): Bounds => {
  const half = shapeHalfExtents(operation.shape);
  const pad = shapePadding(operation.shape, operation.softness);
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (let corner = 0; corner < 8; corner++) {
    const local: Vec3 = {
      x: (corner & 1 ? 1 : -1) * half.x,
      y: (corner & 2 ? 1 : -1) * half.y,
      z: (corner & 4 ? 1 : -1) * half.z,
    };
    const world = rotate(local, operation.orientation);
    min.x = Math.min(min.x, world.x + operation.origin.x - pad);
    min.y = Math.min(min.y, world.y + operation.origin.y - pad);
    min.z = Math.min(min.z, world.z + operation.origin.z - pad);
    max.x = Math.max(max.x, world.x + operation.origin.x + pad);
    max.y = Math.max(max.y, world.y + operation.origin.y + pad);
    max.z = Math.max(max.z, world.z + operation.origin.z + pad);
  }

  return { min, max };
};

/**
 * The half-extents of a shape along its own axes.
 *
 * **This is the primitive's own job and it lives with the primitive.** It was a
 * switch here over three shapes, which meant the second list of primitive facts in a
 * file that has nothing else to do with geometry — the first being `sdShape` itself.
 * The capsule's entry is the interesting one it absorbed: its extent is its length
 * plus a radius at each end along its axis, and the radius alone across it.
 */
export const shapeHalfExtents = primitiveHalfExtents;

/** Rotates a vector by a unit quaternion. */
export const rotate = (v: Vec3, q: Quat): Vec3 => {
  // The two-cross-product form, `v + 2w(q × v) + 2q × (q × v)`, which is the
  // same arithmetic as the matrix form with one fewer normalisation.
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

/** The conjugate of a unit quaternion, which inverts its rotation. */
export const conjugate = (q: Quat): Quat => ({
  x: -q.x,
  y: -q.y,
  z: -q.z,
  w: q.w,
});

/**
 * A point in a shape's own frame, reused by `operationDistance`.
 *
 * **Module-level and mutable, which is the point.** The fold evaluates one
 * operation's distance at a time and keeps only the resulting number, so a single
 * scratch point serves every evaluation in a chunk. The alternative — returning a
 * fresh `{x, y, z}` per call — cost two heap objects per candidate per sample: at a
 * hundred candidates over a chunk's fifty thousand field evaluations that is ten
 * million short-lived objects, and measuring the same arithmetic writing into a
 * reused point rather than a fresh one measured **3.2× faster** over a whole fold.
 *
 * Safe because the callers cannot interleave: `foldOperations` and `evalPaint` both
 * call `operationDistance` as a leaf and use only its return value, so there is no
 * window in which two evaluations are live at once and no way to observe the scratch.
 * Each meshing worker has its own module instance, so the workers do not share it
 * either. A worker that did interleave would get an answer rather than an exception,
 * which is why this is stated rather than assumed — the guard against it is that
 * nothing calls `operationDistance` from inside another `operationDistance`.
 */
const local: Vec3 = { x: 0, y: 0, z: 0 };

/** An operation's signed distance to a world point. */
export const operationDistance = (
  indexed: IndexedOperation,
  p: Vec3,
): number => {
  const origin = indexed.operation.origin;
  const q = indexed.inverseRotation;
  const vx = p.x - origin.x;
  const vy = p.y - origin.y;
  const vz = p.z - origin.z;
  // The two-cross-product form of `rotate`, inlined and writing to the scratch
  // point. Same arithmetic in the same order as `rotate` above — the two are the
  // same function, and `rotate` is the readable statement of it that the fold does
  // not call. Inlining is what removes the intermediate vector; keeping one copy of
  // the arithmetic rather than two is what keeps them from drifting apart.
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);
  local.x = vx + q.w * tx + (q.y * tz - q.z * ty);
  local.y = vy + q.w * ty + (q.z * tx - q.x * tz);
  local.z = vz + q.w * tz + (q.x * ty - q.y * tx);
  return sdShape(indexed.operation.shape, local);
};

/**
 * The quadratic smooth minimum, over a band of width `k`.
 *
 * `min(a, b)` with a quadratic dent taken out of it where the two are within `k`
 * of each other. The hard case is `k === 0`, which has no dent and is exactly
 * `min(a, b)` — the branches are written so that the smooth case reduces to the
 * hard one rather than the other way round, because the hard case is the common
 * one and the difference has to be exact there.
 */
export const smoothMin = (a: number, b: number, k: number): number => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.min(a, b) - (h * h) / (4 * k);
};

/**
 * The smooth maximum, as the negation of a smooth minimum.
 *
 * `max(a, b) = -min(-a, -b)`, so a smooth maximum is a smooth minimum of the
 * negated pair — which is why this is written in terms of `smoothMin` rather than
 * derived a second time. Getting the two out of step is the classic way a
 * subtract operation ends up soft in one direction and hard in the other.
 */
export const smoothMax = (a: number, b: number, k: number): number =>
  -smoothMin(-a, -b, k);

/**
 * Folds one operation's distance into the field so far.
 *
 * `Subtract` subtracts the operation's *negated* distance, so that `max(a, -b)`
 * removes material where `b` is negative and leaves it where `b` is positive —
 * which is why the smoothness is applied to `-b` rather than to `b`.
 *
 * `Paint` is a no-op on the distance, and says so by returning the distance it was
 * given untouched.
 */
export const applyOperation = (
  field: number,
  distance: number,
  op: Operation,
): number => {
  switch (op.combine) {
    case "Add":
      return smoothMin(field, distance, op.softness * 4);
    case "Subtract":
      return smoothMax(field, -distance, op.softness * 4);
    case "Paint":
      return field;
  }
};

/**
 * The distance from a point to a box: zero inside it, and the euclidean distance
 * to its nearest face or edge outside it.
 *
 * This is what replaces a point-in-box test when deciding whether an operation can
 * still change the field. A point-in-box test is not merely conservative, it is
 * *wrong* — see `foldOperations` — and it is wrong in a way a mesh hides: an
 * operation whose point is outside its box but whose surface is still the nearest
 * thing to that point is silently dropped, and the field reads as though nothing
 * were there.
 *
 * Six comparisons and three hypots, against a full shape evaluation per candidate.
 * It is the cheapest test available and it happens to be the correct one.
 */
export const boundsDistance = (bounds: Bounds, p: Vec3): number =>
  Math.sqrt(boundsDistanceSquared(bounds, p));

/**
 * The square of the distance from a point to a box: zero inside, and otherwise the
 * sum of the squares of the overshoot on each axis.
 *
 * **Squared, because the fold's question is answerable squared.** It asks "is this
 * candidate further away than the threshold", and `d² >= threshold²` answers that
 * without a square root. Both sides must be non-negative for squaring to preserve
 * the ordering, which is why the threshold is clamped at zero before use.
 *
 * This was measured, not assumed, and it made no difference: replacing `Math.hypot`
 * here and in the shape functions left the cost of sampling a chunk unchanged on the
 * machine the measurement ran on. What the cost actually is, is the *number* of
 * candidates tested — so that is the thing to reduce, and this is kept because it is
 * no worse and needs no square root.
 *
 * **The overshoot is selected with comparisons rather than with `Math.max`.** This is
 * the fold's innermost test — it runs once per candidate per sample, so about ten
 * million times for one chunk of a busy model, and a variadic `Math.max` is not
 * something V8 inlines. Writing the same three-way clamp as a nested conditional
 * measured **1.4× faster** over a whole fold, and returns bit-identical values: both
 * forms yield `min - p` below the box, `p - max` above it, and zero between.
 *
 * The one input the two forms disagree on is a NaN coordinate. `Math.max(NaN, 0, x)`
 * propagates the NaN, so the caller fails to skip and evaluates the shape; the
 * conditional compares false against everything and reads the point as *inside* every
 * box, which is the opposite answer. Neither is worth a branch in the innermost loop
 * of the project: a NaN coordinate is already a bug upstream, and the mesher treats a
 * NaN sample as outside (see `surfaceNets`), so a hole in the surface is what a NaN
 * produces either way.
 */
export const boundsDistanceSquared = (bounds: Bounds, p: Vec3): number => {
  const min = bounds.min;
  const max = bounds.max;
  const dx = p.x < min.x ? min.x - p.x : p.x > max.x ? p.x - max.x : 0;
  const dy = p.y < min.y ? min.y - p.y : p.y > max.y ? p.y - max.y : 0;
  const dz = p.z < min.z ? min.z - p.z : p.z > max.z ? p.z - max.z : 0;
  return dx * dx + dy * dy + dz * dz;
};

/** Whether a point is inside an operation's box. */
export const boundsContain = (bounds: Bounds, p: Vec3): boolean =>
  p.x >= bounds.min.x &&
  p.x <= bounds.max.x &&
  p.y >= bounds.min.y &&
  p.y <= bounds.max.y &&
  p.z >= bounds.min.z &&
  p.z <= bounds.max.z;

/**
 * Folds a set of candidate operations into a field, starting from `initial`.
 *
 * Both callers go through it — the BVH's own `evalSDF`, and the field's `distance`,
 * which starts from a base field rather than from emptiness. Having one
 * implementation is what makes a query with no base field and a query with one
 * provably agree, and having two is how the base-field path ends up subtly
 * different from the empty one.
 *
 * **The candidates must arrive in list order.** The smooth booleans are symmetric
 * but not associative — `smin(smin(a,b),c)` differs from `smin(a,smin(b,c))` — so
 * the fold's order is part of what the field *is*, not an implementation detail.
 * `OperationBVH.candidatesAt` sorts before handing them over.
 *
 * **An operation is skipped only when it provably cannot change the result**, and
 * the test for that is a distance rather than a box. This is the one piece of
 * arithmetic in the field that has to be exactly right, because the two tempting
 * shortcuts are both wrong in ways a mesh hides:
 *
 * - *Skipping any operation whose box does not contain the point* is wrong
 *   because a minimum is won by the **nearest surface**, not the nearest box. A
 *   point just outside a box's corner can be a unit from that box's surface, and
 *   dropping it makes the field read as empty space where there is material. This
 *   is not a rounding concern: it showed up as a distance error of nearly two
 *   units on the first randomised comparison against a brute-force fold.
 * - *Skipping any operation that cannot win a `min`* is wrong for the same reason
 *   one level up, because the fold is a *sequence* and a distant operation can be
 *   the one that sets the field every later operation then fails to beat.
 *
 * So the threshold is derived from what the boolean actually needs. An `Add` can
 * change the result whenever its distance is below `field + k` — `k` because the
 * smooth blend reaches above the nearer of the two by up to `k`. A `Subtract`
 * changes it whenever the distance is below `k - field`, by the same argument with
 * the sign flipped. And since a shape is contained in its own box, its distance is
 * never below the distance to that box, so comparing *that* against the threshold
 * is sufficient.
 */
export const foldOperations = (
  candidates: readonly IndexedOperation[],
  p: Vec3,
  initial: number,
): number => {
  // The incoming value is saturated too, not only what the loop produces. A base
  // field reporting a million units of "nothing here" means exactly what
  // `FAR_DISTANCE` means, and a point with no candidates at all would otherwise
  // return it unsaturated — which is both a different answer for the same question
  // depending on where the operations happen to be, and an infinite value handed to
  // a picker that would then step by infinity.
  let field = Math.min(initial, FAR_DISTANCE);
  for (const candidate of candidates) {
    const k = candidate.operation.softness * 4;
    // `field + k` for an add: the value its distance has to beat. `k - field` for a
    // subtract: the value its distance has to fall below for the negated distance
    // to win the maximum.
    const threshold =
      candidate.operation.combine === "Subtract" ? k - field : field + k;

    // **Outside the box only, and the qualification is the whole test.** A shape is
    // contained in its own box, so a point outside it is at least `d` from the
    // shape — which is what makes `d >= threshold` a proof that the operation
    // cannot change the result.
    //
    // Inside the box that proof evaporates: `d` is zero there by definition, while
    // the shape's real distance can be deeply negative, and zero is greater than
    // almost every threshold a deeply-inside field produces. Skipping on `d` alone
    // therefore drops precisely the operations that matter most — a brush inside a
    // solid — and the first randomised comparison against a brute-force fold caught
    // it as a field reading −24 where it should have read −110. Inside the box the
    // shape is always evaluated, which is also the only place it needs to be: being
    // inside means being within reach of the surface.
    // Compared squared, and the threshold floored at zero first so that squaring
    // preserves the ordering: `max(0, x)` squared is `x` squared's square root, so
    // the comparison below is equivalent to `d > 0 && d >= threshold` without ever
    // taking a square root.
    const reach = threshold > 0 ? threshold : 0;
    if (
      boundsDistanceSquared(candidate.bounds, p) >= reach * reach &&
      reach > 0
    ) {
      continue;
    }

    // Clamped after every step, and the clamp is what makes the candidate cache
    // provably complete rather than merely usually sufficient.
    //
    // A subtraction is a maximum, and a maximum raises the field: subtracting a
    // shape whose distance is deeply negative leaves the field reading hundreds of
    // units of "outside". So the field does not only fall as operations are folded
    // in, it can climb — and while it is high, an addition a long way off can still
    // win the next minimum. Bounding the cache by the model instead, as this
    // originally did, makes the cache grow with the largest primitive, and a model
    // with one thousand-unit primitive then caches the entire model and prunes
    // nothing.
    //
    // Clamping says what `FAR_DISTANCE` already means: a value that large is the
    // "nothing is near here" sentinel, not a measurement. Nothing downstream can
    // tell the difference — the sign is positive either way so the mesher finds no
    // crossing; a picker steps by a smaller amount, which is conservative and
    // converges; a gradient is only read near zero, where nothing is clamped. With
    // the field bounded, `threshold` is bounded, and a fixed margin is provably
    // enough.
    field = Math.min(
      applyOperation(
        field,
        operationDistance(candidate, p),
        candidate.operation,
      ),
      FAR_DISTANCE,
    );
  }
  return field;
};

/**
 * How far outside a candidate set the field is still exact.
 *
 * The field is clamped to `FAR_DISTANCE` at every step of the fold, so no
 * threshold the fold compares against can exceed `FAR_DISTANCE + k`. An operation
 * whose box is further than that from the query point is therefore provably not one
 * that could set the answer, and the candidate set may stop looking before it gets
 * there. This is the margin the candidate cache adds to its box, and it is what
 * makes the cache a shortcut rather than an approximation.
 */
export const CANDIDATE_MARGIN = FAR_DISTANCE + MAX_SOFTNESS * SOFTNESS_REACH;

/** A blank field: everything outside, by enough to be outside of anything. */
export const emptyField = (): number => FAR_DISTANCE;

/** A fresh operation with the identity rotation and no paint. */
export const makeOperation = (
  index: number,
  origin: Vec3,
  shape: OperationShape,
  combine: Combine,
  options: {
    softness?: number;
    orientation?: Quat;
    colour?: { r: number; g: number; b: number };
    opacity?: number;
  } = {},
): Operation => ({
  index,
  origin,
  orientation: options.orientation ?? IDENTITY,
  shape,
  softness: options.softness ?? 0,
  combine,
  // **No colour unless one was asked for, and that is the opposite of what this used
  // to do.** It defaulted to white, so every operation carried one and every reader
  // could assume it was there — which was right while a colour was only read off a
  // `Paint`, and wrong the moment any operation's colour counts. A default of white
  // would have meant every `Add` in the model paints, and "no colour means no say in
  // appearance" would not have been enforceable by anyone.
  //
  // So the absence is the default, and the reader that cares checks for it — one
  // check, in `evalPaint`, which had to check anyway to reject a `Paint` with no
  // colour. The serialiser already substituted white for the file, so the on-disk
  // bytes are unchanged.
  colour: options.colour,
  opacity: options.opacity ?? 1,
});
