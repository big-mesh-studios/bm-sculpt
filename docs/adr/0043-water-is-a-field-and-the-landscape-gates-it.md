# 0043 — Water is a field, and the landscape gates it

## Context

The sea was a 256-segment `SphereGeometry` at the planet's radius, added to the scene after
the terrain, transparent, not depth-writing, and depth-tested against it.

It looked correct, and it was correct by accident. The sphere is everywhere below that
radius, so the only thing that kept it out of a hole in the ground was that the rock
around the hole happened to be in front of it. **Where the sphere and the ground disagreed,
the sphere was not clipped — it was occluded, and only from outside.**

Dig a shaft down through a hill and it crosses the sea level _inside the hill_. The shaft is
a hole through the rock, the sphere's surface crosses the hole, and the shaft fills with
water to the bottom. Dig a tunnel through a mountain below the sea level and the same thing.
Neither is a bug in the sphere: it is the sphere having no relationship with the ground, and
being drawn where the ground is not in front of it.

Three things followed from the sphere being global rather than chunked:

- **It could not be bounded.** A sphere reaches the horizon from anywhere, so it also drew
  ocean where the streamed chunks had ended, and its surface was a polyhedron whose facets
  sat up to ten units from the true sphere — one voxel of error at the shoreline, which is
  where the water is most visible.
- **It needed the application to promise its draw order.** rmsl has no `renderOrder`, so
  draw order is scene traversal order. The globe is added to the scene after the sea exists
  and writes no depth, so it would blend over the ocean; `app.tsx` re-added the sea's mesh
  after the globe's bake resolved, to put it back on top. A promise in a comment in a
  `.tsx` file, with no test.
- **Its physics predicate and its picture could not agree.** `getInWaterAt` asked "below the
  sea radius and not inside the _edited_ model", so a player in the flooded shaft swam.

The obvious fix — the CSG difference — does not work, and it is worth recording why because
it is the thing one reaches for first. The water volume is `{below sea} ∩ {above ground}`,
whose field is `max(sea, −ground)`. But a difference's boundary is _both_ operands'
boundaries: the zero set is the sea's surface **and** the ground's surface below the water
line. So `max(sea, −ground)` draws the sea and the seabed, and the seabed is already drawn
— coincident triangles, z-fighting, twice the geometry. And a gate cannot recover the
distinction from the composite alone, because `max(sea, −ground) < 0` says a corner is in
open water and nothing more: a _positive_ corner is either above the water or inside rock,
and a cell straddling the seabed differs from a cell straddling the sea only in which of
those its positive corners are.

## Decision

**Water is a field, meshed per chunk by the same Surface Nets that meshes the ground, and the
ground is the mesher's gate rather than the water's field.**

Three parts, and they are separable:

- **`seaDistanceOf(base)` — the field.** `|p| − seaLevel` on a planet, `p.y − seaLevel` on a
  height field, signed so that below the water line is negative, because that is the mesher's
  convention and not a detail. `seaLevel` comes off `BuiltBaseField` rather than from a
  caller, because it is the landscape's own number (`radius` on a planet, `origin` on a
  height field) and a restated constant is a number that can disagree.
- **`outOfTheGround(overlap)` — the gate.** A cell with a corner more than `overlap` inside the
  ground gets no vertex, and therefore no quads, because a quad naming a missing vertex is already
  refused. `overlap` is how far the sea reaches onto land, and zero is the strict rule.
- **`marker` on `SurfaceNetsParams` — how the gate knows.** A second field sampled in the
  same pass as the sea, so the cell loop never touches a field and the ground is available at
  the corners the gate is asked about.

**The ground is the _landscape_, not the model.** The gate reads the base field with no
operations folded over it. Water is therefore a static sheet at sea level, cut to the world as
it was generated: a shaft dug through a hill is dry, because in the untouched landscape that
rock is above sea level, and a pit dug into the seabed sits under a surface that was already
underwater.

**Two surfaces, two groups.** The store puts ground meshes in one `Group` and sea meshes in
another, ground first. Every opaque surface has to be drawn before every translucent one and
this renderer has no other ordering, so a sea mesh added per slot beside its ground mesh would
be interleaved with them and would blend over ground drawn after it.

**The globe draws its own ocean.** `GlobeMaterial` already samples the height map and has
`uSeaRadius`, so it shades below-sea-level through the same `waterLook` the sea's material
uses. Deleting the sphere also deletes the draw-order promise in `app.tsx` that existed only
to repair it.

## Consequences

**Water no longer follows a dig.** That is the decision, not an oversight. A pit in the
seabed does not flood, and a shaft through a hill does not fill — which is what the sibling
voxel engine does with water, and what the bug report asked for. The cost is that a person
who digs a deep undersea pit has to be told the sea is where it was, and the water there is
a sheet above dry air rather than a volume around them.

**The water pass is cheap, and never re-meshes.** The base field is a closed form and never
walks the operation BVH, so the sea costs a fraction of what the ground pass it clips costs —
and it does not depend on the model's revision, so a sculpt does not re-mesh the sea. A chunk
holding neither surface is meshed zero times rather than once, and on a planet that is most of
a window.

**The sea overlaps the land by two voxels, and that is what closes the gap at the shore.** A cell
is accepted only if none of its corners is more than `WATER_OVERLAP` inside the ground, so the
water reaches a short way _onto_ the beach rather than stopping short of it. The water it admits
there is **buried** — a vertex is still placed where the sea's surface crosses zero, which on the
land side of a rising shore is inside the land, by ever more the further in it goes — so the extra
water is not drawn at all. The size is not a cell: the gate decides on a corner's _depth_, and on
a gentle shore a corner a hundred units from the water line is still only a few units inside the
rock. Measured on a 1:10 beach, with no margin the sea's edge stopped 105 units short of the
shoreline, one voxel closed it to 5, and two reached past it.
`water-mesher.test.ts` holds the invariant that makes any margin safe — a water vertex is never
above the ground — and `lod-seam.test.ts` holds the sea to the sea level at all three levels.

**Half the planet is ocean, which is a change to the world rather than to the water.** It was
one direction in four thousand, because the range term was non-negative and lifted the whole
surface above the sea; re-centring the mask (`landscapeShape` in `terrain.ts`) and tripling it
puts it at about 50.5%, stable across seeds. Three things moved with it and none of them was
optional:

- **the range term is now signed**, so a range rises where the mask says one stands and the ground
  falls away where it does not — which is what leaves flats between the ranges as well as lows
  under them;
- **the relief tripled**, from `radius ± 288` to `radius ± 672`;
- **the altitudes that have to clear it are derived rather than written down.** `GLOBE_START_ALTITUDE`
  and the cloud layer's floor were `420` and `700` against a reach of `288`, which put the cloud base
  two thousand units above the peaks and the globe's crossfade below the highest summit. Both now
  read `reachOf(params)`, and a hardcoded number there is how a mountain range ends up standing
  inside the cloud deck.

**Spawning in the sea is now a normal outcome, and the tests had to say so.** The spawn traces
outward from inside the planet and stops at the first surface it finds, which is as likely to be a
sea floor as a beach; a body in water swims, which is correct. Two tests that asserted a spawned
player was standing on the ground were picking directions and hoping they were land — they now ask
the field for land, and a separate test covers arriving in the water.

**The near sea and the far sea still differ, in one place.** The near sea is a translucent
mesh over terrain; the far sea _is_ the terrain, displaced, with no blend against a sea behind
it. So the globe's ocean takes a depth term and the chunk water does not — shallow water shows
its bottom from orbit and does not from the shore. Both use the same Fresnel, the same deep
colour and the same sky, from `render/water-look.ts`, so the swap at 420 units cannot disagree
about what water looks like.

**The physics had to be told.** `GameWorldOptions.waterAt` exists because `seaRadius` alone
answers a different question — one that puts a player in a dry shaft underwater. A world whose
water is meshed supplies the meshed rule; a world with no sea supplies neither and is dry.

**`ChunkMeshStore` lost `scene.clear()` in its dispose.** It emptied every child, and the sky,
the globe and the clouds are children too; it was survivable only because the application
happened to dispose the globe first.

## Alternatives

- **A CSG difference, `max(sea, −ground)`.** Rejected above, and the reason is structural: a
  difference's boundary is both operands' boundaries, so it draws the seabed as well as the
  sea. A gate on the composite cannot tell the two apart, because the composite only says a
  corner is _not_ in open water.
- **Offsetting the ground term by a depth, `max(sea, −(ground + D))`.** No hard gate, so a
  level-of-detail boundary cannot crack it, and the water lands `D` units inside the true water
  line rather than a ragged cell short. Rejected because it adds a second surface `D` units
  below the ground — buried, invisible, and the first thing a deep dig exposes as a
  translucent sheet hanging in the hole. With `D` small the sea starts early; with `D` large
  there is a `D`-unit band of missing water along every shore.
- **Emitting the whole volume and culling quads whose outward side is solid.** The exact edge,
  and what the voxel engine's mesher does at the voxel level. Rejected because it needs a
  ground lookup per quad _and_ re-culls the shoreline quads anyway, since those also have
  outward-facing rock.
- **One mesh per chunk holding both surfaces.** Rejected because the two have genuinely
  independent answers — open ocean has a sea and no ground — and one mesh with a flag encodes
  "no ground" as the absence of the thing that is present.
- **Keeping the sphere for the globe regime only**, crossfaded against the globe's own ocean.
  Smaller change to the globe, and two water representations coexisting on one curve for the
  sake of a case that has one correct answer.
- **Raymarching the sea in a fragment shader.** Rejected on the ground
  `apps/sdf-modeller/src/model/mesh-model.ts` gives: a second renderer with its own camera,
  its own material model and its own performance cliff, none of which this repository has.
  The mesher is already here, and it is what makes the sea obey the ground.
