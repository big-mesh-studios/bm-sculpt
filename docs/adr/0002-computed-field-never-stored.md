# 0002 — The field is computed from an operation list, never stored

## Context

The application being replaced keeps a `BrickMap`: a sparse bricked voxel grid
holding an 8 MB indirection texture, a 128 MB signed-distance atlas and a
**512 MB** colour volume — roughly 650 MB resident before any geometry. A brush
either rasterises into that grid directly (`softness == 0`) or appends a CSG
operation to a list and rebakes a dirty region (`softness > 0`). The two paths
coexist in one grid, and which one a stroke took decided how it could be undone:
neither could.

The desire is also to reuse the tool for an infinite world later, where nothing
is bounded and no volume can be stored at all.

## Decision

The source of truth is a list of CSG operations. The field is a function:

```
field(x, y, z) = combine( baseField(x, y, z)?, operations )
```

Nothing about it is persisted. A hard sculpt stroke — `softness == 0` — is an
operation with a sharp boolean, not a rasterisation. It is already inserted as
one; only the direct-write optimisation is dropped.

The only stored voxel data in the whole system is sparse paint tiles, because
arbitrary per-voxel colour has no smooth operation to express.

## Consequences

**650 MB becomes approximately nothing.** A model of any size costs its operation
list plus the resident window's geometry.

**LOD becomes structural rather than a feature.** The field is analytic, so a
coarse chunk samples the _same function_ at stride 2 or 4. LOD is a sampling
decision, not a data resolution, so a coarse chunk is 8× or 64× _cheaper_ to
build. This inverts the reference implementation, where voxels are truth and every
LOD change needs a refill plus `borderSizes` consensus culling — roughly 1,200
lines that this design has no reason to port.

**Undo is exact and O(1) per operation.** Removing an operation from a list is
the whole of undoing it. The reference implementation's undo has to record a
reverse command per edit and can only guess at the dirty region for a stroke that
covers an unbounded area.

**Every hard dab is an operation, so the list grows with use.** `evalSDF` cost is
linear in the operations overlapping the point being sampled, which is fine while
they cluster where the user is sculpting and needs measurement before it is not.
The operation BVH's candidate cache is sized to the chunk rather than to the hard
coded 100 units the reference uses, which thrashes at this project's chunk size.

**Lipschitz conservatism is the picker's problem, not the mesher's.** A noise
height field is not an exact distance function. Divided by its gradient bound it
becomes a valid lower bound and safe to sphere-trace, which is what the picker
needs; the mesher only looks for sign changes and interpolates, so it does not
care.

**An infinite world is the same format plus a seed.** `baseField` is the only
thing that changes, and 0004 already makes it a seam rather than the whole model.

## Alternatives

**Keep a stored voxel grid and mesh from it.** Rejected: 650 MB before any
geometry, LOD costs a refill rather than saving one, and undo requires knowing
the previous value of every voxel a stroke touched.

**Keep the delta-overlay design considered earlier — sparse tiles holding an SDF
difference added to the CSG.** Rejected as unnecessary. The reference
implementation already inserts an operation for hard strokes; the delta was a
second representation of something the operation list already says, and it would
have needed its own LOD sampling, its own persistence and its own undo.

**Store the field, but as a compressed per-chunk format.** Rejected: still
stores what can be computed, still needs a refill at a new LOD, and still cannot
be undone without the previous value.
