# TODO

Phases 1 to 5 of the plan are done and green, and so are the four that followed them:
the clock and its console, the bake on a worker, the performance ceilings and the
records. **What is left is not code.** It is the list at the bottom of this file, which
is a list of things only a person looking at a screen can answer.

The section that has been worth the most so far is **the rmsl traps** below, because
every one of them cost an hour to find and none of them announces itself. It is
reference material rather than work, and it should outlive the work.

**`README.md:23` links to this file.** That link was broken from ADR 0010's commit until
this one was written. When the last question at the bottom of this page has been
answered, delete the file and the link with it.

## Where the work is

Everything is on branch **`wip`**, pushed. Nothing is on `main` yet and nothing has been
reviewed. The gate is four commands, in this order:

```
pnpm check-types     # clean
pnpm test            # clean
pnpm format:check    # clean
pnpm build           # clean
```

There is no linter and no `needsUpdate` habit in this project; `tsc --noEmit` plus
Prettier is the whole gate, and CI runs those four in that order.

## What exists now

| File                                | What it is                                                            |
| ----------------------------------- | --------------------------------------------------------------------- |
| `src/world/day-night.ts`            | Pure solar-position maths and the day's palette. No DOM, no renderer. |
| `src/world/day-night-controller.ts` | The clock: elapsed, an override, a speed. No material.                |
| `src/world/cloud-field.ts`          | The CPU bake: a 60³ shape volume and a 240² weather map. Pure.        |
| `src/world/cloud-bake-worker.ts`    | That bake, on a worker, with the handler and protocol under it.       |
| `src/world/cloud-textures.ts`       | Wraps a baked field into the two `DataTexture`s.                      |
| `src/world/clouds.ts`               | The raymarched slab material.                                         |
| `src/world/sky.ts`                  | The dome: gradient, starfield, sun and moon discs.                    |
| `src/render/fog.ts`                 | The fog, and the distances it is allowed to use.                      |
| `src/render/sky-light.ts`           | The six sky bindings every lit material shares.                       |
| `docs/adr/0011-*.md`                | Why the sun is computed rather than drawn.                            |
| `docs/adr/0012-*.md`                | Why the clouds are a raymarched slab whose box is a carrier.          |
| `docs/adr/0013-*.md`                | Why the fog is exponential and closes at the chunk window's radius.   |
| `docs/adr/0014-*.md`                | Why the dome is drawn first and ignores depth.                        |

One `DayNightState` per frame, built once in `app.tsx` from one `DayNightController`,
now drives the sky, the clouds, the terrain, the water, the fog colour and the clear
colour. **They cannot disagree, because there is only one answer to ask.** Keep it that
way: if something new needs the time of day, it takes the state, it does not derive its
own.

---

## The rmsl traps

`@random-mesh/rmsl` 1.14.0 is a node-graph DSL that compiles to GLSL ES 3.00. There is
no raw GLSL and no `ShaderMaterial`; `compileGLSL` is how you see what a graph became.
Its source is at `~/GitHub/rmsl` if a change is ever needed — see the last section.

**1. Arithmetic on a node with `*` is `NaN`, and nothing complains.**
`DRIFT * someNode` is JavaScript multiplication of a number by an object. It
stringifies to `NaN`, the shader compiles, it draws, and that uniform is dead. This cost
an afternoon and the only symptom was a sky that did not move. Every scalar-times-node
must be `.mul()`. There is a test asserting the emitted GLSL contains no `NaN` — it
exists because of this.

**2. A texture read written twice is two reads.**
rmsl builds a graph, not a compiler. `texture(uShape, coords).r` and
`texture(uShape, coords).g` become two fetches; the GPU cannot see they were the same
sample. The cloud shader written naturally issued **18 fetches per iteration**; with
every expensive intermediate forced into a `.toVar()` it is **2**. Anything read more
than once goes in a variable, and the same applies to a `hash` — the star shader
evaluated its hash seven times per pixel before hoisting.

**3. `mulAssign` on anything that is not a `toVar()` emits `1.0 = 0.5;`.**
That is not GLSL and it is not raised as an error. It mutates the node it was called on
rather than a variable. `let x = float(1)` then `x.mulAssign(0.5)` inside a loop does
this.

**4. A `toVar()` inside a loop is hoisted out of it.**
So a variable introduced inside a loop body carries the previous iteration's contents
into the next. Declare every mutable value **before** its loop and `.assign()` it in the
body — including accumulators that are reset at the top of each entry, since the
cloud march's light depth is read many times per pixel and kept its previous value.

**5. `setup()` is not in a block scope.**
`toVar`, `If`, `For`, `Discard` and friends throw there. `buildFragmentBody` **is**
wrapped in `Fn`, so loops and branches are fine in the body. `setup` is
declarations-only.

**6. The swizzles are a short list and it is easy to be wrong about.**
vec4 gives `xy xz xw yz yw zw` and single components. **There is no `gb`** — that cost a
compile error and then a day of wondering. `vec3(vec2Node, 0)` works at run time and
emits correctly, but the _type_ does not admit it; see the rmsl section for the
one-token fix, and until then write `vec3(w.x, w.y, 0)`.

**7. Uniforms a material registers but never reads are pruned.**
So a program legitimately has fewer uniforms than the material declared. Asserting
that `uSkyColour` is _absent_ from the terrain's program is how you tell "pruned
because unused" from "missing" — there is a test doing exactly that.

**8. There are no mipmaps, ever.**
`Texture.d.ts` accepts the mipmapped filters and treats them as their base filter,
because no renderer in the library builds a mip chain. Every texture minifies
unfiltered. This is why the shape volume's finest period is four texels per cell and
why nothing samples a skybox image.

**9. `If`/`Switch`/`Break` in a scene material.**
`Loop`, `For`, `While`, `If` and `Break` all compile to real GLSL and work, including
`Break` inside an `If` inside a `Loop`. `Switch` has no `Break` inside a `Case` and
lowers to an `if`/`else if` chain.

**10. Draw order is `scene.children` traversal order.**
There is no `renderOrder` and no `frustumCulled`. Anything that must be drawn first is
added first, which is why `createSky` is called at the top of the shared-scene block in
`app.tsx` and not with the water and the clouds.

---

## The four that already happened

All four were reported by a person looking at the screen, and none of them was visible
from the host: each compiled, each had a green test suite, and each produced a sky that
was wrong in a way only an eye would catch. They are written down because the shape of
them is the shape of everything else on this page.

**1. The starfield drew nothing at all.** `STAR_SIZE` was a fraction of a _grid cell_,
and a cell is a third of a pixel at 360 lines and a ninth at 1080 — so every star was a
sub-pixel feature, which is invisible however bright it is, because a fragment shader
only ever asks about the pixel's centre. Measured over a real frame: **zero lit pixels at
640×360**. The falloff made it worse: `pow(point, 14)` leaves a half-bright core of a
fiftieth of the radius. Stars are now sized in **CSS pixels** (the star's direction is
projected as a point at infinity and measured on screen), and `STAR_GAIN` exists because
the pixel a star lands on reads a seventh of its brightness — mean lit brightness was
**0.13** against a night sky of 0.02. `sky.test.ts` now transcribes the starfield's
arithmetic and asserts on the number of pixels it lights.

**2. The moon was at its true angular size, which is eight pixels on a phone.** Half a
degree across, tinted by the light it casts, so a blue dot. Both discs are now drawn two
to four times life size — 2.2° across for the moon, 1.5° for the sun — while their glows
are left at their true angular scale. Every game that draws a moon draws it bigger.

**3. The cloud layer had never drawn a cloud.** The shape volume's third axis is the
layer's _thickness_, so an altitude has to address it as
`(y - CLOUD_BOTTOM) / CLOUD_THICKNESS`. It was written as a scale of `1 / THICKNESS` and
an offset of `-CLOUD_BOTTOM` — subtracting the altitude from an address that had already
been divided by the thickness, which put every sample at about **−699**. The dimensional
profile multiplies the coverage by `saturate(height / 0.09)`, so the coverage was
multiplied by **zero** at every height in the layer and the density threshold could never
be met. Empty sky, at every hour, for ever.

**4. The clouds drew at one eightieth of their own brightness.** The step's opacity was
divided by its optical depth, which is right only when what multiplies it is a scattering
coefficient in units of one per length — it is a _colour_. And the optical depth is
`density · 1.15 · 70` for a dense step, so the division was by about **eighty**: every
cloud in the sky accumulated one eightieth of itself. Black, at full alpha, with perfect
cumulus silhouettes.

That one is the most instructive of the four, because there was a **test asserting the
division was there**. It read the emitted GLSL, found `T - T * exp(...)`, and then
asserted a `/ max(...)` followed — checking the numerator of an analytic integral and
reading the divisor as part of it. The file's own comment said the point was that the
result was "independent of how finely the march was sampled", which is true of the form
and was used to justify a factor that made it depend on nothing but the extinction.

There is a better assertion, and it is now the one in place: with no division,
`scatter / covered` **telescopes to a weighted mean of the step colours**, so it cannot
come out darker than the sky behind it. That is a property of the arithmetic rather than
of its shape, and it is checkable without a GPU.

That third one is the lesson, and it is why `/sky-probe.html` exists. The field was
well-formed, the shader compiled, the material was built and reported itself ready in the
header, and 927 tests were green. **What was missing was a question that could be
answered about the finished image**, and no amount of host-side testing substitutes for
one:

| mode              | what it answers                                                    |
| ----------------- | ------------------------------------------------------------------ |
| `/sky-probe.html` | how many pixels did the dome and the layer actually light          |
| `?compile`        | does this device's driver accept these shaders at all              |
| `?box`            | is anything drawing, or is the framebuffer not what we think it is |

## What needs a human's eyes

None of this is verifiable from a test, and all of it is the difference between a sky
that works and one that looks right. The tests assert that the shaders compile, that
the arithmetic is shaped correctly and that the field is well-formed. None of them have
ever seen a pixel.

**The tuning constants.** Every one of these was reasoned about on paper and none has
been looked at. They are grouped by the file they live in and each carries a comment
saying what it is for.

- `src/world/clouds.ts` — `CLOUD_BOTTOM`/`CLOUD_TOP` (700/1400), `CLOUD_FEATURE` (2400),
  `WEATHER_FEATURE` (48000), `DENSE_STEP`/`EMPTY_STEP` (70/120), `MAX_STEPS` (128),
  `EXTINCTION`, `ABSORPTION`, `POWDER`, `CORE_HEIGHT`, `AERIAL_PERSPECTIVE`,
  `PHASE_FORWARD`/`PHASE_BACKWARD`/`PHASE_MIX`. `coverage = 0.52` and `density = 1` on
  `CloudMaterial` are the two a player would notice first.
- `src/world/sky.ts` — `GRADIENT_EXPONENT` (0.75), `STAR_THRESHOLD` (0.985),
  `STAR_SIZE`, `STAR_FALLOFF`, the disc radii, and the four glow strengths. Whether
  there are three thousand stars or thirty, and whether the sun is too big, are both
  questions with no answer but a screen.
- `src/world/day-night.ts` — `SOLAR_LATITUDE_DEG` (45), `SOLAR_DECLINATION_DEG` (0) and
  the palette. `TWILIGHT_HIGH_DEG`/`TWILIGHT_LOW_DEG` (6 / −12) are the least arbitrary
  of them and still worth a look.

**The horizon.** The cloud layer reaches 17 000 units and the terrain's fog closes by
1 280. Whether those two meet in a way that reads as a horizon or as a seam is a
screenshot question, and it is the first thing to check once the sky is visible.

**The starfield's tilt.** It rotates about the vertical, so stars rise in the east and
set in the west. A real sky wheels about a celestial pole at the observer's latitude.
The tilt was left out as a refinement nobody would read in a twenty-minute cycle, and
it is the one deliberate simplification in the sky. It is commented as one in the file,
and it is recorded as one in ADR 0014.

**The cloud cost.** `MAX_STEPS` (128) and `LIGHT_STEPS` (5) make 896 texture fetches per
pixel of sky in the worst case a ray can reach, and `clouds.test.ts` holds that under 1024. Nobody has watched it run on a phone. If a frame is being missed, the honest levers
are device pixel ratio and those two numbers, in that order.

**The bake's arrival.** The field arrives from a worker a second or two after the first
frame, so the sky begins empty and fills in. That was the point — the page does not
freeze — and nobody has yet watched whether a cloudless sky for two seconds reads as
loading or as a bug. If it reads as a bug, the answer is a loading screen rather than a
smaller field. (It is worth knowing that the worker path works: a headless run of the real
application printed `clouds: ready (baked on the worker)` while the sky above the player
was empty for a completely different reason.)
