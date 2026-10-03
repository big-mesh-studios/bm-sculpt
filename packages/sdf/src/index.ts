/**
 * `@big-mesh-studios/sdf`
 *
 * How far a point is from each primitive shape, and nothing else.
 *
 * ## What belongs here and what does not
 *
 * **A shape is a distance function and a few numbers. It is not an operation.** The split is the
 * one that makes this package worth having: `sdf` knows there is a box and how to measure the
 * distance to it, and knows nothing about list order, subtraction, colour, softness, a file
 * format or a worker. `packages/csg` owns all of that and depends on this.
 *
 * Before ADR 0025 that division did not exist: the three primitives were `csg/shapes.ts`, and
 * adding a fourth meant finding five exhaustive switches over `shape.type` — the distance, the half
 * extents, the serialiser's read and write and parameter count, the editor's invalidation bounds,
 * and the places vocabulary's validation. **A primitive that has to be added in five places is a
 * primitive nobody adds.** There are six, in fact; the sixth was the script layer's `checkShape`,
 * which is in `apps/bm-sculpt` and validated three literal shape names of its own.
 *
 * Now it is `PRIMITIVES`, one entry per primitive, and every one of those six reads it. There are
 * nine primitives rather than three: Sphere, RoundBox, Cone, Cylinder, Torus and HexPrism are new.
 * All of them are closed form, and adding a tenth is adding one entry.
 *
 * ## Two things in here are approximate, and say so
 *
 * **`sdEllipsoid` is an expansion, not an exact distance**, and `PRIMITIVES.Ellipsoid.exact` is
 * `false` for that reason. What it gets right is measured rather than asserted: its zero set is the
 * exact ellipsoid surface to 2.7e-15, which is nine orders of magnitude below the f32 epsilon the
 * field is stored in, and it never over-reports the distance to that surface along any ray. That is
 * enough for meshing, which samples a grid, and it is enough for a sphere tracer, which may take
 * more steps than it needs and can never step through a surface. **Its error far from the surface
 * is unbounded in relative terms**, so nothing may use it to bound a step by more than the local
 * feature size — which is the constraint a second application that raymarches inherits.
 *
 * **`sdShape` was a switch, and is now a table lookup.** There is no registry for the old one to
 * have: there were three shapes and a switch is the thing this repository writes when a type is a
 * union — the thing it has been careful to *replace* with a table everywhere else.
 */
export type {
  DimensionField,
  DimensionGroup,
  OperationShape,
  PrimitiveParameter,
  PrimitiveSpec,
  ShapeType,
} from "./primitives";
export {
  dimensionGroups,
  MIN_RADIUS,
  parameterFloats,
  parametersToFloats,
  primitiveFromCode,
  primitiveHalfExtents,
  primitiveParameters,
  PRIMITIVE_NAMES,
  PRIMITIVES,
  sdBox,
  sdCapsule,
  sdCone,
  sdCylinder,
  sdEllipsoid,
  sdHexPrism,
  sdRoundBox,
  sdShape,
  sdSphere,
  sdTorus,
  withParameter,
  shapeFromFloats,
  shapePadding,
} from "./primitives";
