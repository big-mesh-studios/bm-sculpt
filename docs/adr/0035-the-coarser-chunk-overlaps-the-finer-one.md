# 0035 — The coarser chunk overlaps the finer one, and there is no skirt

## Context

A level-of-detail boundary puts two chunks on either side of a plane, sampling the same
field at different strides. Both surfaces cross the plane, so there is no hole in the field
and nothing to fix in the field — but the two tessellations are not the same curve, and they
differ by up to about half a coarse sample. Measured on this terrain, that leaves a slit one
to two fine samples wide running the length of every seam in the world.

It was covered by a **skirt**: a flap of geometry dropped from the finer chunk's open
boundary, spreading outward into the neighbour and downward. `apps/bm-sculpt/src/mesh/skirt.ts`
held it, and it worked — the terrain showed no crack.

It was also wrong in a way that only shows up when you make a hole. A skirt hangs from
wherever the surface is open, which at a level boundary is the whole cross-section of the
terrain there, and it hangs _downward_. Dig a tunnel through a seam and the open boundary
follows the tunnel down, so the skirt becomes a curtain across the tunnel: the tunnel is
capped a few metres past the level step, by a vertical wall nothing in the model asked for.
The skirt was not a detail that could be tuned; a flap of geometry across a cross-section is
a flap across a tunnel too.

The exact fix was always available and always deferred: evaluate the coarse boundary strip
at the fine stride, which is stitched surface nets — a separately meshed shell joined to the
coarse interior (ADR 0003, ADR 0004). That is a second mesher and a stitching pass, for a
defect that is invisible until somebody digs.

## Decision

**The coarser of two neighbouring chunks owns one cell beyond its own extent on the face
where its neighbour is finer, so its surface crosses the shared plane and continues into the
neighbour.** No skirt, and no vertical geometry at the seam.

Three parts, and they are separable:

- `SurfaceNetsParams.extra` — cells a chunk owns beyond `samples`, per axis. The run of
  owned cells becomes `1 .. samples + extra`, the grid is `extra + 2` per axis and is
  rectangular rather than cubic, and the strides come off the cell counts. Absent means
  none, which is every other caller.
- `overlapMaskAt` — one bit per face, set where the **neighbour is finer**, not merely
  different. The mask is what makes the overlap land on exactly one of the two chunks.
- `chunkRegion(cell, lod, overlap)` — where the run starts and how far it reaches. An
  overlap at an axis's low end is a region one cell lower, because the mesher's run always
  begins at its origin and a cell below index one does not exist.

## Consequences

**The seam becomes an overlap rather than an edge.** Where the two chunks' surfaces cross
the plane they are two tessellations of one field, so they differ by the level-of-detail
error and no more — about a unit on a hillside, a few units inside a tunnel. What is left of
the seam is a lens between two sheets at most that thick, and it tapers to nothing at both
ends of the overlap. Nothing is added in the vertical direction, so a tunnel through a level
step is a tunnel.

**Only the coarse side pays, and only on the faces that step.** A chunk with one finer
neighbour owns one more cell on one axis: for a middle level of detail that is a sixth of
one face, about 6% more mesh, against the 12–25% a whole extra shell would cost. A chunk
whose neighbours are all coarser or equal — the finest chunk in the window, and every chunk
in a same-level seam — has a mask of zero and pays nothing.

**The overlap is duplicated geometry, and that is the price.** In the overlapped cell there
are two sheets, the coarse one under the fine one. They differ by the LOD error, so the
visible result is a faint crease along the seam rather than a gap. A diagonal arrangement can
even produce two coarse sheets over one cell — a coarse chunk and its diagonal neighbour can
both reach into the same finer chunk through different faces. Wasteful and harmless; arbitrating
it would need the mask to know about diagonals, which is not worth a second rule.

**Two chunks at different levels still share no vertex, and still never will.** The overlap
does not change what the two `it.fails` cases in `mesh/lod-seam.test.ts` say: they remain
failing, and they are the reason this is not called a fix. What the new tests hold the seam to
is the thing a player can see — the coarse sheet crosses the plane, and the two sheets agree
to within one fine sample where they cross.

**`couldHaveMesh` takes the overlap too.** A gate that tested only the chunk's own extent
could rule out a chunk whose only surface is in the cell it reaches into, and nothing would
ever ask again. The gate is the one answer in this pipeline that cannot be taken back, so it
is asked about the whole region.

**`SurfaceNetsScratch` is sized for the widest run, not the widest chunk**, and
`surfaceNets` throws if it is handed something smaller. That guard is new and it is not
decoration: a buffer one cell short of the grid does not fail, it drops the writes past its
end and reads air in their place, which is a uniformly solid field reading as half solid and
the mesher inventing a surface in the middle of rock.

**One parameter rather than a range, per axis, because a seam needs one cell on one face.**
Expressing the same thing through `lanes` was possible and was rejected: the run is a count
per axis, the extra cells have to go _somewhere_, and putting them at whichever end happened
to be free is a shell's worth of duplicate geometry at seams that need none.

## Alternatives

**Keep the skirt and make it shorter.** Rejected: the problem is not its size. A flap across
a cross-section is a flap across a tunnel, and no depth at which it stops existing is a depth
at which it stops capping the tunnel.

**Keep the skirt and let the _coarse_ chunk drop it.** Rejected: the geometry is the same
shape in the same place, so it blocks the same view. Which side draws it is not the defect.

**The fine chunk reaches into the coarse one.** Rejected, and it was close. The two
arrangements agree about as well. The coarse side wins on three counts: every cell it adds is
a cell it would have meshed differently anyway, drawn under a surface that is already there,
whereas the fine side's extra cells are resolution spent on ground already at that
resolution; the same strip at the fine stride costs several times the samples, on the level
the budget is least willing to spend them; and the coarse chunk's samples at the shared plane
are the same numbers with or without the cell beyond them, so the overlap continues an
existing tessellation rather than starting a new one.

**Overlap by a fraction of a cell.** Rejected: a cell is the unit the mesher owns, and a
fraction of one is not a thing it can be told to own. A whole coarse cell is also the right
size — comfortably more than the half-sample disagreement it has to cover.

**Stitched surface nets.** Still deferred, and now with less pressure on it. It is what a
_weld_ would cost: a second mesher, a stitching pass, and a seam rule that has to agree with
itself at two resolutions. The overlap buys the visible half of the problem for one parameter
and a per-axis grid.

**Have the fine chunk leave its first cell unowned**, so the coarse one covers it and nothing
is duplicated. Rejected: it hands the region nearest the player to the coarser of the two
levels, and puts a level-of-detail step in the middle of the ground the player is standing
on rather than at the far edge of it.
