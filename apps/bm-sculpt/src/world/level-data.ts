/**
 * Where chunks are, how big they are, and which level of detail a chunk gets.
 *
 * The whole streaming design rests on one property, and it is worth stating before
 * the arithmetic: **a chunk covers the same ground at every level of detail.** Only
 * the resolution of the samples inside it changes. A coarse chunk is therefore not a
 * smaller or a differently-placed thing — it is the same region measured less
 * finely — which is what makes it legitimate to swap one for another as the camera
 * moves, and what stops level of detail from ever being a source of a seam.
 *
 * That property is only affordable because the field is computed rather than stored
 * (ADR 0004). A stored field would have to be *refilled* at a new resolution, and a
 * refill is where cracks come from.
 */

import {
  BLOCK_WORLD,
  CHUNK_VOXELS,
  LOD_COUNT,
  LOD_STRIDE,
  VOXEL_SIZE,
} from "../constants";
import type { Vec3 } from "@big-mesh-studios/core";

/** Three whole numbers: a chunk cell, or a voxel, or a world corner. */
export type CellCoord = {
  x: number;
  y: number;
  z: number;
};

/** A level of detail, as an index into `LOD_STRIDE`. */
export type Lod = number;

/**
 * How far, in chunks, each level of detail reaches from the focus.
 *
 * Two bands, because there are three levels. A third would need a third number, and
 * a table of that shape is a way of saying "these are not really numbers" — they are
 * one measurement of a single thing, which is how far away things are.
 */
export interface LodBands {
  /** Chunks within this distance are sampled at full resolution. */
  full: number;
  /** Chunks within this distance, and beyond `full`, are one step coarser. */
  coarse: number;
}

/**
 * Full detail within two chunks, one step coarser to three, coarsest beyond that.
 *
 * **`full` is two rather than one because of where the player stands, not where the
 * chunk grid does.** The distance is measured from the focus *cell*, and the player is
 * anywhere inside that cell — so at `full: 1` the full-detail region is the focus cell
 * and its six face neighbours, and the first lower-detail chunk is a diagonal neighbour
 * at distance √2. Its corner is the corner of the chunk the player is standing in. You
 * could stand on the seam and be looking at two levels at once, which is the thing this
 * number exists to prevent. At two, the nearest lower-detail chunk is one whole chunk
 * away from wherever in your own cell you happen to be.
 *
 * `coarse` is three rather than two for a mechanical reason and only that one: it must
 * exceed `full` or the middle level is never reached, and a chunk can be full detail or
 * coarsest with nothing in between. That makes LOD1 the thin shell it is here, which
 * suits it — it exists to be the step between the two, not a region of its own.
 *
 * The cost is real and worth stating plainly: LOD0 grows from 7 cells to 33, so a window
 * carries about 1.3× the samples it did. It buys a resolution change you have to walk a
 * chunk to reach.
 */
export const DEFAULT_LOD_BANDS: LodBands = { full: 2, coarse: 3 };

/** Whether level of detail is switched off, so every chunk is full resolution. */
export const LOD_OFF: LodBands = {
  full: Number.POSITIVE_INFINITY,
  coarse: Number.POSITIVE_INFINITY,
};

export const lodIsOff = (bands: LodBands): boolean =>
  !Number.isFinite(bands.full) || !Number.isFinite(bands.coarse);

/** How many samples a chunk's field is divided by at a level of detail. */
export const lodStride = (lod: Lod): number =>
  LOD_STRIDE[Math.max(0, Math.min(lod, LOD_COUNT - 1)) as 0 | 1 | 2] as number;

/**
 * How many voxel samples fit across a chunk at a level of detail.
 *
 * The coarsest level divides thirty-two by four, giving eight — which is one sample
 * per eighty world units. A brush is twenty units across at its smallest, so a
 * sculpt at that level of detail is not visible. That is not a defect: it is the
 * point of having a coarsest level, and it is why the bands default to keeping the
 * coarsest level at the far edge of the window where nothing is being sculpted.
 */
export const lodSamples = (lod: Lod): number => CHUNK_VOXELS / lodStride(lod);

/** World units per sample at a level of detail. */
export const lodSampleSize = (lod: Lod): number => VOXEL_SIZE * lodStride(lod);

/** The world units a chunk spans, which is the same at every level of detail. */
export const lodExtent = (_lod: Lod): number => BLOCK_WORLD;

/** The distance in world units between two chunk cells' centres. */
export const cellDistance = (a: CellCoord, b: CellCoord): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The level of detail for a chunk, from how far it is from the focus.
 *
 * Euclidean in chunk cells, and compared against squared distances so that no square
 * root is taken per chunk per scroll — the squaring is safe because both bands are
 * non-negative in every configuration a caller can reach, including the infinite one
 * that switches level of detail off.
 */
export const lodAt = (
  cell: CellCoord,
  focus: CellCoord,
  bands: LodBands = DEFAULT_LOD_BANDS,
): Lod => {
  const dx = cell.x - focus.x;
  const dy = cell.y - focus.y;
  const dz = cell.z - focus.z;
  const distanceSquared = dx * dx + dy * dy + dz * dz;
  if (distanceSquared <= bands.full * bands.full) return 0;
  if (distanceSquared <= bands.coarse * bands.coarse) return 1;
  return 2;
};

/**
 * Which of a chunk's six faces border a chunk at a *finer* level of detail.
 *
 * A `OverlapMask` is a bit set, one bit per face, in the order `-x, +x, -y, +y, -z, +z`.
 * A set bit says the neighbouring cell is meshed more finely than this one, so this chunk
 * meshes **one cell into it** and the two surfaces overlap across the plane between them
 * rather than stopping on it (ADR 0035).
 *
 * **Only the coarser side is marked, and that is the whole policy.** Two chunks at
 * different levels sample the same field at different strides, so their surfaces meet
 * across the shared plane but not exactly: they disagree by up to about half a coarse
 * sample, which leaves a slit. One of the two has to reach across that plane, and it is
 * always the coarse one, for two reasons that both point the same way. It is the side whose
 * geometry is an approximation, so the strip it adds is geometry that would have been
 * approximate anyway and is drawn underneath the real thing; and it is the side paying for
 * it in samples, at its own stride rather than the fine one.
 *
 * The mask is derived from the same `lodAt` the window schedules with, one cell out, so
 * it cannot disagree with the level a neighbour is actually built at. A face outside the
 * window still answers, because `lodAt` is defined for every cell: the neighbour simply
 * may not exist yet, which changes nothing about where the discontinuity is.
 */
export type OverlapMask = number;

export const OVERLAP_X_NEG = 1 << 0;
export const OVERLAP_X_POS = 1 << 1;
export const OVERLAP_Y_NEG = 1 << 2;
export const OVERLAP_Y_POS = 1 << 3;
export const OVERLAP_Z_NEG = 1 << 4;
export const OVERLAP_Z_POS = 1 << 5;

/** The six face neighbours, in `OverlapMask` bit order. */
export const OVERLAP_DIRECTIONS: readonly (readonly [
  number,
  number,
  number,
])[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

/**
 * The faces of a cell whose neighbour is meshed at a finer level of detail.
 *
 * **Direction, not equality.** Asking whether a neighbour is at a *different* level was the
 * older question, and it was what a flap of covering geometry needed: drawn by the finer
 * side, which had to know there was something to cover. Nothing needs that now. The coarse
 * side reaches over and the fine side has nothing to do, so a cell whose neighbours are all
 * coarser gets a mask of zero and pays nothing for them — where an inequality test would
 * have had it reach into all six.
 */
export const overlapMaskAt = (
  cell: CellCoord,
  focus: CellCoord,
  bands: LodBands = DEFAULT_LOD_BANDS,
): OverlapMask => {
  const self = lodAt(cell, focus, bands);
  let mask = 0;
  for (let face = 0; face < OVERLAP_DIRECTIONS.length; face++) {
    const [dx, dy, dz] = OVERLAP_DIRECTIONS[face];
    const neighbour = lodAt(
      { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz },
      focus,
      bands,
    );
    if (neighbour < self) mask |= 1 << face;
  }
  return mask;
};

/**
 * The chunk cell containing a world point.
 *
 * `Math.floor` on all three axes with no clamping, so cells are unbounded in both
 * directions — that is what makes the same code serve a sculpting session at the
 * origin and an infinite world scrolled ten thousand chunks out. A window's extent
 * is a property of the window, never of the coordinates.
 *
 * The half-extent shift puts the origin at a cell *centre* rather than a corner, so
 * a model built around the origin is symmetric across all eight octants instead of
 * being split by a plane.
 */
export const chunkCellOf = (world: Vec3): CellCoord => ({
  x: Math.floor((world.x + BLOCK_WORLD / 2) / BLOCK_WORLD),
  y: Math.floor((world.y + BLOCK_WORLD / 2) / BLOCK_WORLD),
  z: Math.floor((world.z + BLOCK_WORLD / 2) / BLOCK_WORLD),
});

/** The world point at a chunk cell's centre. */
export const cellCentre = (cell: CellCoord): Vec3 => ({
  x: cell.x * BLOCK_WORLD,
  y: cell.y * BLOCK_WORLD,
  z: cell.z * BLOCK_WORLD,
});

/**
 * The world position of one sample within a chunk.
 *
 * A chunk spans `BLOCK_WORLD` units and is divided into `CHUNK_VOXELS` **intervals**,
 * so a sample sits at the *start* of each interval: the first at the chunk's low edge,
 * the last one interval short of its high edge.
 *
 * Putting samples at interval *centres* instead is the intuitive choice and it does not
 * work. Thirty-two samples at interval centres span thirty-one intervals — 310 units
 * where the chunk is 320 — so the chunk leaves a ten-unit gap at its high edge, and the
 * next chunk begins with another. Samples on the boundary are shared by two chunks,
 * which sounds alarming and is exactly what is wanted: each chunk uses its neighbour's
 * boundary sample as the one cell of padding the mesher's seam rule needs, and both
 * arrive at the same value because the field is a function of position (0002).
 *
 * Thirty-three samples at interval centres would tile, but then the outermost sample
 * hangs outside the chunk and "which samples does this chunk own" stops being answerable
 * from the chunk alone. Ownership measured from the low edge is.
 */
export const sampleWorld = (cell: CellCoord, along: number): number =>
  cellCentre(cell).x + (along - CHUNK_VOXELS / 2) * VOXEL_SIZE;

/**
 * The world position of a chunk's own first sample, on all three axes.
 *
 * The chunk's low edge, not its centre: the mesher counts ownership from here, and the
 * distance between this and the centre is half the chunk.
 */
export const sampleOriginOf = (cell: CellCoord): Vec3 => {
  const half = (CHUNK_VOXELS / 2) * VOXEL_SIZE;
  const centre = cellCentre(cell);
  return { x: centre.x - half, y: centre.y - half, z: centre.z - half };
};

/**
 * The sample index nearest a world point within a chunk.
 *
 * Rounded rather than floored, because a point exactly between two samples is equally
 * near both, and the tie has to break the same way every time or the field is not a
 * function of position.
 *
 * Clamped to the chunk's own samples. A point in the last interval is nearer the
 * boundary sample than any of this chunk's, and that sample belongs to the *next* chunk
 * — which is right for meshing and wrong for asking what colour this chunk holds, so
 * the clamp answers the question that was actually asked instead of returning an index
 * the caller would have to bounds-check.
 */
export const sampleIndexIn = (world: number, centre: number): number => {
  const index = Math.round((world - centre) / VOXEL_SIZE + CHUNK_VOXELS / 2);
  return index < 0 ? 0 : index > CHUNK_VOXELS - 1 ? CHUNK_VOXELS - 1 : index;
};

/**
 * Every chunk cell within `radius` chunks of `centre`, flattened vertically.
 *
 * A squashed ball rather than a cube: a viewport is wider than it is tall, so a cube
 * large enough to fill the screen horizontally is far larger than it needs to be
 * vertically, and every one of those extra chunks is a chunk's worth of mesh that
 * nobody can see. The squashing is expressed as `yRadius`, so it is a statement
 * about the shape of the window rather than about the terrain.
 *
 * The returned order is unspecified beyond being deterministic, because callers sort
 * by distance before using it — see `ChunkSphere`, which needs the chunk under the
 * player filled first.
 */
export const sphereCells = (
  centre: CellCoord,
  radius: number,
  yRadius = radius,
): CellCoord[] => {
  const cells: CellCoord[] = [];
  const reach = Math.ceil(radius);
  const reachY = Math.ceil(yRadius);
  for (let z = -reach; z <= reach; z++) {
    for (let y = -reachY; y <= reachY; y++) {
      for (let x = -reach; x <= reach; x++) {
        const cell = { x: centre.x + x, y: centre.y + y, z: centre.z + z };
        if (cellInSphere(cell, centre, radius, yRadius)) cells.push(cell);
      }
    }
  }
  return cells;
};

/** Whether a cell is inside a squashed ball. */
export const cellInSphere = (
  cell: CellCoord,
  centre: CellCoord,
  radius: number,
  yRadius = radius,
): boolean => {
  const dx = cell.x - centre.x;
  const dy = cell.y - centre.y;
  const dz = cell.z - centre.z;
  // `yRadius` of zero would divide by nothing, so a window with no vertical extent
  // is treated as one chunk tall rather than as an empty window.
  if (yRadius <= 0) return dy === 0 && dx * dx + dz * dz <= radius * radius;
  const ky = radius / yRadius;
  return dx * dx + dz * dz + (dy * ky) ** 2 <= radius * radius;
};

/** How many cells a squashed ball of that shape holds. */
export const cellsInSphere = (radius: number, yRadius = radius): number =>
  sphereCells({ x: 0, y: 0, z: 0 }, radius, yRadius).length;

/** Whether two cells name the same place. */
export const sameCell = (a: CellCoord, b: CellCoord): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;
