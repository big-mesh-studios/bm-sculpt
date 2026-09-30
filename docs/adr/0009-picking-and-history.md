# 0009 — Picking against the field, and the operation list as the history

## Context

Phase 5 is the first phase that _changes_ the model, and it changes it through every layer
built so far: the field is recomputed, workers are told, chunks are invalidated and re-meshed,
and something has to decide where the edit lands and how to take it back.

The reference implementation keeps a voxel grid, so its picker walks the grid and its brush
writes voxels. Neither is available here — ADR 0002 is the decision that there is no grid —
so both have to be built against something else. The candidates were the mesh, or the field.

## Decision

**The picker sphere-traces the field. The operation list is the history.**

`src/pick/picker.ts` steps along a ray by `distanceForStepping` until the field's sign
changes. `src/edit/` holds the rest: `SculptDocument` is the operation list plus a history of
contiguous ranges, `BrushStroke` turns a drag into operations, and `SculptTool` decides what a
pointer event means.

## Consequences

**The picker and the mesher read the same function, so they cannot disagree.** This is the
whole reason for tracing the field rather than the mesh, and it is worth being concrete about
what it rules out. ADR 0007 records a bug where a query answered from a slot holding another
cell's contents put a dab where the mesh said there was nothing — a class of error that is
possible only when two components answer the same question from different state. Here there is
one function of position and both read it.

It does **not** mean they agree about _resolution_: far from the camera the mesh is coarse and
the picker is not, so a brush can land slightly inside or outside the visible surface. That is
a different problem with a different answer, and the honest one is the preview — a solid
sphere at the pick point, drawn at full resolution, so the user sees where the dab will go
rather than where the mesh happens to be.

**`distanceForStepping`, not `distance`.** The field is only a lower bound on the true distance
where a base function is not itself a distance function, and stepping by a distance that is
too large steps through the surface. ADR 0006's saturation is what bounds the step count: the
field cannot report more than `FAR_DISTANCE` of "outside", so crossing a thousand units of
empty space costs twenty steps rather than one. That is the price of the saturation, paid
deliberately — a picker's reach is a few hundred units anyway.

**Undo is exact, and a stroke is one command.** Removing a range of operations is the whole of
undoing a stroke. Nothing is renumbered afterwards, because an operation's index is its
position in the fold and must keep increasing — a counter that restarted would shift colour
resolution under a live stroke. Redo puts the same operations back where they were rather than
recomputing, so it cannot diverge from what the undo did.

A stroke is committed once, on release. An interrupted stroke leaves nothing behind, because
half a stroke is an edit the user cannot see and cannot undo in one piece.

**Dabs are spaced at a quarter of the radius, and the list grows with use.** Adjacent equal
spheres meeting `s` apart scallop by about `s²/8r`, so at `s = r/4` the scalloping is `r/128` —
under a tenth of a voxel at any brush size here, which is below what the mesher can resolve.
Closer spacing costs operations for nothing. ADR 0002 already names the cost and it is
unmeasured: a long stroke is hundreds of operations, and field evaluation is linear in the
operations overlapping the point being sampled. Affordable while operations cluster where the
user is sculpting. **This is the first thing to measure.**

**Soft brushes are the same mechanism as hard ones.** `MAX_SOFTNESS` caps the blend band at
`4 × softness` world units — a tenth of a voxel — so chained smooth-minimums between
neighbouring dabs smooth the join without moving the surface. A soft brush is a hard brush
with a different constant, and there is no second code path.

**A stroke ends where the pointer lifted, but not for a jittered frame.** Evenly spaced dabs
leave a remainder of up to one spacing, which is a quarter of the radius and plainly visible as
a stroke stopping short of the cursor. A final dab closes it — but only when the remainder
exceeds a quarter of the spacing, because below that it is pointer jitter, and dabbing every
jittered frame of a slow drag puts hundreds of redundant operations into one undo step.

**Editing sends the model on every dab, which cancels every mesh in flight.** That is correct
— a mesh built against a model that no longer exists is worse than useless — and it means every
edit must re-request everything unfinished, or a chunk that happened to be mid-mesh at that
instant stays blank until something unrelated scrolls the window. It also means a long stroke
costs a model send per stroke rather than per dab, which is why the commit is on release.

**A sculpt can change a chunk the window is not showing, and that is fine.** `invalidateBox`
walks the chunks an edit's own bounds overlap, which may include chunks outside the window.
They are simply not resident, and their meshes are stale in a way nothing observes until they
scroll back in — at which point the window asks for them and gets the current model.

## Alternatives

**Pick against the mesh.** Rejected. It can only hit where there are triangles, it answers at
the resolution the mesh was built at, and it introduces a second source of truth for where the
surface is — which is the failure mode this whole design is arranged to avoid.

**March the ray at voxel resolution.** Rejected: a few hundred thousand samples for a pick
that sphere tracing does in a dozen, and it would be the only place in the project sampling at
a fixed grid the field does not have.

**A reverse command per edit, as the reference implementation's undo does.** Rejected: it has to
guess at the region a stroke dirtied, and a stroke covers an unbounded area. Removing the
operations an edit added is exact and needs no guess.

**Undo per dab.** Rejected outright. A stroke across a large model is hundreds of dabs, and
undoing them one at a time is not an undo.

**Build the swept volume of a stroke as one operation.** Rejected, and it is the one worth
revisiting. `OperationShape` has three primitives and a stroke is a chain of them, so a single
soft-min cannot express it. It would mean a swept-capsule shape in the CSG, which would be a
real improvement — a soft stroke would become one operation, and undo and cost both collapse.
Not attempted here because it changes the operation format and the field's arithmetic, which
is a larger piece of work than the problem currently warrants.

**Undo on right-click.** Rejected: it would undo the stroke that was ending at that moment,
which is not what anybody means.
