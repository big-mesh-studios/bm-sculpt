/**
 * The numbers the rest of the project is built around, each with the reasoning
 * that produced it. Changing one is a design change, not a tweak: several of them
 * are load-bearing for memory, and the comments say which.
 */

/** World units per voxel at level of detail 0. */
export const VOXEL_SIZE = 10;

/**
 * Voxels per chunk per axis at level of detail 0.
 *
 * Thirty-two rather than sixty-four. A chunk is re-meshed in full after every
 * edit, so its size sets the cost of the most frequent operation the application
 * performs: 32³ is 32,768 field samples, which is a few milliseconds on one
 * worker thread, where 64³ is eight times that and lands four chunks into the
 * adaptive scaler's frame budget on a modest machine.
 *
 * The reference renderer uses sixty-four, because it also has to fill a chunk
 * from terrain before meshing it and the fill is the larger cost. Nothing is
 * filled here — a chunk is evaluated from the operation list on demand
 * (ADR 0004) — so the mesher's own size is the whole budget.
 */
export const CHUNK_VOXELS = 32;

/** World units one chunk spans on each axis, at every level of detail. */
export const BLOCK_WORLD = CHUNK_VOXELS * VOXEL_SIZE;

/**
 * How many times each level of detail samples the field more coarsely than the
 * one before it. Indexed by level.
 *
 * Doubling rather than growing by a constant, because level of detail is a
 * sampling stride over one continuous function (ADR 0004) and a stride that
 * halves the samples is what makes a coarse chunk cheap rather than merely
 * smaller.
 */
export const LOD_STRIDE = [1, 2, 4] as const;

/** The coarsest level of detail there is, and one past it, for loops. */
export const LOD_COUNT = LOD_STRIDE.length;

/** Voxels across one chunk at a given level of detail, per axis. */
export const lodVoxels = (lod: number): number =>
  CHUNK_VOXELS / (LOD_STRIDE[Math.min(lod, LOD_COUNT - 1)] as number);

/**
 * World units across one chunk at a given level of detail, per axis.
 *
 * Constant across levels, and that is the point: a chunk covers the same ground
 * at every level, and only the resolution of its samples changes. A chunk's world
 * size is therefore the one true extent, and every coordinate conversion goes
 * through this rather than through a level-dependent number.
 */
export const lodWorld = (_lod: number): number => BLOCK_WORLD;

/**
 * One level of detail beyond the texture's edge.
 *
 * Sampled fields do not clamp at their edges, so a chunk needs a border of
 * samples outside itself to cull its seam faces against. One is enough for the
 * mesher to decide every face on its own boundary; more would be a way of
 * hiding a seam rather than closing it.
 */
export const FIELD_BORDER = 1;

/**
 * The side of the box an operation BVH holds its candidate operations in while a
 * chunk is being evaluated.
 *
 * Sized to a chunk rather than to something smaller. The candidate cache is
 * re-queried whenever a sample falls outside it, so a box smaller than the region
 * being sampled is re-queried many times per chunk and gains nothing; a box
 * larger than one chunk keeps candidates from two chunks, which costs memory and
 * no time. The application this replaces used a hardcoded hundred units, which at
 * this project's 320-unit chunk size means re-querying on every few samples.
 */
export const CANDIDATE_CELL = BLOCK_WORLD;

/**
 * How far outside an operation's own box the field may still be changed by it.
 *
 * The smooth booleans blend across a band of width `4 * softness`, so an
 * operation's influence reaches that far past its surface, and a point outside
 * the padded box cannot be affected by it at all. Getting this wrong is not a
 * subtle error: too small and the seam between two chunks disagrees with the
 * interior, and too large costs a bound test per operation per sample.
 */
export const SOFTNESS_REACH = 4;

/**
 * The distance a field reports as "nothing near here".
 *
 * Large enough that a blank world reads as uniformly outside rather than as
 * noise, and small enough that adding it to any real distance changes nothing.
 * Kept as a named value because it is the number a subtraction has to be tested
 * against, and a colour's surface test is a comparison against it.
 */
export const FAR_DISTANCE = 100;

/** A box, as an axis-aligned range. Chosen over a rendering library's type so
 *  the CSG module has no dependency on the renderer and survives a structured
 *  clone into a worker for free. */
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
