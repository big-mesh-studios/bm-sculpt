# Architecture decision records

One file per decision, numbered, never edited after the fact. A record that is
wrong is superseded by a later one that says so, because the value of the older
one is that it explains what the code looked like at the time.

Each record answers the same four questions:

1. **Context** — what forced a decision.
2. **Decision** — what was chosen.
3. **Consequences** — what it costs, and what it forecloses.
4. **Alternatives** — what was rejected, and why.

The consequences section is the one that earns its keep. A decision with no
recorded cost is a decision nobody thought about.

## Records

| #                                                                        | Decision                                                                               | Status                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------- |
| [0001](0001-rmsl-over-three.md)                                          | Render with `@random-mesh/rmsl`, not three.js                                          | accepted                     |
| [0002](0002-computed-field-never-stored.md)                              | The field is computed from an operation list, never stored                             | accepted                     |
| [0003](0003-surface-nets.md)                                             | Surface Nets per chunk, not marching cubes                                             | accepted                     |
| [0004](0004-csg-per-chunk.md)                                            | Each chunk evaluates the operation list at its own LOD                                 | accepted                     |
| [0005](0005-streaming-shape.md)                                          | Slot-indexed flat arrays and a coordinate map, not a keyed map                         | accepted                     |
| [0006](0006-field-saturation.md)                                         | The field saturates at a fixed distance                                                | accepted                     |
| [0007](0007-window-presence-and-lod-reset.md)                            | Invalidating a slot invalidates what a query may read from it                          | accepted                     |
| [0008](0008-worker-pool-and-generations.md)                              | One chunk per worker, and a generation on every request                                | accepted                     |
| [0009](0009-picking-and-history.md)                                      | The picker and the mesher read one field, and edits undo                               | accepted                     |
| [0010](0010-suspend-the-pointer-lock-not-the-input.md)                   | Suspend the pointer lock, not the input                                                | accepted                     |
| [0011](0011-the-sun-is-placed-by-a-solar-model.md)                       | The sun is placed by a solar model, not by a drawn curve                               | accepted                     |
| [0012](0012-the-cloud-layer-is-a-raymarched-slab.md)                     | The cloud layer is a raymarched slab with a carrier geometry                           | superseded by `0040`         |
| [0013](0013-fog-is-exponential-and-closes-at-the-window.md)              | Fog is exponential, and closes at the window's radius                                  | extended by `0040`           |
| [0014](0014-the-sky-dome-is-drawn-first.md)                              | The sky dome is drawn first and ignores depth                                          | accepted                     |
| [0015](0015-place-scripts-run-in-a-quickjs-interpreter.md)               | Place scripts run in QuickJS, and all three caps are set                               | accepted                     |
| [0016](0016-a-place-is-a-named-group-of-operations.md)                   | A place is a named group of operations, and `flatten` decides the fold order           | accepted                     |
| [0017](0017-the-vocabulary-is-a-table.md)                                | The vocabulary is a table, and a payload is accepted whole or refused whole            | accepted                     |
| [0018](0018-a-place-is-bundled-and-the-guest-library-is-a-real-file.md)  | A place is bundled into one reproducible program, and the guest library is a real file | accepted                     |
| [0019](0019-the-host-owns-what-it-can-own.md)                            | The host owns what it can own, and asks for the eight things it cannot                 | accepted                     |
| [0020](0020-a-place-runs-on-the-frame.md)                                | A place runs on the frame, and the console is how a person meets it                    | accepted                     |
| [0021](0021-a-place-arrives-as-a-zip-with-a-manifest.md)                 | A place arrives as a zip with a manifest at its root                                   | accepted                     |
| [0022](0022-a-field-is-a-box-that-moves-the-player.md)                   | A medium is a box the physics reads, and the host supplies it                          | accepted                     |
| [0023](0023-lights-are-a-fixed-table-of-uniforms.md)                     | Lights are a fixed table of uniforms, not per-object state                             | accepted                     |
| [0024](0024-packages-is-what-has-no-opinion.md)                          | `/packages` is what has no opinion, and `/apps` is what does                           | accepted                     |
| [0025](0025-a-primitive-is-one-table-entry.md)                           | A primitive is one table entry, and the capsule points up                              | accepted                     |
| [0026](0026-the-mobile-rules-live-in-a-package.md)                       | The mobile rules live in a package, because they were never this application's         | accepted                     |
| [0027](0027-the-modeller-is-a-flat-list-of-placed-primitives.md)         | The modeller is a flat list of placed primitives, meshed not marched                   | accepted                     |
| [0028](0028-a-colour-is-a-property-of-the-operation.md)                  | A colour is a property of the operation, and the model is a boolean fold               | accepted                     |
| [0029](0029-the-site-root-is-a-front-page.md)                            | The site root is a front page, and the applications sit beside it                      | accepted                     |
| [0030](0030-two-meshers-and-a-report.md)                                 | The modeller offers two meshers, and reports what came back                            | accepted                     |
| [0031](0031-the-nearest-surface-carries-a-points-colour.md)              | The nearest surface carries a point's colour, not the last one in the list             | accepted                     |
| [0032](0032-a-model-leaves-as-a-3mf.md)                                  | A model leaves as a 3MF, stood on a bed at a height in millimetres                     | accepted                     |
| [0033](0033-a-project-file-is-a-manifest-and-the-model.md)               | A project file is a manifest and the model, and Save writes back to where it came from | accepted                     |
| [0034](0034-a-draft-survives-a-reload.md)                                | A draft survives a reload, and the files you opened are remembered                     | accepted                     |
| [0035](0035-the-coarser-chunk-overlaps-the-finer-one.md)                 | The coarser chunk overlaps the finer one, and there is no skirt                        | accepted                     |
| [0036](0036-the-planets-centre-is-the-origin.md)                         | The planet's centre is the world origin                                                | accepted                     |
| [0037](0037-up-is-a-function-of-where-you-are.md)                        | Up is a function of where you are                                                      | accepted                     |
| [0038](0038-the-planets-chunks-are-patches-of-a-warped-cube.md)          | The chunks are patches of a warped cube                                                | superseded by `0039`         |
| [0039](0039-past-a-height-the-planet-is-a-displaced-globe.md)            | Past a height, the planet is a displaced globe                                         | accepted                     |
| [0040](0040-the-atmosphere-is-a-shell-and-the-clouds-wrap-the-planet.md) | The atmosphere is a spherical shell, and the clouds wrap the planet                    | superseded in part by `0042` |
| [0041](0041-the-planet-is-thirty-four-times-larger.md)                   | The planet is 34× larger, and its body scales with it                                  | superseded in part by `0042` |
| [0042](0042-the-cloud-volume-is-addressed-by-direction-and-altitude.md)  | The cloud volume is addressed by direction **and** altitude                            | accepted                     |
| [0043](0043-water-is-a-field-and-the-landscape-gates-it.md)              | Water is a field, and the **landscape** gates it                                       | accepted                     |

## What is decided so far

Phases 1 through 3, in the order the decisions constrain each other:

- **0001, 0002** — the renderer, and the fact that there is no grid to store. Everything
  after this is a consequence of the field being computed.
- **0003, 0004** — how that field becomes triangles, per chunk, at a chunk's own level of
  detail. 0003 carries the seam rule; 0004 carries the LOD cracks it does not solve.
- **0035** — what is done about those cracks, and it supersedes the sentence in both of
  them that ranked the insurance policies. They ended with _"evaluate the boundary strip at
  the finer neighbour's stride, then add skirts"_; the strip was never built, the skirt was
  built and then removed, and what is there now is that the coarser chunk meshes one cell
  into the finer one. The rest of that ranking is untouched — stitched surface nets is still
  deferred, and the two `it.fails` cases in `mesh/lod-seam.test.ts` are still failing, which
  is what keeps the difference between _no visible gap_ and _a weld_ written down rather
  than assumed.
- **0005, 0006, 0007** — the shapes around it: which chunks exist and in which slot, how
  far a distance is trusted, and what a query may read from a slot being rebuilt.
- **0008** — the boundary a chunk's mesh crosses to get to the screen.
- **0009** — the two things that change it: where an edit lands, and how to take it back.
- **0010** — what the console takes from the game while it is open: the pointer lock, and
  not the input.
- **0011** — the sky, and the one parameter every part of it reads.
- **0012, 0013, 0014** — the rest of the sky, in the order it is drawn: the cloud layer as
  a raymarched slab whose box is a carrier, the fog that closes at the chunk window's
  radius, and the dome that is drawn first and ignores depth. Together they are one
  decision about ordering — rmsl has no `renderOrder` key, so the scene graph _is_ the
  occlusion scheme — and one about where the world's two ends meet: the terrain stops at
  the window, and the clouds stop at the fog.

The sky is the first thing in this list that nothing else constrains and that constrains
everything to come: the clouds, the terrain lighting, the water and the fog all take their
colour from it, so the decision that the sun is _computed_ rather than drawn settles
where each of those reads from before any of them exists.

**0015 is the first decision about code this application runs rather than renders,** and it
arrived by measurement rather than by argument. The interpreter was spiked before the
feature, the way the phase 0 spikes settled the vertex layout and the shader precision,
because this repository had already been broken by a dependency that would not run on the
target machine. The spike paid for itself immediately: a place script that recurses without
end overflows the _host's_ stack, leaves the interpreter unfreeable, and then aborts the
peer — not as an exception, as `abort()`. Setting a stack limit turns that into an ordinary
catchable error. The record carries the measurement, and the number is chosen with a margin
because the safe window is narrow and moves between runtimes.

**0016 answers the question 0015 left open, and it is the reason 0015 had to come first.**
A place is a named group of operations in one flat fold order — not a field, not a range in
the document's list, and not an `owner` field on `Operation`. Two of those were close
calls and the record says why they lost. The consequence that reaches furthest is not the
one it was chosen for: a place is **not in the undo history**, so ctrl-z cannot delete a
bridge somebody else's code built, and that falls out of the shape rather than being
enforced by a guard somebody can forget.

Its own measurement is in the record, because `MAX_OPERATIONS_PER_PLACE` is the first
number in this repository chosen from a sweep rather than from taste — and the test holding
it asserts a _ratio_ rather than a wall clock, after the wall-clock version failed under the
suite's own parallel load.

**Superchunk membership is deferred from phase 4.** ADR 0007 named it, and rmsl's
`Mesh.drawRange` is built for it — several meshes sharing one uploaded geometry, each
drawing its own run of indices. It is not built yet, and the reason is that its benefit is
unmeasured: nothing was on screen until this phase's last commit, so there is no count of
draw calls to reduce. Merging is an optimisation, and it costs a second code path — merged
and per-chunk — that doubles what has to stay correct. It should be built against a
measured number, not against an expectation, and the number is now obtainable.

**0020 is where a place became reachable at all.** Everything through 0019 was vocabulary and
machinery with nothing in the application calling it — a capability no one can reach is a
library, not a feature. Three things about it are worth carrying forward rather than
rediscovering:

1. **A command that takes time is a pending line that is replaced, not appended to.** The id on
   the pending entry is what keeps two of them apart; by position alone the first to settle
   would rewrite whichever line came first.
2. **`clearX` must put `X` back, not merely stop setting it.** Both `clearPlayerSpeed` and
   `clearCameraLook` shipped that bug once, and neither was visible in the state they left
   behind — a player at the wrong speed, or looking through a lens nobody chose.
3. **A place's clock is the shared clock.** `nowMs()` rather than `Date.now()` is the whole of
   ADR 0016's determinism rule applied to time, and it reports the _shown_ second, so a pinned
   sky is a pinned world.

Two tests here were passing for the wrong reason when written, which is the argument for
writing them at all: one compared operations by an `id` that `Operation` does not have, so two
`undefined`s compared equal; the other asserted that every shipped demo builds something, which
is false of the timer demo and would have been fixed by weakening the assertion rather than by
splitting the claim in two.

**0021 made a place handable, and the interesting part is what it did not change.** The host,
the bundler and the vocabulary are all untouched: a place in the tree and a place out of a zip are
the same `{ files, entry }` by the time they reach `PlaceHost`, which is the property worth
having — two paths would have meant two places where a geometry change stops reaching the mesh.
What is new is a **gate in front of the interpreter** rather than a way around it: `manifest.json`
is validated before a byte of it is read, an undeclared script in the archive is refused rather
than dropped (the one deliberate divergence from the reference, argued in the record), and the
path-traversal defence is four rules rather than a normalise-then-check.

Two repo guards caught mistakes in the first hour, which is the argument for having them. The
"every limit is referenced somewhere" test failed on the new `MAX_PLACE_SOURCE` because it scans a
fixed list of consumer files, and its sibling holds a register of limits covered elsewhere —
`MAX_PLACE_SOURCE` had to be entered there too, since it is a **sum over a manifest's files** and
so cannot be reached by any payload at all. Neither failure was in the new code; both were in the
test that exists to say a limit is not decorative.

`jszip` is dynamically imported: `dist/assets/load-place-*.js` is 29 kB gzipped, `pako` appears in
it and nowhere else, and no session that never opens a place pays for a zip reader.

**0023 closed the last gap in v1's vocabulary, and its tests are the point of the record.** Lights
were the one thing a place could not make, so a lantern was a coloured box that appeared and stayed.
Three things are worth carrying forward:

1. **The measurement changed the design, not just the test.** Raw inverse-square means a lantern ten
   units away contributes `0.01`, and the first test — asserting `toBeGreaterThan(0.5)` — failed.
   The fix was to scale the falloff by the radius (`r²/d²`), so a place author tunes one number and
   can predict what it did. A compile-and-shape assertion would have passed throughout.
2. **Six of my own test premises were wrong and the shader was right each time.** A light level with
   a surface contributes nothing under a Lambert term; a light overhead contributes nothing to a
   vertical wall; a fragment at a lamp's centre has no direction. A test that needs correcting
   towards the physics seven times was measuring something other than what it claimed.
3. **Three assertions are bounds rather than equalities**, because the correct answer is 4.015 rather
   than 4: doubling a light's radius _quadruples_ it, but the window is marginally more open at the
   larger radius. Asserting equality would fail on a correct shader.

Two consequences are recorded rather than hidden. The clouds and the sky deliberately do **not**
receive lights — a cloud is marched through rather than lit at a surface, and the sky has no surface.
And **three tests in the suite are wall-clock and fail under load**: the interpreter's 250 ms step
budget is what makes `demos.test.ts` flaky at load 20. They were seen failing and passing on one
commit across a session. If they become a nuisance the answer is a budget in interpreter steps, not a
larger number.

**0022's whole finding is that half of it already existed.** `PlayerWorld` has declared
`getMediumAt`, `getSeatYawAt` and `getSurfaceVelocityAt` since before the places layer was written,
and `updatePlayer` consumes all three — speed scaling, both pushes, the sink, a moving platform's
velocity, a seat's heading. `GameWorld implements PlayerWorld` and supplied none of them. So the
phase was a wiring job, not a feature, and what it added was three functions between a place's box
and physics that was already written and already correct.

Two things follow that are worth carrying forward. **A reader rather than a stored collection**,
because a place adds and removes fields while the game runs and a world holding a snapshot would
keep pushing a player standing on a belt that no longer exists. And **`HostMedium` is a re-export of
`player.ts`'s own `Medium`**, for the same reason `HostClock` is `ClockCommands`: one type, so the
compiler checks that the host produces what the physics consumes.

The remaining two queries are now waiting on one decision rather than two. Their physics is written;
they need a thing to sit on and a thing that moves. If props become a _declared_ seat and a
_declared_ surface, both are a few lines each with no change to `player.ts`. If props are made of real
SDF geometry, both need the geometry side built first — which is the props question, and it is not
answered here.

The phases themselves are in the repository history, one commit per phase, each verified
before the next began.

**0024 is the first decision about where code lives rather than what it does, and its cost is
paid in gate coverage.** The second application needed five libraries, and all five were already
written — as application code, next to the application that had no use for them. What makes the
record worth more than the move is the second finding, which had nothing to do with packages.

`src/scratch/` held three test files that the repository-root Vitest collected and `tsc` never
looked at. Moving them into `src/` to type-check them exposed two mistakes, and both had been
sitting in green CI:

- **`pan-recycle.test.ts` marked nothing.** `for (const slot of window.slots) window.markFilled(slot)`
  passes slot _records_ to a function taking a slot _index_, so `slots[record]` was `undefined`
  and every call returned early. It passed because nothing in it depended on a slot being filled.
- **`load-place.test.ts` had been a type error since ADR 0021.** `JSZip.file` has no
  `string | null` overload, so `pnpm check-types` had been printing `TS2769` for a phase and
  nobody was reading to the end of the output.

Neither is an argument for the monorepo. Both are arguments for **a gate that is actually read**,
and for keeping tests inside the tree they claim to cover. `pnpm workspace:check` is also the
only check in this repository that can fail on a dependency graph which compiles perfectly.

**0025 removed the last list of primitives that was written out by hand, and there were
seven of them rather than the five expected.** The two that mattered most were not switches.
`edit/document.ts` held a _duplicate_ of the half-extents function, and its comment argued
against fixing it — correctly, because a too-small invalidation box does not throw and makes
an edit half appear. And the `shape` field's description to place authors was the literal
string `"a primitive: Ellipsoid, Box or Capsule"`, which was a lie the day the table gained
six entries and which nothing caught, because documentation is not a compiler.

Three findings are worth carrying forward:

1. **A table of nine distance functions is testable in a way nine hand-written functions are
   not.** The table-wide tests — one crossing per ray, a unit gradient, never over-reporting,
   the surface inside the reported half-extents — are written against the table, so a tenth
   primitive is covered by being in the table. They caught `sdCone` with its base radius at
   the wrong end, a cone that was upside down: negative inside, zero on _a_ surface, and
   wrong everywhere else.
2. **"Closed form" is not "exact".** All nine are closed form and one is approximate, so the
   table carries an `exact` flag. The old code claimed the ellipsoid's error was "bounded by
   `ellipsoidError`" and `ellipsoidError` did not exist. What replaced it is measured: the
   zero set is exact to 2.7e-15 against an f32 epsilon of 1.2e-7, and it never over-reports
   along any ray. Both are asserted.
3. **A torus is not star-shaped, and `exact: true` does not mean it is.** It has a hole, so a
   ray from its centre meets the surface twice. Irrelevant for meshing and picking, fatal for
   a sphere tracer started inside the bounding box — so the eight-of-nine claim is written as
   a test that must opt the ninth out by name, because a fact in a comment is a fact that
   rots.

The capsule's axis moved from X to Y, which took the file format to version 2. The transform
itself was never missing: `Operation` has carried `orientation: Quat` since before the places
layer, `shape-add` accepts one, and the format persists it. What was pinned was the primitive's
convention, not its placement.

**0026 is the first record about a device rather than about geometry**, and its findings
came from measuring this application rather than from reasoning about phones. Three of the
gaps were live bugs in the shipped application, not omissions:

1. **The command line was `font: 12px monospace` on a zoomable viewport.** iOS Safari zooms
   the _page_ when an input under 16px takes focus and does not reliably zoom back out on
   blur. Unlike the sibling's 3D editors, this application cannot rule that out with
   `user-scalable=no` — it is deliberately zoomable — so it had to make the font big enough
   that the browser had no reason to zoom.
2. **No `overscroll-behavior`,** so a pull towards the top of the page began pull-to-refresh
   in the middle of an orbit. No element-level `touch-action` prevents this: the gesture
   belongs to the document.
3. **The header was pinned to `top: 0` on a phone with a notch,** while the viewport tag was
   already asking for `viewport-fit=cover` — the browser was already handing out the inset
   and nothing asked for it.

The lesson is the packaging rule. **A CSS module's class names are hashed per build and
scoped to its own file, so they cannot travel into a package** — the sibling's own design
record names that as the one thing that made a component extraction cost more than it
saved. So `packages/ui` ships plain CSS with no classes on it (one exception, where the
`max()` arithmetic is the fiddly part), and everything with a class stays in the application
that draws it.

And the one that would have rotted silently: **`env(safe-area-inset-*)` resolves to `0px`
unless the page carries `viewport-fit=cover`, and no CSS feature query can detect the tag's
absence.** In the sibling monorepo, one application sets three safe-area rules and its
`index.html` has no such tag, so all three are dead and it has a bottom sheet with a home
indicator on top of it. Nothing reported it, because the declarations are correct. Hence
`packages/ui/src/viewport.test.ts`, which reads every `apps/*/index.html` and asserts the
pairing.

**0027 is the first record with two applications in it**, and its findings are about the
libraries rather than about the modeller — because a library only its first consumer
exercises is one whose second consumer finds the gaps. Six of the nine primitives had never
been called by anything.

Two things are worth carrying forward:

1. **A transform that stores Euler angles beside a quaternion disagrees with it**, and a
   person finds out by typing roll after yaw. The model holds the quaternion; the panel
   _asks_ it what the angles are. And every axial primitive running along Y (ADR 0025) is
   what makes rotation load-bearing rather than a refinement — a position-only panel could
   not build a figure lying down.
2. **Both shapes of the undo command compiled and both were wrong.** A command that returns
   its own inverse loses the original the moment it is called, so it can undo but not redo;
   and having fixed that, `apply` and `invert` were backwards for _removal_, so undoing a
   removal removed it again. Neither was found by a test — they were found by a test that
   asserted on the parts list rather than on a return value.

And one about the camera: **neither `packages/ui`'s `pointer()` nor the landscape's orbit
controller was reused**, and both refusals are recorded with reasons. A pinch needs pointer
positions in the canvas's own coordinates and one pointer followed per call is the wrong
shape for it.

**0028 is the record where a colour stopped being a `Paint`'s business**, and its cost was
paid in a file format version. The gap it closed was one sentence — `applyOperation` makes
`Paint` a no-op on the distance, so a solid operation could not carry colour at all — but the
obvious fix would have **painted the entire landscape with the brush colour**, because the
brush wrote a colour onto every operation with a comment saying the other modes ignored it.
They did ignore it. So the rule became "a colour means something wherever it is written", and
two producers had to stop writing one.

Three things are worth carrying forward:

1. **A default can enforce the opposite of what it looks like it enforces.**
   `makeOperation` defaulted `colour` to white so that no reader would have to check for
   absence — and under the new rule a default of white means every `Add` in the model paints.
   The absence had to become the default, and the one reader that cares now checks.
2. **A default change is a format change when the bytes still parse.** Version 2 files carry
   a brush colour on their `Add` operations; read under version 3's rule they would paint.
   The bytes are fine. What changed is what they _mean_, which is the one thing a version byte
   cannot leave ambiguous.
3. **Two absolutely-positioned boxes on opposite edges of a short screen have no relationship
   to each other**, which is why the transform panel grew into the parts panel and no
   adjustment to either fixed it. Making the canvas a flex child and the panels its siblings
   makes overlap structurally impossible — and the `min-height: 0` that goes with it is the
   line most likely to be dropped, because a flex item that will not shrink looks exactly like
   a layout that is merely too tall.

And one found on the way: **the modeller had been meshed with no `onVertex` at all**, so every
vertex carried the builder's `+Y` normal placeholder. The builder's comment says that
placeholder was chosen to be "a real direction rather than an obvious sentinel" — so the model
shaded as though its normals were right.

And one at the end: **the modeller's output is going to a 3D printer**, which is a different
requirement from "looks right on a screen", and it is the requirement 0003's mesher could not
meet. `0030` adds marching cubes beside Surface Nets, adds a resolution control, and adds a
report that says whether a finished mesh is closed, manifold and consistently wound — because
the interesting failures draw perfectly and the only moment to act on them is before a slicer
says no.

Two of its findings are worth reading for what they cost rather than for what they decided.
The mesher had a bug that double-counted a corner offset on eight edges of twelve and omitted
the shift from a sample index to a world position; **both still produced a closed mesh of
roughly the right volume**, and only a test that put every vertex against the field found them.
And the report welded vertices at a fixed four decimal places until the modeller's own
finest-resolution mesh came back with an edge 7.6e-5 long and was called non-manifold — a
resolution that cannot serve two scales at once.

And one more, on the other application: **a colour's reach was one world unit, which is a
fraction of a landscape and the whole of a figure.** `0031` is the short version — the nearest
surface takes a point's colour, and the reach is left doing the one job it is good at, which
is rejecting a query that is nowhere near anything. It supersedes one sentence of `0028`,
which was right about its own decision and wrong about the rule underneath it.

**0040 is the record where the sky stopped being flat, and it was forced by 0039.** Making the
planet visible from above exposed the fact that the fog, the clouds and the sky were all still
shaped for a landscape. The finding worth carrying forward is that **one law was doing two jobs
that cannot share a number**: hiding the chunk window needs an extinction that also swallows the
planet from orbit, so the fog was split into a near-field term gated on the globe's own crossfade
and an atmospheric column that depends on where the ray goes. The rest follows from the same
realisation stated geometrically — the clouds became a concentric shell addressed by direction,
and the sky became a function of the eye's altitude, so it goes black and shows stars once there
is no air left to scatter.

**0041 is the record where a decision from 0036 turned out to be about the wrong quantity.** 0036
chose the planet's radius from its circumference — how long it takes to walk around — and that
argument was sound but pointed at the wrong feeling: the horizon, `√(2·R·h)`, was 219 units, less
than one terrain feature, so the ground curved away inside a hillside. The record's real content is
the split it makes: **the planet's body scales with the radius, and its surface detail does not.**
Everything a player walks on and sculpts at stays at its absolute size, which is why the change is a
constant plus a re-derivation rather than a rescaling of the repository, and why the terrain reads
flatter as the price. It also pays off 0039 by confirming, with the patch tests it makes fail, that
the warped-cube lattice could not have served a planet this size.

**0042 is the record where an address was correct and useless, and it was found by asking what it
did rather than what it was.** 0040 made the cloud volume address the direction from the planet's
centre, which is right about seams and poles, and it also moved the altitude out of the volume —
a direction is scale-invariant, so a ray climbing through the whole seven-hundred-unit layer moved
the address **zero texels** of a sixty-texel noise field. Every sample of every ray read the same
base shape and the same three detail channels, and the sky was a silhouette extruded through the
layer. Nothing was wrong with the address's _shape_, which is all the tests asked, and the whole
file passed. Two things are worth carrying forward. **A correct mapping is not a working one: ask
what a value does over the range you actually use, not only what it is at the ends.** And the
feature size is now chosen from the ground rather than from the radius — because a cloud's
angular size and the volume's wrap count are the _same number_, and 0041's "the body scales" rule
is right about the body and wrong about a cloud.
