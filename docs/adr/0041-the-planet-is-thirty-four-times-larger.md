# 0041 — The planet is thirty-four times larger, and its body scales with it

Supersedes the radius-specific figures in [0036](0036-the-planets-centre-is-the-origin.md),
[0039](0039-past-a-height-the-planet-is-a-displaced-globe.md) and
[0040](0040-the-atmosphere-is-a-shell-and-the-clouds-wrap-the-planet.md). Their decisions stand; only
the number `4,000` in their measurements is replaced by `136,000`.

## Context

[0036](0036-the-planets-centre-is-the-origin.md) picked `radius: 4000` and the reason it gives is
circumference: 8,000 units across, 25,133 around, seven minutes to walk the world at 60 units a
second — "the number that decides whether a planet feels like a place or like a texture." That
argument is about travelling, and it is still true. It is not the number that decides how far a
player can _see_.

The visible horizon on a sphere is `√(2·R·h)`. At the player's `eyeHeight` of 6 that is **219 units
at R = 4,000** — less than one chunk (`BLOCK_WORLD` is 320) and a third of one base terrain feature
(`TERRAIN_FEATURE` is 768). Standing on the surface, the land curves away inside a single hillside, so
the planet reads as a bowl rather than a place. The measurement is `world/planet-world.test.ts`'s
and the complaint is the one the horizon predicts.

A rendering trick cannot fix this. The horizon is where an opaque sphere's surface falls below the
tangent from the eye; terrain past it is geometrically hidden. A far field drawn on a shallower curve
would put distant ground _above_ the horizon line and disagree with the near ground it must join — a
second opinion about where the surface is, which is the thing ADRs 0036–0040 spend their whole length
forbidding. The only honest levers are the radius, the eye height, or the size of the features one
wants to see, and only one of those leaves the game unchanged.

## Decision

**The planet's radius is 136,000, and everything that is part of the planet's _body_ scales with it
while everything that is _surface detail_ does not.**

The horizon becomes **1,277 units**, 5.8× the old one. The surface holds about 177 base terrain
features across a great circle, so the landscape recedes rather than ending.

The split that makes the change tractable, and the part worth stating as the decision:

- **Surface detail stays absolute.** The player (`eyeHeight: 6`, speed), `VOXEL_SIZE`, `BLOCK_WORLD`,
  the streaming window, and the terrain's own `scale` (96) and `TERRAIN_FEATURE` (768) are untouched.
  These are what a player walks and sculpts at; scaling them would cancel the radius out and buy
  nothing. Two consequences follow and both are accepted: the terrain's relief stays ±288 units on a
  136,000-unit sphere, so the planet reads **flatter**, and the noise is addressed by direction so a
  feature is still 768 world units across — there are simply many more of them.
- **The planet body scales.** The far-field globe's maps go from `1024×512` to `3072×1536`, so one
  texel is 278 units of surface — still finer than a 320-unit chunk, which is the property that lets
  the globe replace chunks at all. The bake timeout goes to 15 s for roughly 5 s of work (the 3072
  bake is nine times the 1024 one's 564 ms). The camera's far plane goes to 400,000 so the planet's
  272,000-unit diameter fits. The water and globe sphere segment counts rise so their silhouettes
  hold the same angular error. The cloud shape feature becomes `0.6 · R`, so the field still wraps
  the equator about ten times rather than three hundred.
- **The globe's crossfade stays at 420→900 units, and now for a different reason.** At 4,000 the
  ball started there because the chunks (1,280) reached well past the ground horizon (219). At
  136,000 the ground horizon _is_ the chunks' reach (about 1,280), so the far field is needed from the
  first climb — but the band cannot start below the terrain's 288-unit reach, because the globe is
  faded by altitude above the sea and would otherwise blend over the ground underfoot on every
  mountain top. Four hundred and twenty clears the relief, and the near-field fog hides the window's
  edge between the ground and it.
- **The atmosphere's thickness stays absolute at 4,800 units, deliberately.** It is a local effect —
  the sky's gradient and the fog's aerial perspective are functions of the eye's height above the
  surface — and scaling it would change the measured look in
  [0040](0040-the-atmosphere-is-a-shell-and-the-clouds-wrap-the-planet.md) without a browser to check
  it against. On the larger planet it is a thinner skin relative to the radius, which is a different
  sky from orbit rather than a broken one; re-tuning it is a measurement for a later record.

## Consequences

**Precision, checked against 0036's own budget.** `float32` resolves about `R / 16.7 million`; at
136,000 that is **0.008 units**, so world state stays single-precision. 0036's warning stands for the
6,000,000-unit Earth radius, which is still not reachable without moving that state to doubles.

**The far field is chunk-class, not texel-perfect.** 278 units per texel is finer than a chunk but
coarser than the old 25, and the 3072×1536 bake is about 5 s on a phone, off the main thread. The
alternative that keeps 25 units/texel needs a 34,180-wide map — about 600 million texels and eleven
minutes — and is not a thing.

**The patch lattice is confirmed dead.** `packages/csg/src/patch.ts` and the app's `patch-mesher`
were already superseded by 0039; at 34× the radius a fixed quadtree depth resolves a level-3 patch
against 72% of the planet's relief instead of 26%, because the features stayed small and the patch
grew. The two tests that measured the tighter-band property are skipped with that reason, which is
0039 being paid off rather than a regression.

**Tests derive from the radius now.** `planet.test.ts`, `gate-2-meshing.test.ts`, `globe.test.ts`,
`patch.test.ts` and the sky harness all computed a chunk index, an altitude or an expectation from
the literal `4,000`; they read `DEFAULT_PLANET.radius` (or the field's own `radiusAt`) instead, so the
next change to the number is the constant and the tests follow. `DEFAULT_PLANET_RADIUS` in
`render/atmosphere.ts` now _re-exports_ `DEFAULT_PLANET.radius` rather than repeating it, because two
radii that can disagree is a sky built for a different world than the terrain.

## Alternatives

**Shrink the terrain features and player instead of growing the planet.** Mathematically the same
thing — only the ratio of horizon to feature matters — and rejected because it makes the world small
in the other sense: 768-unit features on a 4,000-unit planet already span a fifth of the horizon, and
shrinking them to make the horizon read would make a "continent" a few minutes' walk.

**Scale everything, including the player and the voxel.** Rejected: it changes every number in the
repository and cancels out. The point of the split above is that it does not.

**Keep R = 4,000 and accept the horizon.** Rejected: it is the reported defect, and the horizon is
not a matter of taste.

**Go straight to Earth's 6,000,000.** Rejected for now, on 0036's precision budget: it is the radius
at which world state must move to double-precision, which is a much larger piece of work than this
record, and 136,000 already makes the horizon long enough to read.

**Scale the atmosphere with the radius to preserve its relative thickness.** Rejected in this record
and deferred: it is a change to a look that 0040 measured against a browser, it moves the air column's
cost, and this record has no way to check it. Keeping it absolute is a visibly thinner sky from orbit,
which is honest and reversible.
