# TODO — remaining phases

A handoff for whoever picks this up on another machine. Written at `cb6fca5`
(phase 5 complete, all work pushed to `origin/main`).

This is the working list. The architecture and the reasoning behind it are in
[`docs/adr/`](docs/adr/README.md) — nine records, and several of them contain
measurements and consequences that are not repeated here. **Read ADR 0002, 0003,
0007, 0008 and 0009 before changing anything structural.**

---

## Getting set up

```bash
git clone git@github.com:big-mesh-studios/bm-sculpt.git
cd bm-sculpt
pnpm install --frozen-lockfile     # Node >= 24
pnpm dev                           # http://127.0.0.1:5173
```

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `pnpm test`         | 519 tests across 24 files                       |
| `pnpm check-types`  | `tsc --noEmit`, strict, no linter               |
| `pnpm format:check` | Prettier — **CI fails on this**                 |
| `pnpm build`        | Production build; emits a separate worker chunk |

A desktop machine is the _easier_ target, not a harder one. `pnpm-workspace.yaml`
pins a Babel-based Solid toolchain (`vite-plugin-solid@3.0.0-next.5` +
`babel-preset-solid@2.0.0-beta.29`) specifically because the native Solid compiler
will not run on Termux. It runs everywhere; it is just not the plugin's default.
Do not "upgrade" it back without reading the file.

**CI has a format bot.** `format` job on push auto-commats Prettier changes to
`main`. Expect a `format` commit to land on its own, and expect `format:check` to be
the most common CI failure.

`pnpm-workspace.yaml` holds every dependency version once, in a `catalog:`. Adding a
version in `package.json` instead of the catalog is the mistake the file's own comment
warns about — two copies of a package means two classes, and they fail to meet.

---

## Current state

```
src/csg/      field, operations, BVH, shapes, serialisation, terrain (phase 1, 6)
src/world/    coordinate map, chunk window, LOD, paint tiles   (phase 2)
src/mesh/     Surface Nets, chunk mesher, workers, pool        (phase 3)
src/render/   geometry upload, mesh store, surface material    (phase 4)
src/pick/     ray + sphere trace                               (phase 5)
src/edit/     document, brush, tool                            (phase 5)
src/session.ts  window ↔ pool ↔ store wiring                   (phase 4)
src/sculpt.ts   document + field + tool                         (phase 5)
```

Phases 0–6 are complete. What works, verified in a real browser: a streamed terrain with a
seeded multi-octave height field behind it, meshed in four workers, left-drag sculpting that
re-meshes while the pointer is still down, ctrl-z undo, right-drag orbit, shift-drag pan,
and `?spike` for the phase 0 diagnostic.

**Touch pinch is not verified.** The gesture is meant to work — the orbit controller has
always had the two-pointer branch — but nothing has been run on a touch device, and the
arbitration that would deliver a second finger to it did not exist until after this list
was written. Treat it as untested rather than as working.

**The terrain has visible cracks along level-of-detail boundaries.** Dark lines where two
chunks either side of a `DEFAULT_LOD_BANDS` step sample the same ground at different
strides. Confirmed by setting `bands: LOD_OFF` in `app.tsx`: the cracks vanish and the
triangle count goes from 28k to 125k. Pre-existing and not caused by Phase 6 — the
operations-only model was small enough to sit inside one level, so nothing ever crossed a
boundary. A large continuous surface is the first thing to. See open item 9.

---

## Phase 6 — the terrain base field

**Done.** The model is a height field _behind_ the operations, so a sculptor carves into
terrain the way they carve into a primitive.

### What was built

- **`src/csg/terrain.ts`.** Seeded 2D gradient noise, fBm-summed, as a `BaseField`:
  `y - height(x, z)`. One value fills three roles — the distance function, the region it
  can answer for, and the Lipschitz bound — so a caller cannot pair one terrain's distances
  with another's bound.
- **`lipschitz`,** derived rather than measured. Each fBm octave contributes the same
  gradient (`0.5^i · 2^i = 1`), so the bound is `1 / sqrt(1 + 2A²)` with
  `A = octaves · G · scale / feature`. `G` is a worst-case over the interpolation
  (`NOISE_GRADIENT_BOUND`), because a measured maximum is not a bound. It lands near 0.2
  with the default parameters, so the picker takes about five times the steps it did over
  operations alone and still converges in tens of steps.
- **`couldHoldSurface`,** answered in constant time from the height range, and _only_
  believed once the operation list has been asked too — a sphere floating in the sky is in
  a chunk the terrain calls empty, and skipping it would delete the object permanently.
  `src/mesh/terrain-gate.test.ts` checks the soundness against ground truth: mesh without
  the gate, and if there was any geometry the gate must not have claimed the chunk empty.
- **The gate is now actually used.** `ChunkMesher.couldHaveMesh` existed and was tested,
  but the worker never called it. It does now, and answers with an empty mesh rather than
  silence — an unanswered request is a chunk that stays blank for ever.
- **Wiring.** `mesherFor` builds the terrain from the message's four numbers (the throw is
  gone); `Session` carries them in `modelMessage()`; `SculptSession` reads them back off
  `session.terrain` so the picker and the workers cannot disagree (ADR 0009).

### Checks, and how they were made

- The picker still works with `lipschitz < 1` — asserted on the composed field, and the
  terrain's factor is separately verified to _be_ a bound on its own measured gradient.
  That second test is the load-bearing one: a factor that is too large is not a slow
  picker, it is a picker that walks through the ground.
- Sculpting lands on the visible surface with terrain under it — a hover picks the ground,
  and a stroke across a landscape commits and undoes as one command.
- Streaming did not degrade: `pending` sits at 0–3 with the landscape up, against 0 with
  the model that had five drawn chunks. The window now draws 49 chunks and 28k triangles
  where it drew 5 and 9k.

### Two things that are true now and were not obvious before

- **A terrain world exposes the LOD cracks** — see the note under "Current state". It was
  always there; nothing crossed a level boundary until there was a large surface.
- **`couldHoldSurface` is a permanent answer.** The mesher that skips a chunk records an
  answer, so a wrong `false` is a hole nothing re-meshes. That asymmetry is why the
  composition double-checks the operation list and why the terrain's range bound is
  deliberately pessimistic. Treat any change to either as high-risk.

---

## Phases 7 and 8 — scope unknown

**The project plan document is not in this repository and was not on the machine this was
written on.** The only description anywhere in the tree is one line in `README.md`:

> Phases 1 to 8, in order, are in the project plan. Phases 0 to 5 are the sculpting
> application and are independently shippable; 6 to 8 are an infinite streaming world, and
> because the field is never stored they add no changes to the CSG or the mesher — only a
> `baseField` binding and a camera.

So: both concern the infinite streaming world, and neither should require changes to
`src/csg/` or `src/mesh/`. Do not guess — get the plan, or ask. Everything in the tree
that says "phase 6" is about the terrain; nothing anywhere describes 7 or 8.

---

## Open items, not phases

Ordered by how much they matter.

### 1. The worker path has run, but only against a software rasteriser

Closed as far as this machine could take it. The application has been driven in a real
browser with real module workers, a real WebGL 2 context and real synthetic pointer input:
chunks mesh in four workers, a stroke re-meshes while the pointer is down, and undo and
orbit behave. Two caveats, both worth keeping:

- **The GL context was SwiftShader**, not hardware. That exercises every line of the
  upload and draw path and would have caught a shader that does not compile or a buffer
  that is laid out wrongly, which is most of what could have been wrong. It says nothing
  about frame time on a real GPU.
- **Only the happy path ran.** Every failure branch — a worker that fails to load, a chunk
  that meshes to an error, `onFailed` leaving a slot unfilled — is covered by
  `src/session.test.ts` against fakes and has never been provoked for real.

The two original checks are still worth keeping as the regression net, because they are
cheap and they cover what a browser run does not:

- **Structurally.** A build with `--minify false`, then read the emitted worker chunk:
  it contains `surfaceNets`, `handleMeshMessage`, `mesherFor`, `writeOctahedralNormal`,
  and contains none of `installChunkMesh`, `ChunkMeshStore`, `toChunkGeometry`,
  `BufferGeometry`, `Scene`. That proves the layering, not that it runs.
- **Behaviourally, against fakes.** `src/session.test.ts` drives the entire streaming
  loop with workers that answer when told to. Every staleness rule is covered — but
  against a fake, and `handleMeshMessage` never touches a `Field`.

If a chunk fails to appear, the likely culprits in order: the `new Worker(new URL(...))`
URL resolving oddly under the dev server; the worker's module failing to load (check the
console); and `couldHoldSurface`, which returns `true` unconditionally today and so cannot
be skipping anything yet.

### 2. Fragment precision: answered, and the probe can now shrink

**It reads `highp`.** Measured in a real browser, with the probe working — which is the
part that was open, since the machine this was written on read "not probed" and that is
why `src/render/precision.ts` was changed to return a _reason_ instead of a bare
`undefined`.

So the remaining work is the follow-through, and it is small: the answer is a property of
the device, not of the frame, so `detectFragmentPrecision` can become a boot-time constant
and the probe can go. **Read the line in the header before deleting anything** — a device
that reports `mediump` or fails to probe is exactly the case the reason-returning shape
was built for, and throwing that away to save a probe that now always says `highp` trades
a real diagnosis for tidiness.

### 3. Superchunk membership — measured, and the answer is "not yet"

ADR 0007 named it; rmsl has the mechanism (`Mesh.drawRange` — several meshes sharing one
uploaded geometry, each drawing its own run of indices).

**Measured: the starter model draws 5 chunks.** The header's `N drawn` is the draw-call
count (every drawn chunk is exactly one `Mesh` with the whole geometry), and it reads 5.
The window holds 257 slots at the default radius 4, so the other 252 are filled with air
and draw nothing. Five draw calls is not a number worth reducing, and merging is a second
code path — merged and per-chunk — that doubles what has to stay correct.

**The question is deferred, not closed.** In a terrain world the same window will have far
more of its slots filled, and that is the measurement to take before building anything.
Two things to know when you do:

- **There is no `renderer.info`.** rmsl exposes no draw-call counter and no render
  statistics of any kind — grep the `.d.ts` files, there is nothing. If you want a real
  GPU time figure, `EXT_disjoint_timer_query_webgl2` on the context is the route.
- **There is no merge helper in rmsl.** Merging is hand-written concatenation of the
  four typed arrays with index offsetting, which is mechanical but not free.

**The cheaper half is frustum culling, and it is probably the better one.** rmsl does not
frustum-cull: there is no `frustumCulled` on `Object3D` and nothing in the renderer looks
for one, so every drawn chunk is submitted every frame whether or not it is on screen. At
5 drawn chunks that is free; at 200 it is the whole frame. Culling needs no second code
path and no index arithmetic, so it is the thing to reach for first.

### 4. Brush settings have no UI

`SculptSession.configure()` accepts radius, softness, mode and colour. **Nothing calls
it**, so the brush is effectively hard-only and the soft path is untested by hand. A
small Solid panel over the existing signal would exercise it.

### 5. Measure the operation growth (ADR 0002's open item)

A soft stroke is currently hundreds of operations — one per dab — and field evaluation
is linear in the operations overlapping the point being sampled. ADR 0002 says this is
"fine while they cluster where the user is sculpting and needs measurement before it is
not". It is now measurable and it is the first thing to measure.

ADR 0009 records the fix worth considering: build the swept volume of a stroke as **one**
operation instead of a chain. That needs a swept-capsule shape in the CSG, which changes
the operation format and the field's arithmetic — a larger change than the problem
currently warrants, but it collapses both the cost and the undo granularity at once.

### 6. Never built, though in the parity scope

- Persistent working palette.
- Primitive tools (the gizmo shape the picker already anticipates: `SculptTarget.beginStroke`
  takes a normal it does not yet use).

### 7. The spike scene attaches the orbit controller twice

`src/spike-scene.tsx` attaches its own `OrbitController` when it builds the scene, and
`src/app.tsx` attaches the same controller again for both branches. The spike therefore has
two complete sets of listeners on one canvas.

It is nearly invisible, which is why it has survived: the handlers share one `pointers` map
and one `button`, so the second set sees a zero delta and does nothing. The exception is the
**wheel**, which every handler applies, so zooming on `?spike` runs at double speed — the
one gesture with no shared state to deduplicate it.

The fix is to stop one of them attaching. The spike does not need to: `app.tsx` attaches
uniformly and takes the returned disposer.

### 8. `OrbitController.dragging` is dead

The getter's comment says "the UI uses this to hide its own hints". Nothing reads it —
grep finds no call sites, and the hints text in `app.tsx` is static. Either wire it up or
delete it; a getter that documents a consumer who does not exist is a small lie that costs
a reader a minute every time.

### 9. Level-of-detail transitions crack

**Found and diagnosed while building Phase 6, not fixed.** The terrain shows dark lines
where two chunks either side of a `DEFAULT_LOD_BANDS` step sample the same ground at
different strides — `full: 1, coarse: 2` is a hard step, and a surface crossing it is
meshed twice at two resolutions that do not agree on where the vertices are.

The diagnosis is settled, which is the useful part. Setting `bands: LOD_OFF` in
`app.tsx` makes the cracks disappear and takes the same view from 28k triangles to 125k, so
it is the transition and not the terrain, the mesher, or the material.

Two things to know before fixing it:

- **It is not new.** The operations-only model was small enough to sit inside one level, so
  nothing ever crossed a boundary. A large continuous surface is the first thing to, which
  is why Phase 6 is when it became visible and not when it was introduced.
- **ADR 0003's seam rule does not cover this.** Chunking a region at _one_ level is
  seamless, and there is a test that says so. Two chunks at _different_ levels is a
  different question and nothing in the tree asks it. Whatever answers it — geomorphing
  across the band, a skirt, or a one-level overlap — is a real piece of work and should be
  sized as one rather than discovered again in a bug report.

---

## Things that will bite you

Each of these cost real time and is now recorded somewhere. Read the record.

- **`ChunkWindow.slotOf` refuses unfilled chunks**, deliberately — a query about a chunk
  whose contents have not arrived has no honest answer (ADR 0007). Anything _holding_
  slots must use `claimedSlotOf` instead. Using the wrong one fails quietly: every
  unfilled chunk looks like it is not in the window at all.
- **A renderer's buffers are keyed by geometry object**, so a dropped geometry is held for
  the renderer's whole life. `dispose` belongs to _replacing_ a mesh, to shutting down, and
  to a chunk changing **cell** — not to a chunk changing **model**.

  Those last two look alike and are opposites. A slot re-pointed at another cell is holding
  the previous cell's geometry, and that must go: drawing it at the new cell's coordinates
  is the artefact the revision mechanism exists to prevent. But a slot whose _model_
  changed is still the same cell, so its current surface is the right thing to draw until
  the replacement lands — dropping it opens a chunk-sized hole for as long as the mesher
  takes, once per edit, which is a strobe at the brush. That is why
  `ChunkMeshStore` has `markStale` and `markModelChanged` rather than one method, and why
  `hooksFor` routes the window's three reasons to two different ones. **If you are here
  trying to "fix" a double dispose or a missing one, check which of the two you are in.**

- **Sending a model cancels every mesh in flight.** Correct, and it means every edit must
  re-request everything unfinished or chunks stay blank until something unrelated scrolls
  the window. It looks like a hanging mesher.

  It also means a send is not something to do per frame. Anything that re-sends the model
  while the user is still drawing has to **wait for `Session.idle` first**, or it cancels
  the very mesh that would have shown the edit: the chunk under the brush never lands, and
  the symptom is not a stutter but an edit that appears to do nothing at all until the
  pointer stops. The dabs are not lost while waiting — they accumulate and go out together
  — which is what makes the update rate the mesher's real throughput rather than a number
  someone hoped for. Note this is a _coarse_ gate on the whole pool, not on the chunks the
  edit touches, because a send throws away everything outstanding and not just its own.

- **Chunks are centred on multiples of `BLOCK_WORLD`**, not on their low corner, so world
  319 is in cell 1.
- **An operation's index is its position in the fold** and must increase monotonically.
  Splicing a contiguous range out for undo is safe; anything that renumbers is not.
- **The sample scratch buffer is sized for the padded grid.** `samples + 2` per axis, not
  `samples`. Sized wrong, writes past the end are dropped and reads return 0, which reads
  as "outside" and invents surfaces inside solid chunks.
- **Stripping `distanceForStepping` off a `Field` loses `this`** and reads the BVH as
  undefined. Call it through the field.

---

## A note on the tests

Several of the bugs this project has found were found by tests written _after_ the code,
and a few were found by tests that were themselves wrong in a way that said something —
an operation's index is its position in the fold (a helper restarting at zero was handing
the document duplicates); a stroke's first dab is not the document's first operation;
`undefined` passed to a parameter with a default gets the default, which is why "no
surface under the pointer" is `null`.

Keep the properties, not the numbers. Assert that a pinch depends on the _ratio_ of finger
separation and lands in the same place however many pointer events delivered it — not
that it is 0.5 for a given pair of distances. And assert chunking by meshing a region as
one chunk and as eight and requiring the _identical triangles_: that single formulation
catches a duplicated quad, a dropped quad, a flipped winding and a misplaced vertex at
once, and it is the only checkable statement of the seam rule (ADR 0003).
