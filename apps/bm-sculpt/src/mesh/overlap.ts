/**
 * Overlap: the coarser of two neighbouring chunks meshes one cell into the finer one.
 *
 * At a level-of-detail boundary the two chunks sample the same field at different strides,
 * so their surfaces meet across the shared plane without meeting *exactly* — they disagree
 * by up to about half a coarse sample, which on this terrain is a slit one to two fine
 * samples wide running along the whole seam. It is easy to mistake that for a hole in the
 * field. It is not: both sides sample the same continuous function (ADR 0004), so there is
 * surface on both sides of the plane everywhere, and the disagreement is a tessellation
 * error rather than missing geometry.
 *
 * **Closing it by overlapping.** The chunk whose neighbour is finer owns one cell beyond
 * its own extent on that face, so its surface crosses the plane and continues into the
 * neighbour. Where the two tessellations overlap they are two surfaces of the same field
 * at different strides, which differ by the same half-coarse-sample and no more: the seam
 * becomes a place where one sheet passes through another instead of a place where two
 * edges fail to meet, and what is left of it is at most the LOD error and tapers to
 * nothing at both ends of the overlap.
 *
 * **Why the coarse side, and not the fine one.** The fine side could extend too, and the
 * two arrangements agree about as well. Three things decide it:
 *
 * 1. **The coarse side is the side that was wrong.** Every extra cell it adds is a cell it
 *    would have meshed differently anyway, drawn underneath a surface that is already
 *    there; the fine side's extra cells are resolution the player asked for by being
 *    near, spent on ground that is already at the right resolution.
 * 2. **The coarse side pays in its own samples.** One extra coarse cell is a strip of
 *    coarse-stride evaluations; the same strip at the fine stride is several times the
 *    work, on the level the budget is least willing to spend it.
 * 3. **The overlap can only widen where the coarse mesh already is.** A coarse chunk's
 *    samples at the shared plane are the same numbers whether or not it owns the cell
 *    beyond them, so the extra cell continues an existing tessellation rather than starting
 *    a new one.
 *
 * **What replaced the skirt.** The obvious alternative is the flap of geometry dropped from
 * the finer chunk's open boundary — a skirt — which covers the slit by hanging over it. It
 * was correct for the same reason this is, and it was wrong in a way only geometry can be:
 * the flap is vertical, and it hangs from wherever the surface is open, so dig a tunnel
 * through a level boundary and the flap becomes a curtain across the tunnel. Overlapping
 * adds no vertical geometry at all, which is the entire visible difference.
 *
 * **One cell, and only where a neighbour is finer.** The mask the window supplies says
 * which faces step *towards* finer ground; a cell is one cell of overlap or none, per
 * face, so a chunk with one finer neighbour pays one column of cells and a chunk whose
 * neighbours are all coarser pays nothing.
 */

import type { OverlapMask } from "../world";
import {
  OVERLAP_X_NEG,
  OVERLAP_X_POS,
  OVERLAP_Y_NEG,
  OVERLAP_Y_POS,
  OVERLAP_Z_NEG,
  OVERLAP_Z_POS,
} from "../world";

/**
 * The cells a chunk owns beyond its own extent, per axis.
 *
 * **A count and a split, because where the run sits is the caller's arithmetic.** The
 * mesher's run of owned cells always *begins* at the region it is given, so an overlap
 * that reaches below the chunk's own extent is a region one cell lower rather than a
 * negative cell index, and `low` is how much lower.
 *
 * Both are per axis because the overlap is per face: a chunk with a finer neighbour on its
 * `+x` face owns one more cell along x and the same number it always did along y and z.
 * That is the difference between one extra column of cells and a shell of them, which on a
 * middle level of detail is a third of the mesh again.
 */
export interface OverlapCells {
  /** Cells owned beyond the chunk's own extent, per axis. */
  readonly extra: readonly [number, number, number];
  /** How many of those are below the chunk's own extent, per axis. */
  readonly low: readonly [number, number, number];
}

/** A chunk that reaches into nobody. The common case, and it costs two triples of zero. */
export const NO_OVERLAP: OverlapCells = {
  extra: [0, 0, 0],
  low: [0, 0, 0],
};

/**
 * How many cells of overlap exist at all, which is what the reusable scratch is sized for.
 *
 * One per face, and a constant rather than something derived from a mask, because the
 * scratch is allocated once per worker and reused for every chunk: it has to be big enough
 * for the widest request that could arrive, and one cell per face is that.
 */
export const OVERLAP_CELLS = 1;

/**
 * How many cells a chunk with this mask reaches into its neighbours.
 *
 * Absent means none, for the same reason the mask is optional at all: a mesher that has
 * not been told about its neighbours still has to produce a mesh, just one that stops on
 * the shared plane.
 */
export const overlapCells = (mask: OverlapMask | undefined): OverlapCells => {
  if (mask === undefined) return NO_OVERLAP;
  const bit = (face: number): number => ((mask & face) === 0 ? 0 : 1);
  const lowX = bit(OVERLAP_X_NEG);
  const lowY = bit(OVERLAP_Y_NEG);
  const lowZ = bit(OVERLAP_Z_NEG);
  return {
    extra: [
      lowX + bit(OVERLAP_X_POS),
      lowY + bit(OVERLAP_Y_POS),
      lowZ + bit(OVERLAP_Z_POS),
    ],
    low: [lowX, lowY, lowZ],
  };
};

/**
 * How many cells of padding the region has to sample on each side of the run, per axis.
 *
 * One cell is the seam rule's own, for the interface edges to have their vertices. An
 * overlap face needs a second: the extra owned cell's far sample is one sample further out
 * again, and a region that does not cover every sample taken gets its distances answered
 * from candidates gathered for somewhere else — which is a surface with holes in it, and
 * no error saying so.
 *
 * Split into the two ends rather than one number per axis because the padding is not
 * symmetric once an overlap is: the low end has the cells below the chunk and the high end
 * the cells above it, and a region padded by their sum on one side would sample a chunk
 * that is not the one being meshed.
 */
export const paddingOf = (
  overlap: OverlapCells,
): {
  readonly low: readonly [number, number, number];
  readonly high: readonly [number, number, number];
} => ({
  low: [1 + overlap.low[0], 1 + overlap.low[1], 1 + overlap.low[2]],
  high: [
    1 + overlap.extra[0] - overlap.low[0],
    1 + overlap.extra[1] - overlap.low[1],
    1 + overlap.extra[2] - overlap.low[2],
  ],
});
