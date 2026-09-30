/**
 * The renderer: what the application draws with, and how.
 *
 * Separate from the mesher because the mesher runs in a worker and this does not. Nothing
 * here may be imported by `src/mesh/` — the dependency points this way only, and the one
 * thing that proves it is that `src/mesh/` builds and runs on the host with no DOM.
 */

export type { Precision } from "./precision-types";
export {
  type FragmentPrecision,
  type PrecisionContext,
  type PrecisionProbe,
  choosePrecision,
  describePrecision,
  detectFragmentPrecision,
  probeFragmentPrecision,
} from "./precision";

export { SurfaceMaterial, octahedralNode } from "./surface-material";

export type { SlotGeometry, SlotMesh } from "./chunk-geometry";
export {
  countDrawn,
  emptySlotGeometry,
  installChunkMesh,
  releaseSlotGeometry,
  slotDraws,
  toChunkGeometry,
  totalTriangles,
} from "./chunk-geometry";

export type { ApplyOutcome, Refusal, StoreHooks } from "./chunk-mesh-store";
export { ChunkMeshStore, hooksFor } from "./chunk-mesh-store";
