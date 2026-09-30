# 0003 — Surface Nets per chunk, not marching cubes

## Context

The mesher takes a chunk of field samples and produces triangles. It runs in web
workers, on a target of roughly a 2016 laptop with four cores and no
`SharedArrayBuffer`. Its output must be watertight across chunk boundaries.

The application being replaced implements marching cubes: the classic
Lorensen–Bourke construction with the standard 256-entry triangle table, run over
one region at a uniform step, with vertices welded through a string-keyed map.

## Decision

Naive Surface Nets, one vertex per cell, per chunk at its own level of detail.

A cell whose eight corners disagree on sign gets one vertex, placed at the mean of
its edge crossings weighted by the magnitude of the value at each end. Faces are
emitted per axis and quadrant on a sign change, and **never on the positive
boundary of a chunk** — that single rule is what makes chunks tile seamlessly with
no stitching.

## Consequences

**Chunks tile watertight with a one-voxel border and nothing else.** The
reference Rust implementation, `fast-surface-nets-rs`, states the rule directly:
faces are not generated on a chunk's positive boundaries, so array chunks fit
together seamlessly and need only a translation into world coordinates. That is
the whole seam story, and it is one sentence.

**Fewer triangles and no lookup table.** One vertex per cell and roughly two
triangles per cell, against marching cubes' two to five and a 256-entry table
with ambiguous cases. For a sculpting application — where nearly every cell is
either fully inside or fully outside — that is close to the best achievable.

**Smoother surfaces from an SDF**, which is what this project contours. A dual
method places one vertex per cell and interpolates between them; a primal one puts
vertices on cell edges.

**LOD cracks are not solved by this, and are handled by sampling.** Because both
sides of a level-of-detail boundary sample the same continuous function
(0004), the surfaces genuinely meet and any remaining crack is sub-voxel. Two
insurance policies follow in order: evaluate the boundary strip at the finer
neighbour's stride, then add skirts. Stitched surface nets is not built up front.

**Sharp corners are slightly rounded.** Dual contouring reaches a box corner
closer than Surface Nets does, and the measurement of the gap is real. It does not
matter here, because the field comes from smooth primitives and smooth booleans
(0002) and there is no voxel grid to be blocky in the first place.

**Normals come from central differences** of the field at the vertex, which is
what `fast-surface-nets-rs` does and is six extra evaluations per surface vertex.
The mesher is isolated behind a `ChunkMesher` interface so a Rust-to-WebAssembly
implementation stays a substitution rather than a rewrite, should profiling say a
TypeScript implementation cannot hold the budget.

**The reference implementation's linear scan for affected chunks is not copied.**
It is O(resident chunks) per edited voxel and would become quadratic. This project
derives the dirty set from the edited world-space bounding box and looks it up.

## Alternatives

**Marching cubes.** Rejected. It cracks at LOD boundaries and needs Lengyel's
Transvoxel — 512 transition cases reduced to 73 equivalence classes — to fix them;
its vertex and triangle counts are higher; and its output is visibly voxelised.

**Dual contouring with Hermite data.** Rejected: it needs normals at every
cell-edge crossing as input, and this project has no such data — the field is a
function, evaluated on demand, and evaluating a gradient per sample to feed the
mesher is the cost surface nets avoids.

**Marching tetrahedra.** Rejected: four to six times the triangles, no advantage
here, and it has its own topology ambiguity.

**Greedy meshing of a voxel grid.** Rejected: it needs a grid. This project has no
grid (0002), so there is nothing to merge.
