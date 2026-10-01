# 0007 — Invalidating a slot invalidates what a query may read from it

## Context

`ChunkWindow` has two ways a slot's contents stop being what the window wants:

1. **Reposition.** A scroll evicts a cell and claims its slot for a different one.
   The slot still holds the cell it left behind, and nothing about it is right.
2. **Rebuild.** A scroll finds a cell whose level-of-detail band has moved — because
   the camera approached it — and queues it for a rebuild at the new level. Its cell
   is unchanged, so the slot is not repositioned.

The first path had always marked the slot unfilled. The second did not: it queued
the work, set `targetLod`, and left `filled` true.

## Decision

**Anything that invalidates a slot's contents marks it unfilled, on every path.**

## Consequences

**The bug was invisible in the code's own terms and visible in the model's.** The slot
held geometry at the level it was built for. A query answered from it handed the
picker a surface at one resolution while the rest of the model was at another — so
the brush landed at a place where the mesh said there was nothing, or missed a place
where there was. Nothing errored; the mesh simply disagreed with itself across a band
boundary.

**It is the same failure as a stale slot, and the class now treats them as one
condition.** The distinction worth keeping is _arriving_ versus _refilled_ — the
reference implementation keeps them apart because its refill is a terrain
generation this project does not have — but both answer for nothing until their work
lands. One flag for both.

**This is the kind of thing a generated check catches and a code review does not.**
Two code paths assigning the same fields, differing in one line, with the omitted
line being the entire bug. The test that found it is `chunk-window.test.ts`'s
"rebuilds a cell whose level of detail band moved, in place", and it asserts the
flag rather than the queue — the queue was right all along, which is why nothing else
failed.

**The invariant to carry forward: there is exactly one way for a slot to become
unfilled, and every event that invalidates contents goes through it.**

Phase 4 has now built against it, and the rule turned out to be the right one in a way
this record did not anticipate. `ChunkMeshStore` does not merely mark slots unfilled;
it owns a **revision per slot**, moved by every invalidation, and refuses a mesh
captured against a revision the slot has passed. That is stronger than "mark it
unfilled", and the extra part is what makes the invariant enforceable by the owner of
the state rather than by every caller remembering to invalidate. The pool's generation
check already refuses a _late reply_; the revision refuses a _late answer for a slot
that has since moved on_, which is the case the pool cannot see because it does not
know what a slot now holds.

Building it also produced the failure this record warns about, twice in one method. A
resize moved the revisions without freeing the geometry, so a slot went on drawing the
old cell's surface while refusing every new mesh — blank geometry that never resolves,
with nothing to indicate why — and then cleared its own record of which meshes were in
the scene, so nothing could take them out again. Both are invisible from a unit test that
only checks the revision moved.

## Alternatives

**Leave the slot filled and let the stale mesh stand until the rebuild lands.**
Rejected: the whole point of the narrow band is that the rebuild lands within a frame
or two, so the stale window is short — but it is exactly long enough to put a dab in
the wrong place, which is the worst class of bug a sculpting tool can have. A dab
cannot be undone by the user noticing; it has to be undone by undo.

> **Superseded in part.** The reasoning above is sound and the flag it protects is
> still protected — a refilled slot is marked unfilled, so nothing reads it as
> answered. But the record conflated two questions it should have kept apart: _may a
> query read this slot?_ and _should the screen be showing it?_ The picker traces the
> field rather than the mesh (ADR 0009), so after this record was written the stale
> window stopped being reachable by a query at all — which removed the stated reason
> for the alternative, and nothing revisited the decision it had been holding up.
>
> A rebuild at a new level of detail was also firing `onSlotRelease`, which
> `ChunkMeshStore` mapped to `markStale` — taking the mesh out of the scene and
> freeing its buffers, for a cell that had not moved. That is a hole in the model for
> the length of one chunk mesh, and a band boundary crosses a whole ring of cells at
> once, so it presented as a flicker sweeping the horizon on every step rather than a
> gap somewhere. The store already had the answer in the method now called
> `markOutOfDate`: a mesh belonging to the cell the slot still holds is the right thing
> to draw right up until its replacement lands, whether it is out of date in its model
> or in its resolution.
>
> So a refill is now its own event, `onSlotRefill`, alongside reposition, release and
> staleness, and routes to the store's keep-the-mesh path. `markModelChanged` was
> renamed `markOutOfDate` at the same time, because a name that says "the model moved"
> is a name that will be read as excluding the case that was just wired to it. The
> lesson worth keeping is narrower than the decision it came from: **an alternative
> rejected for reason A is not thereby rejected for every reason**, and this one was
> left in place long after reason A had quietly stopped applying.

**Rebuild synchronously on band change.** Rejected: a band change can touch dozens of
slots at once, and blocking the frame for all of them is the stall this whole
design is arranged to avoid. The mesher is in a worker precisely so this is
asynchronous.
