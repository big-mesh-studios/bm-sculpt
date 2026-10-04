# 0036 — The planet's centre is the origin, and it is not negotiable

## Context

A spherical world has to be placed somewhere. The obvious move is to put its centre at the origin
of the game's coordinate system, because that is where everything else in this codebase starts
counting.

The chunk lattice is the reason it is not a preference. `chunkCellOf(point)` maps a world point to
a cell index by flooring each axis against `BLOCK_WORLD`, and that function has no idea what a
planet is — it is a division per axis, and it was written for an infinite height field where any
point is legal. Its **origin is a fact about the lattice**, not a choice made by the terrain code.

So the question is not "where should the planet go" but "what happens if these two origins
disagree", and the answer turns out to be that the disagreement is not a clean failure. Consider
putting a planet at `(0, 0, 4000)`:

- Near the planet's surface the lattice is happy — `chunkCellOf` returns indices around `z ≈ 12`.
- At the planet's _centre_ it returns `(0, 0, 0)`, the same cell as the origin of a flat world.
- Chunks near the centre are deep rock, so `couldHoldSurface` rejects them and they are never
  meshed. Correct, and it costs nothing.
- But a chunk near the planet centre **straddles the lattice's own origin**, and the origin is
  where a lattice's addressing is least well defined: it is the corner shared by eight cells, so
  "the cell containing the planet's centre" is eight answers and the mesher picks one by
  flooring. Which one it picks depends on the sign of three floats.

The last point is the defect. A planet is not damaged by a chunk lattice origin; it is damaged by
having its **deep interior pass through the lattice's one ill-defined cell**, because that cell is
where addressing depends on rounding. And the rounding would be invisible: the chunks that
straddle the origin are all rejected by the surface gate, so nothing renders there, so nothing
looks wrong.

Meanwhile the ocean, the sky dome, the far plane and every "distance from the centre" question all
want a centre, and a centre at `(0, 0, 4000)` means every one of them carries a subtraction.

## Decision

**The planet is centred on the world origin, and the chunk lattice's origin is that same point.**
A planet is a `BaseFieldSpec` whose `radius` is measured from the origin, and `radiusAt(direction)`
returns a distance from it — so the field needs no centre parameter and cannot be given one.

Three consequences that are decisions rather than side effects:

- **`PlanetParams` has no `centre`.** A centre is representable nowhere in the union, so the
  mismatch between field centre and lattice origin is not a configuration that can be got wrong;
  it is a parameter that does not exist.
- **The sea sphere is built at the origin with no position offset.** The water's fragment normal is
  `normalize(vec3(positionWorld))`, which is outward from the origin — not from a uniform, because
  a uniform for a constant is a value that can be set wrong by nothing.
- **Bounds stay an AABB, and `couldHoldSurface` answers from the origin.** A cell near the planet's
  surface has an AABB at `(12, 0, 0)`; its distance from the origin is about `4000`, so the gate
  compares `lowestRadius` against that. No change to `Bounds`, no bounding-sphere type, and no
  per-chunk centre.

## Consequences

**The lattice origin is inside rock, permanently, and nothing renders there.** A planet's centre is
`4000` units below a surface that lives at `4000 ± reach`, so the chunks containing the origin are
rejected by the surface gate forever. This is why the lattice needs no special case: the ill-defined
cell is in a place the mesher already refuses to look.

**Floating origin stays available for later.** When it is needed, the origin moves and this
decision has to be revisited — but it moves to _both_ places or neither, which is the point. A
floating origin that moved the lattice but not the planet would put the planet's centre back at the
lattice origin's corner, and the argument above applies again exactly.

**Interplanetary travel, when it comes, cannot extend this.** A second planet cannot also be at
the origin. It will need its own frame and its own way of being addressed, and the honest reading
of this ADR is that it is a constraint on _this_ planet rather than a general property of
spherical worlds: one planet per world, centred, with the lattice arranged around it. Whether a
world with a planet and a moon shares a lattice origin at all is not decided here and probably
should not be.

**A test asserts the lattice and the planet share an origin**, in
`world/planet-world.test.ts` — `chunkCellOf` on a surface point returns an index near twelve, and
the centre of that cell is within a chunk of the surface point. If the planet is ever moved, that
test is the thing that fails, and it fails on a fact rather than on a rendering difference.

## Alternatives

**Put the planet at the origin and give the lattice a different origin.** Rejected: it is the same
decision with more moving parts. The lattice is used by more code than the terrain is, and there is
no version of this where moving the lattice is cheaper than moving the planet.

**Centre the planet at a cell boundary rather than the origin**, so no chunk straddles the
ill-defined cell. Rejected: the lattice's origin is a corner, so a planet centred anywhere other
than the origin still has chunks that straddle _something_ — the specific discomfort of the origin
cell is not removed by avoiding it, only relocated to the plane `z = 2000` where it is harder to
reason about.

**Give `PlanetParams` a `centre` and require it to be zero.** Rejected: a parameter with one legal
value is a parameter that will eventually be set to something else, and the thing it would break —
a planet centred off the lattice origin — has no visible symptom to catch it.

**Keep an AABB world bound and clamp per axis.** Kept, and it is the one real cost. A cube of
`1e9` around the origin contains the planet, so the bound is honest; but it is `1e9` rather than
`4000`, and on a spherical world the honest bound is a sphere. A player can reach a point `1e9`
from the centre in a direction with no surface in it. They cannot walk there, because the ground
gate stops them, so it is not reachable in play — but it is a bound that is loose by a factor of
250,000 and it is the honest thing to revisit when a planet can be flown away from.
