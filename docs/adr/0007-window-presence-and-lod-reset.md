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
unfilled, and every event that invalidates contents goes through it.** When Phase 4
adds mesh uploads and superchunk membership, a slot must be marked unfilled by
whichever of those invalidates it, and the class should refuse to answer for a slot
whose revision does not match what the caller holds.

## Alternatives

**Leave the slot filled and let the stale mesh stand until the rebuild lands.**
Rejected: the whole point of the narrow band is that the rebuild lands within a frame
or two, so the stale window is short — but it is exactly long enough to put a dab in
the wrong place, which is the worst class of bug a sculpting tool can have. A dab
cannot be undone by the user noticing; it has to be undone by undo.

**Rebuild synchronously on band change.** Rejected: a band change can touch dozens of
slots at once, and blocking the frame for all of them is the stall this whole
design is arranged to avoid. The mesher is in a worker precisely so this is
asynchronous.
