/**
 * Naive Surface Nets.
 *
 * For every cell whose eight corner samples disagree on sign, emit **one** vertex,
 * placed at the average of the crossings along that cell's edges; then, for every
 * primal edge where the sign changes, emit a quad from the four cells sharing it.
 *
 * Chosen over marching cubes (ADR 0003) for three reasons that all matter here: one
 * vertex per cell rather than two to five triangles; no 256-entry table and no
 * ambiguous cases; and a surface that reads as smooth where marching cubes' reads as
 * voxelised.
 *
 * ## The seam rule, and why it is the only subtle thing here
 *
 * A chunk owns a range of **cells**, and a quad belongs to a primal **edge**. The
 * four cells around an edge straddle chunk boundaries — the edge at the interface has
 * cells on either side of it — so "each chunk meshes its own cells" does not say who
 * emits the interface quads. Both halves would, or neither would, and both produce a
 * visible artefact: duplicated geometry, or a crack.
 *
 * The rule is: **each chunk owns the edges lying within its own cells' span, and
 * takes the four cells it needs from one cell of padding on the low side.**
 *
 *     a chunk owning cells [base, base + n) emits edges at [base, base + n)
 *
 * Neighbouring chunks therefore emit consecutive, disjoint runs, every edge in the
 * world is emitted exactly once, and no stitching is involved. The reference
 * implementation states the same property in one line — *faces are not generated on a
 * chunk's positive boundaries* — and this is the same rule written as what each chunk
 * *does* rather than what it avoids.
 *
 * ## Index layout
 *
 * With `n` samples a chunk owns per axis, and `O` the world position of its own first
 * sample's voxel:
 *
 * - the sample array holds `n + 2` per axis, indices `0 .. n + 1`
 * - sample `s` is at world `O + (s - 1)`, so indices `1 .. n` are the chunk's own
 * - cell `c` spans samples `c` and `c + 1`, so cell `c` is the cell of world voxel
 *   `O + c - 1`, and there are `n + 1` cells, indices `0 .. n`
 * - cell `0` is therefore one cell of **low padding**, and exists only to give the
 *   interface edges their vertices
 * - an edge leaves grid point `p` toward `p + e`; the four cells sharing it all have
 *   index `p` on the edge's own axis, and `p - 1` or `p` on each of the other two
 *
 * Those four-cell indices are what fix the loop ranges. `p` must be `1 .. n` on the
 * edge's own axis to be owned, and `1 .. n` on the other two so that `p - 1` still
 * names a cell. One range, both reasons.
 */

/** What the mesher needs from whatever it is meshing. */
export interface SurfaceSampler {
  /** Signed distance at a world position; negative inside. */
  distance(x: number, y: number, z: number): number;
}

/** A mesh being accumulated into. Passed in so a thread reuses one for every chunk. */
export interface SurfaceOutput {
  clear(): void;
  vertexCount: number;
  /** Appends a vertex at a world position. Returns its index. */
  vertex(x: number, y: number, z: number): number;
  /**
   * Appends two triangles from four existing vertices, in the order given.
   *
   * **A quad and not a triangle because every dual method emits quads**, and an output that
   * only took triangles would have the other half of this seam added for a primal method's sake.
   */
  quad(a: number, b: number, c: number, d: number): void;
  /**
   * Appends one triangle from three existing vertices.
   *
   * **Optional, and that is the point of it being optional rather than absent.** Surface nets
   * never calls it, and a `SurfaceOutput` that a test writes by hand should not have to
   * implement a method nothing will call. A mesher that needs it and does not find it throws
   * rather than silently dropping triangles.
   */
  triangle?(a: number, b: number, c: number): void;
}

/** Appends one triangle, refusing to say nothing if the output cannot take one. */
export const emitTriangle = (
  out: SurfaceOutput,
  a: number,
  b: number,
  c: number,
): void => {
  if (out.triangle === undefined) {
    throw new Error("this SurfaceOutput cannot take a triangle");
  }
  out.triangle(a, b, c);
};

/** The eight corners of a cell, as offsets from its low corner. */
const CORNER_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
] as const;

/**
 * The twelve edges of a cell, as pairs of its corner indices.
 *
 * Six along the cell's own axes and six across its faces. The face-crossing ones are
 * why a cell's vertex is a weighted average of crossings that are not all parallel to
 * anything in particular.
 */
const CELL_EDGES = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

/**
 * Samples a chunk owns per axis: `n`. The grid holds one more on each side.
 *
 * Only one on the low side is ever needed — the seam rule puts every chunk's low cell
 * at index 0 and its last own cell at index `n`, which needs samples `n` and `n + 1`.
 * Both sides are padded so the sampling loop is a plain cube rather than a special case
 * on the high edge.
 */
export const SURFACE_NETS_GRID = (samplesPerAxis: number): number =>
  samplesPerAxis + 2;

/** Cells along an axis: one more than the grid. */
export const SURFACE_NETS_CELLS = (samplesPerAxis: number): number =>
  samplesPerAxis + 1;

/** Reusable per-thread buffers, sized for one chunk shape and then reused. */
export class SurfaceNetsScratch {
  readonly samples: Float32Array;
  /** Cell index to emitted vertex index, or -1. Fixed size: a lookup, not a log. */
  readonly cellVertex: Int32Array;
  /** The eight corner samples of the cell being considered. */
  readonly corners = new Float32Array(8);

  constructor(samplesPerAxis: number) {
    const n = samplesPerAxis;
    this.samples = new Float32Array(SURFACE_NETS_GRID(n) ** 3);
    this.cellVertex = new Int32Array(SURFACE_NETS_CELLS(n) ** 3);
  }
}

export interface SurfaceNetsParams {
  /** The world position of the chunk's own first sample's voxel. */
  origin: readonly [number, number, number];
  /** Samples a chunk owns per axis. The sample grid is two larger. */
  samples: number;
  /** World units between samples. Ignored where `lanes` is given. */
  sampleSize: number;
  /**
   * Where each sample actually sits on each axis, when that is not a single spacing.
   *
   * **Optional, and the uniform case is not a special case in the loops.** Omitting it
   * builds the even lane `origin + (s - 1) * sampleSize` once and then runs the same code
   * as any other lane set, so there is one code path rather than two that have to agree.
   *
   * It exists because "evenly spaced" is an assumption about the *world*, not about this
   * algorithm, and at a level-of-detail boundary it stops being true. A coarse chunk and a
   * fine one put their owned cells either side of the shared plane — a fine chunk's last
   * cell ends at `x = 160` and a coarse one's begins at `x = 160` — so a chunk that refined
   * its own boundary shell would have cells of two different widths, and a vertex placed
   * by `origin + (c - 0.5) * sampleSize` would be in the wrong place by the difference.
   *
   * Giving the algorithm the sample positions rather than a spacing is what lets that be
   * expressed at all; the crossing parameter itself is unchanged, because a linear
   * interpolation crosses zero at the same *fraction* of an edge whatever its length.
   */
  lanes?: SampleLanes;
  sampler: SurfaceSampler;
  out: SurfaceOutput;
  scratch: SurfaceNetsScratch;
  /**
   * Told each emitted vertex's world position, so a caller can fill in its normal and
   * colour without walking the positions array again.
   */
  onVertex?: (index: number, x: number, y: number, z: number) => void;
}

/** World position of every sample index along one axis, `0 .. samples + 1`. */
export type SampleLane = Float64Array;

/** A sample lane per axis. */
export interface SampleLanes {
  readonly x: SampleLane;
  readonly y: SampleLane;
  readonly z: SampleLane;
}

/** The lane an evenly spaced grid would have: sample `s` sits at `origin + (s - 1) * step`. */
export const uniformLane = (
  origin: number,
  step: number,
  grid: number,
): SampleLane => {
  const lane = new Float64Array(grid);
  for (let s = 0; s < grid; s++) lane[s] = origin + (s - 1) * step;
  return lane;
};

/**
 * Meshes one chunk's surface into `out`, which is emptied first.
 *
 * Two passes, and the split is load-bearing. The first pass samples the field into a
 * scratch buffer and then never touches the field again; the cell loop reads only
 * that buffer. The field call is a tree walk in the operations (ADR 0004) and this is
 * the densest loop in the project, so interleaving the two would turn every one of
 * `grid³` samples into a cell walk as well.
 */
export const surfaceNets = (params: SurfaceNetsParams): void => {
  const { origin, samples, sampleSize, sampler, out, scratch } = params;
  const grid = SURFACE_NETS_GRID(samples);
  const cells = SURFACE_NETS_CELLS(samples);
  const STRIDES = strideTable(cells);

  // Where each sample sits on each axis, resolved once. An even grid is built rather than
  // special-cased in the loops below, so there is a single version of the hot code and it
  // is the version that supports uneven spacing.
  const px = params.lanes?.x ?? uniformLane(origin[0], sampleSize, grid);
  const py = params.lanes?.y ?? uniformLane(origin[1], sampleSize, grid);
  const pz = params.lanes?.z ?? uniformLane(origin[2], sampleSize, grid);

  out.clear();

  const sample = (x: number, y: number, z: number): number =>
    scratch.samples[(z * grid + y) * grid + x];
  for (let z = 0; z < grid; z++) {
    const wz = pz[z] as number;
    for (let y = 0; y < grid; y++) {
      const wy = py[y] as number;
      for (let x = 0; x < grid; x++) {
        scratch.samples[(z * grid + y) * grid + x] = sampler.distance(
          px[x] as number,
          wy,
          wz,
        );
      }
    }
  }

  scratch.cellVertex.fill(-1, 0, cells * cells * cells);

  // ---- One vertex per cell whose corners disagree.
  for (let cz = 0; cz < cells; cz++) {
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        let inside = 0;
        for (let corner = 0; corner < 8; corner++) {
          const [dx, dy, dz] = CORNER_OFFSETS[corner];
          const value = sample(cx + dx, cy + dy, cz + dz);
          scratch.corners[corner] = value;
          if (value < 0) inside++;
        }
        // All eight corners one side: no crossing, so no vertex. This is where a chunk
        // that is entirely air or entirely solid costs eight reads per cell and
        // nothing else.
        if (inside === 0 || inside === 8) continue;

        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let crossings = 0;
        for (const [a, b] of CELL_EDGES) {
          const va = scratch.corners[a];
          const vb = scratch.corners[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sumX += (a & 1) + t * ((b & 1) - (a & 1));
          sumY += (a & 2 ? 1 : 0) + t * ((b & 2 ? 1 : 0) - (a & 2 ? 1 : 0));
          sumZ += (a & 4 ? 1 : 0) + t * ((b & 4 ? 1 : 0) - (a & 4 ? 1 : 0));
          crossings++;
        }

        // The average is in the cell's own corner coordinates, 0..1, on each axis. That is
        // a *fraction of the cell*, not a distance, which is why it survives the cell
        // being a different width from its neighbours: the cell's own two samples give
        // where its low corner is and how wide it is, and the fraction says how far along
        // it the crossing fell. Subtracting a half centres it on the cell, which is what
        // makes it a dual vertex rather than a point somewhere near one.
        //
        // Cell `c` is the cell of world voxel `origin + c - 1`, so its own samples are
        // `c` and `c + 1` on the lane and its centre is their middle.
        const worldX =
          (px[cx] as number) +
          (sumX / crossings) * ((px[cx + 1] as number) - (px[cx] as number));
        const worldY =
          (py[cy] as number) +
          (sumY / crossings) * ((py[cy + 1] as number) - (py[cy] as number));
        const worldZ =
          (pz[cz] as number) +
          (sumZ / crossings) * ((pz[cz + 1] as number) - (pz[cz] as number));

        scratch.cellVertex[(cz * cells + cy) * cells + cx] = out.vertex(
          worldX,
          worldY,
          worldZ,
        );
        params.onVertex?.(
          scratch.cellVertex[(cz * cells + cy) * cells + cx],
          worldX,
          worldY,
          worldZ,
        );
      }
    }
  }

  // ---- One quad per owned edge whose sign changes.
  //
  // `p` runs 1..n on every axis: on the edge's own axis because that is the run of
  // edges this chunk owns, and on the other two because the four cells need `p - 1` to
  // name a cell.
  //
  // The four cells round an edge along `axis` all share the index `p` on that axis —
  // the edge lies between cells `p` and `p + 1`, and the four sharing it are the ones
  // at `p` — and take `p - 1` or `p` on the other two. Derived from strides rather
  // than written out three times, because writing it out three times is how the y and z
  // rows came to disagree with the x one.
  for (let pz = 1; pz <= samples; pz++) {
    for (let py = 1; py <= samples; py++) {
      for (let px = 1; px <= samples; px++) {
        const base = (pz * cells + py) * cells + px;
        const nearInside = sample(px, py, pz) < 0;

        for (let axis = 0; axis < 3; axis++) {
          const farInside =
            axis === 0
              ? sample(px + 1, py, pz) < 0
              : axis === 1
                ? sample(px, py + 1, pz) < 0
                : sample(px, py, pz + 1) < 0;

          const acrossB = STRIDES[OTHER_AXES[axis][0]];
          const acrossC = STRIDES[OTHER_AXES[axis][1]];

          // A cycle round the edge: (b-1, c-1), (b, c-1), (b, c), (b-1, c).
          quadAcross(
            nearInside,
            farInside,
            [
              scratch.cellVertex[base - acrossB - acrossC],
              scratch.cellVertex[base - acrossC],
              scratch.cellVertex[base],
              scratch.cellVertex[base - acrossB],
            ],
            out,
          );
        }
      }
    }
  }
};

/** The linear stride of one cell step along each axis, for `cells` cells a side. */
const strideTable = (cells: number): readonly number[] => [
  1,
  cells,
  cells * cells,
];

/** The two axes other than each axis. */
const OTHER_AXES: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 0],
  [0, 1],
];

/**
 * Emits a quad if the sign changed, and only if all four of its cells have vertices.
 *
 * A cell with no vertex is one the surface did not cross, so the surface simply does
 * not reach this edge. Emitting a degenerate triangle there instead would put a
 * zero-area face in the mesh, which every normal calculation downstream has to
 * special-case and which casts as a black speck under any lighting.
 *
 * The winding is reversed depending on which end of the edge is inside, because the
 * cycle of cells round an edge is clockwise from one end and anticlockwise from the
 * other. Without it, half the world's quads face inward.
 */
const quadAcross = (
  nearInside: boolean,
  farInside: boolean,
  vertices: readonly number[],
  out: SurfaceOutput,
): void => {
  if (nearInside === farInside) return;
  for (const vertex of vertices) if (vertex < 0) return;
  if (nearInside) {
    out.quad(vertices[0], vertices[1], vertices[2], vertices[3]);
  } else {
    out.quad(vertices[0], vertices[3], vertices[2], vertices[1]);
  }
};

/** Scratch for a chunk meshing `samples` samples per axis. */
export const scratchFor = (samples: number): SurfaceNetsScratch =>
  new SurfaceNetsScratch(samples);
