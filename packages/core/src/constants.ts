/**
 * The vocabulary two applications share.
 *
 * ## What is here and what is not
 *
 * **Types and the four numbers that are properties of a field rather than of a world.**
 * `Vec3`, `Quat`, `Bounds` and `Rgb8` are the shapes every layer in this repository passes
 * around, and they are here because a signed distance function, a mesher and a picker all have to
 * agree on them without depending on each other.
 *
 * What is **not** here is anything about chunk size, level of detail or the streaming window.
 * Those belong to one application — `apps/bm-sculpt/src/constants.ts` — and they were moved there
 * by ADR 0024 for a reason that had nothing to do with tidiness: `VOXEL_SIZE` multiplied into
 * `CHUNK_VOXELS` to make `BLOCK_WORLD`, which was assigned to `CANDIDATE_CELL`, which the
 * operation BVH read. The CSG was therefore coupled to the landscape's chunk size by a chain of
 * *values* rather than by an import, and a second application with a different natural scale would
 * have silently changed the BVH's cache partition. See the `csg` package's `OperationBVH`, which
 * now takes that number as a constructor option.
 *
 * ## Why `Bounds` is not a rendering library's type
 *
 * **The operation list is cloned into every meshing worker whenever it changes, and it crosses
 * that boundary by structured clone.** A type from a renderer would be plain data too, but it
 * would also be a dependency of the only package in this repository that is required to have none,
 * for no gain.
 */

/**
 * The distance a field reports as "nothing near here".
 *
 * Large enough that a blank world reads as uniformly outside rather than as noise, and small
 * enough that adding it to any real distance changes nothing. Kept as a named value because it is
 * the number a subtraction has to be tested against, and a colour's surface test is a comparison
 * against it.
 */
export const FAR_DISTANCE = 100;

/**
 * How far outside an operation's own box the field may still be changed by it.
 *
 * The smooth booleans blend across a band of width `4 * softness`, so an operation's influence
 * reaches that far past its surface, and a point outside the padded box cannot be affected by it
 * at all. Getting this wrong is not a subtle error: too small and the seam between two chunks
 * disagrees with the interior, and too large costs a bound test per operation per sample.
 */
export const SOFTNESS_REACH = 4;

/**
 * The widest blend a shape may carry, as a fraction of `SOFTNESS_REACH`.
 *
 * **A cap of a quarter keeps the blend band to one world unit**, which is a tenth of this
 * landscape's voxel and therefore finer than anything the mesher resolves. It is what lets the
 * candidate cache be sized by a fixed margin rather than by the softest shape in the model.
 *
 * A modelling application will want a wider range than a landscape does — a wax shape wants a
 * blend a metre across — and ADR 0025 records that the cap moves to whoever owns the model rather
 * than staying here.
 */
export const MAX_SOFTNESS = 0.25;

/**
 * The step a field takes when it is asked for a distance and none was given.
 *
 * **One world unit, and previously written `VOXEL_SIZE / 10`.** That expression was a unit of
 * chunk sampling that happened to evaluate to one, and the field's own gradient step is not a
 * property of a chunk — a field can be asked for a distance anywhere by a picker, a brush or a
 * mesher. Spelled as the number it always was.
 */
export const DEFAULT_FIELD_STEP = 1;

/**
 * The side of the box an operation BVH holds its candidate operations in while a region is being
 * evaluated.
 *
 * **A default, not a constant.** It was `BLOCK_WORLD` — one chunk of one application — and the
 * BVH is the one place the CSG was tied to that application's chunk size. `OperationBVH` takes
 * this as a constructor option and reads this only when it is not given one.
 *
 * Sized to a region rather than to something smaller. The candidate cache is re-queried whenever a
 * sample falls outside it, so a box smaller than the region being sampled is re-queried many times
 * and gains nothing; a box larger than one region keeps candidates from two regions, which costs
 * memory and no time. The application this replaces used a hardcoded hundred units, which at this
 * project's 320-unit chunk size means re-querying on every few samples.
 */
export const DEFAULT_CANDIDATE_CELL = 320;

/**
 * What a scripted field does to a player inside it.
 *
 * **Here rather than in `player.ts`, because `places/host.ts` produces it and the physics
 * consumes it.** When both were the player's type the host had to re-export the physics's copy,
 * and ADR 0022 records that re-export as the thing worth keeping: one declaration, so the compiler
 * checks that the host produces what the physics reads. Moving the type here rather than there is
 * the same argument made about the file rather than the reference — `core` is the one place both
 * sides can reach without depending on each other.
 */
export interface Medium {
  /** A push field's horizontal target-velocity pull, in units per second. */
  pushVx: number;
  pushVz: number;
  /** A push field's vertical target-velocity pull (up positive), or null when none. */
  pushVy: number | null;
  /** What quicksand multiplies a player's walk speed by; 1 when none. */
  speedScale: number;
  /** The fastest quicksand lets a player fall, in units per second; 0 when none. */
  sink: number;
}

/** A box, as an axis-aligned range. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** A three-component vector of plain numbers. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A rotation, as a unit quaternion. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A colour as three bytes. */
export interface Rgb8 {
  r: number;
  g: number;
  b: number;
}
