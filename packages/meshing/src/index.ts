/**
 * Meshing a field into triangles.
 *
 * ## What is here and what is not
 *
 * **Three files, and the seam that makes them reusable.** `surfaceNets` takes a `SurfaceSampler` —
 * one method, a distance — and returns vertices and quads through a `SurfaceOutput`. That is the
 * whole contract, and it is why a second application whose models are not chunks can be meshed by
 * this package without anything in it knowing what a chunk is.
 *
 * `ChunkMeshBuilder` is the output implementation this repository uses: a twenty-bytes-per-vertex
 * packed layout, which a caller hands straight to a renderer.
 *
 * **The chunk pipeline is not here.** Region arithmetic, the worker protocol, the LOD ladder and
 * the paint-tile addressing are all in `apps/bm-sculpt/src/mesh/`, because they are that
 * application's rather than meshing's (ADR 0024).
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
