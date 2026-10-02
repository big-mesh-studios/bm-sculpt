# 0013 — Fog is exponential, and its far distance is the chunk window's radius

## Context

The chunk window is a sphere of cells around the camera, and outside it there is
nothing. The camera's far plane is a hundred thousand units and the camera's near plane
is one. So the terrain stops at one and a hundredth of the depth of the frame, and
without something to fade into the sky its edge is a hard line across the horizon at a
distance the eye resolves perfectly well — 1280 units, about a fifth of the way to the
mountains a kilometre away appear to be.

The sibling project solves this with `smoothstep(near, far, distance)`, which is what
most engines do and what is in every tutorial about fog.

Two things had to be decided rather than copied. What curve the fog follows, and how
far away it closes — because the second is not an art decision at all. It is a fact
about where the geometry stops, and it is the kind of fact that quietly stops being
true when a number elsewhere in the system changes.

## Decision

**Fog is an exponential in distance, closing at four chunks — the streaming window's
radius — rather than at a distance chosen to look right.**

- `FOG_NEAR` is 500, inside the window, so the ground at the player's feet is not hazed.
- `FOG_FAR` is `4 * BLOCK_WORLD`, which is **the window's radius** and nothing else.
  `src/render/fog.test.ts` asserts it against `BLOCK_WORLD` precisely so that raising
  the window radius without moving this is a failing test rather than a visible seam.
- `FOG_FALLOFF` is 3.5 in multiples of "fully fogged" over that span, which leaves
  about three per cent of the surface showing at `FOG_FAR` and rather less at the
  window's actual edge.
- The fog's colour is the sky's **horizon** colour, and the same colour as the
  renderer's clear colour. One value, written once per frame from one
  `DayNightState`, reaching the terrain and the water as `uFogColour` and the
  background as `Color.set`.

## Consequences

**The curve has no terminus, and the reference's has a ring.** A `smoothstep` reaches
solid at `far` and stays there, so there is a band where it gets there and a visible
edge around the frame at that distance. An exponential _approaches_ — its rate of
change falls without bound, so the eye cannot find the place where it stops. The test
asserts the rate rather than the amount for exactly this reason: an amount saturates in
a float and stops meaning anything a couple of thousand units out, while a rate
continues to fall.

**The far distance is now coupled to the window, and that is the point.** If the
window grows, the terrain is drawn further out and the fog is where it was: still
correct, because an exponential never stops, but no longer tuned to the edge — which is
why `fog.test.ts` also holds the amount _at the widest window any scene builds_ rather
than only at `FOG_FAR`. The game's window is five chunks to the editor's four
(`GAME_WINDOW`), and a test that asserted only the nominal far distance would be
asserting a property of the editor's world.

**The near clamp is not tidiness.** The exponential's argument is `distance - FOG_NEAR`,
which is _negative_ for anything nearer — and an unclamped `mix` with a negative weight
extrapolates past the surface colour, away from the fog, so the ground at the player's
feet comes out inverted. This was found by writing the shader's own law out by hand in
a test, where the copy had the same bug: it returned −8 at the origin. A test that
calls the implementation cannot catch a bug that is in the implementation.

**Fog is a material's, not the renderer's.** There is no fog parameter on the renderer
here; `Fog` is a small object a material declares a uniform through and applies to its
own colour. So the terrain and the water each fade with their own shader, and the two
can be given different colours — which matters here, because the water is a mirror and
a mirror does not fade like a surface.

**The horizon colour is now load-bearing in three places.** The clear colour, the
fog's colour and the water's reflection all want the sky at the horizon, and the
reason they cannot drift apart is that `app.tsx` writes all three from one
`DayNightState` per frame. Three copies of the number would be three copies each right
on a different afternoon.

**A cloud drawn before the terrain is not occluded by it** — that is ADR 0012's
ordering, and fog is what makes the join between the two invisible: the terrain fades
into the sky's own colour at the window's edge, which is the same colour the clouds
fade into at theirs.

## Alternatives

**`smoothstep(near, far, distance)`, as the sibling project uses.** Rejected: it has a
terminus, and the terminus is a ring. It is also the form that invites the far value to
be chosen by eye — which is exactly what `FOG_FAR` must not be.

**Linear fog.** Rejected for the same reason as the smoothstep, with the extra
disadvantage that it is visibly wrong at the near end, where the slope does not go to
zero and the ground in front of the player has a visible edge on it.

**Linear-squared fog.** Rejected: it converges on the exponential's shape at range and
is worse near the camera, which is the half of the frame that is always on screen. The
exponential is one `exp()` and no branch; this is a multiply and a clamp, which is
cheaper and not worth the shape it produces.

**A height-based fog term, so the valleys hold more of it than the peaks.** Rejected:
it needs the terrain's height at every fragment, which this application computes rather
than stores (ADR 0002) — so the term would have to sample the field per pixel, in a
shader, for an effect that the exponential already half-provides.

**Move `FOG_FAR` out to the camera's far plane and let the terrain be visible to the
edge of the depth buffer.** Rejected: the terrain genuinely ends at the window, so the
far plane is not a distance at which anything has to be hidden — it is a distance at
which there is nothing left to show. Fading to the horizon colour at 1280 rather than
at 100 000 is what turns the absence of geometry into sky.
