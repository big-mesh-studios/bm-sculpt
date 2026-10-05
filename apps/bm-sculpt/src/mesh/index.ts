/**
 * The chunk pipeline: turning a streamed region into triangles, on a worker.
 *
 * ## What is here and what is not
 *
 * **The region arithmetic and the worker protocol, and nothing about a field.** This is the half
 * of meshing that knows what a *chunk* is — how many samples it holds, which cell of it a sample
 * belongs to, how a LOD stride divides it — and none of that is meshing. `SurfaceNets` itself,
 * which is what actually turns a distance function into quads, is in
 * `@big-mesh-studios/meshing` with a one-method sampler and no idea a chunk exists.
 *
 * That split is the reason a second application can be meshed by the same code: it brings a
 * different idea of a region, or none, and reaches for the mesher rather than for this (ADR 0024).
 *
 * ## The rule this directory keeps
 *
 * **The worker never reaches back to the main thread.** Everything crossing the boundary is a
 * `ModelMessage` of plain numbers, because the operation list is structured-cloned on every change
 * and a payload holding a class or a closure would arrive at the worker as something else. The
 * assertion is in `worker.test.ts`.
 */

export {
  NO_OVERLAP,
  OVERLAP_CELLS,
  overlapCells,
  paddingOf,
  type OverlapCells,
} from "./overlap";

export type {
  ChunkMesher,
  ChunkMeshers,
  ChunkRegion,
  MeshField,
  MeshRequest,
} from "./chunk-mesher";
export {
  chunkOriginOn,
  chunkRegion,
  chunkSpan,
  sampleCount,
  sampleSizeAt,
  SurfaceNetsChunkMesher,
} from "./chunk-mesher";

export type {
  CancelMessage,
  ChunkFailedMessage,
  ChunkMeshMessage,
  ChunkRequestMessage,
  FromWorker,
  MeshedChunk,
  ModelMessage,
  PaintTileMessage,
  ToWorker,
} from "./protocol";
export {
  isFromWorker,
  isToWorker,
  meshedOf,
  meshTransferables,
} from "./protocol";

export type { Handled, MesherFactory, Wanted, WorkerState } from "./worker";
export {
  emptyWorkerState,
  handleMeshMessage,
  replyCell,
  replyIsWanted,
} from "./worker";

export type {
  PoolHandlers,
  PoolWorker,
  WorkerFactory,
  WorldWorkerPoolOptions,
} from "./worker-pool";
export { WorldWorkerPool } from "./worker-pool";

export {
  meshersFor,
  paintTilesOf,
  TilePaint,
  type WorkerPaint,
} from "./model-field";

export {
  couldHoldWater,
  outOfTheGround,
  seaDistanceOf,
  WaterChunkMesher,
} from "./water-mesher";

export { runWorker } from "./mesh-worker";
