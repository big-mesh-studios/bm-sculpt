/**
 * Meshing: turning the field's sign into triangles.
 *
 * Kept separate from the field and from the renderer because this is the one part of
 * the pipeline that runs in a worker, repeatedly, and has to be free of anything that
 * would stop it: no DOM, no renderer types, no allocation per chunk. The seam rule
 * documented in `surface-nets.ts` is the reason the chunked mesher is correct at all,
 * and it is stated there rather than here.
 */

export {
  scratchFor,
  surfaceNets,
  SURFACE_NETS_CELLS,
  SURFACE_NETS_GRID,
  SurfaceNetsScratch,
  type SurfaceNetsParams,
  type SurfaceOutput,
  type SurfaceSampler,
} from "./surface-nets";

export {
  ChunkMeshBuilder,
  meshBytes,
  VERTEX_BYTES,
  type ChunkMesh,
} from "./chunk-mesh";

export { Growable } from "./growable";

export type {
  ChunkMesher,
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
  BaseFieldKind,
  CancelMessage,
  ChunkFailedMessage,
  ChunkMeshMessage,
  ChunkRequestMessage,
  FromWorker,
  ModelMessage,
  PaintTileMessage,
  ToWorker,
} from "./protocol";
export { isFromWorker, isToWorker, meshTransferables } from "./protocol";

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
