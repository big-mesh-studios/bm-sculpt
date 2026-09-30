# 0004 — Each chunk evaluates the operation list at its own LOD

## Context

A chunk has to be meshed at some resolution, and distant chunks want less of it.
Two shapes are possible.

The reference implementation stores voxels per chunk and picks a level of detail
per chunk; a chunk at a coarser level is filled again from the terrain function
at the new resolution, with `borderSizes` describing each neighbour's voxel size
so seam faces can be culled against a coarse cell by sampling every fine cell
inside it and treating the coarse cell as solid only when they all agree. Its fill
stage carries array lending, generation counters, border consensus culling and
edit re-application after every refill.

This project has no stored voxels (0002), which removes the reason that stage
exists.

## Decision

Level of detail is a **sampling stride on the field**, not a data resolution.

```
field(x, y, z) = combine( baseField(x, y, z)?, operations )
colour(x, y, z) = paintTile(x, y, z) ?? nearestPaintOperation(x, y, z)
```

A chunk at level _n_ evaluates that same function over its own extent with stride
`1 << n`. There is no fill stage, no neighbour data, and nothing to refill.

## Consequences

**A coarse chunk is cheaper to build, not dearer.** 8× fewer samples at level 1,
64× fewer at level 2. The reference implementation pays to re-fill at a new
resolution.

**No mesh request carries voxel data.** The worker holds the operation list, sent
once per change. A request is `{ cell, focus, lod, paintTiles }` — a few numbers
and any paint bytes the user just wrote.

**Workers need no buffer lending or buffer pools for field data**, because there
is no field data to send. Generation counters per slot remain, to drop results
superseded while in flight.

**Roughly 1,200 lines of the reference implementation are not ported**: the fill
client, array lending, `borderSizes`, consensus border culling, and re-applying
edits after a refill.

**LOD seams are handled by sampling rather than stitching.** Both sides of a
boundary evaluate the same continuous function, so the surfaces meet. Two
insurance policies remain, in escalation order — evaluate the boundary strip at
the finer neighbour's stride, then add skirts — and stitched surface nets is not
built unless those are visibly insufficient.

**Level-of-detail bands become a primary quality lever.** Where the reference
implementation treats them as fixed constants adjustable only from a console, they
here drive the adaptive ladder alongside window radius and render scale, because
for a surface mesher they buy far more than resolution does.

**An infinite world is a `baseField` binding away.** With terrain in `baseField`,
an infinite world streams by scrolling the chunk window and evaluating the field
at the requested stride — no new code in `csg/` or `mesh/`, only a new
implementation of the function and a camera.

**The level-of-detail decision depends on the focus**, so a level must be
re-evaluated when the focus moves, and a chunk that crosses a band is re-meshed in
place. `reshape` exists to do that without replacing the slot array, because
everything holding a reference to it depends on its identity.

## Alternatives

**Store the field at every level of detail.** Rejected: it stores what can be
computed, costs memory proportional to the number of levels, and still has to be
refilled whenever the operations change — which is after every stroke.

**Fill a chunk at coarse resolution from the operation list, as a middle stage.**
Rejected: it is the same evaluation, cached, with a cache to invalidate.

**One global level of detail.** Rejected: it spends the same detail on a chunk at
the horizon as on the one under the cursor, which for a mesher is the single
largest available saving.
