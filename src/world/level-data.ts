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
import type { Vec3 } from "../constants";

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

export const DEFAULT_LOD_BANDS: LodBands = { full: 1, coarse: 2 };

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
 * A chunk is `CHUNK_VOXELS` samples wide and spans `BLOCK_WORLD` units, so the
 * samples are at the *centres* of their intervals: the first is half a sample in
 * from the chunk's edge, and the last half a sample in from the other edge. Sampling
 * at the edges would put the outermost sample on the boundary between two chunks,
 * where both would sample the same point and neither would have a neighbour to agree
 * with.
 */
export const sampleWorld = (cell: CellCoord, along: number): number =>
  cellCentre(cell).x + (along - CHUNK_VOXELS / 2) * VOXEL_SIZE + VOXEL_SIZE / 2;

/** One sample's world position on all three axes, for the cube's own origin. */
export const sampleOriginOf = (cell: CellCoord): Vec3 => cellCentre(cell);

/**
 * The sample index nearest a world point within a chunk.
 *
 * Rounded rather than floored, because the sample positions are at interval centres:
 * a point exactly between two samples is equally near both, and the tie has to break
 * the same way every time or the field is not a function of position.
 */
export const sampleIndexIn = (world: number, centre: number): number =>
  Math.round((world - centre) / VOXEL_SIZE + CHUNK_VOXELS / 2 - 0.5);

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
