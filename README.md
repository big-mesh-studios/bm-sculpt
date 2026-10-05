# bm-sculpt

Chunked surface-nets sculpting, in the browser.

A sculptor whose field is an operation list rather than a stored volume, meshed
per chunk in web workers, drawn with a node-graph renderer, and built to stay
responsive on hardware several years old.

This repository is at **phase 5** of a planned rebuild. The CSG core, the streaming
foundation, the mesher, the render path and the editing tools exist and are tested,
and you can sculpt on a model that is meshed in workers and never stored. Phases 0
to 5 are the sculpting application; what is not built is the palette and the
primitive tools a parity pass would want.

Load it and you get a streamed model; load `?spike` and you get the phase 0
diagnostic, which is kept because the application draws with the same material and
the same vertex layout, and the first question about anything that looks wrong is
which of the two broke it.

## What exists

The decisions behind all of it, with their costs and their rejected alternatives, are in
[`docs/adr/`](docs/adr/README.md). The phases the sculpting application was built in —
0 through 5 — are in the repository history, one commit per phase, each verified before the
next began.

|              |                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renderer** | [`@random-mesh/rmsl`](https://www.npmjs.com/package/@random-mesh/rmsl) 1.14.0 — a scene graph and a node-graph shader DSL. Not a three.js fork; see [ADR 0001](docs/adr/0001-rmsl-over-three.md).                                                                                                                                                                                                                                                       |
| **UI**       | Solid **2.0.0-beta.29**, `solid-js` + `@solidjs/web` + `@solidjs/signals`, coordinated at one version. The JSX transform runs through Babel rather than the native compiler, so the toolchain has no native step and builds anywhere Node does; see `pnpm-workspace.yaml`.                                                                                                                                                                              |
| **Build**    | Vite 8, `vite-plugin-solid@3.0.0-next.5`, TypeScript in `strict` with `noUnusedLocals` and `noUnusedParameters`.                                                                                                                                                                                                                                                                                                                                        |
| **Style**    | One Prettier config, no linter. Type safety is `tsc --noEmit`.                                                                                                                                                                                                                                                                                                                                                                                          |
| **Layout**   | One package. `pnpm-workspace.yaml` exists for the `catalog:` it holds, which every version more than one place needs is written into once.                                                                                                                                                                                                                                                                                                              |
| **Console**  | `/` for a floating terminal over the game: fuzzy command completion, history, `/help`, and the fullscreen button beside its trigger. Commands are declared in one table (`apps/bm-sculpt/src/console/commands.ts`) whose `run` closures call plain methods on `Game`; neither knows a console exists. A second table, `/place:`, is merged in with `Commander.with()` and may return a promise, which the console prints as a pending line it replaces. |
| **Places**   | TypeScript run in QuickJS-in-WASM, bundled from source, with 19 effects and 7 events. `/place:load bridge` builds a bridge you can walk on, and `/place:open` reads one out of a zip. Isolated, deterministic and capped; see [ADR 0021](docs/adr/0021-a-place-arrives-as-a-zip-with-a-manifest.md).                                                                                                                                                    |

## Phase 0 spikes

Three questions were meant to be settled before the mesher is written, because a
wrong answer to any of them would force the mesher's output format to change.
All three are answered, and each is answered twice: once as a unit test that
compiles and inspects the shader on the host, and once visibly on screen.

**Does a packed vertex layout reach the GPU?** The layout is the one the mesher
will target — `float32x3` position, `snorm16x2` octahedral normal, `unorm8x4`
colour, twenty bytes. `vertexFormatOf` infers the format from the array type,
component count and `normalized` flag, and
[`spike-geometry.test.ts`](apps/bm-sculpt/src/render/spike-geometry.test.ts) asserts the
inference and that `VERTEX_BYTES` matches what those formats actually occupy.
Signed 16-bit pairs beat unsigned 8-bit quads for the normal at the same four
bytes — roughly a hundredth of a degree of error rather than four tenths.

**Does a 3D sampler bind?** There is no `Data3DTexture`; a volume is a
`DataTexture` with a depth, bound through `b.sampler(name, "sampler3D", …)`.
[`surface-material.test.ts`](apps/bm-sculpt/src/render/surface-material.test.ts) compiles the
material on the host and asserts `sampler3D` appears in the emitted GLSL and in
the program's binding list — the text being the only place the difference between a
`sampler3D` and a `sampler2D` on the same bytes is visible.

**What precision does this device have?** `highp` is mandatory in the vertex stage
and optional in the fragment stage, and an unsupported qualifier is dropped
_silently_ — the shader still compiles and the only symptom is banded lighting.
[`precision.ts`](apps/bm-sculpt/src/render/precision.ts) measures it with
`getShaderPrecisionFormat` and the spike page reports the answer.

**Is a raw GLSL escape hatch available?** No, and that is worth knowing before
reaching for one: there is no `ShaderMaterial` in this library. Every shader must
be a node graph. `compileGLSL` is how to see what one became.

## Running it

This is a pnpm workspace: **five libraries under `packages/`, one application under `apps/`.**
`pnpm` at the root does the right thing for all of them, so the commands below have not changed.

```sh
pnpm install
pnpm dev
```

```sh
pnpm check-types       # tsc --noEmit, in every workspace
pnpm test              # vitest, in every workspace
pnpm build             # vite build, per app
pnpm format            # prettier --write
pnpm workspace:check   # the /apps versus /packages rule
```

### The layout, and the rule that keeps it

| Path               | What it is                                                          |
| ------------------ | ------------------------------------------------------------------- |
| `packages/core`    | Vector and box types, `Medium`, the three numbers every field needs |
| `packages/sdf`     | Closed-form primitive distances and their validation table          |
| `packages/csg`     | The operation list, the fold, the BVH, terrain, serialisation       |
| `packages/meshing` | Surface Nets, growable buffers, chunk mesh output                   |
| `packages/picking` | Which primitive a structural ray hits                               |
| `apps/bm-sculpt`   | The landscape: chunks, streaming, renderer, places, console         |
| `apps/homepage`    | The front page the site root serves, prerendered to one HTML file   |
| `tools`            | The checks the workspaces cannot check on each other                |

**Mobile lives in `packages/ui`, not in an application.** `baseline.css` carries
`overscroll-behavior`, the 16px input rule that stops iOS zooming the page on focus, the
safe-area insets, the coarse-pointer 44px sizing tokens and `prefers-reduced-motion` — and
it ships **no classes at all**, because a CSS module's hashed names cannot travel into a
package. [ADR 0026](docs/adr/0026-the-mobile-rules-live-in-a-package.md) records what that
found in this application, including three shipped bugs.

`workspace:check` is the only gate here that can fail on a dependency graph which compiles
perfectly: a package that depends on an app, an app that could be published, or two packages
pointing at each other by path. It runs first in CI, because it costs a second and it is the
check with nothing to do with types. [ADR 0024](docs/adr/0024-packages-is-what-has-no-opinion.md)
records why the split is at this line rather than another.

**Packages ship raw TypeScript.** Each one's `exports` points at `./src/index.ts` and consumers
resolve it with `moduleResolution: "bundler"`, so there is no build step in any package and a
broken type in a library fails the _consumer's_ type-check immediately. The only workspace with a
`build` script is an app.

### Why Solid beta rather than RC

From `vite-plugin-solid@3.0.0-next.21`, the plugin delegates to
`@solidjs/vite-plugin`, which drives the **native** Solid compiler — a platform
binary, with a WebAssembly fallback only where no binary exists for the platform.

Termux is one of those platforms. It is Linux on arm64, but it uses Bionic rather
than glibc, so the published `linux-arm64-gnu` binary will not load and the
WebAssembly fallback is blocked by the sandbox, failing with `UVWASI_EACCES,
uvwasi_init` before any code runs. Every RC of the framework has this problem on
this machine.

`vite-plugin-solid@3.0.0-next.5` transforms JSX with Babel and `@babel/core`,
which are pure JavaScript and have no platform to disagree with. Its peer ranges
cover this exactly — Solid `>=2.0.0-beta.0 <2.0.0-experimental.0`, Vite up to 8 —
and it is the combination `big-mesh-studios` builds both of its applications with.
So the framework is pinned to beta.29 and `babel-preset-solid` is pinned to match,
because each preset declares a peer of `^2.0.0-beta.<its own>` and a floating
resolve lands on one that wants a newer framework than the one installed.

The Vite plugin is also scoped to `.tsx` and `.jsx` (`include: /\.[jt]sx$/`), which
is correct regardless — a `.ts` file cannot contain JSX — and means the unit tests,
all of which are JSX-free, run without a compiler at all.

## Plans

The architecture decisions, each with its costs and its rejected alternatives,
are in [`docs/adr/`](docs/adr/README.md):

|                                                                                  |                                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [0001](docs/adr/0001-rmsl-over-three.md)                                         | Render with rmsl, not three.js                                                     |
| [0002](docs/adr/0002-computed-field-never-stored.md)                             | The field is computed, never stored                                                |
| [0003](docs/adr/0003-surface-nets.md)                                            | Surface Nets per chunk, not marching cubes                                         |
| [0004](docs/adr/0004-csg-per-chunk.md)                                           | Each chunk evaluates the operations at its own LOD                                 |
| [0005](docs/adr/0005-streaming-shape.md)                                         | Slot-indexed arrays and a coordinate map                                           |
| [0006](docs/adr/0006-field-saturation.md)                                        | The field saturates at a fixed distance                                            |
| [0007](docs/adr/0007-window-presence-and-lod-reset.md)                           | Invalidating a slot invalidates what a query may read                              |
| [0008](docs/adr/0008-worker-pool-and-generations.md)                             | One chunk per worker, and a generation per request                                 |
| [0009](docs/adr/0009-picking-and-history.md)                                     | Edits land where the field says, and are undoable                                  |
| [0010](docs/adr/0010-suspend-the-pointer-lock-not-the-input.md)                  | Suspend the pointer lock, not the input                                            |
| [0011](docs/adr/0011-the-sun-is-placed-by-a-solar-model.md)                      | The sun is placed by a solar model, not a drawn curve                              |
| [0012](docs/adr/0012-the-cloud-layer-is-a-raymarched-slab.md)                    | The cloud layer is a raymarched slab with a carrier                                |
| [0013](docs/adr/0013-fog-is-exponential-and-closes-at-the-window.md)             | Fog is exponential and closes at the window                                        |
| [0014](docs/adr/0014-the-sky-dome-is-drawn-first.md)                             | The sky dome is drawn first and ignores depth                                      |
| [0015](docs/adr/0015-place-scripts-run-in-a-quickjs-interpreter.md)              | Place scripts run in QuickJS, and all three caps are set                           |
| [0016](docs/adr/0016-a-place-is-a-named-group-of-operations.md)                  | A place is a named group of operations, and `flatten` decides the fold order       |
| [0017](docs/adr/0017-the-vocabulary-is-a-table.md)                               | The effect and event vocabulary is a table, and a payload is all-or-nothing        |
| [0018](docs/adr/0018-a-place-is-bundled-and-the-guest-library-is-a-real-file.md) | A place is bundled into one reproducible program; the guest library is a real file |
| [0019](docs/adr/0019-the-host-owns-what-it-can-own.md)                           | The host owns what it can own, and asks for the eight things it cannot             |
| [0020](docs/adr/0020-a-place-runs-on-the-frame.md)                               | A place runs on the frame, and the console is how a person meets it                |
| [0021](docs/adr/0021-a-place-arrives-as-a-zip-with-a-manifest.md)                | A place arrives as a zip with a manifest at its root                               |
| [0022](docs/adr/0022-a-field-is-a-box-that-moves-the-player.md)                  | A field is a box that moves the player, and the physics was already there          |
| [0023](docs/adr/0023-lights-are-a-fixed-table-of-uniforms.md)                    | Lights are a fixed table of uniforms, and the tests measure light                  |

**The phases after 6 are not in this table, because they are not decided.** Phase 6 was the
terrain base field and is in: `session.ts` binds the landscape as the field's base, which is
all ADR 0002 says an infinite world would need. Phases 7 and 8 were the infinite streaming
world, and **their scope was never written down anywhere in the tree** — the handoff that
should have said so said it plainly rather than inventing one. What is left instead is the
places track and props, figures and NPCs, and neither has a phase number.

## The sky

The game scene has a sky, and it changes over a twenty-minute cycle. It is four
pieces that share one parameter and cannot disagree about what hour it is.

|                  |                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sky.ts`         | A dome: a horizon-to-zenith gradient, a hashed starfield, and the sun and moon as soft discs with their glow.              |
| `day-night.ts`   | Where the sun is and what colour the light is — pure arithmetic over one elapsed-seconds argument, no DOM and no renderer. |
| `clouds.ts`      | A raymarched slab between 700 and 1400 units, sampling two baked fields at incommensurate periods.                         |
| `cloud-field.ts` | The CPU bake: a 60³ shape volume and a 240² weather map, pure, and therefore baked in a worker.                            |
| `fog.ts`         | An exponential that closes at four chunks, which is where the terrain stops.                                               |

One `DayNightState` per frame is built in `app.tsx` and pushed into the sky, the
clouds, the terrain, the water, the fog and the clear colour. **There is only one
answer to the question of what hour it is**, and everything asks that one; a system
that derived its own would be right on a different afternoon from its neighbour.

The sun is placed by the standard solar-position solution for a fixed latitude and
declination rather than by a drawn arc, and every phase boundary is a statement about
the sun's elevation rather than a partition of the clock — so the sky cannot be painted
dusk while the sun is twenty degrees up, which is the failure a drawn curve drifts
into. [ADR 0011](docs/adr/0011-the-sun-is-placed-by-a-solar-model.md) has the reasoning
and the phase durations the model actually produces.

Press `/` and `/clock:` drives it:

```
/clock:day  /clock:sunset  /clock:night  /clock:sunrise   jump to the middle of that phase
/clock:time <seconds>                                         pin the sky to a second
/clock:speed <multiplier>                                     0 pauses, 1 is real time
/clock:live                                                   release the pin
/clock:state                                                  say where the clock is
```

The four jumps ask the solar model where the phase is rather than carrying their own
seconds, so they keep meaning what they say if the latitude or the twilight threshold
ever moves. The clock itself holds three numbers and no reference to anything that
draws — `app.tsx` owns it and the materials, and writes the state into them.

`/cloud:` is the other half of the console's sky, and it exists for the same reason: the
clouds' two constants were reasoned about on paper and never looked at, and looking at
one used to mean editing it and rebuilding.

```
/cloud:coverage [0..1]   /cloud:density [n]   /cloud:state
```

The header also says where the cloud field came from — `baked on the worker` or
`baked on the main thread` — because the two routes produce identical bytes and a
fallback would otherwise be invisible except as a stutter.

Two numbers here are the sky's whole budget. The bake is about two and a half seconds
of arithmetic at the production sizes, which is why it runs in a worker
(`cloud-bake-worker.ts`) rather than on the frame loop, and the shader's worst case is
896 texture fetches per pixel of sky. Neither can be measured on the host any other
way — rmsl has no `renderer.info` and no render-scale plumbing — so
`cloud-field.test.ts` holds the bake to a ceiling and `clouds.test.ts` derives the
fetch count from the emitted GLSL and holds it to a budget. Two more tests in that file answer
questions the others cannot. One transcribes the shader's coverage arithmetic over a real
bake and asserts the **defaults** put visible cloud in the sky. The other asserts the
**volume's vertical address** — that the layer's underside addresses zero in the shape
volume and its top addresses one — which is the assertion whose absence let a layer that
had never drawn a single cloud ship with a green suite.

### Looking at it

A dev-server page (`pnpm dev`, then `/sky-probe.html` — it is a diagnostic, so it is not
in the production build). It stands the dome, and with `?clouds` the layer, up on their own, renders
one frame, reads the framebuffer back and prints **how many pixels each one lit**. Stars
at midnight should light a few thousand per megapixel at a mean brightness around 0.4; a
frame with cloud in it should have a peak well above the sky's own.

```
/sky-probe.html?compile          does this device accept these shaders at all
/sky-probe.html?t=900            midnight, when the stars are due
/sky-probe.html?clouds          the layer as well
/sky-probe.html?box             a red control cube — is anything drawing?
```

It is here because every fault the sky has had was invisible from a test process: a
starfield whose stars were sub-pixel, a moon eight pixels wide, and a cloud layer whose
vertical address was off by 699 units. Each compiled, each had green tests, and each was
reported by someone looking at the screen. `?compile` is the one a _phone_ can answer and
no test can — "too big to compile" is a failure mode particular to one GPU, and rmsl
throws on it from inside the render loop, which looks exactly like a sky that drew
nothing.

## The sea

The sea is meshed per chunk, out of the landscape's own field, by the same Surface Nets that
meshes the ground. It was a sphere, and the sphere decided where water was: it is everywhere
below the sea radius, so the only thing that kept it out of a hole in the ground was the rock
around the hole being in front of it, and a shaft dug down through a hill crossed the radius
inside the hill and filled with water.

|                   | Where                   |                                                                                              |
| ----------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `water-mesher.ts` | `apps/bm-sculpt/mesh`   | The sea's field, and the gate that stops it where the ground rises through it.               |
| `water-look.ts`   | `apps/bm-sculpt/render` | The colour, the Fresnel and the alpha, as one function both the near sea and the globe call. |
| `water.ts`        | `apps/bm-sculpt/world`  | The material, and which way up this world's sea faces.                                       |
| `globe.ts`        | `apps/bm-sculpt/render` | Its own ocean, past the streaming window, from the baked height map.                         |

Four things about it are worth knowing before changing any of it, and all four are in
[ADR 0043](docs/adr/0043-water-is-a-field-and-the-landscape-gates-it.md).

- **The gate takes the ground from the landscape, not from the model.** Water is a static
  sheet at sea level cut to the world as it was generated, so a shaft dug through a hill is
  dry and a pit dug in the seabed does not flood. It is also cheaper than the ground pass it
  clips — the base field is a closed form and never walks the operation BVH — and it does not
  move when a sculpt does.
- **The sea overlaps the land by two voxels**, which is what closes the gap where the water
  would otherwise stop short of the shore. The overlap is _buried_: a vertex is still placed
  on the sea's own surface, which on the land side is inside the hill, so the extra water is
  never drawn. `water-mesher.test.ts` holds that a water vertex is never above the ground,
  which is the whole reason the margin is safe at any size.
- **The CSG difference does not work**, and the reason is structural rather than a matter of
  tuning: a difference's boundary is both operands' boundaries, so `max(sea, −ground)` draws
  the seabed as well as the sea, coincident with the ground's own triangles.
- **Two groups, in that order.** rmsl has no render-order key, so the store puts ground meshes
  in one `Group` and sea meshes in another and the ground group first — which replaced a
  promise the application used to keep by hand, in a comment, by re-adding the sea's mesh after
  the globe's bake resolved.

## How much water there is

**About half the planet, and that is a decision rather than an accident.** A sea at the
landscape's own zero cuts the world in half only if the landscape's shape has no mean — and it
used to have one. The range term was `ridge · mask` with `mask` in `[0, 1]`: non-negative
everywhere, so the whole surface sat above the sea and only the deepest troughs dipped under
it. **One direction in four thousand was underwater**, which is a world that is technically not
entirely dry and in which you cannot find the water.

`landscapeShape` in `packages/csg/src/terrain.ts` is the composition both worlds are built
from, and two things changed in it. The mask is **re-centred to `[-1, 1]`**, so a range rises
where the mask says one stands and the ground falls away where it does not — which is what
leaves flats between the ranges as well as lows under them. And `RIDGE_STRENGTH` went from two
to six, so a range stands three times as far above the plain as it did. Measured: 50.3% to
50.7% of the surface underwater, across three seeds.

The relief tripled with it, from `radius ± 288` to `radius ± 672`, and two altitudes in this
application were numbers that only meant something against the old one. `GLOBE_START_ALTITUDE`
was 420 and the cloud layer's floor 700 — below the highest summit and two thousand units above
it respectively. Both are now derived from `reachOf(params)`. **A hardcoded altitude is a
number that means something only until the landscape changes**, and there were three of them
waiting for exactly this.

## Places

A **place** is a piece of code someone else wrote that builds a world, and the question of
where that code runs was settled by measurement before any of it was built — see
[ADR 0015](docs/adr/0015-place-scripts-run-in-a-quickjs-interpreter.md). The short version:

- Code runs inside a [QuickJS](https://bellard.org/quickjs/) interpreter compiled to
  WebAssembly. A script has no `fetch`, no timers, no DOM and no engine objects beyond the
  handful this application injects — not denied, **absent**. It receives that one object as
  a _function parameter_, so code that was never passed it cannot name it.
- A step is capped at **250 ms**, memory at **16 MiB**, and interpreter stack at
  **128 KiB**. The third is not hygiene. Without it, a script that recurses without end
  overflows the _host's_ stack, leaves the interpreter unfreeable, and then aborts the peer
  — not as an exception, as `abort()`, which a tab cannot report or survive. The ADR has the
  measurement.
- `Math.random` is seeded and `Date.now` answers from a caller-supplied clock, because
  every peer runs every place and has to arrive at the same world.

`apps/bm-sculpt/src/places/interpreter.ts` and its twenty tests settle all of that under Node, and
`/places-probe.html` settles the one claim a test cannot: that the WebAssembly file loads
under Vite, which rewrites the loader's own module location and can leave the fetch
answering with the page instead of the binary. Same argument as `sky-probe.html` — one page
load, and it prints a verdict per claim.

```
pnpm dev                            # then open /places-probe.html
```

### What a place is

Settled in [ADR 0016](docs/adr/0016-a-place-is-a-named-group-of-operations.md): **a place
is a named group of operations in one flat fold order.** Not a field, not a range in the
document's list, and not an `owner` field on `Operation` — the record says why each of
those lost, and two of them were close.

Three things follow, and they are the reason to want this shape:

- **A place is not in the undo history.** Its operations never reach `document.undoStack`,
  so ctrl-z cannot delete a bridge somebody else's code built. That falls out of the design
  rather than being enforced by a guard somebody can forget.
- **`PlaceRegistry.flatten` is the only place the fold order is decided.** `sculpt.ts` read
  the operation list in four places — the picker trace, the model sent to the workers, the
  live preview, the discarded-stroke rebuild — and all four now go through one method. Four
  independent copies of ADR 0009's invariant is three too many.
- **The fold is chronological, and so is colour.** `flatten` sorts by index rather than
  concatenating, because `bvh.ts` sorts fold candidates by index while `evalPaint` takes
  the last writer in list order. Concatenating made those disagree the moment a place built
  twice, and a user painting over a script's painted wall lost.

`MAX_OPERATIONS_PER_PLACE` is 2,000, and it is measured rather than guessed — one chunk's
39,936 field samples, with every operation packed inside the sampled chunk because overlap
is what costs:

| operations                    | ms        | ratio to a session's worth |
| ----------------------------- | --------- | -------------------------- |
| 310 — a hand-sculpted session | 144       | 1×                         |
| **2,000 — one place**         | **1,218** | **8.5×**                   |
| 4,000                         | 3,893     | 27×                        |

The test that holds the number asserts a **ratio rather than a wall clock**, which is a
correction: the millisecond version failed, because the same sweep takes a second alone and
3.5 seconds inside the suite where every file runs in parallel.

### What a script may ask for

Settled in [ADR 0017](docs/adr/0017-the-vocabulary-is-a-table.md). Nineteen effects in six
groups — geometry, triggers, clock, player, camera, and output — seven events, and
twenty-five bounds. It is much smaller than voxelscape's ninety-two because most of those are
about a voxel grid this engine does not have; the surface here is the sign of a distance
field, so `block-set` and the six plan shapes are one `createShape` call.

What carries the weight is not the count:

- **The rules are the definition.** `parseEffect` is a function over the table of fields and
  bounds, so a tag cannot exist without being validated and there is no second list of
  required fields that can fall out of step with the first. The same table is what a generated
  reference document would be read from, so the documentation cannot describe a field the
  parser does not check.
- **A payload is accepted whole or refused whole.** There is no partial result type, so a
  caller cannot accidentally apply the nine tenths of a shape whose position was `null`. A
  shape in the wrong place with no record that anything was wrong is the worst outcome
  available; a refused effect is a log line naming the field, which is a bug report.
- **An undeclared field is refused, not ignored** — which is also what makes the vocabulary
  safe to extend, since a future field cannot arrive at an old peer and be dropped there.
- **Facts are never forgotten.** The event log refuses when it is full rather than evicting,
  because a log that had dropped its oldest events would be a _different_ log from every other
  peer's.

### What exists today

All of it, and it runs. `/place:load bridge` in the browser builds a bridge you can walk on.

- The interpreter (`interpreter.ts`), the registry and the shared fold-order counter they
  allocate from (`place-registry.ts`, `apps/bm-sculpt/src/edit/fold-order.ts`), the vocabulary
  (`limits.ts`, `fields.ts`, `effects.ts`, `events.ts`, `event-log.ts`), the bundler
  (`bundle.ts`) and the guest library as a real type-checked file (`guest/place-api.ts`).
- The host (`host.ts`), which owns what it can and asks the application for the eight
  things it cannot, and the zone overlay (`zones.ts`) that draws them — one mesh for every
  zone, because `MAX_ZONES` is 256 and a player can count 256 boxes on their fingers.
- `SculptSession.refreshPlaces`, the seam that makes a place's geometry reach the meshes
  at all. A place writes into the registry rather than through `document.add`, so nothing
  else would find out; the symptom is a bridge that is in the collision field and in no
  mesh, so the player stands on something nobody can see.
- Three shipped places (`apps/bm-sculpt/src/places/demo/`), loaded for real by `demos.test.ts` — the
  only test that would catch a typo in an example, and the reason a demo nobody can run
  does not reach a person.
- **`/place:open` reads a place out of a zip** — `manifest.json` at the root, validated
  before a byte of it is read, refused whole rather than half-loaded. Same format as the
  sibling project's, plus an `entry` field because `PlaceHost` is handed one. `jszip` is
  dynamically imported, so the 29 kB of it reaches only the command that needs it.

- **Lights.** `createLight` makes one, `removeLight` takes it away, and the falloff is scaled
  so `intensity` is the brightness _at the edge of its own radius_ — so reach and brightness are
  one number to tune rather than two to reconcile with a distance. Eight reach the shader as
  sixteen `vec4` uniforms and the host picks the nearest, so a lantern appearing never rebuilds a
  shader. The clouds and the sky deliberately do not receive them
  ([ADR 0023](docs/adr/0023-lights-are-a-fixed-table-of-uniforms.md)).

- **Fields.** `createMedium` makes a box the player is inside that moves them: a conveyor
  (`pushVz`), quicksand (`speedScale: 0` with a `sink`), an updraft (`pushVy`). The physics for all
  three was written before the vocabulary existed and was waiting for this
  ([ADR 0022](docs/adr/0022-a-field-is-a-box-that-moves-the-player.md)).

Still to come: a way to _write_ a place, and `getSeatYawAt` and `getSurfaceVelocityAt` — whose physics
also already exists, and which now wait only on the props decision.

## The game and its console

The application grew a third scene, the default one: a first-person player over the
terrain who digs and places with the same stroke machinery the sculptor uses. `apps/bm-sculpt/src/player/`
is that player's physics — arithmetic over the field, testable without a browser —
and `apps/bm-sculpt/src/engine/game.ts` is the seam where the player, the input, the camera and the
streamed world meet once a frame.

Press `/` and a floating terminal opens. It completes command names as they are typed,
ranks the fuzzy matches so the arrow keys walk the good ones first, ghosts the rest of a
name behind the caret, walks back through what has been run, and answers `/help` with the
whole vocabulary. Escape closes it; a click outside it closes it. The scrollback and the
history outlive the panel, so reopening shows the same session.

Two things had to be settled for that, and both are decisions rather than details.

**A locked pointer delivers no key events at all**, so a terminal opened over a locked
canvas cannot be typed into — and the cursor cannot be aimed at anything. The input
controller grows `suspendPointerLock()`, and the console holds it for exactly as long as
its panel is showing. The lock is deliberately _not_ re-taken on release: the canvas
already asks for it on the next click, which is the same "click to play" prompt the
application shows anyway. [ADR 0010](docs/adr/0010-suspend-the-pointer-lock-not-the-input.md)
records the cost — one click to resume — and what else was rejected.

**Commands are declared in one table and call plain methods on `Game`.**
`apps/bm-sculpt/src/console/commands.ts` holds a `Commander` over a literal of `{ description, args,
run }`, where each `run` does its own argument parsing and validation and then asks the
game to do something typed. `Game.setFlying` and `Game.setNoClip` know nothing about
where they were called from; `Player.flying` and `Player.noclip` know nothing either.
That is the shape `big-mesh-studios`'s voxelscape uses for its own console, kept for the
same reason: a command that reaches into a player's fields directly ends up owning
physics behaviour — the reason a fall in progress is discarded on the way into flight
belongs next to the integrator that would have carried it, not in a parse closure.

The fullscreen button beside the `>_` trigger runs `/fullscreen` rather than a second
path to the same place, so the button and the command are one thing that can only be
tested once. It asks for fullscreen, asks for `screen.orientation.lock("landscape")` —
the button exists because a phone held sideways is the ordinary way to play this — and
reports what it asked for rather than waiting to find out what it got, which keeps every
command in the table a `string` to print.

### A command that takes time

`/place:load` genuinely waits — it bundles, starts an interpreter and runs a script's
top-level code — so `CommandEntry.run` may return a promise and `CommandOutput` a promise
of a line. The console prints `…` under the echo and **replaces that line** when the
promise settles, so a slow load is visibly slow rather than apparently hung, and a reader
is never left pairing up a line that said it was waiting with a line that said what
happened. Each pending entry carries an id: replacing by position works, replacing by
content does not, because two pending commands can print the same `…`.

The `/place:` commands are a second table in their own file, merged in by
`Commander.with()`, because nothing outside the game should have to know a place exists.
`ConsoleState.print()` is how a place's `log` reaches the scrollback — it is not a command
and has no echo of its own, and it lands in the same entries so a place's output and a
person's commands interleave in the order they happened.
[ADR 0020](docs/adr/0020-a-place-runs-on-the-frame.md) records the frame order and the two
`clearX` methods that shipped wrong once each.

## Phase 5 — sculpting on it

Drag to sculpt. Right-drag orbits, shift-drag pans, ctrl-z undoes. The model is an
operation list, the mesher runs in workers, and the picker traces the same field the
mesher reads — so a dab lands where the field says the surface is, which is the property
the whole design exists to make true.

`packages/picking/src/` traces the ray. `apps/bm-sculpt/src/edit/` holds the model, the brush, and the tool that
decides what a pointer event means. The single most important decision is recorded in
[ADR 0009](docs/adr/0009-picking-and-history.md) and is worth repeating here: **the picker
and the mesher read the same function of position**, so they cannot disagree about where the
surface is. That rules out a class of error ADR 0007 records, where a query answered from a
slot holding another cell's contents put a dab where the mesh said there was nothing. It does
not mean they agree about _resolution_ — far away the mesh is coarse and the picker is not —
which is why the brush preview is a solid sphere at the pick point rather than something
derived from the mesh.

Three things the tests found, all of which would have shown up as "the brush is broken":

- **A stroke stopped up to one dab-spacing short of the cursor.** Evenly spaced dabs leave a
  remainder, and a quarter of the radius is visible. There is now a final dab at the pointer —
  but only when the remainder is more than a quarter of a spacing, because below that it is
  pointer jitter, and dabbing every jittered frame puts hundreds of redundant operations in one
  undo step.
- **A sculpt stranded every chunk that happened to be mid-mesh.** Sending a model cancels
  everything in flight, which is correct — a mesh built against a model that no longer exists is
  worse than useless — but nothing re-requested the cancelled work, so those chunks stayed
  blank until something unrelated scrolled the window. It looked like a mesher that hangs.
- **`ChunkWindow.markStale` never notified anything.** So invalidating a chunk's contents —
  which every dab needs to do — left the window correctly forgetting it was filled while the
  store went on drawing its old geometry. ADR 0007's invariant, that there is exactly one way
  for a slot to become unfilled and everything that invalidates contents goes through it, was
  not actually holding: the third way to invalidate was silent.

`invalidateBox` also found that the window had no way to ask "which slot holds this cell, even
an unfilled one" — `slotOf` deliberately refuses unfilled chunks, since a query about a chunk
whose contents have not arrived has no honest answer, and that is right. But the chunks an edit
most needs to invalidate are exactly the ones still being meshed. `claimedSlotOf` is now there
for holders of slots, as against askers, which is what the comment on `isClaimed` had always
said it needed.

## Phase 4 — drawing it

`apps/bm-sculpt/src/session.ts` is where the phases meet, and it is the most bug-prone file in the
project for a reason that is worth stating: a seam between two correct pieces is not
automatically correct. Each of the pieces enforces its own invariant, and none of them
knows whether the wiring honours it. So the session takes an injected worker factory, and
its tests drive the whole streaming loop against workers that answer when told to —
because every failure here is about _when_ something arrives relative to a scroll, and a
fake that answered immediately could express none of them.

Three seams carry a decision:

- **A mesh is applied at the revision recorded when it was requested, not the slot's
  current one.** Between the two the window may have scrolled and given that slot to a
  different cell, and applying it anyway draws one chunk's surface at another's
  coordinates.
- **A chunk leaving the window is abandoned in the pool, not merely dropped.** The pool
  queues by cell and the window forgets by slot, so without this the queue fills with work
  nobody is waiting for and the cancellation line never advances.
- **The window follows what the camera looks at, not where it is.** Panning is how a user
  moves around a model; a window tracking the eye would scroll the world sideways on every
  dolly.

Two bugs the session's own tests caught:

- **The window fires `onSlotsWanted` from inside its own constructor**, before the session
  holds a window at all. This threw on the first line of the application.
- **The window's initial placement is unsorted** — deliberately, its documentation says
  callers order by distance — so startup meshed the far corners of the window while the
  chunk the player was standing in waited its turn.

`apps/bm-sculpt/src/render/chunk-mesh-store.ts` enforces ADR 0007's rule that a slot is marked unfilled by
whatever invalidates it and refused for a revision the caller does not hold. That rule turned
out to need to be stronger than the record expected: the store owns a revision per slot, so
the invariant is enforced by the owner of the state rather than by every caller remembering
to invalidate.

A renderer's buffers are keyed by geometry object, so a dropped geometry is held for the
renderer's whole life. In a scrolling world that is a leak several times a second, so
`dispose` belongs to _replacing_ a mesh rather than to shutting down — including when a
sculpt deletes a chunk's surface, which is what every deletion produces.

## Phase 3 — meshing

Meshing is split at the line between the algorithm and this landscape's LOD bands. The
first three rows are `packages/meshing`; the rest are `apps/bm-sculpt/src/mesh/`.

|                   | Where              |                                                                                                                                                                        |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface-nets.ts` | `packages/meshing` | One vertex per cell whose corners disagree, one quad per sign-changing edge. Owns the seam rule, which is the only subtle thing in it.                                 |
| `chunk-mesh.ts`   | `packages/meshing` | The twenty-byte vertex the Phase 0 spike proved reaches the GPU.                                                                                                       |
| `growable.ts`     | `packages/meshing` | The only way geometry is accumulated, with the `array`/`exact` split so a transfer never delivers a detached view.                                                     |
| `chunk-mesher.ts` | `apps/bm-sculpt`   | `ChunkMesher`, the interface a WebAssembly implementation would come through, and the Surface Nets implementation of it — over `CHUNK_VOXELS`, and scheduled by `Lod`. |
| `model-field.ts`  | `apps/bm-sculpt`   | Builds a field from a model message, on the worker's side of the thread boundary.                                                                                      |
| `protocol.ts`     | `apps/bm-sculpt`   | The messages, as data and nothing else.                                                                                                                                |
| `worker.ts`       | `apps/bm-sculpt`   | `handleMeshMessage`, a pure function of state, message and an injected mesher factory.                                                                                 |
| `worker-pool.ts`  | `apps/bm-sculpt`   | Four workers, one chunk each, and the rule for which answer counts.                                                                                                    |

The seam rule, in one sentence: **a chunk owning cells `[base, base + n)` emits the
edges in that same range, taking the four cells it needs from one cell of low
padding.** That is awkward to assert and easy to assert indirectly — mesh a region as
one chunk, mesh it as several, and require the identical set of triangles. Not the same
count; the same triangles. A duplicated quad, a dropped quad, a flipped winding and a
misplaced vertex each fail it, and an eight-chunk tiling exercises all twelve internal
faces at once.

Writing this phase turned up a bug in phase 2 that no phase 2 test could see.
`sampleWorld` put a chunk's 32 samples at the centres of its intervals, which spans
310 units of a 320-unit chunk — so every chunk left a ten-unit gap at its high edge
and the next chunk began with another, a hole in the field running along every chunk
boundary in the world. A chunk has `CHUNK_VOXELS` _intervals_ now and a sample at the
start of each. The paint-tiles tests had their own copy of that formula and the copy
quietly kept the old one, so they went on agreeing with each other about a chunk with a
gap in it; it reads through `sampleWorld` now.

Three more things the tests found, recorded in
[ADR 0003](docs/adr/0003-surface-nets.md) and
[ADR 0008](docs/adr/0008-worker-pool-and-generations.md):

- **Adjacent chunks cannot share vertices**, because a chunk has no way to know a
  neighbour's. An edge can therefore belong to two triangles in the world while sharing
  no index pair, and a watertightness check that compares by index reports correct
  chunking as broken. It did, until it was fixed.
- **Naive surface nets is not manifold in general.** A quad per sign-changing edge means
  a thin or creased surface can leave a dual edge in a single triangle. A resolved
  sphere is exactly manifold; a thin torus at one voxel per minor radius is not. It is
  the price of the method, and it does not affect seams.
- **`pump()` did not skip busy workers**, so every chunk went to worker zero, and a
  queue per worker meant only one chunk was ever in flight. Both invisible in review.

## Phase 2 — the streaming foundation

`apps/bm-sculpt/src/world/` is where chunks live: which cells exist, which slot each is in, and what
colour they hold. None of it touches the renderer, the DOM or the field, so a meshing
worker needs its arithmetic and nothing else.

|                     |                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coordinate-map.ts` | An integer-triple hash map: flat typed-array keys, FNV-1a, 0.7 load factor, backward-shift deletion. Ported from voxelscape's, which runs in a world that scrolls under a walking player. |
| `level-data.ts`     | Chunk cells, level-of-detail bands, and the world/sample conversions.                                                                                                                     |
| `chunk-window.ts`   | The slot pool, the free list, `scrollTo`, `reshape`, and the `filled` gate.                                                                                                               |
| `paint-tiles.ts`    | Sparse chunk tiles of colour — the only stored voxel data in the system.                                                                                                                  |

The property everything else follows from: **a chunk covers the same ground at every
level of detail.** Only the resolution of the samples inside it changes, so a slot's
level can be swapped as the camera moves without anything moving in the world. That
is affordable only because the field is computed rather than stored (ADR 0004); a
stored field would have to be refilled at a new resolution, and a refill is where
cracks come from.

Three things writing the tests corrected, recorded in
[ADR 0005](docs/adr/0005-streaming-shape.md) and
[ADR 0007](docs/adr/0007-window-presence-and-lod-reset.md):

- **A fresh window has to be _covering_, not merely _sized_.** Allocating the pool
  is not placing cells into it — every slot stood for the origin cell until
  construction and `reshape` were made to share one placement routine.
- **A slot whose LOD band moved was queued for rebuild but still reported `filled`**,
  so a query answered from it handed the picker a surface at one resolution while the
  rest of the model was at another. Nothing errored; the mesh disagreed with itself
  across a band boundary.
- **`CoordinateMap`'s deletion was inverted twice** before it was right. The hole
  moves forward only _after_ a move, never on a skip — setting it to a skipped entry
  points it at an occupied slot, and the next entry pulled in overwrites a live one.
  Both versions lost about two entries per hundred deletions, which no test of the
  entry just touched would notice.

## Phase 1 — the CSG core

The model is a list of CSG operations and nothing else: no voxel grid, no baked
field, no stored mesh (ADR 0002). `packages/csg/src/` is the whole of it.

|                 |                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.ts` | All nine primitives and the signed distance to each, in `packages/sdf`, as one table. Eight are exact closed forms; the ellipsoid is the standard two-term approximation, carries `exact: false`, and its two measured properties — an exact zero set, and never over-reporting — are asserted rather than assumed. |
| `operations.ts` | The operation type, the smooth booleans, an operation's world box, and **the fold** — the one piece of arithmetic that has to be exactly right.                                                                                                                                                                     |
| `bvh.ts`        | A binned surface-area hierarchy over the operations, and the candidate cache that makes a chunk's cost independent of the model.                                                                                                                                                                                    |
| `field.ts`      | The composition seam: `fold(operations, p, baseField?(p))`. Adding an infinite world is a new `baseField` and nothing else.                                                                                                                                                                                         |
| `serialise.ts`  | File format v1. The field's _description_, never any voxel data — so a file's size is a function of what the user did, not how big the model is.                                                                                                                                                                    |

Three things came out of building it that the plan did not foresee, each caught by a
test comparing against a brute-force fold and each now its own decision:

1. **A bounding-box test is not a sound way to skip an operation.** A minimum is won
   by the nearest _surface_, not the nearest box, so a point a unit outside a box's
   corner is a unit from the shape inside it. The skip has to be a distance against
   a threshold derived from the boolean — and only _outside_ the box, since inside it
   the box distance is zero while the true distance can be deeply negative
   ([ADR 0006](docs/adr/0006-field-saturation.md)).
2. **A subtraction raises the field.** It is a `max`, and a `max` goes up, so "the
   field only falls" is false and a cache margin sized on that assumption does not
   cover the case. Saturating the field at `FAR_DISTANCE` fixes it and makes the
   margin a constant.
3. **`smoothMin` is not associative**, so the fold's _order_ is part of what the field
   is. Candidates come back from the tree in traversal order and are sorted by list
   index, once per rebuild. Unsorted, two chunks either side of a level-of-detail
   boundary would fold the same operations differently and crack along every
   boundary in the world.

### Measured

One chunk's field — 39,304 samples (32³ plus a border), over a session's worth of 310
operations — takes **275 ms** on an ARM phone. A 2016 laptop is several times quicker
and four workers run four chunks at once. One candidate cache rebuild serves the whole
chunk.

`apps/bm-sculpt/src/csg-cost/cost.test.ts` holds that to a ceiling rather than reporting it as a
benchmark, because the failure worth catching is a change that looks harmless and
costs ten times as much, not a number that drifts.
