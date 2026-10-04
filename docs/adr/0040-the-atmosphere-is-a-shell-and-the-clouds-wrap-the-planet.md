# 0040 — The atmosphere is a shell, and the clouds wrap the planet

Supersedes the flat-world shape in [0012](0012-the-cloud-layer-is-a-raymarched-slab.md) and
extends [0013](0013-fog-is-exponential-and-closes-at-the-window.md).

## Context

[0039](0039-past-a-height-the-planet-is-a-displaced-globe.md) made the planet visible above 420 units
by swapping the streamed chunks for a displaced globe, and promised it would be lit and hazed by the
same `Fog` the terrain is. The globe was built correctly and the promise failed anyway: from the
altitude the globe takes over at, the whole planet was still the sky's colour.

The cause was not the globe. Two of the sky's three pieces had been built for a flat world, and only
the third — the globe — had been curved.

- **The fog had one law for two jobs.** It was a distance exponential with a height falloff, and its
  far distance was the chunk window's radius, 1280 units. Hiding that window needs an extinction
  that swallows everything past it. From 900 units up the planet's surface is thousands of units
  away in every direction, so the same extinction swallowed the planet. The eye-height term 0039
  added thinned the air but could not separate _far away_ from _thin air up here_, because a
  distance law has no way to see the difference.
- **The cloud layer was a slab.** Two horizontal planes at `y = 700…1400`, addressed in world x/z,
  carried on a camera-centred box. On a sphere the layer stands off the ground on one side and sinks
  into it on the other, and the far side of the planet has no clouds at all.
- **The sky was a plane gradient with a starfield gated on the day.** It had no altitude. From
  outside the atmosphere it was a full blue daytime gradient, and its stars could only appear at
  night, because the only thing that hid them was `twilight`.

## Decision

**The air is a spherical shell integrated as a column; the clouds are a concentric shell addressed by
direction; and the sky knows how much air is above the eye.**

1. **`render/atmosphere.ts` states the shell once.** Air is `seaRadius <= |p| <= seaRadius +
ATMOSPHERE_HEIGHT`, density `exp(-height/H)`, and `airMass` is a two-point Gauss-Legendre
   quadrature of that density along a ray, clipped to the shell. The host `airMassShell` is the
   shader's rule, `airMassReference` is a 256-sample oracle, and a test holds the **visible** amount
   within five per cent of it over every altitude and angle a player looks along. Two samples and not
   one: a single midpoint sample read a grazing limb up to fifty per cent low.
2. **Fog is two optical depths summed through one exponential.** The near-field window term — 0013’s,
   unchanged — scaled by `nearField`, plus `ATMOSPHERE_EXTINCTION × airMass`. `nearField` is the
   complement of the globe’s own crossfade opacity, written from the same `globeOpacityAt` in
   `app.tsx`, so the window fog goes out exactly as the globe takes over.
3. **The cloud layer is two concentric spheres**, `seaRadius + CLOUD_BOTTOM` and
   `seaRadius + CLOUD_TOP`. The march solves entry and exit against them and keeps only the **near**
   span, because the far side is behind the planet and the globe writes no depth for it to hide
   behind; it empties entirely when a ground eye looks down into the planet. The shape volume is
   addressed by the **direction from the planet’s centre**, scaled to `seaRadius / CLOUD_FEATURE`, so
   it is seam-free and has no pole; the weather map wraps the planet once through the same
   `equirectUV` the globe’s albedo uses; altitude is the vertical profile and no longer a volume
   axis. Drift is a rotation of the direction about the planet’s axis, so it crosses the
   antimeridian continuously.
4. **The sky is gated on altitude.** `atmosphere = exp(-altitude / H)` scales the gradient and the
   sun and moon glows; the same shell draws the planet’s **limb** as the view ray’s air mass, shown
   only when the eye is outside it; and stars are `max(nightFade, 1 - atmosphere)`, so they appear in
   daylight once the eye leaves the air.

## Consequences

**The planet is visible from the altitude the globe takes over at.** Measured: 17% haze straight down
at 900 units with the atmosphere alone, against 86% with the window term switched back on — which is
the bug this decision exists to end. The limb is about 85% along a grazing ray from the same height,
so the rim reads.

**The atmosphere completes where the shell ends, at four scale heights — 4800 units above the sea.**
That is where the sky is black enough to see stars at noon. It is well above the 900-unit globe
crossover, which is the point: the crossover is a change of surface, not of air.

**The clouds wrap and are visible from above.** The shape field has no seam and no pole, because it
is a three-dimensional field sampled on a sphere. Two things are given up for that: the weather map
keeps the equirectangular pole pinch (the same pinch the globe’s own albedo has), and the shape
volume no longer varies with altitude, so vertical billow structure comes from `heightGradient`
rather than from the volume. Both are visible only to somebody looking for them.

**The fog is no longer one number, and the split is load-bearing.** `nearField` ties the window term
to the globe’s crossfade; if the two ever stopped being written from the same value the seam the
crossfade exists to hide would reappear as a fog seam. It is one assignment in the frame loop and it
is asserted by the shape of the shader, not by a screenshot.

**Cost.** Every surface fragment now evaluates three exponentials and the shell’s square root where
it evaluated two exponentials before; the sky gained a few square roots and exponentials, once per
pixel. The fog test pins the count so it cannot grow unnoticed.

**The globe and the sky still share their inputs.** The globe’s `Fog`, the terrain’s and the water’s
are written from the same `DayNightState` each frame, and the sky’s shell is the same constant; the
swap stays invisible because nothing has a second opinion about the hour or the air.

## Alternatives

**One physical atmosphere, and let the window fog go.** Rejected, and it is the trap the whole
decision is about: hiding a 1280-unit window needs a high extinction, and that same extinction makes
the vertical column from orbit opaque. The two jobs cannot share one number, so they are two terms
with a fade between them.

**Keep the slab and post-process the horizon.** Rejected: a slab on a sphere is wrong at the poles
and on the far side, which is exactly where a planet is seen from.

**A cube-map or triplanar weather field, to remove the pole pinch.** Rejected for now: the
equirectangular mapping is the one the globe’s albedo already uses, so there is a single mapping for
a sphere rather than two that could disagree at a seam, and the pinch is invisible in a
low-frequency coverage field.

**Rayleigh and Mie single scattering.** Rejected: larger, harder to verify without a GPU, and the
two things a player reads — the limb and the aerial perspective down to the surface — are what a
shell column already draws.

**Stars always visible, attenuated only by the sky’s own brightness.** Rejected: it changes the
ground daytime sky, which is not the bug. Gating them on `1 - atmosphere` leaves the ground exactly
as it was.
