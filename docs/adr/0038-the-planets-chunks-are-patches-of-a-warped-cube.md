# 0038 — The planet's chunks are patches of a warped cube, not cells of a cubic lattice

## Context

The goal is that a player can fly up and look down and see a planet, with no transition to notice.
ADR 0036 put a planet at the world origin so it could live on the existing cubic chunk lattice.
That works at walking scale and it fails at the scale the goal actually asks for.

The window is a solid ellipsoid of lattice cells — 5 chunks in x and z, 2 in y — a shape chosen for
a height field, where terrain lies in a slab and so the world is a slab. A planet's surface is a
**shell**, and the two do not fit. The window is thin in **y**; the shell is thin along **radial**.
So the fit depends on which way up is, and measured (`scratch/window-waste.test.ts`) it is:

| focus latitude from `+Y` | window cells | can hold surface | usable |
| ------------------------ | ------------ | ---------------- | ------ |
| 0° (radial is `+Y`)      | 205          | 202              | 98.5%  |
| 45°                      | 205          | 119              | 58.0%  |
| 90° (radial is `+X`)     | 205          | 84               | 41.0%  |

At the pole the window is nearly perfect, because its thin axis and the shell's thin axis happen to
agree. At the equator **59% of the streaming budget is rock**. And the failure gets worse exactly
where the goal needs it to work, because the window has to grow to cover a globe:

| window radius        | cells   | usable at the equator | usable   |
| -------------------- | ------- | --------------------- | -------- |
| 5                    | 205     | 84                    | 41.0%    |
| 13 (planet-spanning) | 3,475   | 676                   | 19.5%    |
| 30                   | 45,117  | 5,378                 | 11.9%    |
| 45                   | 152,669 | 6,508                 | **4.3%** |

Radius 45 spans the planet, and 95.7% of that window is deep rock. The usable count barely moves —
84 to 6,508, while the cost rises 745-fold — because **the number of chunks that can hold surface is
bounded by the planet's surface area, not by the window's radius.** Intersecting the window with the
shell does not rescue it; it just draws the same conclusion more slowly.

So the shape is not the thing that is wrong. A window that is a solid volume in space cannot show a
sphere, at any budget, because most of any large volume of space near a planet is inside the planet.

## Decision

**Chunks become patches of a cube face. A cell is `(face, u, v, size)`, and the surface it covers is
that patch of the unit cube pushed out through the spherified-cube warp and scaled to the terrain
radius.**

The parts:

- **`cube-face.ts` — six faces, each `(u, v) ∈ [-1,1]²`, mapped to a unit direction.** The
  spherified-cube warp pushes each axis out by a factor depending only on that axis, so the map is
  continuous and monotonic and cannot fold. Plain normalisation would also give a sphere, and would
  bunch cells into the eight corners where three faces meet while leaving face centres sparse — and a
  patch lattice inherits that, so the finest level of detail would go where the surface is smallest.
- **Noise is addressed by direction, never by `(u, v)`.** Established in phase 0 and the reason
  this map was measured before it was used: the map _is_ continuous as a map to a direction, but the
  six faces disagree about what `(u, v)` means across an edge, so a `(u, v)` domain has twelve
  discontinuities in it.
- **The terrain function is unchanged.** `PlanetField.radiusAt(direction)` is already a function of
  direction, so a patch's height is the same call the cubic lattice was making. Nothing about the
  planet field had to be rewritten to move to cube-sphere — which is why phase 2 survived this.
- **Level of detail becomes a per-face quadtree**, not a distance band. A patch's level is chosen
  by how far it is from the viewer, and a patch that needs more detail splits into four.

Continuity across the twelve edges is **verified, not assumed**. `cube-face.test.ts` generates the
edges from the cube's combinatorics (`C(3,2)·2·2 = 12`) rather than listing twelve hand-derived sign
conventions — listing them would be the same class of error the file exists to catch. Measured, the
terrain on both sides of every edge agrees to **0.00e+0 units**: bit-identical, because both faces
evaluate the same direction through the same `radiusAt`. There is no crack to hide.

## Consequences

**Every cell is on the surface, so the budget buys distance.** This is the whole point, and it is
the thing the measured table above says the current shape cannot do. A quadtree rooted at each face
refines where the viewer is close and stops where it is far, which is also what a height field's
distance bands were doing — except that here there is no rock to spend the budget on.

**The count is bounded, and that is the property — not growth.** Measured, at the default
`factor`, the patch count _falls_ as the viewer rises: 648 at the surface, 552 at 500 units, 144
from a radius up, 6 from ten radii up. It was tempting to claim the count grows logarithmically with
altitude, and `patch.ts` did claim it until it was measured. The claim is wrong in the useful
direction — rising makes the planet smaller in the view, so distance-proportional detail coarsens
and the count drops.

What replaces it is a bound the cubic lattice had no version of: **the selection never returns more
than a full refinement, `6 · 32² = 6144` patches, at any altitude, and every one is on the surface.**
Against the table above — 152,669 cells for 6,508 usable ones — that is five figures fewer for a
comparable view, and no surface gate rejecting anything, because there is nothing but surface to
reject. The `factor` knob trades between them, measured from the surface and from a radius up:

| factor      | 2 up  | 500 up | 4,000 up | 40,000 up |
| ----------- | ----- | ------ | -------- | --------- |
| 2           | 204   | 177    | 36       | 6         |
| 4 (default) | 648   | 552    | 144      | 6         |
| 8           | 1,812 | 1,704  | 600      | 24        |
| 16          | 4,419 | 4,038  | 2,433    | 96        |

**Altitude is measured from the viewer's position, not as an angle between directions.** This is not
a detail. Measured by angle, the patch directly below a viewer at _any_ altitude subtends an angle of
zero, so it would never split and the ground underfoot would stay coarse forever — a bug invisible
from the ground, because at ground level the two measures coincide. Distance comes from the law of
cosines on the viewer's radius and the patch's.

**ADR 0036's one awkwardness disappears.** The cubic lattice has exactly one ill-defined cell: the
origin, shared by eight cells, where addressing depends on the sign of three floats. A quadtree
lattice has no single origin cell at all, so the defect that ADR 0036 had to reason around — and
that the planet's centre had to be placed in rock to avoid — is simply not there. The planet no
longer has to be at the origin for the _lattice's_ sake, though it stays there for the water sphere's
and the sky dome's.

**The mesher has to be generalised, and this is the largest single piece of work.** `SurfaceNetsSamples`
carries `samples: number` — a scalar, so the mesher is cubic-only. A face patch is a quad on a warped
grid: it needs per-axis sample counts, per-axis strides, and sample positions pushed through the
warp. Surface nets itself is indifferent to a warped sample lattice, so the algorithm survives; the
region description does not.

**Addressing changes everywhere.** `chunkCellOf(point)` is a per-axis floor and appears in nine
non-test call sites, with twenty-two files touching cell coordinates. The player and the picker need
the inverse — _which patch contains this direction_ — which is a quadtree descent rather than three
divisions.

**Level of detail stops being a function of distance alone.** A quadtree's level is a function of
where the splits are, which means a patch's level can differ from a pure distance calculation, and
the overlap rule from ADR 0035 — a coarse chunk reaching one cell into a finer neighbour — has to be
re-expressed in patch terms, where "one cell" is one quadrant.

**The twelve edges are now load-bearing at runtime, not just in the map.** Two patches meeting at an
edge must share the vertices along it or the mesh shows a hairline, and ADR 0035's overlap
machinery was built for cubes. This is the seam risk, and it is the part of this change most likely
to need a second mechanism rather than a reuse.

**`?flat` can keep the cubic lattice.** A flat world has no shell and no curvature, so the cube-sphere
buys it nothing, and keeping the existing path means the flat world cannot regress. The cost is two
addressing schemes to maintain. That choice is deferred to stage 6 and is deliberately not made here.

## Alternatives

**Keep the cubic lattice and make the window a shell.** Measured and rejected: it cannot reach orbit
at any budget. The usable count is bounded by surface area, so shrinking the window's wasted fraction
cannot buy a whole planet.

**Keep the cubic lattice and add a coarse cube-sphere globe for the far field.** Rejected, and it was
the close second. It reuses everything and it works — but it puts a seam exactly where the goal says
there must not be one, and it needs the near field and the far field to agree about the terrain at
the handover distance, which is the same continuity problem as the cube edges, solved less well and
in more places.

**Use a plain cubemap — normalised cube points, no warp.** Rejected on LOD distribution: cells bunch
at the eight corners, so the finest detail lands where the surface is smallest and the coarsest where
it is largest. The warp is nine lines and it is the difference between a quadtree whose levels mean
something and one that needs constant correction.

**Use a quad sphere or an icosphere instead of a cube.** Both are better distributed than a plain
cube, and both are worse here for one specific reason: **the cube's edges are straight and its faces
are axis-aligned, so a patch's samples are a regular grid in the parameter domain.** An icosphere's
faces are triangles, which means three-way splits and a mesher that has to handle non-rectangular
regions. The cube's unevenness is a distortion you can correct with a warp; the icosphere's is a
different shape of cell.

**Keep the cubic lattice and accept that the planet is only visible from low altitude.** Rejected:
that is not the goal, and the measurement says it does not even give a convincing low-altitude view,
since the horizon curvature a player would come for is present at both scales but the rest of the
planet is missing from both.

**Re-centre the lattice on the surface rather than on the planet.** Rejected: it makes the lattice
move as the player does, which is a floating origin wearing a different hat, and it reintroduces the
problem ADR 0036 was written to avoid.
