# 0042 — The cloud volume is addressed by direction _and_ altitude

Supersedes the shape-addressing half of [0040](0040-the-atmosphere-is-a-shell-and-the-clouds-wrap-the-planet.md)
and the cloud feature figure in [0041](0041-the-planet-is-thirty-four-times-larger.md). Their
decisions about the shell's two radii, the fog's two terms, the sky's altitude gate and the
planet's radius stand; only the address of the noise volume and the size of its features are
replaced here.

## Context

[0040](0040-the-atmosphere-is-a-shell-and-the-clouds-wrap-the-planet.md) made the cloud layer two
concentric spheres and addressed the shape volume by **the direction from the planet's centre**,
scaled so one tile is `CLOUD_FEATURE` of surface. That was right about the thing it was fixing —
a slab is a flat-world sky — and the shell itself has been fine ever since: seam-free, pole-free,
planted over the ground, and visible from orbit.

It also dropped the altitude out of the volume, and wrote that down as a decision: _"The shape
volume is addressed by the direction from the planet's centre ... so it is seam-free and has no
pole; the weather map wraps the planet once through the same `equirectUV`; **altitude is the
vertical profile and no longer a volume axis**."_

That last clause is what broke the sky for anybody standing on the ground, and nobody found it
by reading the sky.

**The file's own header said the right thing the whole time.** `clouds.ts` opens by describing the
density field as "addressed by **direction from the planet's centre and altitude** instead of by
world `x`/`z` and `y`" — which is this record, written down, in the module that did not do it. So
the design was never in question and the prose was never wrong; a description of an address is not
a test of one, and a header comment cannot fail a build. That is the second half of the lesson and
it is the more uncomfortable one: **the drift here was between a comment and a shader, which is
the one pair in this repository that nothing compares.**

## Decision

**The address is the direction _and_ the altitude. `coords = direction · seaRadius/CLOUD_FEATURE`
with the layer's own normalised height added into `y`. And `CLOUD_FEATURE` is `0.12 · seaRadius`,
chosen from the ground rather than from the radius.**

The altitude term is the layer's `height` — `(length(world) − seaRadius − CLOUD_BOTTOM) /
CLOUD_THICKNESS` — which is the same number the vertical profile already used, so the profile
and the volume address are now two readers of one expression rather than two spellings of a
number that have to agree. It goes into the volume in the **march** and in the **march toward the
light**, and the weather map's warp moves out of `y` into `z` to get out of its way.

The feature is a twelfth of the radius: **16,320 units, 6.9° of arc, 52.36 wraps** around the
equator.

## Consequences

**The bug was a scale-invariance, and the number that describes it is 0.00.**

A direction is scale-invariant. Two samples seven hundred units apart _vertically_ — exactly the
distance from the ground to the underside of the layer — differ in direction by about five
thousandths of a radian. So the address moved **half a texel** of a sixty-texel volume, and this
is what a ray actually read on its way through the layer, at the eye height a player stands at:

| elevation | span | read, direction only | read, direction + altitude |
| --------- | ---- | -------------------- | -------------------------- |
| 90°       | 700  | **0.00 texels**      | **60.0 texels**            |
| 30°       | 1369 | 0.01 texels          | 60.1 texels                |
| 5°        | 4688 | 0.21 texels          | 61.1 texels                |
| 2°        | 5551 | 0.37 texels          | 61.8 texels                |

A vertical ray read the _same texel sixty times_, which means the same base shape and the same
three detail channels, with only the one-dimensional `heightGradient` varying between them. The
sky was a silhouette extruded through seven hundred units, softly capped and softly floored. That
is the defect a person standing on a planet reports as "the clouds look wrong", and it is not a
matter of taste or of a constant being mistuned.

**Every test in the suite passed throughout.** The address was _correct_ and it did not go
anywhere, and the whole file was written to ask what the address's **shape** was — that it was
scaled by the sea radius, that the weather wrapped once, that the altitude was divided by the
thickness. All three held. None of them asked how far the address **moved along a ray**, and that
is the only question that could have seen it. `clouds.test.ts` now has both halves: two regexes
over the emitted GLSL that pin the address's shape and are verified to fail when the altitude is
dropped from the march _or_ from the light march, and a geometric block that walks rays across
the layer and holds the answer to something the volume can resolve — its finest detail cell,
`SHAPE_SIZE / SHAPE_DETAIL_PERIODS[2]` = four texels. The division is deliberate. The regexes
would happily pin a useless address; the arithmetic knows nothing about how the address is
spelled; only together are they the pair the bug needed and only had neither of.

**The light march was the same bug reached from the other side, and it would have survived a fix
that only touched the march.** Its five geometrically growing steps climb about fifteen hundred
units — more than twice the layer's thickness — so addressed by direction alone they read _one
texel_ and every cloud would have been unshaded. It costs one `length` per light step, inside the
near field only, where the march is already the expensive half. The fetch budget is unchanged:
still two reads per marched step and one per light step, still 896 in the worst case, because an
address is arithmetic and not a fetch.

**The feature size is chosen from the ground, which inverts part of 0041.** 0041's rule is that
the planet's _body_ scales with the radius while its _surface detail_ does not, and it scaled the
cloud feature to `0.6 · R` on the grounds that it was part of the body. That rule is right about
the body and wrong about a cloud: a cloud feature is not a feature of the body, it is a distance at
which weather is recognisable, and the eye standing on the ground is the instrument that measures
it. At `0.6 · R` one feature was 34.4° of arc, which put **two and a half features between the
horizon and the zenith** and rather less than one in everything above thirty degrees — technically
weather, and not something a person would call weather. At `0.12 · R` it is 6.9° and about
thirteen.

(The figure is per band of _elevation_, which is the measure the address is uniform in. The
hemisphere as a whole holds more, because the solid angle near the horizon is enormous while the
address's `y` barely moves there — which is also why the count near the horizon is not a measure
of anything a player reads.)

**Angular size and wrap count are the same number, so there is no value of this constant that
gives big clouds overhead and few repeats.** A feature `L` units across on a planet of radius `R`
subtends `L / R` radians to a player under it at every elevation, and the volume repeats
`2π · R / L` times around the equator. Both are the same measurement. `0040` and `0041` chose ten
and a half wraps and got thirty-four degrees; this record chooses fifty-two and a third and gets
six point nine. Which is the whole trade, stated once: **the tiling and the ground-level cloud are
one number, and this one is spent on the ground** — at a factor of seven over the
anti-repetition floor, so nothing is lost but the ability to be dramatic from orbit.

**The scaling is `R`, and `R²` was considered and is wrong by an order of magnitude.** Features
tile a surface: `N · L² = 4π · R²`, so holding `N` fixed makes `L` proportional to `R` and it is
the _area_ that goes as the square. Taking `L = 2400 · (R/4000)²` on the second planet gives
2,774,400 units — **20.4 radians**, which is six and a half whole skies, so the entire planet
would be one cloud. The square is the law for an _area_, and a cloud feature is a length.

**The direction half is still nearly still, and that is what it is for.** Over a whole crossing
it moves less than 0.05 of a tile — 0.0000 vertically, 0.031 at two degrees of elevation. So the
field stays seam-free and pole-free and the clouds stay planted over the ground, and none of the
cost of restoring the volume's vertical structure came back as tiling.

**The warp moved to `z`, because `y` now means something.** It displaces the volume's two
_horizontal_ slots. A tenth of a tile of warp in `y` would slide each billow up or down its own
layer by up to seventy units of height depending on where in the weather field the sample fell —
which is a shear, not a wind. And the warp is stated in tiles rather than world units, which is
why it needed no retuning: the same tenth was 240 units on the flat planet, 8,160 on the first
spherical one and is 1,632 now, and the constant never changed.

**The coverage threshold is sharper than it was, and it is the threshold and not the address.**
Over a 16×16 grid of directions at the defaults, mean alpha went from 0.499 to 0.328 and the
distribution became bimodal: 172 rays below 0.1 and 84 above 0.9, with nothing in between. A ray
that sweeps a whole tile meets the coverage threshold along its length or it does not, and once
it does, `pow(density, 0.42)` and the extinction saturate within a few hundred units. Two things
were checked before believing it was real: re-running the grid with the _shader's_ two tiers of
step rather than the transcription's equal ones moves the split to 188 and 68 and leaves the gap
exactly where it was, so it is not oversampling; and the flat world's shader ran the same
threshold against the same volume over the same 700-unit crossing, so the sharpness predates the
planet. What it means is that the layer's **edges live in the volume** and not in the
accumulation, which is why the erosion and the detail channels have to carry them. Softening the
threshold would soften the edges and is a change of look, not a fix of one.

**A transcription had drifted in six ways and none of them showed.** `clouds.test.ts` asks the one
question the others cannot — does the finished layer look like weather — by transcribing the
shader's arithmetic into plain numbers. Its address held its direction still for the whole ray;
its streak came from a second, differently-addressed weather read; its `v` clamped instead of
wrapping, so both poles read the same two rows of the map; its `v` was **mirrored**; its coverage
threshold lacked its `min(profile, 1)`; and it applied the erosion to the **raw** base shape
instead of the **coverage-thresholded** one — the one that mattered, since `erosionNode`'s floor
is `1 − base` and its closing `min(…, base)` is that same `base`, so substituting a different one
silently changes what the erosion is allowed to remove. All six survived because the field is
self-similar, and a self-similar field forgives almost any addressing error. The fix is in the
transcription and the list is in its doc comment, because the next drift will be as quiet as the
last six.

**One light step is shorter than one detail cell, and that is on purpose.** The dither scales the
first of the five by 0.6 to 1.4, so it reads between three tenths and two tenths of a tile —
under the four-texel detail cell. It is the wrong cell to hold it to: the light march reads the
base shape alone, whose finest octave is three times coarser again, and it integrates a depth over
all five rather than sampling a profile. Recorded so the numbers are not mistaken for an oversight,
and because the assertion that would catch it is one this design never claimed to satisfy.

## Alternatives

**Address the volume by world position, as the flat world did** — `world · (1/L, 1/THICKNESS,
1/L)`, generalised to a sphere by putting `length(world) − seaRadius` in the `y` slot. It is
seam-free too, being linear in `x` and `z`, and it would restore the flat world's horizontal
perspective as well as its vertical structure. Rejected on a measurement rather than a principle:
**the player spawns at the pole** (`centre + (0, spawnRadius, 0)`, and `up` at that point is
`+Y`), so at the spawn `x` and `z` are zero in _every_ direction and every overhead ray would
address one texel — the same defect as the one this record fixes, but at the one place a player
starts. And with `L = 16,320` it repeats 52 times around the equator, at which point a
position-addressed field's convergence at the poles is visible from orbit.

**Restore only the vertical structure and leave `CLOUD_FEATURE` at `0.6 · R`.** Half the fix, and
it leaves one feature at 34.4° of arc. The altitude term is what makes a ray read the volume; the
feature size is what makes it read _different_ volumes. A smooth billow thirty-four degrees wide
is still one cloud in the sky.

**Scale the whole layer with the radius** — `CLOUD_BOTTOM`, `CLOUD_TOP` and `CLOUD_THICKNESS` up
by thirty-four, so the clouds stand off the ground at a proportionate distance and the same
angular size follows. It is arithmetically sound and it was rejected because it moves a measured
look with no browser to check it against, which is the reason 0041 gives for leaving the
atmosphere's thickness absolute. On top of that it fights the terrain: the relief is ±288 units
and is staying there, so a layer whose underside was 23,800 units up would put the cloud base far
outside anything the chunk window or the near-field fog is calibrated for.

**Give the volume a second altitude octave instead of the layer's own `height`.** More vertical
structure for free. Rejected: `height` is already the right coordinate, already tested, already
what the profile uses, and a second octave would be a new bake to verify for a difference
nobody has asked for.

**Raise `MAX_STEPS` because the layer is now sampled across a whole tile of volume.** The
horizontal sweep is 0.031 of a tile at the most grazing elevation a ground player has, so raising
the budget buys nothing. `128 × 120 = 15,360` against a maximum slant path through the layer of
5,551 units from sea level: the march was never the constraint, and the fetch budget test still
holds at 896.

## What this record does not touch

- **The shell.** Two concentric spheres at `seaRadius + 700` and `+ 1400`, solved for entry and
  exit, near span only. 0040's, and correct.
- **The weather map.** Wrapped once around the planet through `equirectUV`, pole pinch and all.
  0040's, and correct — and it now supplies a genuinely low-frequency coverage field _under_ a
  high-frequency shape volume, which is the right way round. The coverage field's own features run
  from 56,968 units at its finest octave to 170,903 at its coarsest, so at `0.12 · R` one weather
  feature spans **three and a half to ten** shape features; at `0.6 · R` it spanned between a half
  and two. Weather systems containing clouds read better than clouds containing weather systems,
  and the change made that the case by accident of arithmetic rather than by design.
- **The warp, the drift, the two tiers of step, `FAR_FIELD`, `MAX_DISTANCE` and the aerial
  perspective.** All 0040's and 0012's numbers, unchanged. In particular `MAX_DISTANCE = 17,000`
  and `FAR_FIELD = 7,000` are still absolute world units and the layer's spans still run from
  689 to 5,551 units from sea level, so the far-field cut still falls where it fell.
- **The bake.** `cloud-field.ts` and `cloud-textures.ts` are byte-for-byte what they were on the
  flat planet, and `cloud-field.test.ts` still pins their sizes and periods. Only the mapping
  from a position to a texture coordinate moved. That is the reason this was a two-line fix
  rather than a re-bake.
- **The sun and moon choice in the cloud shader**, which still asks `sun.y > 0` and so picks the
  lit light correctly only at the pole. A one-line fix against `normalize(eye)`, and a separate
  one; recorded here so it is not lost, because it is the same class of mistake — a world-`+Y`
  test surviving on a world whose `+Y` is only `up` in one place.
