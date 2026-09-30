# 0005 — Slot-indexed flat arrays and a coordinate map, not a keyed map

## Context

An earlier version of the plan specified a bounded sculpting volume around the
origin with chunk keys as strings. The tool is now expected to be reused for an
infinite world, where the window follows a focus point and chunks enter and leave
continuously.

One fact decides the shape. In the reference implementation, chunk slots are a
**recycled pool**: scrolling frees a slot when its cell leaves the window and
pushes it onto a free list, and a later entering cell pops that same slot and
re-points the same object at a different part of the world.

## Decision

The chunk store is slot-indexed:

- `blocks: Chunk[]`, `cells: CellCoord[]`, `filled: boolean[]`, `free: number[]` —
  flat arrays, one entry per slot, mutated in place.
- A `CoordinateMap<number>` maps a world cell coordinate to its slot.

Paint tiles are keyed by **absolute world chunk cell**, never by slot.

Chunk coordinates are signed 32-bit integers and nothing rejects a cell on
coordinate grounds. The only bound on the world is the size of the slot pool.

## Consequences

**Nothing may hold a chunk's identity across a scroll.** Slots are positions in
an array, not names. This is the constraint that decides the rest.

**Paint tiles outlive the window that made them.** They are keyed by absolute
cell, so a chunk scrolled away and scrolled back finds its edits again without
anything having been copied. This is the difference between a sculpt that survives
walking away from it and one that does not.

**Undo entries are absolute-coordinate, never per-chunk snapshots**, because in
world mode the chunk an edit belongs to may not be resident when it is undone.
Paired with the reference implementation's trick — the manager stores the command
that _reverses_ each change, so applying an entry is itself reversible and pushes
to the other stack for free — this makes undo computable from whatever is
currently resident.

**A query against an unfilled slot is refused rather than answered.** Between the
moment a slot is re-pointed at an entering cell and the moment that cell's
geometry lands, the slot physically holds the cell it left behind. Answering from
it puts one chunk's voxels at another's coordinates. The reference implementation
sets `filled[slot] = false` and its comment says why: _"until the fill lands it
answers for neither, and every query about it is turned away rather than the
voxels being zeroed to make the wrong answer a harmless one."_ Nothing is zeroed
because zeroed air is a plausible-looking wrong answer.

**The map's cost is a hash and a short probe run over integers**, with keys in
three parallel typed arrays and no string parsing — the reason the reference
implementation does not use a `Map` keyed by `"x,y,z"`. It never shrinks, so the
pool is sized once for its whole extent and no scroll ever rehashes.

**Focus is a parameter from the first commit.** Every spatial predicate takes a
centre explicitly, and sculpting mode is one call at the origin. There is no
world-origin concept to unlearn later.

**A `Map` keyed by chunk coordinates would need rewriting at the point the tool
becomes an infinite world** — across the renderer, the mesher, the client, the
picker and every edit call site. The coordinate map is about two hundred lines and
is needed either way.

## Alternatives

**`Map<chunkKey, Chunk>`.** Rejected: fine for a bounded volume, and the reason
the earlier plan was fine. Rejected now because chunk keys become slot identities
the moment the window scrolls, which is not a small change.

**A `CoordinateMap` for everything, including the resident chunks.** Rejected:
resident chunks are a fixed-size pool, so a dense array indexed by slot is both
smaller and faster than a hash for them. The hash is for the mapping between cell
and slot.

**Sparse arrays indexed by cell coordinate.** Rejected: an unbounded coordinate
space cannot be array-indexed.
