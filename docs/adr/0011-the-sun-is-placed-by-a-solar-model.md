# 0011 — The sun is placed by a solar model, not by a drawn curve

## Context

The sky needs to change over time: the clear colour, the clouds, the terrain and the
water all have to agree about what hour it is, and they have to agree about the sun's
_direction_, not only its brightness, or the shadows will lie.

`big-mesh-studios`'s `apps/voxelscape` owns a twenty-minute day-night cycle in
`src/environment/day-night.ts`, and most of it is worth taking as it stands: a palette
of three stops tweened through a warm midpoint, a moon placed exactly opposite the sun,
a clock of `(elapsed, override, speed)`, and the whole thing as pure functions over one
elapsed-seconds argument so the caller can ask it every frame and test it without a
graphics device. `src/console/commands.ts` already records that the console in this
repository is a partial port of that one.

What is not worth taking is the sun's path. The reference walks elevation through a
piecewise-linear curve — 35° up to 60° and back by noon, then a dive to −25° held flat
for the whole of night — and takes azimuth from a second piecewise curve beside it. It
reads well and it is cheap. It is also a _drawn_ arc rather than a computed one, and it
has three properties no latitude on earth has:

- **Dawn and dusk are the same length**, by construction, because both are `90` seconds
  of clock.
- **The sun never gets above 60°**, so the world's own latitude is not a thing that can
  be wrong.
- **The palette and the light can disagree.** The reference classifies phases by
  wall-clock against hardcoded windows and paints each window with its own tween. Those
  two are separate facts that happen to agree today. Change the sun curve and the sky
  keeps painting dusk while the sun sits twenty degrees up — which is not a subtle
  artefact, it is the single most legible thing in a frame.

The third is the one that decides it. A day-night cycle is two pieces of maths — where
the sun is, and what colour that light is — and they should have one parameter between
them rather than a shared convention.

## Decision

**`src/world/day-night.ts` places the sun with the standard solar-position solution for
a fixed latitude and declination, and drives the palette from the resulting elevation.
Every phase boundary is a statement about the sun's elevation, not a partition of the
clock.**

Concretely:

- The sun's direction comes from the horizon-frame solution
  (`up = sinφ·sinδ + cosφ·cosδ·cosH`, `east = −cosδ·sinH`,
  `north = sinδ·cosφ − cosδ·cosH·sinφ`), mapped into the world as
  `east → +X`, `up → +Y`, `north → −Z`.
- The hour angle turns once per cycle and is zeroed at `NOON_SECONDS`, a quarter of the
  way in — so the cycle opens on a sunrise, as the reference's does.
- Latitude is `45°` and declination is `0°`. Zero declination is an equinox, which makes
  dawn and dusk symmetric about noon and the sun clear the horizon exactly at
  `t = 0` and `t = 600`.
- One number, `twilight`, runs from 0 at `+6°` of elevation to 1 at `−12°`, clamped
  outside. It is the palette's only parameter, and it is exposed on the state so that
  the starfield can fade on the same thing rather than on elevation independently.
- `phaseAt` reads elevation: above `TWILIGHT_HIGH_DEG` is `day`, below
  `TWILIGHT_LOW_DEG` is `night`, and inside the band it is `sunrise` or `sunset`
  according to whether the sun is climbing.

The reference's `DAY_SECONDS` and `SUNSET_SECONDS` constants are kept, but nothing reads
them. `phasePreset` finds a phase by walking the cycle and returning the midpoint of its
longest run, which is what `/clock:sunset` jumps to.

## Consequences

**The phase durations are not the reference's, and cannot be made to be.** The model
produces 85 seconds of sunrise, 543 of day, 85 of sunset and 487 of night, against the
reference's 90 / 600 / 90 / 420. The difference is entirely the `−12°` twilight
threshold, and it is the honest answer rather than a tuning one: the reference chose
thirty-five minutes of darkness and back, and this asks the sun when it is dark. The
`day` and `night` constants survive as documentation of roughly where that is.

**The palette cannot disagree with the sun.** This is the consequence the decision was
for, and it is structural rather than a matter of choosing values carefully: there is
only one parameter and both consumers read it. No pair of numbers can fall out of step.

**A dawn and a dusk at the same elevation are the same colour.** The reference could not
express this. Its windows were differently shaped and it tweened sunrise and sunset in
opposite directions to compensate, so the two ends of the day were the same hue only by
coincidence of the numbers. Here they agree by construction, which is both a correctness
win and a test that can be written — `day-night.test.ts` asserts it directly.

**Brightness lives in the colours, and there is no intensity curve anywhere.** Noon sun
light is near white; midnight sun light is a fifth of that in the same channel. The
reference's trick, carried across unchanged, and the reason one directional light and
one ambient light can cover every hour.

**The sky does not change with the season.** Declination is a constant rather than a
day of the year, so two visits to the same `elapsed` give exactly the same sky and the
cycle is reproducible for a benchmark. A calendar would be one more feature and would
make `elapsed` no longer sufficient to name a sky. If a world ever needs a season, that
is the change to make and it belongs in the same function.

**Stars are not optional.** A seven-and-a-half-minute night painted as
`[0.02, 0.03, 0.09]` is a long flat black rectangle, and a long flat black rectangle
reads as a broken renderer rather than as midnight. The reference has no starfield at
all, so this is built rather than ported, and it is the one place where taking the
reference's output verbatim would have been visibly wrong.

**Rising and falling is decided by probing, which costs one extra evaluation.**
`sunIsRising` calls `sunElevationDeg` twice rather than reading the sign of the hour
angle's cosine. One call per frame per query, no allocation either way. The cosine is
cheaper and is wrong near the poles, where the sun can climb at a positive hour angle;
this configuration is at 45° and would not notice, but the probe costs nothing and does
not need a comment explaining which latitude it stopped working at.

## Alternatives

**Port the piecewise curve verbatim and change nothing.** Rejected: it is the shortest
path and it carries all three defects above, of which the third is the one that gets
worse rather than staying static. The longer the model lives, the more code depends on
the phase windows being right, and they would be right only by not being changed.

**Keep the phases as clock windows and replace only the elevation.** Rejected: this is
the tempting half-measure, because it preserves the reference's `phaseAt` signature and
its console presets exactly. It is the arrangement that has to be avoided — the windows
become a second, independent statement about when the sun is low, and the two are
correct only until the latitude changes.

**A sinusoidal elevation.** Rejected: it gives a plausible arc and no azimuth. An
elevation-only sun rises in the same compass direction all day, which reads as a
translating light rather than an orbiting one, and it cannot be corrected afterwards
because there is nothing to correct.

**Drive the palette off `sunElevation` and let the phases be a wall-clock partition
after all.** Rejected: that is the same second-source-of-truth problem as the previous
rejected half-measure, with the difference that the palette is now right and the labels
are wrong — strictly worse, because a mislabelled phase is a console command that jumps
to the wrong time.

**Read rising or falling from `cos(hourAngle)`.** Rejected: see the consequences above.
It is the faster answer and it is only correct between the polar circles.
