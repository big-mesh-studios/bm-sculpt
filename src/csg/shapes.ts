/**
 * The three primitives an operation can be, and the signed distance to each.
 *
 * A distance function here is negative inside, zero on the surface, and positive
 * outside. Its units are world units, because it has to be comparable with a
 * brush radius, a level-of-detail stride and a mesh vertex position — the whole
 * design rests on distance being one number in one space.
 *
 * Every function takes a point in the shape's own local frame, centred on the
 * origin and unrotated. Transforming a world point into that frame is the
 * caller's job and happens once per operation per sample, which is why the
 * inverse rotation is cached rather than recomputed.
 *
 * Two of the three are exact signed distance functions. The ellipsoid is not, and
 * cannot be: an ellipsoid has no closed-form distance function, and the standard
 * approximation under-reports near the surface. That is acceptable for meshing,
 * where only the sign and a rough gradient matter, and it is *not* acceptable for
 * sphere-tracing a picker — so the approximation's shortfall is bounded by
 * `ellipsoidError` and documented rather than assumed away.
 */

import type { Vec3 } from "../constants";

export type OperationShape =
  | { type: "Ellipsoid"; radius: Vec3 }
  | { type: "Box"; len: Vec3 }
  | { type: "Capsule"; lenX: number; radius: number };

/** The primitive kinds, as the numbers the file format writes. */
export const SHAPE_TYPE = {
  Ellipsoid: 0,
  Box: 1,
  Capsule: 2,
} as const;

/**
 * The smallest radius an ellipsoid may be given before it is treated as smaller
 * still.
 *
 * The distance function divides by the squared radii, so a zero radius is a
 * division by zero and a very small one loses most of its significant digits to
 * the subtraction in `k0 - 1`. Clamping here rather than at every call site means
 * a degenerate primitive produces a surface very close to where it was asked for
 * instead of a NaN that spreads through a chunk.
 */
export const MIN_RADIUS = 1e-3;

const radius = (value: number): number =>
  value < MIN_RADIUS ? MIN_RADIUS : value;

/**
 * Signed distance to an ellipsoid of the given radii, centred on the origin.
 *
 * The standard two-term expansion: divide the point by the radii to get its
 * distance in normalised space, divide again to get a local curvature, and solve
 * the quadratic that curvature implies. Exact for a sphere, since the two terms
 * then cancel to the radius.
 */
export const sdEllipsoid = (radii: Vec3, p: Vec3): number => {
  const rx = radius(radii.x);
  const ry = radius(radii.y);
  const rz = radius(radii.z);
  // `Math.sqrt` of a sum of squares rather than `Math.hypot`: the variadic form is
  // not inlined by V8, and this runs for every operation the fold does not skip,
  // which is the hot path of the whole mesher.
  const ax = p.x / rx;
  const ay = p.y / ry;
  const az = p.z / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = ax / rx;
  const by = ay / ry;
  const bz = az / rz;
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  // A point exactly on the origin has no direction, and both terms are zero, so
  // the division below would be a division by zero. The distance is negative
  // there — deep inside — and the smallest radius is deeper inside than any
  // field will use, so nothing downstream can tell the difference.
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
};

/** Signed distance to an axis-aligned box of the given half-extents. */
export const sdBox = (len: Vec3, p: Vec3): number => {
  const dx = Math.abs(p.x) - len.x;
  const dy = Math.abs(p.y) - len.y;
  const dz = Math.abs(p.z) - len.z;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  return outside + inside;
};

/**
 * Signed distance to a capsule of the given length along x and radius, centred on
 * the origin.
 *
 * The exact distance from a point to a segment, minus the radius. Clamping the
 * x coordinate to the segment's extent is the whole algorithm: the closest point
 * on the segment to any point is either an endpoint, where clamping lands, or
 * the point's own x within the extent, where clamping leaves it alone.
 */
export const sdCapsule = (lenX: number, radius: number, p: Vec3): number => {
  const half = lenX / 2;
  const along = p.x < -half ? -half : p.x > half ? half : p.x;
  const dx = p.x - along;
  return Math.sqrt(dx * dx + p.y * p.y + p.z * p.z) - radius;
};

/** Signed distance to a shape in its own local frame. */
export const sdShape = (shape: OperationShape, p: Vec3): number => {
  switch (shape.type) {
    case "Ellipsoid":
      return sdEllipsoid(shape.radius, p);
    case "Box":
      return sdBox(shape.len, p);
    case "Capsule":
      return sdCapsule(shape.lenX, shape.radius, p);
  }
};

/**
 * How far outside a shape a point may be and still be inside the box its
 * operation is indexed by.
 *
 * The box an operation is stored under has to cover everywhere the operation can
 * change the field. A hard boolean reaches nothing outside the shape, but a soft
 * one blends across `4 * softness`, so the box grows by that much as well as by a
 * unit of slack.
 *
 * Deliberately loose. An index that misses an operation is a hole in the surface
 * that nothing else will notice, while one that includes an operation which turns
 * out not to contribute costs a point-in-box test.
 */
export const shapePadding = (
  shape: OperationShape,
  softness: number,
): number => {
  // A capsule's own extent is already its bounds, so no shape needs padding for
  // its own sake; the softness term and the unit of slack are the whole of it.
  void shape;
  return softness * 4 + 1;
};
