# 0030 — The modeller offers two meshers, and reports what came back

## Context

ADR 0003 chose Surface Nets and rejected marching cubes, and its reasons were good: marching cubes
cracks at level-of-detail boundaries and needs Lengyel's Transvoxel to fix them, it emits more
triangles, and its output reads as voxelised. Every one of those is about **streamed chunks at
varying levels of detail**, and `sdf-modeller` has none of that — it meshes one bounded box for one
model, and always has.

What ADR 0003 also recorded is the price it paid: _"Naive surface nets is not manifold in general…
leaving that edge in a single triangle."_ `packages/meshing/src/surface-nets.test.ts` is the code
form of that sentence, and it is scoped — the describe block is called _"manifoldness of a resolved
surface"_ and the surface nets test for a closed mesh is _"closed at the corners, where a surface is
least well conditioned"_. The word **resolved** is doing the work, and it is a real limitation: a
figure with a thin fin or a sharp crease is not resolved, and the mesh comes out with edges in one
triangle instead of two.

Then the question changed. The modeller is not only a viewer: **its output is going to a 3D printer**,
and a mesh with an edge in one triangle is not a solid. That is a different requirement from "looks
right on a screen", and it is the requirement the mesher now has to meet.

So the decision is not "replace surface nets". It is that **there are two meshers, the choice is the
user's, and the application says what came back.**

## Decision

### Both meshers, behind one seam, chosen by a control

`packages/meshing` grows a `marchingCubes` beside `surfaceNets`. Both take the same `SurfaceSampler`
— one method, a distance — and return vertices through the same `SurfaceOutput`, so
`apps/sdf-modeller/src/model/mesh-model.ts` chooses between them with one argument and nothing else in
the application changes.

`SurfaceOutput` gains an optional `triangle(a, b, c)`, because every method here emits quads and an
output that only took triangles would have had the other half of the seam added for a primal method's
sake. It is optional rather than absent: surface nets never calls it, and a `SurfaceOutput` written by
hand in a test should not have to implement a method nothing will call. `emitTriangle` throws if it is
missing rather than dropping triangles quietly.

### Marching cubes is the print path, and surface nets is the edit path

**The default is surface nets**, for two reasons. It is what this application was, so switching would
change what every existing user sees for a reason they did not ask for. And it is faster, which is
what matters while a finger is down: a mesh that arrives a few tens of milliseconds late is more
annoying than one that is not quite closed.

**Marching cubes is what the status line tells someone to print.** Its vertices sit on real crossings
of the surface rather than at a cell's average crossing, so it follows the model more closely as well
as closing reliably — measured against analytic volumes, it is roughly half the error of surface nets
at the same resolution, which is what a resolution control is for.

### A resolution control, as a list of voxel sizes

`RESOLUTIONS` is `[0.5, 0.25, 0.125, 0.0625]` rather than a slider over an interval, because the cost
is cubic in the reciprocal and a continuous control offers ratios a person cannot predict. Each step
doubles the samples on an axis and multiplies the work by eight; the fine end is where the sampling
stops being what limits the surface.

### The mesh is reported, not assumed

`packages/meshing/src/mesh-report.ts` reads a finished mesh and says whether it is closed, manifold and
consistently wound, and every `MeshResult` carries one. The status line ends with it.

This is the part that makes the mode worth offering rather than deciding for someone. **The two
meshers mostly agree** — on the models this application builds, surface nets is closed almost
everywhere, which is why ADR 0003 could say "not manifold in general" and still have been right. The
choice is between a guarantee and an observation, and the report is what turns either into something a
person can see before they find out from a slicer.

## Consequences

**The watertightness claim is proved exhaustively rather than sampled.** `marching-cubes.test.ts` checks
all 24,576 pairs of cells that can share a face — six faces, sixteen sign patterns on the face, sixteen
and sixteen off it — and requires that the two draw the same curve across it. That is the whole of
watertightness for a mesh built cell by cell, and checking it in full costs 700 ms and cannot be
fooled by a shape nobody thought to try.

**The classic table's real defect is its topology, not its closure, and the record says so.** The
Lorensen–Bourke table resolves each ambiguous face without looking at the values, so a region of high
curvature can come out with a tunnel that is not there or missing one that is. The mesh stays closed
throughout. It is common to say in passing that classic marching cubes "produces holes", and for this
table that is wrong; fixing the topology is Lewiner's MC33, which is a different algorithm rather than
a table swap. Recorded here so nobody re-derives the wrong conclusion from the literature.

**Marching cubes costs about two to five triangles a cell against surface nets' two, and 11 MB of
scratch.** The scratch is held across rebuilds in `mesh-model.ts` and grown but never shrunk, because
reallocating twenty megabytes per rebuild would cost more than the meshing. It is module state, which
is the one thing in this application that is not per-application, and `releaseScratch` exists so a test
can start from nothing.

**Marching cubes does not define a cell ownership rule, so it cannot be chunked.** It emits per cell,
so two chunks meeting at a boundary would both mesh the cells in their overlap and duplicate the
geometry. Surface nets has an explicit seam rule for exactly this (ADR 0003). Nothing chunks the new
mesher — the modeller meshes one box — and `marching-cubes.test.ts` says so rather than asserting a
chunk independence it does not have.

**An exactly-zero sample is a real degenerate input, and it needed handling.** Marching cubes decides
which corners are inside with `value < 0`, so a zero is outside, and every edge through that corner
interpolates its crossing onto the corner itself. Several such edges then make several vertices at one
point. It is not rare for round numbers: a sphere of radius fifty on a grid point passes exactly
through every sample whose offset is a three-four-five triple. The crossings are welded by **where they
landed** rather than by which edge they came from, and samples within `SAMPLE_ZERO` of zero are stored
as zero so that every edge through one agrees where the crossing is.

**Two bugs the mesher had, that a volume check would not have caught.** The crossing position double
counted the edge's lower corner on the eight edges of twelve whose two corners share a non-zero offset,
and omitted the `-1` that turns a sample index into a world position. Both still produced a closed mesh
of roughly the right volume; only a test that puts every vertex against the field, and a test that
checks the mesh stays inside the region it was given, found them.

**`mesh-report`'s welding resolution is a fraction of the mesh, not a fixed number of decimals.** A
fixed count cannot serve two scales: a figure a few units across has legitimate edges a ten-thousandth
of a unit long, and rounding those to four places fuses two real vertices and reports a perfectly good
mesh as non-manifold. That was found by the modeller's own model at its finest resolution, where
marching cubes reported two non-manifold edges and surface nets reported none — the difference being
the report's resolution rather than either mesher. `WELD_PRECISION` is a millionth of the mesh's
bounding box diagonal, a little above the noise floor of the `Float32Array` the positions arrive in,
and a caller can override it.

**The winding check is on edge traversal, not against the vertex normals.** The obvious metric is wrong
in a way that looks like a fault in the mesh: on a curved surface a face and its own vertex normals are
nearly perpendicular wherever the surface turns away, so the sign of their dot product is decided by
rounding. A sphere of radius fifty sampled every five units reports a quarter of its triangles reversed,
all in a ring at the silhouette, and is perfectly good. Two triangles walking a shared edge in opposite
directions is exact and has no such region.

**A clipped model reads as open rather than as closed, which is the failure most likely to ship.** The
region is derived from the model's bounds, so a model that grows past them comes back as a lidless
shell that looks correct on screen. `boundaryEdges` catches it and the status line says
_"N open edges — not printable"_.

**The resolution and the mode changed the mesher's memory ceiling by a factor of sixty-four, and the
default budget's `maxSamplesPerAxis` of 96 caps the coarse end only.** At 0.0625 a model that fills the
budget is about 7 million samples, and the finest setting is the one a person will reach for when they
are about to print rather than about to look.

## Alternatives

**Marching tetrahedra.** Rejected for the print path, and it is the closest thing to a right answer.
Splitting each cube into six tetrahedra along its main diagonal is unambiguous — no table of 256, no
ambiguous faces, and provably manifold and watertight. It costs four to six times the triangles and it
puts visible staircases on axis-aligned surfaces, which for a figure editor is a worse trade than a
guarantee the classic table already keeps. Recorded here because it is the answer if the classic table's
topology ever stops being acceptable.

**Lewiner's MC33.** The right fix for the ambiguous faces, and rejected as a table swap when what is
needed is not a table. MC33 derives its own per-case triangulation from the face configuration, which is
a substantial algorithm rather than 256 rows of data, for a defect — a spur or a missing tunnel in a
high-curvature region — that does not affect whether the mesh can be printed.

**One mesher, chosen for the application.** Rejected. The two produce measurably different geometry from
the same field, and a person making a thing to print is not the same person as a person nudging a
sphere, so the choice belongs to them. Keeping both also means the report has something to be right
about.

**Checking watertightness by meshing a handful of shapes.** Rejected, and it is what this record was
nearly written without. Six shapes and a mesh count cannot tell a correct table from a corrupted one
that happens to be wrong where nobody looked; the exhaustive face-pair check can, and it is not much
more expensive.

**Fixing the zero-sample case by perturbing the isolevel.** Rejected. Moving the surface by an epsilon
that nobody chose is a change to the model to accommodate the mesher, and it does not fix the
disagreement between edges anyway — only the interpolation would change, not which edges believe they
were crossed.

**A fixed four-decimal welding resolution.** Rejected by measurement, which is the only thing that could
reject it: it reported the modeller's own finest-resolution mesh as non-manifold when the mesh had an
edge 7.6e-5 long.
