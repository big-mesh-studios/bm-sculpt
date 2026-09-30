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

export type { CellCoord, Lod, LodBands } from "./level-data";
export {
  DEFAULT_LOD_BANDS,
  LOD_OFF,
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
