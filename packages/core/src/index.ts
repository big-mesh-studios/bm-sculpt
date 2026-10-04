/**
 * `@big-mesh-studios/core`
 *
 * The one package both applications depend on, and the smallest one here. Four types and five
 * numbers, which is the whole of it.
 *
 * ## Why `core` exists rather than a copy in each package
 *
 * **`Vec3` has to be the same type in a field, in a mesher and in a picker**, and it has to be
 * the same *identity* as well as the same shape: a `Vec3` crossing from one to another as a
 * `Boundary` type error would be noise, and a structural match would quietly pass a number where
 * something else was meant. One declaration is the only version of "the same type" that holds.
 *
 * The same argument put `Medium` here rather than in `player.ts`, where it started. ADR 0022 kept
 * the host's copy as a re-export of the physics's — one type, so the compiler checks that the host
 * produces what the physics reads — and moving the declaration to the one package both sides can
 * reach keeps that property without making `packages/places` depend on an application's physics.
 *
 * ## What is deliberately *not* here
 *
 * Anything about a chunk. `VOXEL_SIZE` multiplied into `CHUNK_VOXELS` to make `BLOCK_WORLD`, which
 * was `CANDIDATE_CELL`, which the operation BVH read — so a package that has to be usable at any
 * scale was one application's chunk size wide, by a chain of values rather than by an import. That
 * chain is broken; see ADR 0024 and `OperationBVH`'s constructor.
 */

export {
  DEFAULT_CANDIDATE_CELL,
  DEFAULT_FIELD_STEP,
  FAR_DISTANCE,
  MAX_SOFTNESS,
  SOFTNESS_REACH,
  type Bounds,
  type Medium,
  type Quat,
  type Rgb8,
  type Vec3,
} from "./constants";

export type { Basis } from "./vec3";
export {
  ONE,
  ZERO,
  add,
  angleBetween,
  cross,
  distance,
  dot,
  isFinite,
  length,
  lengthSq,
  lerp,
  negate,
  normalize,
  onbFromDirection,
  rotateAboutAxis,
  scale,
  sub,
  vec3,
} from "./vec3";

export type { HSVA, RGBA } from "./colour";
export {
  byteToOpacity,
  hsvaEquals,
  hsvaToCss,
  hsvaToRgba,
  opacityToByte,
  rgbEquals,
  rgbToCss,
  rgbToRgba,
  rgbaEquals,
  rgbaToHsva,
  rgbaToRgb,
  rgbaToCss,
} from "./colour";

export {
  SNORM16_MAX,
  decodeOctahedral,
  decodeOctahedralSnorm16,
  encodeOctahedral,
  encodeOctahedralSnorm16,
  normalized,
  writeOctahedralNormal,
  type Vec2,
} from "./octahedral";
