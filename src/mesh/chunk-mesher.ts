/**
 * Meshing one chunk, from a field.
 *
 * The mesher proper (`surface-nets.ts`) takes a sampler and a region and knows nothing
 * about chunks, levels of detail, candidate caches, normals or colours. This is the
 * layer that knows all of that, and it exists to keep the two apart: the mesher is a
 * pure algorithm that is easy to test and hard to get wrong, while everything specific
 * to this project lives here where it can be replaced wholesale.
 *
 * It is an interface with a TypeScript implementation for a reason stated in ADR 0003.
 * `fast-surface-nets-rs` compiled to WebAssembly is measurably faster, and this is the
 * seam it would come through — a substitution, not a rewrite. Anything the interface
 * needs and does not have is something that implementation would be missing too.
 */

import type { Bounds, Rgb8, Vec3 } from "../constants";
import { BLOCK_WORLD, VOXEL_SIZE } from "../constants";
import type { CellCoord, Lod } from "../world";
import { lodSampleSize, lodSamples } from "../world";

import { ChunkMeshBuilder, type ChunkMesh } from "./chunk-mesh";
import {
  scratchFor,
  surfaceNets,
  type SurfaceNetsScratch,
} from "./surface-nets";

/**
 * What a mesher is asked for: which chunk, and at what level.
 *
 * The level is a `Lod` rather than a sample count because it is what the rest of the
 * project schedules in, and converting it here keeps the conversion in one place. Two
 * chunks at different levels still tile seamlessly, which the mesher's tests pin.
 */
export interface MeshRequest {
  readonly cell: CellCoord;
  readonly lod: Lod;
}

/** Builds the mesh for a chunk. */
export interface ChunkMesher {
  mesh(request: MeshRequest): ChunkMesh;
}

/**
 * The samples and cells a chunk at a given level meshes, in world units.
 *
 * Stated once and used by both the mesher and its bounds checks, because the two must
 * agree exactly: the region declared to the candidate cache has to cover every sample
 * taken, or the cache answers from candidates gathered for somewhere else and the
 * surface comes out with holes in it.
 */
export interface ChunkRegion {
  /** The world position of the chunk's own first sample's voxel. */
  readonly origin: Vec3;
  /** Samples a chunk owns per axis, and so the sample grid's inner size. */
  readonly samples: number;
  /** World units between samples. */
  readonly sampleSize: number;
  /** The chunk's own world extent. */
  readonly bounds: Bounds;
  /**
   * Every sample taken, padding included.
   *
   * Wider than `bounds` by one sample on each side: the seam rule needs one cell of low
   * padding to give the interface edges their vertices, and the high side is padded to
   * match so the sampling loop is a plain cube.
   */
  readonly sampleBounds: Bounds;
}

/** The region a chunk at a level meshes. */
export const chunkRegion = (cell: CellCoord, lod: Lod): ChunkRegion => {
  const samples = lodSamples(lod);
  const sampleSize = lodSampleSize(lod);

  // A chunk's world centre is the middle of its samples. Its *origin* — the first sample
  // it owns — sits half a sample inside that, and the seam rule counts ownership from
  // there. Both are derived from the centre rather than from the chunk's edge, so that
  // the chunk's own extent is exactly `samples * sampleSize` and lands on a chunk
  // boundary at every level, which is what lets a coarse chunk stand in for four fine
  // ones.
  const centre = cell.x * BLOCK_WORLD;
  const centreY = cell.y * BLOCK_WORLD;
  const centreZ = cell.z * BLOCK_WORLD;
  const originX = centre - (samples / 2) * sampleSize;
  const originY = centreY - (samples / 2) * sampleSize;
  const originZ = centreZ - (samples / 2) * sampleSize;

  const span = samples * sampleSize;
  const pad = sampleSize;

  return {
    origin: { x: originX, y: originY, z: originZ },
    samples,
    sampleSize,
    bounds: {
      min: { x: originX, y: originY, z: originZ },
      max: { x: originX + span, y: originY + span, z: originZ + span },
    },
    sampleBounds: {
      min: { x: originX - pad, y: originY - pad, z: originZ - pad },
      max: {
        x: originX + span + pad,
        y: originY + span + pad,
        z: originZ + span + pad,
      },
    },
  };
};

/** The part of the field a mesher needs. The smallest thing that can hold it. */
export interface MeshField {
  distance(x: number, y: number, z: number): number;
  distanceForStepping(x: number, y: number, z: number): number;
  gradient(x: number, y: number, z: number, step?: number): Vec3;
  colourAt(x: number, y: number, z: number): Rgb8;
  /**
   * Declares a region about to be sampled, so one candidate cache serves all of it, and
   * returns the function that ends it.
   *
   * Optional: a field with no operation list has no candidates to cache. A mesher that
   * skips this still produces a correct mesh — it just gathers candidates per point
   * instead of once per chunk, which is most of the cost.
   */
  beginRegion?(bounds: Bounds): (() => void) | undefined;
  /** Whether a box could hold a surface at all. */
  couldHoldSurface(bounds: Bounds): boolean;
}

/**
 * Meshes chunks with Surface Nets.
 *
 * Holds its scratch buffers and its output builder for its whole life, because both
 * are sized for a chunk and reused for every chunk thereafter. Allocating them per
 * chunk would put two multi-megabyte allocations in the path of a 34,304-sample loop.
 */
export class SurfaceNetsChunkMesher implements ChunkMesher {
  private readonly scratch: SurfaceNetsScratch;
  private readonly builder = new ChunkMeshBuilder();

  constructor(
    private readonly field: MeshField,
    samples: number = lodSamples(0),
  ) {
    this.scratch = scratchFor(samples);
  }

  /**
   * Whether the chunk can be skipped without sampling it.
   *
   * The cheap half of streaming. A chunk entirely above the tallest thing the field can
   * produce has no sign change in it, and answering that costs one box test instead of
   * 34,304 field evaluations. `couldHoldSurface` returns true when it cannot tell, so
   * this never produces a wrong answer — only a missed saving.
   */
  couldHaveMesh(cell: CellCoord, lod: Lod): boolean {
    const region = chunkRegion(cell, lod);
    // The region that decides whether anything is in the chunk is the chunk's own extent
    // plus its padding: a surface just outside the padding still puts vertices inside the
    // chunk, so testing the bare bounds would skip chunks that have visible geometry.
    return this.field.couldHoldSurface(region.sampleBounds);
  }

  mesh(request: MeshRequest): ChunkMesh {
    const region = chunkRegion(request.cell, request.lod);

    // The candidate cache is told the whole sample region for the duration. Without this
    // the cache is rebuilt every few cells instead of once per chunk, which on the
    // measured cost of a chunk is the difference between one build and dozens.
    const endRegion =
      this.field.beginRegion?.(region.sampleBounds) ?? (() => {});

    try {
      surfaceNets({
        origin: [region.origin.x, region.origin.y, region.origin.z],
        samples: region.samples,
        sampleSize: region.sampleSize,
        sampler: {
          distance: (x, y, z) => this.field.distance(x, y, z),
        },
        out: this.builder,
        scratch: this.scratch,
        onVertex: (index, x, y, z) => {
          // Normals come from the field's gradient, which is central differences — six
          // extra field evaluations a vertex. That is why they are computed here, where
          // the vertex's position is already in hand, and not by the mesher, which would
          // have to know about fields at all.
          const normal = this.field.gradient(x, y, z);
          this.builder.setNormal(index, normal.x, normal.y, normal.z);
          const colour = this.field.colourAt(x, y, z);
          this.builder.setColour(index, colour);
        },
      });
    } finally {
      // The disposer drops the candidate cache, so the next chunk builds its own rather
      // than answering from candidates gathered for this one. It runs even if meshing
      // threw, because a worker that kept a stale region would silently mesh every
      // chunk after a failure with the wrong candidates.
      endRegion();
    }

    // `finish` copies to exact length, which is what leaves the thread by transfer.
    return this.builder.finish();
  }
}

/** How many samples a chunk at a level takes, for budgeting. */
export const sampleCount = (lod: Lod): number => {
  const samples = lodSamples(lod);
  return (samples + 2) ** 3;
};

/** How many world units a chunk at a level spans on one axis. */
export const chunkSpan = (lod: Lod): number =>
  lodSamples(lod) * lodSampleSize(lod);

/** The world position of a chunk's own first sample's voxel, on one axis. */
export const chunkOriginOn = (
  cell: CellCoord,
  axis: "x" | "y" | "z",
  lod: Lod,
): number =>
  cell[axis] * BLOCK_WORLD - (lodSamples(lod) / 2) * lodSampleSize(lod);

/** The size of one sample at a level, for anyone who needs it named. */
export const sampleSizeAt = (lod: Lod): number =>
  lodSampleSize(lod) || VOXEL_SIZE;
