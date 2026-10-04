/**
 * Meshing one patch of a cube face.
 *
 * ## Why this is not the chunk mesher with different numbers
 *
 * A chunk on a cubic lattice samples a **separable** grid: the sample at index `(i, j, k)` is at
 * `origin + (px[i], py[j], pz[k])`, and each axis's positions can be listed on its own. That is
 * what `SurfaceNetsParams.lanes` describes, and it is why a cubic chunk needs three arrays.
 *
 * A patch of a cube face cannot be sampled that way. Its three axes are **two face parameters and
 * a radial depth**, and the sample at `(u, v, w)` is at `directionAt(u, v) · (r + w)` — a direction
 * depending on `u` and `v` *together*. No product of three per-axis lists expresses that, which is
 * why `surfaceNets` grew a `sampleAt` hook beside `lanes` rather than in place of it. See ADR 0038.
 *
 * ## The grid, and why depth is small
 *
 * `side` samples across the patch in each face parameter; `depth` samples across a radial band that
 * brackets the terrain. **Tangential resolution carries the detail and radial resolution carries
 * almost none**, because surface nets finds a crossing by interpolating along an edge and a linear
 * interpolation crosses zero at the same *fraction* of an edge whatever its length. Depth exists to
 * put samples on both sides of the surface, not to resolve it.
 *
 * ## The radial band, and the assumption in it
 *
 * The band must bracket the terrain *everywhere in the patch*, or part of the patch gets no surface
 * and the hole is permanent — `couldHoldSurface`'s rule that an answer of "no" cannot be taken back.
 *
 * It is derived from the patch's own `(side + 1)²` corner grid, padded by the largest step between
 * neighbouring samples on that grid times a safety factor. **The assumption is that the terrain
 * does not move further between two adjacent tangential samples than it does across the grid**, and
 * that is an assumption rather than a proof: it holds because the noise is smooth at this scale and
 * the grid is at least as fine as the mesh. `patch-mesher.test.ts` checks it the only way it can be
 * checked honestly — by meshing patches across a whole planet and requiring every one to produce
 * geometry. A band that was too narrow would show up there as an empty patch.
 *
 * The alternative — the planet's global radius band — is exactly conservative and useless: it spans
 * the entire relief of the planet, so a patch that happens to be flat would be sampled across a
 * range hundreds of units deep to find a crossing it does not have.
 */

import {
  ChunkMeshBuilder,
  surfaceNets,
  scratchFor,
  type ChunkMesh,
} from "@big-mesh-studios/meshing";
import {
  PATCH_ROOT,
  directionAt,
  patchRange,
  type Patch,
} from "@big-mesh-studios/csg";
import type { BaseField } from "@big-mesh-studios/csg";
import type { Bounds, Rgb8, Vec3 } from "@big-mesh-studios/core";

/** What a patch mesh needs to know beyond the patch itself. */
export interface PatchMeshParams {
  /** The field to sample. A function, so this file needs no knowledge of planets. */
  readonly field: (x: number, y: number, z: number) => number;
  /** Where the surface's normal points at a point, for shading. */
  readonly gradientAt: (x: number, y: number, z: number) => Vec3;
  /** The colour of the surface at a point. */
  readonly colourAt: (
    x: number,
    y: number,
    z: number,
  ) => { colour: Rgb8; opacity: number };
  /**
   * Told the box the patch's samples occupy, before they are taken, so a field with a candidate
   * cache can build it once — as `chunk-mesher.ts` does for chunks, for the same reason.
   */
  readonly beginRegion?: (bounds: Bounds) => (() => void) | undefined;
  /**
   * Which sides have a finer neighbour, and so want this patch to reach one sample into them.
   *
   * **ADR 0035 in patch terms.** Two patches of different size tessellate the same surface and
   * disagree by the level-of-detail error, so where they meet one of them has to continue past the
   * shared edge or there is a lens-shaped gap along it. For chunks that continuation is one *cell*;
   * for a patch it is one *sample step*, which is the same idea at the patch's own resolution — and
   * one quadrant would be wrong, doubling the patch's extent to cover a boundary the sampling can
   * already reach across.
   */
  readonly overlap?: PatchOverlap;
  /**
   * The band beyond the sampled terrain, in world units, at least.
   *
   * **Not `side` or `depth`.** Those belong to the mesher and not to the call, because the
   * scratch buffers are sized for them once and live for the mesher's whole life. The first version
   * took both, and a caller that passed neither got the module defaults — 16 — against a scratch
   * sized for the 8 it had constructed with, which fails at the first mesh with a complaint about
   * buffer sizes that names neither the cause nor the fix.
   *
   * Non-zero because a sample sitting exactly on a crossing has an ambiguous sign, and the band
   * would otherwise be allowed to collapse to zero width.
   */
  readonly pad?: number;
}

/**
 * The two rows and columns `surfaceNets` adds beyond the samples it is asked for.
 *
 * **The grid is two larger than `samples` on every axis, and the lanes have to be that long.**
 * The first version sized them from the sample count, so the outermost grid row indexed one past
 * the end of a `Float64Array`, read `undefined`, and multiplied it into a `NaN` position. Every
 * sample on that row was `NaN`, no cell on it had a sign change, and all 384 patches of the planet
 * meshed to nothing — with no error anywhere, because `NaN` compares false against both signs.
 */
const GRID_MARGIN = 2;

/**
 * How far past the sampled terrain the band reaches, as a multiple of the largest step between
 * neighbouring samples.
 *
 * **Two, and it is a safety factor rather than a bound.** A neighbour-to-neighbour step on the
 * corner grid is the finest variation the grid can see; the worst case between two samples is
 * somewhat larger, and this is the margin that covers it. `patch-mesher.test.ts` is what holds the
 * result honest.
 */
const BAND_SAFETY = 2;

/** The radial band a patch's samples must span, and the box those samples occupy. */
export interface PatchBand {
  readonly low: number;
  readonly high: number;
  readonly bounds: Bounds;
}

/**
 * The band of radii a patch's samples must cover, from the patch's own terrain.
 *
 * Evaluated on the `(side + 1)²` corner grid — the same grid the mesh samples, so the band and the
 * samples cannot disagree about where the terrain is.
 */
export const patchBand = (
  patch: Patch,
  radiusAt: (d: Vec3) => number,
  side: number,
  pad: number,
): PatchBand => {
  const [ur, vr] = patchRange(patch);
  let low = Infinity;
  let high = -Infinity;
  let biggestStep = 0;
  const radii: number[][] = [];

  for (let j = 0; j <= side; j++) {
    const row: number[] = [];
    // **`v` from `vr` and `u` from `ur`, in that order and not the other way round.**
    //
    // Taking both from `ur` walks a diagonal strip of the parameter square rather than the square,
    // so the band misses most of the patch's terrain. It fails quietly: the band is still a
    // perfectly good band, just for the wrong region and some tens of units too low, so every
    // sample lands inside the planet, every value is negative, and the finest patches mesh to
    // nothing while the coarse ones look fine. The transpose — `v` from `ur`, `u` from `vr` — is
    // the same defect wearing different clothes, and both were present here at once.
    const v = vr[0] + ((vr[1] - vr[0]) * j) / side;
    for (let i = 0; i <= side; i++) {
      const u = ur[0] + ((ur[1] - ur[0]) * i) / side;
      const r = radiusAt(directionAt(patch.face, u, v));
      row.push(r);
      if (r < low) low = r;
      if (r > high) high = r;
    }
    radii.push(row);
  }

  for (let j = 0; j <= side; j++) {
    for (let i = 0; i <= side; i++) {
      const here = radii[j]![i]!;
      if (i < side)
        biggestStep = Math.max(biggestStep, Math.abs(here - radii[j]![i + 1]!));
      if (j < side)
        biggestStep = Math.max(biggestStep, Math.abs(here - radii[j + 1]![i]!));
    }
  }

  const margin = Math.max(pad, biggestStep * BAND_SAFETY);
  const lo = low - margin;
  const hi = high + margin;

  // The box the samples occupy, from the patch's directions at the band's ends. An AABB is a
  // conservative bound on a warped patch, which is all a candidate cache is asked for.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const radius of [lo, hi]) {
    for (const [u, v] of [
      [ur[0], vr[0]],
      [ur[1], vr[0]],
      [ur[0], vr[1]],
      [ur[1], vr[1]],
    ] as const) {
      const d = directionAt(patch.face, u, v);
      const x = d.x * radius;
      const y = d.y * radius;
      const z = d.z * radius;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  return {
    low: lo,
    high: hi,
    bounds: {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    },
  };
};

/** What one patch's mesh costs and produces. */
export type { ChunkMesh };

/**
 * Meshes one patch.
 *
 * Holds its scratch and its builder for its whole life, as `SurfaceNetsChunkMesher` does — both
 * are large and allocating them per patch would dominate the cost of meshing.
 */
export class PatchMesher {
  private readonly scratch;
  private readonly builder = new ChunkMeshBuilder();

  /** Samples across the patch in each face parameter. Fixed for this mesher's life. */
  private readonly side: number;
  /** Samples across the radial band. Fixed, and small on purpose. */
  private readonly depth: number;
  /** The band pad, in world units, at least. */
  private readonly pad: number;

  /**
   * @param side samples across each face parameter.
   * @param depth samples across the radial band.
   * @param pad world units of band beyond the sampled terrain, at least.
   *
   * **The three are constructor arguments because the scratch is sized from them once.** A caller
   * that could vary `side` per mesh would be able to ask for a grid the buffers cannot hold, and
   * the failure arrives as a size mismatch inside the mesher rather than as a rejected call.
   */
  constructor(side: number, depth: number, pad: number) {
    this.side = side;
    this.depth = depth;
    this.pad = pad;
    // Sized for the grid `surfaceNets` asks for, which is one larger than the samples on each
    // axis plus the two it needs either side. A scratch one cell short does not fail loudly — it
    // reads air where samples should be, which is a solid field meshing as half solid.
    this.scratch = scratchFor([side + 1, side + 1, depth + 1]);
  }

  /**
   * Meshes a patch, or `undefined` when it holds no surface.
   *
   * **`undefined` and not an empty mesh**, because the caller streaming patches has to tell "no
   * surface here" from "a surface that has not arrived". The first means stop asking; the second
   * means keep asking.
   */
  mesh(
    patch: Patch,
    radiusAt: (d: Vec3) => number,
    params: PatchMeshParams,
  ): ChunkMesh | undefined {
    const { side, depth } = this;
    const pad = params.pad ?? this.pad;
    const overlap = params.overlap ?? NO_OVERLAP;
    const band = patchBand(patch, radiusAt, side, pad);
    const endRegion = params.beginRegion?.(band.bounds) ?? (() => {});
    const [ur, vr] = widenedRange(patch, overlap, side);
    const endRegionFinally = endRegion;

    // **Lanes run one sample beyond the patch on every side**, because the grid's outermost row and
    // column exist to bound the cells at the patch's edge. Fraction `(i - 1) / side` puts the
    // owned samples at `1 .. side` — which is the run `samples` asks for — and grid indices `0`
    // and `side + 1` one step outside it. Without that skirt the edge cells are infinitely thin,
    // the crossing on the boundary is unresolved, and a patch's surface stops short of its own
    // edge, which is a gap between every pair of neighbours.
    const uAt = new Float64Array(side + GRID_MARGIN);
    const vAt = new Float64Array(side + GRID_MARGIN);
    const wAt = new Float64Array(depth + GRID_MARGIN);
    for (let i = 0; i < uAt.length; i++) {
      const t = (i - 1) / side;
      uAt[i] = ur[0] + (ur[1] - ur[0]) * t;
      vAt[i] = vr[0] + (vr[1] - vr[0]) * t;
    }
    for (let k = 0; k < wAt.length; k++) {
      wAt[k] = band.low + (band.high - band.low) * ((k - 1) / depth);
    }

    try {
      surfaceNets({
        // Placeholders. `positionAt` is what places this grid, so the separable fields are never
        // read — they are still required because they are how a *separable* grid says where it
        // runs, and the two mechanisms are alternatives rather than additions.
        origin: [0, 0, 0],
        samples: [side, side, depth],
        sampleSize: 1,
        sampler: { distance: params.field },
        // **The position, not the value** — see `SurfaceNetsParams.positionAt`. A vertex on a
        // warped grid is placed by interpolating along its cell's edges between the corners' real
        // positions, so a hook returning only values leaves the mesher reading the placeholder lanes
        // above and putting every vertex within a few units of the origin. The first version of
        // this file did exactly that and produced a planet whose vertices were all at radius eight.
        positionAt: (i, j, k): readonly [number, number, number] => {
          const d = directionAt(patch.face, uAt[i]!, vAt[j]!);
          const w = wAt[k]!;
          return [d.x * w, d.y * w, d.z * w];
        },
        out: this.builder,
        scratch: this.scratch,
        onVertex: (index, x, y, z) => {
          // Normals from the field's gradient — six extra field evaluations a vertex — computed
          // here where the position is already in hand, rather than by the mesher, which would
          // have to know about fields at all.
          const normal = params.gradientAt(x, y, z);
          this.builder.setNormal(index, normal.x, normal.y, normal.z);
          const { colour, opacity } = params.colourAt(x, y, z);
          this.builder.setColour(index, colour, Math.round(opacity * 255));
        },
      });
    } finally {
      // Drops the candidate cache. Runs even if meshing threw, because a worker that kept a stale
      // region would mesh every later patch against the wrong candidates.
      endRegionFinally();
    }

    return this.builder.finish();
  }
}

/** The base-field interface a patch mesher is given, named so callers need not restate it. */
export type { BaseField };

/**
 * Which of a patch's four sides have a finer neighbour across them.
 *
 * **Sides rather than faces, because a patch is a quad on a cube face** and its neighbours are
 * across its four edges. Two patches of different size cannot be face-adjacent the way two chunks
 * are, because a level-of-detail boundary on a quadtree runs along patch edges and every patch has
 * four of them.
 */
export interface PatchOverlap {
  readonly lowX: boolean;
  readonly highX: boolean;
  readonly lowY: boolean;
  readonly highY: boolean;
}

/** Nothing reaches into anything, for a patch with no finer neighbour. */
const NO_OVERLAP: PatchOverlap = {
  lowX: false,
  highX: false,
  lowY: false,
  highY: false,
};

/**
 * A patch's parameter box, widened by one sample step on each side that has a finer neighbour.
 *
 * **The band is measured on the patch's own box and not the widened one**, and that is the one
 * thing here that could quietly go wrong. The overlap is a continuation past the shared edge to
 * *cover the disagreement* between two tessellations — not a claim that this patch's terrain extends
 * past its own boundary. Measuring the band on the widened box would pull in the neighbour's terrain
 * and mesh it as if it were this patch's, which is the overlap's purpose and its exact opposite.
 */
const widenedRange = (
  patch: Patch,
  overlap: PatchOverlap,
  side: number,
): readonly [readonly [number, number], readonly [number, number]] => {
  const [ur, vr] = patchRange(patch);
  const step = (2 * patch.size) / PATCH_ROOT / side;
  return [
    [ur[0] - (overlap.lowX ? step : 0), ur[1] + (overlap.highX ? step : 0)],
    [vr[0] - (overlap.lowY ? step : 0), vr[1] + (overlap.highY ? step : 0)],
  ];
};
