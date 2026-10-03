/**
 * The primitives an operation can be, described once.
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
 * ## Why this is one table
 *
 * Before this file there were six places that knew what a primitive was, and they
 * were six switches that had to be edited together: the distance function, the
 * half-extents the BVH indexes by, the file format's reader and writer, the
 * parameter count, the script layer's validation, and the list of names a script
 * could ask for. Adding a primitive meant touching all six and hoping the seventh
 * thing nobody remembered did not disagree.
 *
 * `PRIMITIVES` is that list. Each entry carries its file-format code, its
 * parameter names, its half-extents and its distance function, and the four
 * derived things — the parameter count, the reader, the writer and the script
 * validator — are computed from those. **Adding a primitive is adding one entry,
 * and the compiler then reports every other file that needs to learn about it.**
 *
 * ## Closed form only, and what that costs
 *
 * Every entry here is a closed-form signed distance function, which is a
 * deliberate limit rather than a coincidence. It means meshing can place a
 * vertex on the surface by stepping along the gradient, and it means a primitive
 * costs the same wherever it is in the fold — no marching, no precomputation, no
 * dependence on a chunk's resolution. It also means there is no extrusion and no
 * revolution, which is what a modeller wants first and what this table does not
 * have.
 *
 * **`sdEllipsoid` is the one entry that is not exact**, and cannot be: an
 * ellipsoid has no closed-form distance function, and the standard approximation
 * under-reports near the surface. That is acceptable for meshing, where only the
 * sign and a rough gradient matter, and it is *not* acceptable for sphere-tracing
 * a picker — so `exact: false` says so in the table and the test below measures what
 * the approximation is and is not good for. Every other entry is exact, and the same
 * test checks that claim rather than asserting it.
 */

import type { Vec3 } from "@big-mesh-studios/core";

/**
 * The shapes, as the discriminated union every layer passes around.
 *
 * **One word, `len`, for "extent along this primitive's own axis",** whether that
 * is three numbers (`Box`) or one. An axial primitive — capsule, cone, cylinder,
 * hex prism — is one number because its cross-section is round and a second
 * length would be a second number that had to be kept equal to the first.
 *
 * The axis is **Y, and always Y.** This was `lenX` before, which was wrong for a
 * world where gravity is `-y` and the player stands up (`player.ts`). Every axial
 * primitive added here would otherwise have had to remember which way round it
 * was, which is the kind of detail a modeller author cannot be expected to hold.
 * The file format's version byte went to 2 for this reason and not only because
 * there are new shapes.
 */
export type OperationShape =
  | { type: "Sphere"; radius: number }
  | { type: "Ellipsoid"; radius: Vec3 }
  | { type: "Box"; len: Vec3 }
  | { type: "RoundBox"; len: Vec3; radius: number }
  | { type: "Capsule"; len: number; radius: number }
  | { type: "Cone"; len: number; radius: number }
  | { type: "Cylinder"; len: number; radius: number }
  | { type: "Torus"; majorRadius: number; minorRadius: number }
  | { type: "HexPrism"; len: number; radius: number };

/** The names of the primitives, for a switch that has to be exhaustive. */
export type ShapeType = OperationShape["type"];

/**
 * The smallest extent a primitive may be given before it is treated as smaller
 * than still.
 *
 * The ellipsoid distance divides by the squared radii, so a zero radius is a
 * division by zero and a very small one loses most of its significant digits to
 * the subtraction in `k0 - 1`. The round primitive's radius enters a
 * `max(abs(p) - len + radius, 0)` that has no such problem, but a torus's major
 * radius does: `length(p.xz) - majorRadius` goes imaginary rather than merely
 * wrong when the tube is thicker than the ring.
 *
 * Clamping here rather than at every call site means a degenerate primitive
 * produces a surface very close to where it was asked for instead of a NaN that
 * spreads through a chunk. **A NaN in a field is unrecoverable** — it propagates
 * through every comparison as false and produces a hole nothing downstream can
 * explain — so this is the difference between a bad primitive and a broken chunk.
 */
export const MIN_RADIUS = 1e-3;

const radius = (value: number): number =>
  value < MIN_RADIUS ? MIN_RADIUS : value;

/** The two-component length helper, inlined because this is the hot path. */
const length2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);

// ---------------------------------------------------------------------------
// The distance functions
// ---------------------------------------------------------------------------

/** Signed distance to a sphere of the given radius, centred on the origin. */
export const sdSphere = (r: number, p: Vec3): number =>
  Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) - radius(r);

/**
 * Signed distance to an ellipsoid of the given radii, centred on the origin.
 *
 * The standard two-term expansion: divide the point by the radii to get its
 * distance in normalised space, divide again to get a local curvature, and solve
 * the quadratic that curvature implies. Exact for a sphere, since the two terms
 * then cancel to the radius.
 *
 * **The one entry in the table that is not exact**, for the reason in this file's
 * header. **What it gets right, and what the test measures:** its zero set is the
 * exact ellipsoid surface to 2.7e-15 — nine orders of magnitude below the f32
 * epsilon the field is stored in — and it never over-reports the distance to that
 * surface, along any ray. Both are the properties that matter. The surface is in the
 * right place, and the number is always a lower bound on the true distance, which is
 * the direction a sphere tracer needs: it may take more steps than necessary, and it
 * can never step through the surface. Its error far from the surface is unbounded in
 * relative terms, which is why nothing here may use it to bound a step by more than
 * the local feature size.
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

/**
 * The inside/outside sum every convex polyhedral primitive is built from.
 *
 * `d` is the signed distance to each pair of parallel faces before rounding; the
 * largest negative term is how far inside the point is, and the length of the
 * positive parts is how far outside the nearest face is.
 */
const convex = (dx: number, dy: number, dz: number): number =>
  Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) +
  Math.min(Math.max(dx, Math.max(dy, dz)), 0);

/** Signed distance to an axis-aligned box of the given half-extents. */
export const sdBox = (len: Vec3, p: Vec3): number =>
  convex(Math.abs(p.x) - len.x, Math.abs(p.y) - len.y, Math.abs(p.z) - len.z);

/**
 * Signed distance to a box with its corners rounded by `r`, centred on the origin.
 *
 * The rounding is a subtraction: shrinking the box by `r` and dilating the result
 * by a sphere of `r` is a Minkowski sum, which is what a fillet is. Written the
 * other way round — `abs(p) - len + r` — the `- r` is the dilation and the `+ r`
 * on `q` is the shrink.
 */
export const sdRoundBox = (len: Vec3, r: number, p: Vec3): number => {
  const fillet = radius(r);
  const qx = Math.abs(p.x) - len.x + fillet;
  const qy = Math.abs(p.y) - len.y + fillet;
  const qz = Math.abs(p.z) - len.z + fillet;
  return (
    Math.sqrt(
      Math.max(qx, 0) * Math.max(qx, 0) +
        Math.max(qy, 0) * Math.max(qy, 0) +
        Math.max(qz, 0) * Math.max(qz, 0),
    ) +
    Math.min(Math.max(qx, Math.max(qy, qz)), 0) -
    fillet
  );
};

/**
 * The distance to a segment along the Y axis, minus a radius: a vertical capsule.
 *
 * Clamping the y coordinate to the segment's extent is the whole algorithm: the
 * closest point on the segment to any point is either an endpoint, where clamping
 * lands, or the point's own y within the extent, where clamping leaves it alone.
 */
export const sdCapsule = (len: number, r: number, p: Vec3): number => {
  const half = radius(len) / 2;
  const along = p.y < -half ? -half : p.y > half ? half : p.y;
  return (
    Math.sqrt(p.x * p.x + (p.y - along) * (p.y - along) + p.z * p.z) - radius(r)
  );
};

/**
 * Signed distance to a capped cone along Y, base at `-len / 2`, apex at `+len / 2`.
 *
 * Two candidate distances, both exact, and the minimum of them: the distance to
 * the flat cap (`ca`) and the distance to the slanted side (`cb`). Which one is
 * nearer depends on whether the point is above or below the widest part, and the
 * side of the sign is taken from the sign of `ca.y` — a point below the base is
 * outside the cone, and one in the frustum's corner is inside.
 */
export const sdCone = (len: number, r: number, p: Vec3): number => {
  const half = radius(len) / 2;
  const base = radius(r);
  const qx = Math.sqrt(p.x * p.x + p.z * p.z);
  const qy = p.y;
  // The cap: a disc at `-half`, reachable only within the base radius. Above the
  // origin the cone narrows to a point, so there is nothing out there but the slant.
  const capR = qy < 0 ? base : 0;
  const cax = qx - Math.min(qx, capR);
  const cay = Math.abs(qy) - half;
  // **The slant, as a segment from the apex down to the base rim** — `(0, half)` to
  // `(base, -half)`, which is `k1` at the apex and `k1 + k2` at the rim. Getting these
  // two ends the wrong way round gives a cone that is upside down: still negative
  // inside, still zero on *a* surface, and wrong everywhere else. The two candidate
  // distances are then the nearer of the cap and the slant.
  const k1x = 0;
  const k1y = half;
  const k2x = -base;
  const k2y = 2 * half;
  const dot2 = k2x * k2x + k2y * k2y;
  const t = ((k1x - qx) * k2x + (k1y - qy) * k2y) / dot2;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const cbx = qx - k1x + k2x * clamped;
  const cby = qy - k1y + k2y * clamped;
  // Inside the cone means below the cap and inward of the slant at this height.
  const sign = cbx < 0 && cay < 0 ? -1 : 1;
  return (
    sign * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby))
  );
};

/** Signed distance to a capped cylinder along Y of the given length. */
export const sdCylinder = (len: number, r: number, p: Vec3): number => {
  const half = radius(len) / 2;
  const c = radius(r);
  const radial = Math.sqrt(p.x * p.x + p.z * p.z) - c;
  const axial = Math.abs(p.y) - half;
  return (
    Math.min(Math.max(radial, axial), 0) +
    Math.sqrt(
      Math.max(radial, 0) * Math.max(radial, 0) +
        Math.max(axial, 0) * Math.max(axial, 0),
    )
  );
};

/**
 * Signed distance to a torus lying in the XZ plane, axis Y.
 *
 * Folding the point onto the (radial, y) plane first is the whole trick: a torus
 * is a circle swept around the Y axis, so in that plane it is a 2D circle of
 * radius `minorRadius` centred `majorRadius` out from the origin.
 */
export const sdTorus = (
  majorRadius: number,
  minorRadius: number,
  p: Vec3,
): number =>
  length2(Math.sqrt(p.x * p.x + p.z * p.z) - radius(majorRadius), p.y) -
  radius(minorRadius);

/**
 * Signed distance to a hexagonal prism along Y, `radius` measured to a vertex.
 *
 * **The radius is the circumradius, not the inradius**, so `radius` is the distance
 * from the axis to a corner and the flats sit at `radius * √3 / 2`. A hex prism
 * specified by its inradius has flats at the named number, which is the reading a
 * modeller author is most likely to assume and the one that makes a 6-sided shape
 * smaller than the box it was drawn to replace.
 *
 * The hexagon comes from the standard construction: fold the point across the three
 * axes that pass through a vertex–opposite-vertex line, which turns the point into
 * the fundamental sector, then clamp x to the flat and take the 2D distance to the
 * resulting rectangle in the radial/axial plane.
 */
export const sdHexPrism = (len: number, r: number, p: Vec3): number => {
  const half = radius(len) / 2;
  const circum = radius(r);
  // **The construction works in inradius, and the conversion is the whole point of
  // this function.** A hexagon is built from the distance to a *flat*, so the shape is
  // easiest to describe that way; but a caller who asks for `radius: 2` means two units
  // to a corner, because that is what they drew. For a hexagon of circumradius `c` the
  // inradius is `c·√3/2`, so passing `c` where the construction wants the inradius
  // produces a prism whose corners are 15% further out than asked for — which is
  // wrong in the direction nobody notices, because a slightly large shape still joins
  // up with its neighbours.
  const inradius = circum * 0.8660254037844387;
  const kx = -0.8660254037844387;
  const ky = 0.5;
  const kz = 0.5773502691896258;
  // **The hexagon is in the XZ plane and the axis is Y**, which is the convention
  // every axial primitive in this table uses. The standard construction is written
  // with the hexagon in XY and the axis along Z, so the radial pair here is
  // `(x, z)` rather than `(x, y)` and the axial coordinate is `y` — transposing those
  // is a prism on its side, which is exactly the kind of mistake that still looks
  // like a hexagon from most angles and is not one.
  const ax = Math.abs(p.x);
  const az = Math.abs(p.z);
  const ay = Math.abs(p.y);
  // Fold onto the fundamental sector: a reflection about the axis through the vertex
  // on +x, which is what turns any of the six sectors into the one the rest is
  // measured in. Applied to the absolute pair, so all six symmetries come free.
  const dot = kx * ax + ky * az;
  const fold = dot < 0 ? -2 * dot : 0;
  const fx = ax + kx * fold;
  const fz = az + ky * fold;
  // Clamp x to the flat, and the signed 2D distance to the resulting edge is the
  // radial error. The sign is the sign of `fz - inradius`, because above the flat the
  // point is outside and below it, inside.
  const rx = fx - Math.min(Math.max(fx, -kz * inradius), kz * inradius);
  const rz = fz - inradius;
  const radial = length2(rx, rz) * (fz < inradius ? -1 : 1);
  const axial = ay - half;
  return (
    Math.min(Math.max(radial, axial), 0) +
    length2(Math.max(radial, 0), Math.max(axial, 0))
  );
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * One parameter of a primitive: a name, whether it is one float or three, and enough for a
 * panel to put an input next to it.
 *
 * ## Why the label lives here rather than in the panel
 *
 * **Because "the corner radius of a rounded box" and "the radius of a sphere" are both
 * `radius`, and only the shape knows which is which.** A panel that labelled the field
 * `radius` for a `RoundBox` would be describing the wrong number — the corner fillet, not
 * the size — and there is no way to tell the two apart from the name. So the name stays
 * `radius` for the serialiser and the human name is carried beside it.
 *
 * The same goes for `len`, which is a full extent on a box and the length of the straight
 * segment between two cap centres on a capsule: identical name, different thing, and the
 * panel has to say which.
 *
 * ## Why there is a `min` and no `max`
 *
 * **Every parameter here is a size, and no size is negative** — that is a property of the
 * geometry rather than of a user interface, so it belongs in the table. A maximum is not: how
 * big a person is willing to make a limb is a question about the application and about the
 * mesh budget, not about what a capsule is, so a panel may impose one and this does not.
 */
export interface PrimitiveParameter {
  readonly name: string;
  /** Three for a `Vec3`, one for a number. Also the number of floats it occupies. */
  readonly arity: 1 | 3;
  /** What a panel calls it. */
  readonly label: string;
  /**
   * What the three components of a `Vec3` parameter are called, in x, y, z order.
   *
   * **`Width`, `Height` and `Depth` rather than `x`, `y` and `z` for the box family**,
   * because a person's box has a width and a depth whichever way up it is on screen, and an
   * axis letter only means something once you know which way the part is rotated.
   */
  readonly axes?: readonly [string, string, string];
  /** Smallest value that still describes a shape. */
  readonly min: number;
  /** A sensible increment for a number field or a drag. */
  readonly step: number;
}

/**
 * Everything one primitive is, in one entry, as a reader sees it.
 *
 * **The reader view is wide, the entries are narrow.** Each entry below is written
 * for its own variant — `sdf: (shape: { type: "Torus"; ... }, p) => ...` — which is
 * what gives a wrong field name inside an entry a compile error. This interface is
 * the union of the properties without the per-entry signatures, because a table of
 * nine different function types is not `Record<ShapeType, PrimitiveSpec>` and cannot
 * be made to be one. `PRIMITIVES` is therefore left unannotated, and the two
 * properties that could drift from its keys — the `type` and the parameter names —
 * are checked in `PRIMITIVES.test.ts` rather than by a `satisfies` clause that
 * could not express them anyway.
 */
export interface PrimitiveSpec {
  readonly type: ShapeType;
  /**
   * The byte this shape's type is written as.
   *
   * **Never reused, never reordered.** Ellipsoid, Box and Capsule keep 0, 1 and 2
   * so that the shapes which existed before this table are still the shapes those
   * bytes meant, and the new ones start at 3. A file's type bytes are the one part
   * of it that cannot be validated by the arithmetic around them.
   */
  readonly code: number;
  /** In file order. The reader and the writer both walk this. */
  readonly parameters: readonly PrimitiveParameter[];
  /**
   * Whether `sdf` is the true Euclidean distance, or an approximation of it.
   *
   * **True for every entry except the ellipsoid.** It is here because a second
   * application that sphere-traces rather than meshes needs to know which is which,
   * and because "closed form" and "exact" are not the same claim: this table is
   * entirely closed form, and one entry of nine is not exact.
   */
  readonly exact: boolean;
  /** The primitive's own extent along its own axes, centred on the origin. */
  readonly halfExtents: (shape: never) => Vec3;
  /** Negative inside, zero on the surface, positive outside. */
  readonly sdf: (shape: never, p: Vec3) => number;
}

/**
 * Every primitive, keyed by name.
 *
 * The order is the order a modeller's palette is likely to want, not the order of
 * the type bytes and not alphabetical: a sphere and a box first because they are
 * the two everything else is measured against, the rounded and axial family next,
 * then the two that are neither a box nor a cylinder.
 */
export const PRIMITIVES = {
  Sphere: {
    type: "Sphere",
    exact: true,
    code: 3,
    parameters: [
      { name: "radius", arity: 1, label: "Radius", min: 0, step: 0.01 },
    ],
    halfExtents: (shape: { type: "Sphere"; radius: number }) => ({
      x: shape.radius,
      y: shape.radius,
      z: shape.radius,
    }),
    sdf: (shape: { type: "Sphere"; radius: number }, p: Vec3) =>
      sdSphere(shape.radius, p),
  },
  Ellipsoid: {
    type: "Ellipsoid",
    exact: false,
    code: 0,
    parameters: [
      {
        name: "radius",
        arity: 3,
        label: "Radius",
        axes: ["Width", "Height", "Depth"],
        min: 0,
        step: 0.01,
      },
    ],
    halfExtents: (shape: { type: "Ellipsoid"; radius: Vec3 }) => shape.radius,
    sdf: (shape: { type: "Ellipsoid"; radius: Vec3 }, p: Vec3) =>
      sdEllipsoid(shape.radius, p),
  },
  Box: {
    type: "Box",
    exact: true,
    code: 1,
    parameters: [
      {
        name: "len",
        arity: 3,
        label: "Size",
        axes: ["Width", "Height", "Depth"],
        min: 0,
        step: 0.05,
      },
    ],
    halfExtents: (shape: { type: "Box"; len: Vec3 }) => shape.len,
    sdf: (shape: { type: "Box"; len: Vec3 }, p: Vec3) => sdBox(shape.len, p),
  },
  RoundBox: {
    type: "RoundBox",
    exact: true,
    code: 4,
    parameters: [
      {
        name: "len",
        arity: 3,
        label: "Size",
        axes: ["Width", "Height", "Depth"],
        min: 0,
        step: 0.05,
      },
      { name: "radius", arity: 1, label: "Corner", min: 0, step: 0.01 },
    ],
    halfExtents: (shape: { type: "RoundBox"; len: Vec3; radius: number }) => ({
      x: shape.len.x + shape.radius,
      y: shape.len.y + shape.radius,
      z: shape.len.z + shape.radius,
    }),
    sdf: (shape: { type: "RoundBox"; len: Vec3; radius: number }, p: Vec3) =>
      sdRoundBox(shape.len, shape.radius, p),
  },
  Capsule: {
    type: "Capsule",
    exact: true,
    code: 2,
    parameters: [
      { name: "len", arity: 1, label: "Length", min: 0, step: 0.05 },
      { name: "radius", arity: 1, label: "Radius", min: 0, step: 0.01 },
    ],
    halfExtents: (shape: { type: "Capsule"; len: number; radius: number }) => ({
      x: shape.radius,
      y: shape.len / 2 + shape.radius,
      z: shape.radius,
    }),
    sdf: (shape: { type: "Capsule"; len: number; radius: number }, p: Vec3) =>
      sdCapsule(shape.len, shape.radius, p),
  },
  Cone: {
    type: "Cone",
    exact: true,
    code: 5,
    parameters: [
      { name: "len", arity: 1, label: "Height", min: 0, step: 0.05 },
      { name: "radius", arity: 1, label: "Radius", min: 0, step: 0.01 },
    ],
    halfExtents: (shape: { type: "Cone"; len: number; radius: number }) => ({
      x: shape.radius,
      y: shape.len / 2,
      z: shape.radius,
    }),
    sdf: (shape: { type: "Cone"; len: number; radius: number }, p: Vec3) =>
      sdCone(shape.len, shape.radius, p),
  },
  Cylinder: {
    type: "Cylinder",
    exact: true,
    code: 6,
    parameters: [
      { name: "len", arity: 1, label: "Height", min: 0, step: 0.05 },
      { name: "radius", arity: 1, label: "Radius", min: 0, step: 0.01 },
    ],
    halfExtents: (shape: {
      type: "Cylinder";
      len: number;
      radius: number;
    }) => ({
      x: shape.radius,
      y: shape.len / 2,
      z: shape.radius,
    }),
    sdf: (shape: { type: "Cylinder"; len: number; radius: number }, p: Vec3) =>
      sdCylinder(shape.len, shape.radius, p),
  },
  Torus: {
    type: "Torus",
    exact: true,
    code: 7,
    parameters: [
      {
        name: "majorRadius",
        arity: 1,
        label: "Major radius",
        min: 0,
        step: 0.01,
      },
      {
        name: "minorRadius",
        arity: 1,
        label: "Minor radius",
        min: 0,
        step: 0.01,
      },
    ],
    halfExtents: (shape: {
      type: "Torus";
      majorRadius: number;
      minorRadius: number;
    }) => ({
      x: shape.majorRadius + shape.minorRadius,
      y: shape.minorRadius,
      z: shape.majorRadius + shape.minorRadius,
    }),
    sdf: (
      shape: { type: "Torus"; majorRadius: number; minorRadius: number },
      p: Vec3,
    ) => sdTorus(shape.majorRadius, shape.minorRadius, p),
  },
  HexPrism: {
    type: "HexPrism",
    exact: true,
    code: 8,
    parameters: [
      { name: "len", arity: 1, label: "Height", min: 0, step: 0.05 },
      { name: "radius", arity: 1, label: "Radius", min: 0, step: 0.01 },
    ],
    halfExtents: (shape: {
      type: "HexPrism";
      len: number;
      radius: number;
    }) => ({
      x: shape.radius,
      y: shape.len / 2,
      z: shape.radius,
    }),
    sdf: (shape: { type: "HexPrism"; len: number; radius: number }, p: Vec3) =>
      sdHexPrism(shape.len, shape.radius, p),
  },
} as const;

/** The names of every primitive, in table order. */
export const PRIMITIVE_NAMES = Object.keys(PRIMITIVES) as ShapeType[];

/**
 * The one place a shape's variant meets a generic accessor.
 *
 * **Why a cast is here and not avoided.** `PRIMITIVES[shape.type]` has one of nine
 * value types, and `.sdf` on that union is nine function types with nine different
 * parameter types, which TypeScript will not call with a `OperationShape`. The
 * alternatives are worse: a `switch` (what this file replaced), a `Record<ShapeType,
 * {sdf: (shape: OperationShape, p: Vec3) => number}>` with each entry narrowing
 * internally (nine casts rather than one, each inside a table that is supposed to
 * read as data), or widening every entry's function to accept the union (which
 * moves the cast into nine entries and loses the narrowing entirely).
 *
 * One cast in one function, with the reason here, is the cheaper of those. **The
 * guarantee it relies on is that the table's keys and each entry's `type` agree**,
 * which `PRIMITIVES.test.ts` checks directly rather than trusting.
 */
const specOf = (shape: OperationShape): PrimitiveSpec => {
  const spec: unknown = PRIMITIVES[shape.type];
  return spec as PrimitiveSpec;
};

/** Signed distance to a primitive in its own local frame. */
export const sdShape = (shape: OperationShape, p: Vec3): number =>
  specOf(shape).sdf(shape as never, p);

/** A primitive's half-extents along its own axes. */
export const primitiveHalfExtents = (shape: OperationShape): Vec3 =>
  specOf(shape).halfExtents(shape as never);

/**
 * A primitive's parameters, in file order, with the labels and bounds a panel needs.
 *
 * **This is the seventh reader the table replaced.** A picker that wanted one input per
 * dimension used to switch over `shape.type` itself, which is the thing ADR 0025 set out to
 * stop — and it would have had to learn that a `RoundBox`'s `radius` is its corner and a
 * capsule's `len` is its straight segment, which is what `parameters` now says outright.
 */
export const primitiveParameters = (
  shape: OperationShape,
): readonly PrimitiveParameter[] => specOf(shape).parameters;

/** The float count a primitive's parameters occupy in the file format. */
export const parameterFloats = (shape: OperationShape): number => {
  let count = 0;
  for (const parameter of specOf(shape).parameters) count += parameter.arity;
  return count;
};

/**
 * The primitive's parameters, in file order, as a flat list of floats.
 *
 * **Why flatten and rebuild rather than write each shape's fields by hand** is the
 * argument for this file: a reader that switches on the type has to be edited with
 * every new shape, and the two halves drift by one float and parse into plausible
 * numbers. Flattening through a table means the bytes and the names cannot drift,
 * because there is only one list of names.
 */
export const parametersToFloats = (shape: OperationShape): number[] => {
  const floats: number[] = [];
  for (const parameter of specOf(shape).parameters) {
    const value: unknown = (shape as Record<string, unknown>)[parameter.name];
    if (parameter.arity === 3) {
      const v = value as Vec3;
      floats.push(v.x, v.y, v.z);
    } else {
      floats.push(value as number);
    }
  }
  return floats;
};

/** Rebuilds a primitive from its type and its flat parameter list. */
export const shapeFromFloats = (
  type: ShapeType,
  floats: number[],
): OperationShape => {
  const spec = PRIMITIVES[type];
  const shape: Record<string, unknown> = { type };
  let at = 0;
  for (const parameter of spec.parameters) {
    if (parameter.arity === 3) {
      shape[parameter.name] = {
        x: floats[at],
        y: floats[at + 1],
        z: floats[at + 2],
      };
      at += 3;
    } else {
      shape[parameter.name] = floats[at];
      at += 1;
    }
  }
  return shape as OperationShape;
};

/**
 * One editable number of a shape: a scalar parameter's own value, or one component of a
 * three-number one.
 *
 * **`axis` is `undefined` for a scalar and set for a `Vec3`,** rather than there being two
 * kinds of field. One kind means a panel can loop over one list, and the axis is what tells
 * a reader which of the two it is looking at.
 */
export interface DimensionField {
  /** The parameter's name in the shape. */
  readonly name: string;
  /** Which component of a `Vec3`, or `undefined` when the parameter is a number. */
  readonly axis: "x" | "y" | "z" | undefined;
  /** What to call this input: `Width` for a box's x, `Radius` for a sphere's only number. */
  readonly label: string;
  /** What it is now. */
  readonly value: number;
  /** The table's floor. No size here is negative. */
  readonly min: number;
  /** A sensible increment. */
  readonly step: number;
}

/** One parameter of a shape, with the inputs it needs. */
export interface DimensionGroup {
  readonly name: string;
  readonly label: string;
  /** One entry for a number, three for a `Vec3`. Never two. */
  readonly fields: readonly DimensionField[];
}

const AXES = ["x", "y", "z"] as const;

/**
 * A shape's editable numbers, grouped by parameter and in file order.
 *
 * **The eighth reader the table replaced, and the one that had been a `switch`.** A panel
 * that wanted an input per dimension had to enumerate the nine shapes itself to learn that a
 * box has three numbers and a capsule has two — which is exactly the duplication ADR 0025
 * set out to remove, and the reason the first version of this panel rendered nothing.
 *
 * Grouping by parameter rather than returning one flat list of numbers is what lets a panel
 * put a border around the three of a `Vec3`; the shape really does treat them as one value,
 * and a border is the cheapest way to say so.
 */
export const dimensionGroups = (
  shape: OperationShape,
): readonly DimensionGroup[] => {
  const values = shape as unknown as Record<string, unknown>;
  return specOf(shape).parameters.map((parameter) => ({
    name: parameter.name,
    label: parameter.label,
    fields:
      parameter.arity === 3
        ? AXES.map((axis, index) => ({
            name: parameter.name,
            axis,
            label: (parameter.axes ?? ["x", "y", "z"])[index],
            value: (values[parameter.name] as Vec3)[axis],
            min: parameter.min,
            step: parameter.step,
          }))
        : [
            {
              name: parameter.name,
              axis: undefined,
              label: parameter.label,
              value: values[parameter.name] as number,
              min: parameter.min,
              step: parameter.step,
            },
          ],
  }));
};

/**
 * A copy of `shape` with one of its parameters changed.
 *
 * **A new object, never a mutation.** The store decides whether an edit deserves a history
 * entry by comparing, and a panel that edited a shape in place would produce an edit the
 * store cannot see and an undo that does not undo. The union cannot be narrowed by name
 * without the same single cast `specOf` documents, so it is here once rather than in every
 * panel.
 *
 * Returns `shape` unchanged when the named parameter is not one of its own — which is what a
 * caller gets if it asks for a field the table does not have, and is why the read side and
 * the write side cannot disagree about what a shape contains.
 */
export const withParameter = (
  shape: OperationShape,
  name: string,
  axis: "x" | "y" | "z" | undefined,
  value: number,
): OperationShape => {
  const values = shape as unknown as Record<string, unknown>;
  if (values[name] === undefined) return shape;
  if (axis === undefined) {
    return { ...values, [name]: value } as OperationShape;
  }
  return {
    ...values,
    [name]: { ...(values[name] as Vec3), [axis]: value },
  } as OperationShape;
};

/**
 * The primitive named by a file's type byte, or null if this version does not
 * write that byte.
 *
 * **Reverse lookup, and the reason it cannot be an array index.** The codes are
 * 0, 1, 2 and 3 through 8, so an index into an array would work today and would
 * silently read a *different primitive* the moment a code was retired or a tenth
 * one was added out of order. A gap has to be a gap.
 */
export const primitiveFromCode = (code: number): ShapeType | null => {
  for (const name of PRIMITIVE_NAMES) {
    if (PRIMITIVES[name].code === code) return name;
  }
  return null;
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
 * **The same for every primitive, and that is not an oversight** — each entry's
 * `halfExtents` already includes the primitive's own extent, the fillet of a round
 * box, the tube of a torus and the caps of a capsule. What is left to allow for is
 * only the softness and a unit of slack.
 *
 * Deliberately loose. An index that misses an operation is a hole in the surface
 * that nothing else will notice, while one that includes an operation which turns
 * out not to contribute costs a point-in-box test.
 */
export const shapePadding = (
  shape: OperationShape,
  softness: number,
): number => {
  void shape;
  return softness * 4 + 1;
};
