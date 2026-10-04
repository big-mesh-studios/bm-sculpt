# 0039 — Past a height, the planet is a displaced globe, not streamed chunks

Supersedes [0038](0038-the-planets-chunks-are-patches-of-a-warped-cube.md).

## Context

The goal has not changed: a player can fly up and look down and see a planet, with no transition to
notice. ADR 0038 answered it by replacing the cubic chunk lattice with patches of a spherified cube.
That answer was correct about the problem and wrong about the shape of it, and the difference cost a
day of regressions that were individually small and collectively fatal.

0038's measurement stands and is the reason this ADR exists. The streaming window is a solid ellipsoid
of cells, 205 of them, and it can hold 98.5% of the surface when the thin axis is radial, 58% at 45°,
and 41% when it is not. A planet's surface is a shell; a window shaped for a height field is a slab.
The fit depends on which way up is, and at a planet's scale the answer is usually bad.

So the surface is out of reach of a window of that shape. 0038 took that to mean the _cells_ were
wrong, and rebuilt them as warped patches. It turns out the cells were the least of it.

The thing that was missed is simpler and it is about cost, not shape. A cubic window on a planet spends
almost all of its budget on **rock**: most of any large volume of space near a planet is inside the
planet. The waste table in 0038 is not a distortion to be corrected, it is a bill. Even a perfectly
shaped window spends most of itself on material no player will ever see, because the alternative is
not showing it, and that is a much more expensive mistake to make.

That is a problem of _budget_, and a budget problem does not have to be solved by rebuilding the thing
that overspends. It can be solved by spending it somewhere else.

## Decision

**Above 420 units of altitude the streamed chunks fade out and a displaced globe fades in. Below it, the
opposite. The globe is a sphere carrying maps baked from the same field the chunks read.**

Four parts, each load-bearing:

1. **The globe is two triangles' worth of geometry — a `SphereGeometry` of 256 segments — and two
   baked maps: an equirectangular albedo and a height.** The height map displaces the mesh and is
   differentiated per fragment into a normal. This is cheaper than the chunks it replaces, and it is
   _more_ accurate than them, because it is built from the field directly rather than from a window
   of samples the window could not afford.

2. **The maps are baked off the main thread.** 1024×512 is 524,288 three-dimensional noise
   evaluations and measures **564ms** on a phone. The frame loop is already running at startup, so
   that cost cannot be spent there. `planet-bake-client.ts` falls back to the main thread when a
   worker cannot be had, because a hitch is a smaller problem than a planet that never arrives, and
   reports which of the two happened.

3. **The swap is a crossfade over 480 units of altitude — 420 to 900 — which is eight seconds at
   flight speed.** The number is not arbitrary: the horizon grows as √(2Rh), and the chunks reach
   1280 units, so the horizon passes the chunks' edge at about 205 units of altitude. The crossover
   sits above that, because a cube's corners reach past its edge and the arithmetic assumes a smooth
   sphere, but it is in the right order of magnitude and derived rather than chosen.

4. **The globe is lit and hazed by the terrain's own `SkyLight` and `Fog`, assigned every frame from
   the same values as every other surface.** This is what makes the swap invisible. A globe with its
   own light or its own atmosphere is a second opinion about what the hour is doing, and it disagrees
   at exactly the altitude the player is watching.

The albedo comes from the same `colourAt` the terrain material is fed, from the same field. The two
therefore agree by construction rather than by anyone having remembered to match them. **That means
the globe is as colourless as the terrain is** — grey, because nothing has painted it. This is the
correct answer and not a disappointing one; colouring the terrain is a separate decision that has to
be made in the terrain's material or the swap becomes visible.

## Consequences

**Streaming is no longer the planet's strategy; it is its near-field detail.** A chunk's job is now
the metre-level surface a player can walk on and sculpt, and it is good at that job, unchanged. The
planet it sits on comes from the maps. Nothing about the cubic lattice had to be wrong for this to
work, which is why nothing about it was changed.

**The window's shape stops mattering.** 0038's 41%-at-90° measurement is the argument for a
far-field globe and not for a particular near-field cell shape: whatever the window is, it is only
being asked to cover the ground within a few hundred units of the player, where "41% usable" is not a
constraint because the player is not anywhere near the edge.

**Painting is not on the globe.** The bake runs before any model arrives, from the base field. A
painted chunk beside an unpainted globe is a mismatch the crossfade cannot hide, and at the moment it
is possible. The honest statement is that the globe shows base terrain and the chunks show base
terrain plus edits, and the two agree exactly until the first edit. **If painting becomes common
enough to be visible from orbit, the globe needs rebaking on the edit — a cost that is not paid now
and is not paid speculatively.**

**`FOG_FAR` was hiding the planet, and that was not a fog bug.** The ground fog's far distance is
1280 units — four chunks, chosen when the terrain stopped there. On a planet of radius 4000 the ground
is never nearer than that to somebody standing on it, so the fog turned the whole surface into sky.
The fix is in `fog.ts`: the density falls off exponentially with **height**, using the higher of the
eye's altitude and the fragment's, with a scale height of 1200 units. The near distance, the far
distance, the falloff and the colour are all unchanged. The fragment's height alone was the first
attempt and it does not work: a ground fragment is at height zero however far up the viewer is, so
from orbit the whole surface stayed hazed. The eye's height alone would be wrong the other way — it
clears the air above a mountain top that is a few hundred units from the camera. Taking the higher of
the two keeps the mountain case and adds the orbit case, for two more `exp` and `length` per fragment,
and the shader test pins the count so the cost cannot grow unnoticed.

## Alternatives

**Finish the patch migration from 0038.** Rejected, on evidence. It was built and it regressed in six
distinct ways over the course of a day — origin construction flooding 6,144 chunks, a worker pool
without a patch factory, a radial-side error that showed bands of wrong terrain at one orientation,
an operation-band fault, and seams that moved as the LOD changed. None of those is a deep design
problem. They are the ordinary cost of replacing the core of a working renderer, and the deep design
problem — the budget — turned out not to need solving that way at all.

**Replace the cubic lattice, but only for the far field, with warped patches.** This is 0038 with a
smaller scope, and it is the same cost for a smaller prize. The far field does not need patches, LOD
or streaming: it needs to be correct once and cheap forever, which is what a baked map is.

**Keep the cubic lattice and simply raise the streaming window far enough to see the planet.**
Rejected on the measurement rather than on taste: the window would have to cover a sphere of radius
4000, and the rock it spends itself on is why it cannot.

**One sphere, always, with no near field.** Rejected. A sphere at 256 segments is a poor surface to
walk on and impossible to sculpt — there is no field sample per vertex to edit, and 256 segments is a
hundred units per facet at the surface. The crossfade exists because the two are genuinely better at
different jobs, not because either is a placeholder.

**Scale the fog by the eye's altitude alone instead of the higher of the two.** Rejected above: it is
cheaper by one transcendental and looks identical on the ground, but it clears the air above a
mountain top that is a few hundred units away, which is the case the fragment term exists for. It is
the kind of optimisation that passes a review and then makes a mountain hazy-when-it-should-not-be and
a planet invisible.

**Map the albedo from a colour ramp over elevation and slope rather than from `colourAt`.**
Rejected for now, for a reason worth stating plainly: the terrain's own colour _is_ `colourAt`, so a
ramp on the globe and a flat `colourAt` on the chunks is a visible difference appearing at one
altitude. Making the planet pretty means tinting both from one rule, and a rule that has to be
written twice — once in GLSL, once in TypeScript — is worth writing once and testing against itself
first.
