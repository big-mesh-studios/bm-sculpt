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
 *
 * ## A chunk may own cells outside its own extent
 *
 * `extra` widens the run of owned cells per axis, to `1 .. n + extra`, and everything
 * above follows from that: the grid is two larger than the run rather than than `n`, and
 * the grid is rectangular rather than cubic, so the strides come off the cell counts
 * instead of off one `cells`.
 *
 * The run still *begins* at `origin`, so a caller whose extra cell lies below its chunk
 * says so by lowering `origin` rather than by asking for a negative index. That is the
 * whole reason the parameter is a count per axis and not a range: a chunk reaching into
 * its neighbour on one face should own one extra cell, not a shell of them.
 *
 * ## A cell may be refused, and a second field sampled to say why
 *
 * `cellGate` exists for the case where a surface should stop against another surface
 * that something else already draws: the sea's surface, which is everywhere as a sphere
 * but is water only where it stands in open air, and is buried in the landscape
 * everywhere else. The gate is asked, per cell, whether any of that cell's corners is
 * inside the ground, and a cell it refuses gets no vertex — and therefore no quads,
 * because a quad naming a missing vertex is already refused. `marker` is the ground,
 * sampled in the same pass as the water, so the cell loop never has to touch a field.
 * `SurfaceNetsParams.cellGate` says why a CSG difference is not the same thing done
 * more cheaply.
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
 *
 * `extra` is the most this will ever be asked for beyond `n`, which is what a buffer has
 * to be sized for: a chunk that owns cells past its own extent needs a bigger grid, and a
 * buffer one cell short of the grid does not fail loudly — it drops the writes past its
 * end and reads air in their place.
 */
export const SURFACE_NETS_GRID = (samplesPerAxis: number, extra = 0): number =>
  samplesPerAxis + extra + 2;

/** Cells along an axis: one more than the grid. */
export const SURFACE_NETS_CELLS = (samplesPerAxis: number, extra = 0): number =>
  samplesPerAxis + extra + 1;

/** Reusable per-thread buffers, sized for one chunk shape and then reused. */
export class SurfaceNetsScratch {
  readonly samples: Float32Array;
  /**
   * The `marker` field's values, at the same samples. See `SurfaceNetsParams.marker`.
   *
   * **Allocated and left zeroed for every caller, including the ones that give no
   * marker**, so `cellGate` can read it without asking whether there was one: a cell with
   * no marker reads as uniformly out of the ground, which is the answer that lets a gate
   * written for the sea run on a mesh that was not given a landscape.
   */
  readonly marks: Float32Array;
  /** Cell index to emitted vertex index, or -1. Fixed size: a lookup, not a log. */
  readonly cellVertex: Int32Array;
  /** The eight corner samples of the cell being considered. */
  readonly corners = new Float32Array(8);
  /** The eight corner marker values of that same cell. */
  readonly cornerMarks = new Float32Array(8);

  /**
   * @param samplesPerAxis samples on each axis, or the three counts when they differ.
   *
   * **Per-axis because a region on a sphere is not cubic.** A patch of a cube face is square in its
   * own two parameters but is sampled across a radial depth as well, and the three counts are set
   * by what is being sampled rather than by the shape of the chunk. A scalar constructor is kept
   * because every existing caller is cubic and passing three equal numbers to say so is noise.
   */
  constructor(
    samplesPerAxis: number | readonly [number, number, number],
    maxExtra: number | readonly [number, number, number] = 0,
  ) {
    const [nx, ny, nz] = perAxis(samplesPerAxis);
    const [ex, ey, ez] = perAxis(maxExtra);
    const gx = SURFACE_NETS_GRID(nx, ex);
    const gy = SURFACE_NETS_GRID(ny, ey);
    const gz = SURFACE_NETS_GRID(nz, ez);
    const cx = SURFACE_NETS_CELLS(nx, ex);
    const cy = SURFACE_NETS_CELLS(ny, ey);
    const cz = SURFACE_NETS_CELLS(nz, ez);
    this.samples = new Float32Array(gx * gy * gz);
    this.marks = new Float32Array(gx * gy * gz);
    this.cellVertex = new Int32Array(cx * cy * cz);
  }
}

/**
 * Three counts from either three counts or one.
 *
 * **A scalar means all three, which is every existing call.** The alternative — three required
 * numbers everywhere — would put `[32, 32, 32]` at nine call sites to say "a cube", and the ones
 * that are genuinely cubic would stop looking cubic.
 */
const perAxis = (
  n: number | readonly [number, number, number],
): readonly [number, number, number] => (typeof n === "number" ? [n, n, n] : n);

export interface SurfaceNetsParams {
  /** The world position of the chunk's own first sample's voxel. */
  origin: readonly [number, number, number];
  /**
   * Samples this chunk owns, per axis. The sample grid is two larger on each.
   *
   * A scalar is all three, which is every chunk on a cubic lattice. **A patch of a cube face is
   * not cubic** — it is square in its two face parameters and sampled across a radial depth — so it
   * passes three.
   */
  samples: number | readonly [number, number, number];
  /**
   * Cells this chunk owns beyond `samples`, on each axis.
   *
   * **A chunk reaching into its neighbour's ground.** The run of owned cells becomes
   * `1 .. samples + extra`, which is what closes a level-of-detail seam: the coarser of
   * two neighbouring chunks meshes one cell into the finer one, so their two surfaces
   * overlap across the plane between them instead of stopping on it and leaving a slit
   * (ADR 0035).
   *
   * The run still begins at `origin`, so an extra cell on an axis's *low* side is a lower
   * `origin` rather than a negative cell index, and the axes are independent — one finer
   * neighbour on one face costs one cell rather than a shell of them on all six.
   *
   * Optional, and absent means none, which is the case every other caller is.
   */
  extra?: readonly [number, number, number];
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
  /**
   * Where the sample at a grid index sits, given the index rather than the position.
   *
   * **This is what makes a warped region meshable, and `lanes` could not do it.** `lanes` gives each
   * axis its own list of positions, so it describes a grid whose sample positions are *separable* —
   * axis `x`'s positions do not depend on `y` or `z`. A region on a sphere is not separable: the
   * sample at face parameters `(u, v)` and radial depth `w` sits at `directionAt(u, v) · (r + w)`,
   * so every position depends on all three indices at once. No product of three per-axis lists can
   * express that.
   *
   * **Positions and not values, because a vertex is placed from positions.** A value-only hook was
   * tried first and it silently produced nonsense: the samples were right, and the vertices came
   * out at a radius of 8 on a planet of radius 4000, because a dual vertex is placed by
   * interpolating along the cell's edges and that interpolation was reading the *lane* positions —
   * which for a warped grid are the placeholders above. There is no way to place a vertex from
   * values alone.
   *
   * Given one, `lanes`, `origin` and `sampleSize` are unused — but they are still required, because
   * `lanes` is how a caller says where a *separable* grid runs and the two are alternatives rather
   * than additions.
   */
  positionAt?: (
    x: number,
    y: number,
    z: number,
  ) => readonly [number, number, number];
  sampler: SurfaceSampler;
  out: SurfaceOutput;
  scratch: SurfaceNetsScratch;
  /**
   * Told each emitted vertex's world position, so a caller can fill in its normal and
   * colour without walking the positions array again.
   */
  onVertex?: (index: number, x: number, y: number, z: number) => void;
  /**
   * Asked, for every cell whose corners disagree, whether that cell may carry a vertex
   * at all. Receives the cell's eight corner samples and, when a `marker` was given, the
   * eight marker values at the same corners.
   *
   * ## What it is for
   *
   * **A surface that ends against another one, where the other one is already drawn.**
   * The sea is a sphere of radius `seaLevel` and it is everywhere; only the part of it
   * standing in open air is water, and the rest is buried in the landscape, which draws
   * its own surface there. Meshing the whole sphere gives the visible sea *and* a second
   * copy of the seabed, coincident with the ground's own triangles — so it z-fights them
   * and doubles their count.
   *
   * The obvious fix is to clip with a CSG difference, `max(sea, −ground)`, and it is
   * worse: the zero set of that composite is the sea's surface *and* the ground's surface
   * below the waterline, because a difference's boundary is both operands' boundaries.
   * The unwanted half is the same seabed, arrived at from the other direction.
   *
   * ## Why it takes a second value rather than reading the composite
   *
   * **`max(sea, −ground) < 0` says a corner is in open water and nothing more.** It cannot
   * say whether a *positive* corner is above the waterline or inside the ground, and a
   * cell straddling the seabed differs from a cell straddling the sea only in which of
   * those its positive corners are. So the ground is sampled as its own `marker`, and the
   * gate is asked the question it can answer: is any corner of this cell inside the
   * ground?
   *
   * Refusing the cell leaves its vertex at `-1`, and `quadAcross` already refuses any quad
   * naming a vertex it does not have, so removing vertices cannot leave a half-emitted
   * quad behind.
   *
   * ## Why it cannot open a seam
   *
   * **The gate is a pure function of values sampled at the corners, and corner `c` of a
   * cell is sampled at the same world position in every chunk that owns it.** Two
   * neighbours asked about one shared cell are handed the same numbers in the same order
   * and therefore answer alike, which is the property the seam rule above exists to
   * preserve and the reason this is a per-cell predicate rather than a per-chunk one.
   *
   * ## What it costs
   *
   * One call per crossing cell, in the loop that already read its eight corners, plus one
   * extra sampling pass when a `marker` is given. Optional, and absent means every
   * crossing cell emits and no second pass runs — which is every other caller, and is why
   * this changes no existing output.
   */
  cellGate?: (
    corners: Float32Array,
    /** The `marker`'s values at the same corners, or a zero-filled buffer when none. */
    marks: Float32Array,
  ) => boolean;
  /**
   * A second field, sampled in the same pass as `sampler` and read only by `cellGate`.
   *
   * **Optional, and absent means the second buffer is left zeroed** — so a gate written
   * against `marks` still runs on a mesh with no marker, and sees a field that is
   * uniformly non-negative, which is the answer "nothing here is inside anything".
   */
  marker?: SurfaceSampler;
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

  // The run of owned cells, and the two grids around it. Cubic when no axis takes an
  // extra cell, which is every call but one kind, so the general form costs nothing to
  // read: `grid` is `owned + 2` and `cells` is one fewer than that.
  const extra = params.extra ?? NO_EXTRA;
  const counts = perAxis(samples);
  const ownedX = counts[0] + extra[0];
  const ownedY = counts[1] + extra[1];
  const ownedZ = counts[2] + extra[2];
  const gridX = SURFACE_NETS_GRID(ownedX);
  const gridY = SURFACE_NETS_GRID(ownedY);
  const gridZ = SURFACE_NETS_GRID(ownedZ);
  const cellsX = SURFACE_NETS_CELLS(ownedX);
  const cellsY = SURFACE_NETS_CELLS(ownedY);
  const cellsZ = SURFACE_NETS_CELLS(ownedZ);
  const STRIDES = cellStrides(cellsX, cellsY);

  // A scratch one cell short of the grid does not fail — it drops the writes past its end
  // and reads air in their place, which is a field that is solid everywhere reading as
  // half solid and the mesher inventing a surface in the middle of rock. The two grids
  // are separately sized and separately checked because either one alone can be short.
  if (scratch.samples.length < gridX * gridY * gridZ) {
    throw new Error(
      `surface nets: scratch holds ${scratch.samples.length} samples, this grid needs ${gridX * gridY * gridZ}`,
    );
  }
  if (scratch.cellVertex.length < cellsX * cellsY * cellsZ) {
    throw new Error(
      `surface nets: scratch holds ${scratch.cellVertex.length} cells, this grid needs ${cellsX * cellsY * cellsZ}`,
    );
  }

  // Where each sample sits on each axis, resolved once. An even grid is built rather than
  // special-cased in the loops below, so there is a single version of the hot code and it
  // is the version that supports uneven spacing.
  const px = params.lanes?.x ?? uniformLane(origin[0], sampleSize, gridX);
  const py = params.lanes?.y ?? uniformLane(origin[1], sampleSize, gridY);
  const pz = params.lanes?.z ?? uniformLane(origin[2], sampleSize, gridZ);

  out.clear();

  const gate = params.cellGate;

  const sample = (x: number, y: number, z: number): number =>
    scratch.samples[(z * gridY + y) * gridX + x];

  const mark = (x: number, y: number, z: number): number =>
    scratch.marks[(z * gridY + y) * gridX + x];

  // **Two fill loops, not one with a branch.** The separable case is the hot path for every chunk
  // on a cubic lattice, and a branch there would sit in the innermost loop of the densest routine
  // in the project. The warped case is rare enough that duplicating four lines is the cheaper trade.
  const positionAt = params.positionAt;
  if (positionAt) {
    for (let z = 0; z < gridZ; z++) {
      for (let y = 0; y < gridY; y++) {
        for (let x = 0; x < gridX; x++) {
          const p = positionAt(x, y, z);
          scratch.samples[(z * gridY + y) * gridX + x] = sampler.distance(
            p[0],
            p[1],
            p[2],
          );
        }
      }
    }
  } else {
    for (let z = 0; z < gridZ; z++) {
      const wz = pz[z] as number;
      for (let y = 0; y < gridY; y++) {
        const wy = py[y] as number;
        for (let x = 0; x < gridX; x++) {
          scratch.samples[(z * gridY + y) * gridX + x] = sampler.distance(
            px[x] as number,
            wy,
            wz,
          );
        }
      }
    }
  }

  // The marker, in a pass of its own rather than a branch inside the two loops above.
  //
  // **Same position, same call shape, and skipped entirely when there is no marker** — which is
  // every caller but the sea's. A branch in the innermost loop of the densest routine in the
  // project would cost every chunk that has no use for one to save a loop only the sea pays.
  if (params.marker !== undefined) {
    const marker = params.marker;
    if (positionAt) {
      for (let z = 0; z < gridZ; z++) {
        for (let y = 0; y < gridY; y++) {
          for (let x = 0; x < gridX; x++) {
            const p = positionAt(x, y, z);
            scratch.marks[(z * gridY + y) * gridX + x] = marker.distance(
              p[0],
              p[1],
              p[2],
            );
          }
        }
      }
    } else {
      for (let z = 0; z < gridZ; z++) {
        const wz = pz[z] as number;
        for (let y = 0; y < gridY; y++) {
          const wy = py[y] as number;
          for (let x = 0; x < gridX; x++) {
            scratch.marks[(z * gridY + y) * gridX + x] = marker.distance(
              px[x] as number,
              wy,
              wz,
            );
          }
        }
      }
    }
  } else if (gate !== undefined) {
    // Zeroed for a gate that was given no marker, once per chunk rather than per sample: the
    // buffer is only read where a gate reads it, and a caller with no marker wants the same
    // answer every time rather than the last chunk's.
    scratch.marks.fill(0);
  }

  // The whole buffer, rather than the part this grid uses: it is sized for the widest grid
  // the thread will be asked for, and a leftover entry from a previous chunk would be read
  // as a vertex in this one.
  scratch.cellVertex.fill(-1);

  // ---- One vertex per cell whose corners disagree.
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
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

        // A cell the caller will not have. Its markers are gathered here rather than read
        // in place because the gate is handed both corners together and reads them as
        // pairs — see `SurfaceNetsParams.cellGate`, which is why this is here and not in
        // the gate itself.
        if (gate !== undefined) {
          if (params.marker !== undefined) {
            for (let corner = 0; corner < 8; corner++) {
              const [dx, dy, dz] = CORNER_OFFSETS[corner];
              scratch.cornerMarks[corner] = mark(cx + dx, cy + dy, cz + dz);
            }
          } else {
            scratch.cornerMarks.fill(0);
          }
          if (!gate(scratch.corners, scratch.cornerMarks)) continue;
        }

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

        // Where the vertex goes, and the reason there are two ways to work it out.
        //
        // **Separable: the average is in the cell's own corner coordinates, 0..1, on each axis.**
        // That is a *fraction of the cell*, not a distance, which is why it survives the cell being
        // a different width from its neighbours: the cell's own two samples give where its low
        // corner is and how wide it is, and the fraction says how far along it the crossing fell.
        // Subtracting a half centres it on the cell, which is what makes it a dual vertex rather
        // than a point somewhere near one. Cell `c` is the cell of world voxel `origin + c - 1`,
        // so its own samples are `c` and `c + 1` on the lane and its centre is their middle.
        //
        // **Warped: the same fractions, but interpolated between the corners' actual positions.**
        // The separable arithmetic cannot be reused, because it assumes each axis moves at its own
        // constant rate — which is exactly what a warped grid does not do. So each crossing is
        // taken along its edge in three dimensions and the vertex is the mean of those points.
        // This costs twelve position lookups per cell instead of six array reads, which is why it
        // is not the default.
        let worldX: number;
        let worldY: number;
        let worldZ: number;
        if (positionAt) {
          let ax = 0;
          let ay = 0;
          let az = 0;
          let n = 0;
          for (let e = 0; e < CELL_EDGES.length; e++) {
            const ca = CELL_EDGES[e]![0];
            const cb = CELL_EDGES[e]![1];
            const [ax0, ay0, az0] = CORNER_OFFSETS[ca] as readonly [
              number,
              number,
              number,
            ];
            const [bx0, by0, bz0] = CORNER_OFFSETS[cb] as readonly [
              number,
              number,
              number,
            ];
            const va = sample(cx + ax0, cy + ay0, cz + az0);
            const vb = sample(cx + bx0, cy + by0, cz + bz0);
            if (va < 0 === vb < 0) continue;
            const t = va / (va - vb);
            const pa = positionAt(cx + ax0, cy + ay0, cz + az0);
            const pb = positionAt(cx + bx0, cy + by0, cz + bz0);
            ax += pa[0] + t * (pb[0] - pa[0]);
            ay += pa[1] + t * (pb[1] - pa[1]);
            az += pa[2] + t * (pb[2] - pa[2]);
            n++;
          }
          // Both branches walk `CELL_EDGES`, so both count the same crossings and
          // `crossings === n`. It is not asserted at runtime — a mismatch would divide by a count
          // it did not earn, which is the kind of thing to catch in a test rather than in the
          // innermost loop of every mesh on the planet.
          worldX = ax / crossings;
          worldY = ay / crossings;
          worldZ = az / crossings;
        } else {
          worldX =
            (px[cx] as number) +
            (sumX / crossings) * ((px[cx + 1] as number) - (px[cx] as number));
          worldY =
            (py[cy] as number) +
            (sumY / crossings) * ((py[cy + 1] as number) - (py[cy] as number));
          worldZ =
            (pz[cz] as number) +
            (sumZ / crossings) * ((pz[cz + 1] as number) - (pz[cz] as number));
        }

        scratch.cellVertex[(cz * cellsY + cy) * cellsX + cx] = out.vertex(
          worldX,
          worldY,
          worldZ,
        );
        params.onVertex?.(
          scratch.cellVertex[(cz * cellsY + cy) * cellsX + cx],
          worldX,
          worldY,
          worldZ,
        );
      }
    }
  }

  // ---- One quad per owned edge whose sign changes.
  //
  // `p` runs 1..owned on every axis: on the edge's own axis because that is the run of
  // edges this chunk owns, and on the other two because the four cells need `p - 1` to
  // name a cell.
  //
  // The four cells round an edge along `axis` all share the index `p` on that axis —
  // the edge lies between cells `p` and `p + 1`, and the four sharing it are the ones
  // at `p` — and take `p - 1` or `p` on the other two. Derived from strides rather
  // than written out three times, because writing it out three times is how the y and z
  // rows came to disagree with the x one.
  for (let pz = 1; pz <= ownedZ; pz++) {
    for (let py = 1; py <= ownedY; py++) {
      for (let px = 1; px <= ownedX; px++) {
        const base = (pz * cellsY + py) * cellsX + px;
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

/** The linear stride of one cell step along each axis, of a rectangular cell grid. */
const cellStrides = (cellsX: number, cellsY: number): readonly number[] => [
  1,
  cellsX,
  cellsX * cellsY,
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

/** Scratch for a chunk meshing `samples` samples per axis, owning `maxExtra` more. */
export const scratchFor = (
  samples: number | readonly [number, number, number],
  maxExtra: number | readonly [number, number, number] = 0,
): SurfaceNetsScratch => new SurfaceNetsScratch(samples, maxExtra);

/** The default `extra`: a chunk that owns exactly the cells it was promised. */
const NO_EXTRA: readonly [number, number, number] = [0, 0, 0];
