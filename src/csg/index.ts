/**
 * The CSG core: what the model is, and how a point in space is measured against it.
 *
 * One import for everything a worker or a chunk mesher needs. The pieces are
 * separable and individually tested — shapes, operations, the tree, the field, the
 * file format — and this barrel exists so that a mesher does not have to know that,
 * and so that a change to one does not force a change to the other's imports.
 *
 * Nothing here imports the renderer or the DOM. That is deliberate and load-bearing:
 * the operation list is cloned into every meshing worker whenever it changes, and it
 * crosses that boundary by structured clone, which means it has to be plain data.
 * `docs/adr/0002-computed-field-never-stored.md` has the reasoning for why the model
 * is a list of primitives at all.
 */

export type { Bounds, Quat, Rgb8, Vec3 } from "../constants";
export {
  BLOCK_WORLD,
  CANDIDATE_CELL,
  CHUNK_VOXELS,
  FAR_DISTANCE,
  FIELD_BORDER,
  LOD_COUNT,
  LOD_STRIDE,
  SOFTNESS_REACH,
  VOXEL_SIZE,
  lodVoxels,
  lodWorld,
} from "../constants";

export type { OperationShape } from "./shapes";
export {
  MIN_RADIUS,
  sdBox,
  sdCapsule,
  sdEllipsoid,
  sdShape,
  shapePadding,
  SHAPE_TYPE,
} from "./shapes";

export type { Combine, IndexedOperation, Operation } from "./operations";
export {
  CANDIDATE_MARGIN,
  COMBINE,
  MAX_SOFTNESS,
  applyOperation,
  boundsContain,
  boundsDistance,
  boundsDistanceSquared,
  conjugate,
  emptyField,
  foldOperations,
  indexOperation,
  makeOperation,
  operationBounds,
  operationDistance,
  rotate,
  shapeHalfExtents,
  smoothMax,
  smoothMin,
} from "./operations";

export { OperationBVH } from "./bvh";

export type {
  BaseField,
  FieldOptions,
  PaintSource,
  SurfaceExtent,
} from "./field";
export { DEFAULT_COLOUR, Field } from "./field";

export type { TerrainField, TerrainParams } from "./terrain";
export {
  DEFAULT_TERRAIN,
  FBM_AMPLITUDE_BOUND,
  NOISE_GRADIENT_BOUND,
  PerlinNoise2D,
  TERRAIN_FEATURE,
  terrainField,
} from "./terrain";

export {
  FormatError,
  FORMAT_VERSION,
  deserialiseOperations,
  serialisedSize,
  serialiseOperations,
} from "./serialise";
