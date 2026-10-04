# 0032 — A model leaves as a 3MF, stood on a bed at a height in millimetres

## Context

ADR 0030 added marching cubes and said the reason: _"its output is going to a 3D printer, and a
mesh with an edge in one triangle is not a solid."_ It also said the status line would say which
kind of mesh came back, and that _"the only moment a person can act on either is before they send
it to a slicer."_

So the destination has been named since before it existed. What has not existed is a way to get
there. `apps/sdf-modeller` has no file I/O at all: no save, no open, no export, no `Blob` in
`src/`. The nearest thing in the family is `big-mesh-studios`' `rm-stacker`, which writes a 3MF
package from `packages/stacker/src/print/`, and whose `apps/rm-stacker/docs/adr/0007` records why.

Three questions have to be answered, and none of them is the writer.

**How big is it?** The modeller's world unit is unitless. A `Capsule` of `len: 2.2` is two and a
bit of something, and nothing in this repository says what that something is in millimetres. A
3MF model part carries `unit="millimeter"` and a slicer reads every number in the file against
it, so a file written without an answer to this is the wrong size and says so nowhere.

**Is it a solid?** A clipped model comes back as a lidless shell that looks correct on screen.
ADR 0030 measured how often that happens and put the number in the status line. It did not stop
the export.

**What colour is it?** `Field.colourAt` gives every **vertex** a colour, so two `Paint` operations
meeting is a gradient across every triangle between them, and every interpolated value along
that gradient is a distinct 24-bit colour. A four-filament machine has four colours.

## Decision

### 3MF rather than STL, and the writer is taken rather than written

`apps/sdf-modeller/src/print/three-mf.ts` is `big-mesh-studios`' `packages/stacker/src/print/three-mf.ts`
near enough whole — the Open Packaging Conventions triad, the colour group, the three-decimal
precision, `requiredextensions` deliberately absent, content types written first.

It could be taken because **it has no opinion about voxels or about a figure.** It takes
triangles and a palette and knows nothing about where they came from, which is the whole test
for whether a file format belongs in a package or in an application (ADR 0024). What came out of
`rm-stacker` on the other side of that test — `figure-print.ts`, which solves six drawings into a
voxel volume and greedy-meshes the faces — stays there. The meshing already exists here.

### The height is asked for, and measured over the mesh's own vertices

The export takes how tall the model should stand in millimetres and measures everything else
from that. Not a ratio in the file, because a file's unit is a fact about the world and the ratio
would have to be carried as metadata to be meaningful.

**The extent is measured over the mesh, not over `modelBounds`, and this is where the two
implementations disagree.** rm-stacker measures over part boxes, which is right there: a figure's
size _is_ the boxes it was drawn in, and ADR 0007 says so at length. Here `partHalfDiagonal` is
documented as _"the smallest axis-aligned bound on a rotated shape that can be computed without
rotating anything"_ — a bound, and for this model a bad one, because a `Subtract` **removes**
material and so makes the solid smaller than the union of the boxes that made it. Scaling by the
bound would print a model smaller than the height that was typed, by however much was cut away.

### The export re-meshes, with marching cubes, at a print resolution

**The mesh on screen is not the mesh being printed.** The viewport's resolution exists so a
rebuild arrives while a finger is still down, which is the coarsest thing this application does
on purpose. `PRINT_VOXEL_SIZE` is `0.125`: finer than the `0.25` preview default, coarser than
the `0.0625` fine end where sampling stops being what limits the surface and the cost is about
seven million samples.

Whichever mesher the viewport is on, the export meshes with marching cubes — ADR 0030's reason,
and the reason is a guarantee rather than an observation.

### Open edges block the export; nothing else does

`printProblem` refuses a mesh with `boundaryEdges > 0` and lets through non-manifold edges,
inconsistent winding and degenerate triangles. **A mesh with an edge in one triangle is not a
solid**, and a slicer decides for itself what to do with the hole. The other three are worse news
but not that news: a printer's own slicing and the union of a solid with itself absorb them far
more often than they cause a visible fault, and refusing every mesh with one of them would
refuse meshes that come out fine.

The refusal is **a sentence and not a boolean**, and it is the same sentence the button's
`title` is and the thrown error is. There is no second wording to keep in step.

### Colour is written per corner, and reduced to what the printer has

The colours are in a `colorgroup` in the materials extension and **each corner of each triangle
names its own** — `p1`, `p2`, `p3`. rm-stacker writes `p1` alone because a rectangle it merges
is one colour by construction; here a `Paint` blend is a gradient across a triangle, and
collapsing it to one colour throws away what the modeller drew. Any of the three may be absent,
which is what a boundary between a kept colour and a dropped one produces.

`quantiseColours` then reduces the model's colours to at most `maxColours`, **four by default**:
the most-used colours are kept, the rest are snapped to the nearest kept one by distance over all
four channels. The kept colours come back most-used first, so slot zero is the model's dominant
colour — and slot zero is where the writer puts the `pindex="0"` that a corner naming no colour
falls back to.

## Consequences

**One solid, one object, and therefore one filament on a multi-material printer.** This is the
biggest limitation and it is not fixable here. A `Part` is a step in a CSG fold, not a body: the
default model is a capsule with a subtraction cut into it, and writing those as two objects would
hand a slicer two interpenetrating shells rather than the solid the screen shows. PrusaSlicer and
Bambu Studio both assign filament **per object**, so a four-filament machine will use one filament
for a model however many colours the XML carries. Getting four colours onto a plate means
splitting the mesh into objects along colour boundaries afterwards. Writing per corner is what
makes that possible: a splitter needs to know which colour each corner is, and a per-face file
has already thrown it away.

**The reduction is lossy and says so by being visible.** A `Paint` gradient becomes bands. The
alternative — leaving eight hundred distinct colours in the file — is worse: a slicer handed that
does one of two things with it and neither is what the modeller drew.

**Marching cubes cost slightly _fewer_ triangles than surface nets here, not more.** Measured at
`PRINT_VOXEL_SIZE` across a capsule, a capsule with a thin fin, a thin fin alone, a cone on a
sphere, a 45° crease, a needle, a sliver and two hex prisms: marching cubes was between 4 and 32
triangles **below** surface nets in every case. This contradicts ADR 0030's _"two to five
triangles a cell against surface nets' two"_, which is a per-cell figure and does not survive
being totalled over a whole mesh — surface nets merges cells into quads across the entire
surface, and on a smooth surface that merging wins. Recorded because it is the sort of number
that gets quoted the wrong way round.

**At print resolution, surface nets closed every model measured above too.** So the choice of
mesher rests on the guarantee and not on a rescue this repository has watched happen. That is
what ADR 0030 already said — _"a guarantee rather than an observation"_ — and measuring it at the
export's own resolution rather than at a convenient one is what confirms it rather than assuming
it.

**A model thinner than a sample comes back with no surface, and the export refuses it.** The
budget caps samples per axis at 96, so a model's own size sets its sample spacing and a torus
with a minor radius well under one sample falls between them. `printProblem` says _"no surface
in it"_ rather than writing a file with an empty mesh in it. The boundary is a sampling
coincidence rather than a clean threshold, which is why no test pins a specific thin model to it.

**The size is a number, not a decision the file carries.** Two people printing the same model at
the same height get the same file; the same model at two heights gives two files, and nothing in
either records what it would have been otherwise, so a second print needs the number typed again.

**The thumbnail is the one untested part, deliberately.** rmsl's `render(scene, camera, target)`
and `readPixels(target)` share the viewport's WebGL context, so the picture costs no second one,
and the PNG comes from a 2D canvas's `toBlob` — no `fast-png`, unlike rm-stacker, which needs it
because it also encodes PNGs in Node under test and there is no canvas there. `jsdom` has no
WebGL and a test that mocks a renderer's readback is a test of the mock, so only
`cameraDistanceFor` — the part with arithmetic in it — is tested, and a failure in the rest
throws out of `exportThreeMf` rather than producing a wrong file.

## Alternatives

**Reusing `rm-stacker`'s file format.** Rejected because it is six indexed 8-bit PNGs and a
`.cvox` carve per part: that is a voxel-drawing editor's data model in full, and this model is a
list of primitives with booleans between them. The CSG fold has no drawing to save.

**STL.** Rejected for the two reasons rm-stacker's ADR 0007 gives: no unit, so a model is
silently the wrong size, and no colour. It is also fifty bytes a triangle of normal and three
corners and nothing else, which cannot say that a model is one solid rather than a soup.

**A millimetres-per-world-unit constant.** Rejected in favour of asking. A fixed ratio is one
fewer dialog and it bakes a number into the code forever; asking also means the same model can
be exported at two sizes, which is the thing somebody who has just built a prototype wants.

**Emitting one 3MF object per `Part`.** Rejected, and it is the alternative worth being most
tempted by. It is what rm-stacker does, and there a part is a body. Here a `Subtract` part has no
material of its own at all, so an object per part would be an empty shell unioned into the solid
— interpenetrating shells at the seams and a slicer left to reconcile them.

**Decimating before writing.** Rejected for now. A model at `0.125` is a few thousand triangles,
which every slicer handles; and the reduction that would matter — merging near-coincident
vertices and dropping the slivers a thin feature produces — is a change to the mesh's topology,
which is a larger decision than a file format.
