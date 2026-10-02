# 0023 — Lights are a fixed table of uniforms, and the tests measure light

## Context

ADR 0020 recorded the last of v1's vocabulary gaps: "there is no way to turn a light off, so a
lantern is a shape that appears and stays." That is what `demo/lanterns.ts` was doing — eight
coloured boxes appearing on a timer, none of which could ever be un-made, in a place whose whole
subject was _lighting things up_.

Two things made this the riskiest change in the project, and both are recorded in the deleted
`TODO.md`.

**The shader layer is where four bugs already shipped with a green test suite.** A starfield that
lit zero pixels. A moon eight pixels across on a phone. A cloud layer that had never drawn a cloud.
Clouds at one eightieth of their own brightness. The fourth is the instructive one: a test asserted
the _shape_ of the emitted GLSL, found `T - T * exp(...)`, and read the divisor of an analytic
integral as part of its numerator. Every one compiled. Every one had tests. Every one was wrong.

**rmsl's own point lights cannot be used.** `PointLight`, `collectLights` and
`pointLightAttenuation` are all exported, and none of them can be. `collectLights` calls
`b.materialUniform` once per light during material compile, which bakes the light _count_ into the
shader. A world where lanterns appear on a timer would rebuild the terrain program several times a
second.

## Decision

**Eight lights, as sixteen `vec4` uniforms, unrolled in JavaScript at compile time, and a test file
that asserts on numbers a light produces rather than on the GLSL it emits.**

- **`MAX_DRAWN_LIGHTS = 8`, fixed, and unfilled slots read as dead lights.** A light of radius zero
  contributes exactly nothing, because the falloff window saturates to zero there and the term
  divides by `d²` rather than by the radius. **The price is sixteen uniform slots and sixteen thunk
  calls per draw whether or not a place is loaded; the thing bought with them is that a light
  appearing never rebuilds a shader.**
- **`PointLights` mirrors `SkyLight` exactly** — data on the instance, `declare` builds bindings
  onto it, one assignment a frame. Not a shared object with per-material bindings, because
  `declare` _assigns_ the uniform nodes and two materials sharing one instance would both read
  whichever declared last. The _list_ is shared by reference, so the per-frame work is one array per
  material rather than a fan-out of light data.
- **Intensity is a multiplier on a falloff scaled by the radius.** `r²/d²` means doubling a light's
  radius quadruples it at a fixed distance, so a place author tunes one number and can predict what
  it did. Raw `1/d²` was measured and rejected: a lantern ten units from a fragment contributes
  `0.01`, so every place would have had to write an intensity of a hundred.
- **The terrain and the water take lights. The clouds and the sky do not**, and this is a decision
  rather than an omission. A cloud is marched _through_ rather than lit at a surface, so lighting it
  means evaluating the light at the cloud's position along the whole march; and the sky has no
  surface at all. A ground lantern lighting the underside of a cloud deck is physically wrong
  anyway.
- **`MAX_LIGHTS = 256` in `places/limits.ts` is how many a place may _declare_, and the host picks
  the nearest `MAX_DRAWN_LIGHTS`.** Sorting by squared distance with **ties broken by id**, because
  two lights at equal distance have no geometric order and `Map` insertion order would decide — which
  is the order two scripts happened to run in, and therefore a peer divergence (ADR 0016).

## Consequences

**The measurement found a design error that a compile test never would have.** Raw inverse-square
means a lantern at distance 10 contributes `0.01`. The first version of the tests asserted
`toBeGreaterThan(0.5)` and failed — and the fix was to change the _physics' units_, not the
assertion. That is the whole reason this file is worth more than a compile check.

**Three assertions in `point-lights.test.ts` are bounds rather than equalities, and each says
why.** Doubling a radius quadruples the light — but to 4.015, not 4, because the window is
marginally more open at the larger radius. Asserting `toBeCloseTo(4, 2)` would have failed on a
correct shader; asserting `toBeGreaterThan(4)` alone would have passed on a broken one. The bounds
are `> 4` and `< 4.05`, and the comment says what the excess is.

**"Intensity is brightness at your own radius" was wrong and had to be taken back out.** The window
is _zero_ at the radius, so the contribution there is zero at any intensity. The docs, the type and
the tests now all say intensity scales the _falloff_ rather than naming a distance, and there is a
test asserting a light is dark at its own radius whatever its intensity — which is what keeps the
docs and the shader agreeing.

**Six of my own test premises were wrong, and every one of them was the shader being right.** A
light level with a surface contributes nothing under a Lambert term; comparing a lit _underside_ to
an unlit _top_ passes for any term at all; a light overhead contributes nothing to a vertical wall;
a fragment exactly at a lamp's centre has no direction; and two of the "is it brighter" comparisons
needed a light _beside_ the normal rather than above it. Each was corrected towards the physics.
A test that has to be corrected towards the physics seven times is a test that was measuring
something other than what it claimed.

**Two repo guards fired again, both correctly.** `limits.test.ts` refuses an exported limit nothing
references, so `MAX_LIGHTS`, `MAX_LIGHT_RADIUS` and `MAX_LIGHT_INTENSITY` each had to be wired in
before the suite would go green — the first into `host.test.ts`, the other two into the `edges`
table that checks a limit at its value and one past it. `effects.test.ts` holds one canonical
well-formed payload per tag, so `light-add` needed an entry or every other assertion in that file
was unreachable.

**Three tests in the suite are wall-clock and will fail under load.** The interpreter's own 250 ms
step budget (`MAX_STEP_MS`, ADR 0015) is what makes `demos.test.ts` flaky — a bundle that compiles in
40 ms on an idle machine exceeds it at load 20. The step-budget test asserts under 4,000 ms. These
are a property of choosing a _time_ budget rather than an instruction or memory one, and they were
observed failing and passing on the same commit across this session. Recorded here rather than
papered over: if they become a nuisance the answer is a budget in interpreter steps, not a larger
number.

**Nothing measures a light on a real GPU.** Every number in `point-lights.test.ts` comes from rmsl's
CPU rasteriser. The four sky bugs were all found by looking, and the probe here is closer to
looking than a compile check is — but a shader that computes the right value on a CPU has still not
been seen on a screen.
