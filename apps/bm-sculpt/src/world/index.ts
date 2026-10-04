/**
 * The world: which chunks exist, which slot each is in, and what colour they hold.
 *
 * One import for everything the renderer, the mesher and the picker need to know
 * about space. Nothing here touches the renderer, the DOM, or the field — a meshing
 * worker needs the chunk window's arithmetic and nothing else, and keeping the
 * dependency that way is what lets it run off the main thread.
 *
 * `docs/adr/0005-streaming-shape.md` is the decision this whole directory exists to
 * implement: slots are positions in a recycled array, never names.
 */

// **The types come from `core` and the numbers from this application.** That split used to
// be invisible because both lived in one `constants.ts`; ADR 0024 moved the four types out,
// and a barrel that re-exported both would hide the difference from every reader of this file.
export type { Bounds, Quat, Rgb8, Vec3 } from "@big-mesh-studios/core";
export { FAR_DISTANCE, SOFTNESS_REACH } from "@big-mesh-studios/core";
export {
  BLOCK_WORLD,
  BVH_CANDIDATE_CELL,
  CHUNK_VOXELS,
  FIELD_BORDER,
  LOD_COUNT,
  LOD_STRIDE,
  VOXEL_SIZE,
  lodVoxels,
  lodWorld,
} from "../constants";

export type { CellCoord, Lod, LodBands, OverlapMask } from "./level-data";
export {
  DEFAULT_LOD_BANDS,
  LOD_OFF,
  OVERLAP_DIRECTIONS,
  OVERLAP_X_NEG,
  OVERLAP_X_POS,
  OVERLAP_Y_NEG,
  OVERLAP_Y_POS,
  OVERLAP_Z_NEG,
  OVERLAP_Z_POS,
  cellCentre,
  cellDistance,
  cellInSphere,
  cellsInSphere,
  chunkCellOf,
  lodAt,
  lodExtent,
  lodIsOff,
  lodSampleSize,
  lodSamples,
  lodStride,
  overlapMaskAt,
  sameCell,
  sampleIndexIn,
  sampleWorld,
  sphereCells,
} from "./level-data";

export { CoordinateMap } from "./coordinate-map";

export type { ChunkSlot, ChunkWindowParams } from "./chunk-window";
export { ChunkWindow } from "./chunk-window";

export type { PaintedBox, Tile } from "./paint-tiles";
export {
  PaintTiles,
  TILE_BYTES,
  TILE_COLOURS,
  emptyTile,
  makeTile,
  sampleInTile,
  tileIndex,
} from "./paint-tiles";
