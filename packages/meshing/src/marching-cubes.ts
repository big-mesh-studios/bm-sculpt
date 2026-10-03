/**
 * Marching cubes, for a mesh that has to be closed.
 *
 * ## Why this exists alongside `surfaceNets`
 *
 * **Because surface nets is not manifold, and says so.** `docs/adr/0003` chose it for a landscape
 * — one vertex per cell, no table, no ambiguous cases — and records the price in the same breath:
 * *"Naive surface nets is not manifold in general… leaving that edge in a single triangle."*
 * `surface-nets.test.ts:412-424` is the code form of that sentence, and it scopes its manifoldness
 * test to *"manifoldness of a resolved surface"*. A surface that is thin, sharply creased, or
 * resolved at a low level of detail is not resolved, and the mesh comes out with edges in one
 * triangle instead of two.
 *
 * Marching cubes emits its geometry **per cell**, from a table derived so that the two cells
 * either side of a shared face agree about the curve crossing it. That is the guarantee a mesh
 * destined for a slicer needs: every edge in exactly two triangles.
 *
 * ## What it costs, stated plainly
 *
 * - **Two to five triangles a cell, against surface nets' two.** One vertex per cell becomes one
 *   vertex per *crossed edge*, so a cell with three crossed edges has three vertices rather than
 *   one.
 * - **A 256-entry table**, where surface nets has none.
 * - **Vertices sit on cell edges rather than at cell centres**, so the surface follows the grid
 *   more visibly than a dual method's does.
 *
 * ## It is watertight, and the check for that is exhaustive rather than sampled
 *
 * The published table is **face-consistent**: for every pair of cells that can share a face, the
 * curve each draws across that face is the same. That is the whole of watertightness for a
 * mesh built cell by cell, and `marching-cubes.test.ts` checks all 24,576 such pairs rather than
 * meshing a handful of shapes and hoping — 6 faces × 16 sign patterns on the face × 16 × 16
 * patterns off it.
 *
 * **The thing that is genuinely wrong with the classic table is its topology, not its closure.**
 * The faces whose four corners alternate in sign admit two different surfaces; the table picks one
 * without looking at the values, so a region of high curvature can come out with a tunnel that is
 * not there or missing one that is. The mesh stays closed throughout, which is why it is safe to
 * print and why it is wrong to say, as the literature often does in passing, that classic marching
 * cubes "produces holes". Fixing the topology is Lewiner's MC33, and it is a different algorithm
 * rather than a table swap; see `docs/adr`.
 *
 * ## The one degenerate input it does have, and what is done about it
 *
 * **A corner sample of exactly zero.** Marching cubes decides which corners are inside with
 * `value < 0`, so a zero is outside, and every edge through that corner that is crossed
 * interpolates its vertex onto the corner itself. Several such edges then make several vertices at
 * one point, and the mesh acquires non-manifold edges there.
 *
 * It is not a rare corner case: a sphere of radius fifty centred on a grid point passes exactly
 * through every sample whose offset from the centre is a three-four-five triple, so a round test
 * shape produces dozens of them. So the crossings are welded by **where they landed** rather than
 * by which edge they came from — a crossing on a corner is welded to that corner's slot, which
 * every other edge through the same corner finds. The alternative, perturbing the isolevel by a
 * small epsilon, would move the surface by an amount nobody chose.
 *
 * ## Index layout
 *
 * With `n` samples a region owns per axis, matching `surfaceNets` so the two are interchangeable at
 * the call site:
 *
 * - the sample array holds `n + 2` per axis, indices `0 .. n + 1`
 * - sample `s` is at world `origin + (s - 1) * sampleSize`, so indices `1 .. n` are the region's own
 * - cell `c` spans samples `c` and `c + 1`, so there are `n + 1` cells per axis
 *
 * ## Vertices are welded by grid edge
 *
 * Two cells sharing a face both need a vertex on each edge of that face, and they must get the
 * *same* vertex or the two patches do not join. So a vertex is keyed by the grid edge it lies on —
 * three `Int32Array`s, one per axis, each indexed by the edge's lower corner — rather than being
 * emitted per cell.
 *
 * **Arrays and not a map, because this is the densest loop in the project.** A `Map<number, number>`
 * would be correct and would hash a million keys a rebuild. The arrays cost `grid * grid * cells`
 * entries each, which is 11 MB for all three at a 96-sample region, and holding the scratch
 * across rebuilds is what makes that affordable.
 */

import {
  emitTriangle,
  type SurfaceOutput,
  type SurfaceSampler,
} from "./surface-nets";

/**
 * The eight corners of a cell, as offsets from its low corner.
 *
 * **This is not the ordering `surface-nets.ts` uses, and mixing the two is the one mistake available
 * here.** That file numbers corners by bit — `x | y << 1 | z << 2` — because it derives a vertex
 * position from a corner index arithmetically. This file's numbering is Lorensen–Bourke's, because
 * the table below is written against it and re-deriving 256 rows to match a bit convention would be
 * a transliteration with no payoff. The two orders disagree from corner 2 onwards.
 */
export const CORNER_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;

/** The twelve edges of a cell, as pairs of its corner indices. */
export const EDGE_CORNERS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

/**
 * Which axis each edge runs along: `0` x, `1` y, `2` z.
 *
 * **Edges `0`–`7` are the four edges of each of the two `z` faces, alternating x and y; edges
 * `8`–`11` are the four that join them, all z.** That is the whole rule, and it is why the
 * expression is `edge & 1` rather than a table — a table would be a third place for the edge
 * numbering to be written down.
 */
export const edgeAxis = (edge: number): number => (edge < 8 ? edge & 1 : 2);

/** Samples a region owns per axis: `n`. The grid holds one more on each side. */
export const MARCHING_CUBES_GRID = (samplesPerAxis: number): number =>
  samplesPerAxis + 2;

/** Cells along an axis: one more than the grid. */
export const MARCHING_CUBES_CELLS = (samplesPerAxis: number): number =>
  samplesPerAxis + 1;

/**
 * A sample closer to the surface than this counts as **on** it, and is stored as exactly zero.
 *
 * **Because a sample that ought to be zero usually is not, and half-measures do not help.** A
 * sphere of radius eighteen evaluated at a grid point two, eight and sixteen units away wants
 * `hypot(2, 8, 16) - 18`, and `Math.hypot` returns `18 - 4e-15`. Every edge through that sample
 * therefore interpolates its crossing a hair to one side rather than onto the corner — so some of
 * them weld to the corner's vertex and some do not, and the same point arrives twice as two
 * vertices. The mesh then carries non-manifold edges at every sample a shape happens to pass exactly
 * through, which for a shape on round numbers is a lot of them.
 *
 * **Snapping is at the point of sampling rather than in the interpolation**, so that every edge
 * through the sample agrees about where the crossing is. Comparing `t` against a tolerance instead
 * would fix the position and leave the disagreement.
 *
 * The value is a distance in world units and is far below anything a caller can sample at: the
 * finest budget this repository offers is a voxel of 1/16 unit, so this is a sixteen-thousandth of
 * a voxel. It is also below the resolution `scratch.samples` stores at, being a `Float32Array` —
 * which is the honest reason it is not smaller.
 */
export const SAMPLE_ZERO = 1e-6;

/**
 * Which edges the surface cuts, for each of the 256 corner sign patterns.
 *
 * **Computed rather than tabulated, because it is derivable and a table would be a second place for
 * the table and the edge numbering to drift apart.** Bit `e` is set when edge `e` joins a corner
 * inside to a corner outside. A cell whose mask is zero is entirely one side and costs nothing but
 * the eight reads.
 */
export const EDGE_MASK: Int32Array = (() => {
  const masks = new Int32Array(256);
  for (let pattern = 0; pattern < 256; pattern++) {
    let mask = 0;
    for (let edge = 0; edge < 12; edge++) {
      const [a, b] = EDGE_CORNERS[edge] as unknown as readonly [number, number];
      if (((pattern >> a) & 1) !== ((pattern >> b) & 1)) mask |= 1 << edge;
    }
    masks[pattern] = mask;
  }
  return masks;
})();

/**
 * The 256 cases, one per line, as the edges their triangles use.
 *
 * **The Lorensen–Bourke table, verbatim, from Bourke's `polygonise` page.** It is kept as text
 * rather than as an array literal so that it can be read against the reference line by line, which
 * is the only way a 256-row table is ever going to be reviewable. `TRI_TABLE` validates it on load
 * — every entry an edge the surface actually cuts, every case a whole number of triangles — so a
 * damaged transcription fails immediately rather than producing a mesh with holes in it.
 */
const TRI_TABLE_SOURCE = [
  "",
  "0 8 3",
  "0 1 9",
  "1 8 3 9 8 1",
  "1 2 10",
  "0 8 3 1 2 10",
  "9 2 10 0 2 9",
  "2 8 3 2 10 8 10 9 8",
  "3 11 2",
  "0 11 2 8 11 0",
  "1 9 0 2 3 11",
  "1 11 2 1 9 11 9 8 11",
  "3 10 1 11 10 3",
  "0 10 1 0 8 10 8 11 10",
  "3 9 0 3 11 9 11 10 9",
  "9 8 10 10 8 11",
  "4 7 8",
  "4 3 0 7 3 4",
  "0 1 9 8 4 7",
  "4 1 9 4 7 1 7 3 1",
  "1 2 10 8 4 7",
  "3 4 7 3 0 4 1 2 10",
  "9 2 10 9 0 2 8 4 7",
  "2 10 9 2 9 7 2 7 3 7 9 4",
  "8 4 7 3 11 2",
  "11 4 7 11 2 4 2 0 4",
  "9 0 1 8 4 7 2 3 11",
  "4 7 11 9 4 11 9 11 2 9 2 1",
  "3 10 1 3 11 10 7 8 4",
  "1 11 10 1 4 11 1 0 4 7 11 4",
  "4 7 8 9 0 11 9 11 10 11 0 3",
  "4 7 11 4 11 9 9 11 10",
  "9 5 4",
  "9 5 4 0 8 3",
  "0 5 4 1 5 0",
  "8 5 4 8 3 5 3 1 5",
  "1 2 10 9 5 4",
  "3 0 8 1 2 10 4 9 5",
  "5 2 10 5 4 2 4 0 2",
  "2 10 5 3 2 5 3 5 4 3 4 8",
  "9 5 4 2 3 11",
  "0 11 2 0 8 11 4 9 5",
  "0 5 4 0 1 5 2 3 11",
  "2 1 5 2 5 8 2 8 11 4 8 5",
  "10 3 11 10 1 3 9 5 4",
  "4 9 5 0 8 1 8 10 1 8 11 10",
  "5 4 0 5 0 11 5 11 10 11 0 3",
  "5 4 8 5 8 10 10 8 11",
  "9 7 8 5 7 9",
  "9 3 0 9 5 3 5 7 3",
  "0 7 8 0 1 7 1 5 7",
  "1 5 3 3 5 7",
  "9 7 8 9 5 7 10 1 2",
  "10 1 2 9 5 0 5 3 0 5 7 3",
  "8 0 2 8 2 5 8 5 7 10 5 2",
  "2 10 5 2 5 3 3 5 7",
  "7 9 5 7 8 9 3 11 2",
  "9 5 7 9 7 2 9 2 0 2 7 11",
  "2 3 11 0 1 8 1 7 8 1 5 7",
  "11 2 1 11 1 7 7 1 5",
  "9 5 8 8 5 7 10 1 3 10 3 11",
  "5 7 0 5 0 9 7 11 0 1 0 10 11 10 0",
  "11 10 0 11 0 3 10 5 0 8 0 7 5 7 0",
  "11 10 5 7 11 5",
  "10 6 5",
  "0 8 3 5 10 6",
  "9 0 1 5 10 6",
  "1 8 3 1 9 8 5 10 6",
  "1 6 5 2 6 1",
  "1 6 5 1 2 6 3 0 8",
  "9 6 5 9 0 6 0 2 6",
  "5 9 8 5 8 2 5 2 6 3 2 8",
  "2 3 11 10 6 5",
  "11 0 8 11 2 0 10 6 5",
  "0 1 9 2 3 11 5 10 6",
  "5 10 6 1 9 2 9 11 2 9 8 11",
  "6 3 11 6 5 3 5 1 3",
  "0 8 11 0 11 5 0 5 1 5 11 6",
  "3 11 6 0 3 6 0 6 5 0 5 9",
  "6 5 9 6 9 11 11 9 8",
  "5 10 6 4 7 8",
  "4 3 0 4 7 3 6 5 10",
  "1 9 0 5 10 6 8 4 7",
  "10 6 5 1 9 7 1 7 3 7 9 4",
  "6 1 2 6 5 1 4 7 8",
  "1 2 5 5 2 6 3 0 4 3 4 7",
  "8 4 7 9 0 5 0 6 5 0 2 6",
  "7 3 9 7 9 4 3 2 9 5 9 6 2 6 9",
  "3 11 2 7 8 4 10 6 5",
  "5 10 6 4 7 2 4 2 0 2 7 11",
  "0 1 9 4 7 8 2 3 11 5 10 6",
  "9 2 1 9 11 2 9 4 11 7 11 4 5 10 6",
  "8 4 7 3 11 5 3 5 1 5 11 6",
  "5 1 11 5 11 6 1 0 11 7 11 4 0 4 11",
  "0 5 9 0 6 5 0 3 6 11 6 3 8 4 7",
  "6 5 9 6 9 11 4 7 9 7 11 9",
  "10 4 9 6 4 10",
  "4 10 6 4 9 10 0 8 3",
  "10 0 1 10 6 0 6 4 0",
  "8 3 1 8 1 6 8 6 4 6 1 10",
  "1 4 9 1 2 4 2 6 4",
  "3 0 8 1 2 9 2 4 9 2 6 4",
  "0 2 4 4 2 6",
  "8 3 2 8 2 4 4 2 6",
  "10 4 9 10 6 4 11 2 3",
  "0 8 2 2 8 11 4 9 10 4 10 6",
  "3 11 2 0 1 6 0 6 4 6 1 10",
  "6 4 1 6 1 10 4 8 1 2 1 11 8 11 1",
  "9 6 4 9 3 6 9 1 3 11 6 3",
  "8 11 1 8 1 0 11 6 1 9 1 4 6 4 1",
  "3 11 6 3 6 0 0 6 4",
  "6 4 8 11 6 8",
  "7 10 6 7 8 10 8 9 10",
  "0 7 3 0 10 7 0 9 10 6 7 10",
  "10 6 7 1 10 7 1 7 8 1 8 0",
  "10 6 7 10 7 1 1 7 3",
  "1 2 6 1 6 8 1 8 9 8 6 7",
  "2 6 9 2 9 1 6 7 9 0 9 3 7 3 9",
  "7 8 0 7 0 6 6 0 2",
  "7 3 2 6 7 2",
  "2 3 11 10 6 8 10 8 9 8 6 7",
  "2 0 7 2 7 11 0 9 7 6 7 10 9 10 7",
  "1 8 0 1 7 8 1 10 7 6 7 10 2 3 11",
  "11 2 1 11 1 7 10 6 1 6 7 1",
  "8 9 6 8 6 7 9 1 6 11 6 3 1 3 6",
  "0 9 1 11 6 7",
  "7 8 0 7 0 6 3 11 0 11 6 0",
  "7 11 6",
  "7 6 11",
  "3 0 8 11 7 6",
  "0 1 9 11 7 6",
  "8 1 9 8 3 1 11 7 6",
  "10 1 2 6 11 7",
  "1 2 10 3 0 8 6 11 7",
  "2 9 0 2 10 9 6 11 7",
  "6 11 7 2 10 3 10 8 3 10 9 8",
  "7 2 3 6 2 7",
  "7 0 8 7 6 0 6 2 0",
  "2 7 6 2 3 7 0 1 9",
  "1 6 2 1 8 6 1 9 8 8 7 6",
  "10 7 6 10 1 7 1 3 7",
  "10 7 6 1 7 10 1 8 7 1 0 8",
  "0 3 7 0 7 10 0 10 9 6 10 7",
  "7 6 10 7 10 8 8 10 9",
  "6 8 4 11 8 6",
  "3 6 11 3 0 6 0 4 6",
  "8 6 11 8 4 6 9 0 1",
  "9 4 6 9 6 3 9 3 1 11 3 6",
  "6 8 4 6 11 8 2 10 1",
  "1 2 10 3 0 11 0 6 11 0 4 6",
  "4 11 8 4 6 11 0 2 9 2 10 9",
  "10 9 3 10 3 2 9 4 3 11 3 6 4 6 3",
  "8 2 3 8 4 2 4 6 2",
  "0 4 2 4 6 2",
  "1 9 0 2 3 4 2 4 6 4 3 8",
  "1 9 4 1 4 2 2 4 6",
  "8 1 3 8 6 1 8 4 6 6 10 1",
  "10 1 0 10 0 6 6 0 4",
  "4 6 3 4 3 8 6 10 3 0 3 9 10 9 3",
  "10 9 4 6 10 4",
  "4 9 5 7 6 11",
  "0 8 3 4 9 5 11 7 6",
  "5 0 1 5 4 0 7 6 11",
  "11 7 6 8 3 4 3 5 4 3 1 5",
  "9 5 4 10 1 2 7 6 11",
  "6 11 7 1 2 10 0 8 3 4 9 5",
  "7 6 11 5 4 10 4 2 10 4 0 2",
  "3 4 8 3 5 4 3 2 5 10 5 2 11 7 6",
  "7 2 3 7 6 2 5 4 9",
  "9 5 4 0 8 6 0 6 2 6 8 7",
  "3 6 2 3 7 6 1 5 0 5 4 0",
  "6 2 8 6 8 7 2 1 8 4 8 5 1 5 8",
  "9 5 4 10 1 6 1 7 6 1 3 7",
  "1 6 10 1 7 6 1 0 7 8 7 0 9 5 4",
  "4 0 10 4 10 5 0 3 10 6 10 7 3 7 10",
  "7 6 10 7 10 8 5 4 10 4 8 10",
  "6 9 5 6 11 9 11 8 9",
  "3 6 11 0 6 3 0 5 6 0 9 5",
  "0 11 8 0 5 11 0 1 5 5 6 11",
  "6 11 3 6 3 5 5 3 1",
  "1 2 10 9 5 11 9 11 8 11 5 6",
  "0 11 3 0 6 11 0 9 6 5 6 9 1 2 10",
  "11 8 5 11 5 6 8 0 5 10 5 2 0 2 5",
  "6 11 3 6 3 5 2 10 3 10 5 3",
  "5 8 9 5 2 8 5 6 2 3 8 2",
  "9 5 6 9 6 0 0 6 2",
  "1 5 8 1 8 0 5 6 8 3 8 2 6 2 8",
  "1 5 6 2 1 6",
  "1 3 6 1 6 10 3 8 6 5 6 9 8 9 6",
  "10 1 0 10 0 6 9 5 0 5 6 0",
  "0 3 8 5 6 10",
  "10 5 6",
  "11 5 10 7 5 11",
  "11 5 10 11 7 5 8 3 0",
  "5 11 7 5 10 11 1 9 0",
  "10 7 5 10 11 7 9 8 1 8 3 1",
  "11 1 2 11 7 1 7 5 1",
  "0 8 3 1 2 7 1 7 5 7 2 11",
  "9 7 5 9 2 7 9 0 2 2 11 7",
  "7 5 2 7 2 11 5 9 2 3 2 8 9 8 2",
  "2 5 10 2 3 5 3 7 5",
  "8 2 0 8 5 2 8 7 5 10 2 5",
  "9 0 1 5 10 3 5 3 7 3 10 2",
  "9 8 2 9 2 1 8 7 2 10 2 5 7 5 2",
  "1 3 5 3 7 5",
  "0 8 7 0 7 1 1 7 5",
  "9 0 3 9 3 5 5 3 7",
  "9 8 7 5 9 7",
  "5 8 4 5 10 8 10 11 8",
  "5 0 4 5 11 0 5 10 11 11 3 0",
  "0 1 9 8 4 10 8 10 11 10 4 5",
  "10 11 4 10 4 5 11 3 4 9 4 1 3 1 4",
  "2 5 1 2 8 5 2 11 8 4 5 8",
  "0 4 11 0 11 3 4 5 11 2 11 1 5 1 11",
  "0 2 5 0 5 9 2 11 5 4 5 8 11 8 5",
  "9 4 5 2 11 3",
  "2 5 10 3 5 2 3 4 5 3 8 4",
  "5 10 2 5 2 4 4 2 0",
  "3 10 2 3 5 10 3 8 5 4 5 8 0 1 9",
  "5 10 2 5 2 4 1 9 2 9 4 2",
  "8 4 5 8 5 3 3 5 1",
  "0 4 5 1 0 5",
  "8 4 5 8 5 3 9 0 5 0 3 5",
  "9 4 5",
  "4 11 7 4 9 11 9 10 11",
  "0 8 3 4 9 7 9 11 7 9 10 11",
  "1 10 11 1 11 4 1 4 0 7 4 11",
  "3 1 4 3 4 8 1 10 4 7 4 11 10 11 4",
  "4 11 7 9 11 4 9 2 11 9 1 2",
  "9 7 4 9 11 7 9 1 11 2 11 1 0 8 3",
  "11 7 4 11 4 2 2 4 0",
  "11 7 4 11 4 2 8 3 4 3 2 4",
  "2 9 10 2 7 9 2 3 7 7 4 9",
  "9 10 7 9 7 4 10 2 7 8 7 0 2 0 7",
  "3 7 10 3 10 2 7 4 10 1 10 0 4 0 10",
  "1 10 2 8 7 4",
  "4 9 1 4 1 7 7 1 3",
  "4 9 1 4 1 7 0 8 1 8 7 1",
  "4 0 3 7 4 3",
  "4 8 7",
  "9 10 8 10 11 8",
  "3 0 9 3 9 11 11 9 10",
  "0 1 10 0 10 8 8 10 11",
  "3 1 10 11 3 10",
  "1 2 11 1 11 9 9 11 8",
  "3 0 9 3 9 11 1 2 9 2 11 9",
  "0 2 11 8 0 11",
  "3 2 11",
  "2 3 8 2 8 10 10 8 9",
  "9 10 2 0 9 2",
  "2 3 8 2 8 10 0 1 8 1 10 8",
  "1 10 2",
  "1 3 8 9 1 8",
  "0 9 1",
  "0 3 8",
  "",
].join("\n");

/** Edge numbers per pattern, at most fifteen, terminated by `-1`. */
export const TRI_TABLE: Int8Array = (() => {
  const table = new Int8Array(256 * 16).fill(-1);
  const lines = TRI_TABLE_SOURCE.split("\n");
  if (lines.length !== 256) {
    throw new Error(
      `the marching cubes table has ${lines.length} rows, not 256`,
    );
  }
  for (let pattern = 0; pattern < 256; pattern++) {
    const edges = (lines[pattern] as string)
      .split(" ")
      .filter((token) => token.length > 0)
      .map(Number);
    if (edges.length % 3 !== 0) {
      throw new Error(
        `case ${pattern} has ${edges.length} edges, not a multiple of 3`,
      );
    }
    if (edges.length > 15) {
      throw new Error(
        `case ${pattern} has ${edges.length} edges, more than a cell can hold`,
      );
    }
    for (const edge of edges) {
      if (!Number.isInteger(edge) || edge < 0 || edge > 11) {
        throw new Error(
          `case ${pattern} names edge ${edge}, which is not one of twelve`,
        );
      }
      if (((EDGE_MASK[pattern] as number) & (1 << edge)) === 0) {
        throw new Error(
          `case ${pattern} uses edge ${edge}, which the surface does not cut`,
        );
      }
    }
    for (let i = 0; i < edges.length; i++) {
      table[pattern * 16 + i] = edges[i] as number;
    }
  }
  return table;
})();

/**
 * Reusable per-thread buffers, sized for one region shape and then reused.
 *
 * **The three edge arrays are the reason this is a class rather than a local.** They are eleven
 * megabytes together at a 96-sample region and are re-zeroed every rebuild, so allocating them per
 * call would make the allocator the second most expensive thing in the mesh.
 */
export class MarchingCubesScratch {
  readonly samples: Float32Array;
  /**
   * Emitted vertex index per grid edge, or -1.
   *
   * **One array per axis, all three the same length, because that makes the index a single
   * expression.** An x-edge is named by its lower corner `(x, y, z)` and indexed
   * `(z * grid + y) * cells + x`; a y-edge by `(z * grid + x) * cells + y`; a z-edge by
   * `(y * grid + x) * cells + z`. All three are `grid * grid * cells` long, and the axis only
   * permutes which two of `x, y, z` are the plane and which is the position along it.
   */
  readonly edgeX: Int32Array;
  readonly edgeY: Int32Array;
  readonly edgeZ: Int32Array;
  /** The eight corner samples of the cell being considered. */
  readonly corners = new Float32Array(8);
  /** Which of the three arrays each edge is welded in. */
  readonly edgeSlots: Int32Array;
  /** The lower corner of each edge, as offsets from the cell's own corner. Twelve of three. */
  readonly edgeOffset = new Int32Array(36);
  /** Emitted vertex index per edge of the cell being considered, -1 where it does not cut. */
  readonly vertices = new Int32Array(12);
  /**
   * Emitted vertex index per grid point, for the crossings that land exactly on a corner.
   *
   * **Allocated on first use, because the case it exists for is rare and the array is not
   * small.** A sample of exactly zero is a coincidence of the numbers rather than a property of
   * a model — but when it happens it is not cosmetic, so it is handled rather than wished away,
   * and a model that never produces one never pays for it.
   */
  cornerVertex: Int32Array | undefined;

  constructor(samplesPerAxis: number) {
    const grid = MARCHING_CUBES_GRID(samplesPerAxis);
    const cells = MARCHING_CUBES_CELLS(samplesPerAxis);
    const slots = grid * grid * cells;
    this.samples = new Float32Array(grid * grid * grid);
    this.edgeX = new Int32Array(slots);
    this.edgeY = new Int32Array(slots);
    this.edgeZ = new Int32Array(slots);
    this.edgeSlots = new Int32Array(12);
    for (let edge = 0; edge < 12; edge++) {
      const [a, b] = EDGE_CORNERS[edge] as unknown as readonly [number, number];
      const ax = (
        CORNER_OFFSETS[a] as unknown as readonly [number, number, number]
      )[0];
      const ay = (
        CORNER_OFFSETS[a] as unknown as readonly [number, number, number]
      )[1];
      const az = (
        CORNER_OFFSETS[a] as unknown as readonly [number, number, number]
      )[2];
      const bx = (
        CORNER_OFFSETS[b] as unknown as readonly [number, number, number]
      )[0];
      const by = (
        CORNER_OFFSETS[b] as unknown as readonly [number, number, number]
      )[1];
      const bz = (
        CORNER_OFFSETS[b] as unknown as readonly [number, number, number]
      )[2];
      this.edgeSlots[edge] = edgeAxis(edge);
      this.edgeOffset[edge * 3] = Math.min(ax, bx);
      this.edgeOffset[edge * 3 + 1] = Math.min(ay, by);
      this.edgeOffset[edge * 3 + 2] = Math.min(az, bz);
    }
  }
}

export interface MarchingCubesParams {
  /** The world position of the region's own first sample's voxel. */
  origin: readonly [number, number, number];
  /** Samples a region owns per axis. The sample grid is two larger. */
  samples: number;
  /** World units between samples. */
  sampleSize: number;
  sampler: SurfaceSampler;
  out: SurfaceOutput;
  scratch: MarchingCubesScratch;
  /**
   * Told each emitted vertex's world position, so a caller can fill in its normal and colour
   * without walking the positions array again.
   *
   * **Called once per vertex, not once per cell**, because a vertex is shared between cells and
   * filling a normal per cell would write the same vertex several times.
   */
  onVertex?: (index: number, x: number, y: number, z: number) => void;
}

/**
 * Meshes one region's surface into `out`, which is emptied first.
 *
 * **Two passes, and the split is load-bearing for the same reason it is in `surfaceNets`.** The
 * first samples the field into a scratch buffer and then never touches the field again; the cell
 * loop reads only that. Interleaving them would turn every one of `grid³` samples into a field
 * walk as well.
 */
export const marchingCubes = (params: MarchingCubesParams): void => {
  const { origin, samples, sampleSize, sampler, out, scratch } = params;
  const grid = MARCHING_CUBES_GRID(samples);
  const cells = MARCHING_CUBES_CELLS(samples);

  out.clear();

  for (let z = 0; z < grid; z++) {
    const wz = origin[2] + (z - 1) * sampleSize;
    for (let y = 0; y < grid; y++) {
      const wy = origin[1] + (y - 1) * sampleSize;
      for (let x = 0; x < grid; x++) {
        const value = sampler.distance(
          origin[0] + (x - 1) * sampleSize,
          wy,
          wz,
        );
        scratch.samples[(z * grid + y) * grid + x] =
          Math.abs(value) < SAMPLE_ZERO ? 0 : value;
      }
    }
  }

  scratch.edgeX.fill(-1);
  scratch.edgeY.fill(-1);
  scratch.edgeZ.fill(-1);

  for (let cz = 0; cz < cells; cz++) {
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        let pattern = 0;
        for (let corner = 0; corner < 8; corner++) {
          const at = cellCornerOffset(corner);
          const value = scratch.samples[
            ((cz + at[2]) * grid + (cy + at[1])) * grid + (cx + at[0])
          ] as number;
          scratch.corners[corner] = value;
          if (value < 0) pattern |= 1 << corner;
        }
        if (pattern === 0 || pattern === 255) continue;

        const vertices = cellVertices(
          scratch,
          out,
          pattern,
          origin,
          sampleSize,
          cx,
          cy,
          cz,
          grid,
          cells,
          params.onVertex,
        );

        const table = pattern * 16;
        for (let i = 0; (TRI_TABLE[table + i] as number) !== -1; i += 3) {
          const a = vertices[TRI_TABLE[table + i] as number] as number;
          const b = vertices[TRI_TABLE[table + i + 1] as number] as number;
          const c = vertices[TRI_TABLE[table + i + 2] as number] as number;
          // Unreachable while the table names each edge at most once per triangle, which it
          // does; here because a zero-area face is the one defect this mesher could hand a
          // caller that no later stage would catch, and it costs one comparison.
          if (a === b || b === c || a === c) continue;
          // **`c, b` and not `b, c`, because the published table winds the other way.** It is
          // written for "inside" meaning above the isolevel, where positive values are solid; this
          // package's convention is the opposite one, shared with `surfaceNets` and with every
          // field in the repository, so the winding has to be reversed to keep the two meshers
          // facing the same way. Getting this wrong is invisible from outside a solid and shows up
          // as a negative volume in `mesh-report`.
          emitTriangle(out, a, c, b);
        }
      }
    }
  }
};

/**
 * Emits the vertices on the edges this cell's pattern cuts, reusing any a cell already meshed put
 * there, and returns them indexed by edge.
 *
 * **Returns twelve slots rather than a packed list because the table indexes edges by number**, and
 * packing would mean a translation from edge number to slot on every triangle. Edges the surface
 * does not cut are left at -1 and the table never reads them.
 */
const cellVertices = (
  scratch: MarchingCubesScratch,
  out: SurfaceOutput,
  pattern: number,
  origin: readonly [number, number, number],
  sampleSize: number,
  cx: number,
  cy: number,
  cz: number,
  grid: number,
  cells: number,
  onVertex: MarchingCubesParams["onVertex"],
): Int32Array => {
  const mask = EDGE_MASK[pattern] as number;
  const vertices = scratch.vertices;
  for (let edge = 0; edge < 12; edge++) {
    if ((mask & (1 << edge)) === 0) continue;

    const ex = cx + (scratch.edgeOffset[edge * 3] as number);
    const ey = cy + (scratch.edgeOffset[edge * 3 + 1] as number);
    const ez = cz + (scratch.edgeOffset[edge * 3 + 2] as number);

    // Linear crossing: the fraction along the edge at which the two corner samples interpolate
    // to zero. Independent of how long the edge is, which is what lets one `sampleSize` serve
    // every edge of the cell.
    const [ca, cb] = EDGE_CORNERS[edge] as unknown as readonly [number, number];
    const va = scratch.corners[ca] as number;
    const vb = scratch.corners[cb] as number;
    const t = va / (va - vb);
    const a = cellCornerOffset(ca);
    const b = cellCornerOffset(cb);

    // **Where the vertex is welded is decided by where the crossing actually landed.** A crossing
    // that falls exactly on a corner belongs to that corner's slot rather than the edge's, because
    // every other edge through the same corner with the same zero makes the same point and has to
    // be given the same vertex — or two of them weld into a non-manifold edge. That happens
    // whenever a sample is exactly zero, which for round numbers is often: a sphere of radius 50
    // centred on a grid point passes exactly through samples where the offsets are a 3-4-5 triple.
    const onCornerA = t <= 0;
    const onCornerB = t >= 1;
    let slot: Int32Array;
    let index: number;
    if (onCornerA || onCornerB) {
      const corners = (scratch.cornerVertex ??= new Int32Array(
        scratch.samples.length,
      ).fill(-1));
      // **From the cell's corner, not from the edge's lower corner.** A y-edge's lower corner
      // already carries the cell's x offset, so adding the corner's own x offset to it again
      // lands a cell past the end of the grid — a write dropped and a read of `undefined` in the
      // same expression, which is a NaN index and a silently absent vertex.
      const at = onCornerA ? a : b;
      index = ((cz + at[2]) * grid + (cy + at[1])) * grid + (cx + at[0]);
      slot = corners;
      if ((corners[index] as number) >= 0) {
        vertices[edge] = corners[index] as number;
        continue;
      }
    } else {
      const axis = scratch.edgeSlots[edge] as number;
      const edges =
        axis === 0 ? scratch.edgeX : axis === 1 ? scratch.edgeY : scratch.edgeZ;
      index =
        axis === 0
          ? (ez * grid + ey) * cells + ex
          : axis === 1
            ? (ez * grid + ex) * cells + ey
            : (ey * grid + ex) * cells + ez;
      slot = edges;
      if ((slot[index] as number) >= 0) {
        vertices[edge] = slot[index] as number;
        continue;
      }
    }

    // **From the cell's own corner, and one sample back.** Two offsets, both easy to get wrong:
    //
    // - `cx + a[k]`, *not* the edge's lower corner plus `a[k]`. On the eight edges whose two
    //   corners share a non-zero offset on some axis — a y-edge's corners are both at x = 1 — the
    //   lower corner already carries that offset, so adding the corner's own doubles it and puts
    //   the vertex a whole cell away from the crossing it is interpolating. That is eight edges in
    //   twelve, and it still produces a closed mesh, so nothing but a vertex-against-the-field
    //   assertion notices.
    // - `- 1`, because sample `s` sits at `origin + (s - 1) * sampleSize` and `cx` is a sample
    //   index, not a voxel offset. Without it the whole mesh is translated one voxel along all three
    //   axes, which a volume check cannot see either.
    const px = origin[0] + (cx + a[0] + t * (b[0] - a[0]) - 1) * sampleSize;
    const py = origin[1] + (cy + a[1] + t * (b[1] - a[1]) - 1) * sampleSize;
    const pz = origin[2] + (cz + a[2] + t * (b[2] - a[2]) - 1) * sampleSize;

    const created = out.vertex(px, py, pz);
    slot[index] = created;
    vertices[edge] = created;
    onVertex?.(created, px, py, pz);
  }
  return vertices;
};

const cellCornerOffset = (corner: number): readonly [number, number, number] =>
  CORNER_OFFSETS[corner] as unknown as readonly [number, number, number];

/** Scratch for a region meshing `samples` samples per axis. */
export const marchingCubesScratchFor = (
  samples: number,
): MarchingCubesScratch => new MarchingCubesScratch(samples);
