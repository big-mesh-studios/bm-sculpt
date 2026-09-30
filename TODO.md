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
| `pnpm test`         | 481 tests across 23 files                       |
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
src/csg/      field, operations, BVH, shapes, serialisation   (phase 1)
src/world/    coordinate map, chunk window, LOD, paint tiles   (phase 2)
src/mesh/     Surface Nets, chunk mesher, workers, pool        (phase 3)
src/render/   geometry upload, mesh store, surface material    (phase 4)
src/pick/     ray + sphere trace                               (phase 5)
src/edit/     document, brush, tool                            (phase 5)
src/session.ts  window ↔ pool ↔ store wiring                   (phase 4)
src/sculpt.ts   document + field + tool                         (phase 5)
```

Phases 0–5 are complete. What works, verified in a browser: a streamed model meshed in
four workers, left-drag sculpting, ctrl-z undo, orbit/pan/pinch, and `?spike` for the
phase 0 diagnostic.

---

## Phase 6 — the terrain base field

**The next phase, and the only one whose scope is written down in the code.** Four
places say what it is, and one of them throws today.

The model is currently operations only. Phase 6 adds a height field _behind_ the
operations, so a sculptor carves into terrain the way they carve into a primitive.

### What to build

- **The field itself.** `BaseField` already exists and is just
  `(x, y, z) => number` — a distance function, negative inside the solid. Fill it in
  `src/csg/` as a new module. ADR 0002 expects a seeded, multi-octave height field.
- **`lipschitz`.** `FieldOptions.lipschitz` exists and defaults to 1. A height field is
  _not_ a distance function in any direction but the vertical one, so it must be divided
  by its largest gradient — otherwise the picker steps through surfaces and the field
  over-reports. The comment on the option says so; this is the first consumer.
- **`couldHoldSurface`.** `Field.couldHoldSurface` currently returns `true` for
  everything (`src/csg/field.ts:167`). Its own doc says the real answer belongs to the
  terrain, not the composition: a height field can answer it in constant time from its
  column range, and an arbitrary base field cannot answer it at all. This is the mesher's
  first gate — in a terrain world most chunks are all air or all solid, and skipping them
  is most of what makes streaming affordable.
- **Wire it through.** `ModelMessage` already has `base: "none" | "terrain"` and a
  `terrain` parameter block (`origin`, `scale`, `octaves`, `seed`).
  `src/mesh/model-field.ts:123` currently throws
  `no base field for terrain; terrain arrives in Phase 6` — that throw is the seam, and
  removing it is the moment the feature exists.
- **The main thread needs it too.** `SculptSession` builds its own `Field` from
  operations only. If the picker does not trace the same model that is on screen, the
  dab lands where the mesh is not — which is the one disagreement this whole design
  exists to rule out (ADR 0009). The camera-following window already works at any
  distance, so nothing else changes.

### Checks

- The picker must still work with `lipschitz < 1` — that is the entire point of it.
- Sculpting must still land on the visible surface with terrain under it.
- Streaming must not degrade: watch the `pending` counter in the header. It is the
  difference between a world that streams and one that stalls.

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

### 1. No test has run a real `Worker` against a real GPU

The worker path is verified two ways that are both weaker than they look:

- **Structurally.** A build with `--minify false`, then read the emitted worker chunk:
  it contains `surfaceNets`, `handleMeshMessage`, `mesherFor`, `writeOctahedralNormal`,
  and contains none of `installChunkMesh`, `ChunkMeshStore`, `toChunkGeometry`,
  `BufferGeometry`, `Scene`. That proves the layering, not that it runs.
- **Behaviourally, against fakes.** `src/session.test.ts` drives the entire streaming
  loop with workers that answer when told to. Every staleness rule is covered — but
  against a fake, and `handleMeshMessage` never touches a `Field`.

A desktop with a real browser is where that closes. If a chunk fails to appear, the
likely culprits in order: the `new Worker(new URL(...))` URL resolving oddly under the dev
server; the worker's module failing to load (check the console); and `couldHoldSurface`,
which returns `true` unconditionally today and so cannot be skipping anything yet.

### 2. Fragment precision is still unanswered

You will see `fragment precision: <something>` in the header. On the machine this was
written on it read "not probed", which is why `src/render/precision.ts` was changed to
return a _reason_ instead of a bare `undefined` — a silent `catch` made "this device
cannot run the renderer" and "this probe is broken" look identical.

**Read that line and write it down here.** If it says `highp`, the question is answered
and the probe can shrink to a boot-time constant. If it says anything else, the reason is
in the line.

### 3. Superchunk membership — deferred from phase 4, needs a measurement

ADR 0007 named it; rmsl has the mechanism (`Mesh.drawRange` — several meshes sharing one
uploaded geometry, each drawing its own run of indices). It was not built because nothing
was on screen yet, so there was no count of draw calls to reduce, and merging costs a
second code path (merged and per-chunk) that doubles what has to stay correct.

Now it can be measured. Two things to know before you try:

- **There is no `renderer.info`.** rmsl exposes no draw-call counter and no render
  statistics of any kind — grep the `.d.ts` files, there is nothing. If you want a real
  GPU time figure, `EXT_disjoint_timer_query_webgl2` on the context is the route.
- **But you may already have the number.** Every drawn chunk is exactly one `Mesh` with
  the whole geometry, so draw calls equal `stats().drawn` — which is _already in the
  header_ as `N drawn`. Orbit and watch it. If it sits in the tens, merging will not
  save you anything and the whole question closes.
- **There is no merge helper in rmsl.** Merging is hand-written concatenation of the
  four typed arrays with index offsetting, which is mechanical but not free.

Also worth knowing before optimising anything: **rmsl does not frustum-cull.** There is
no `frustumCulled` on `Object3D` and nothing in the renderer looks for one, so every
drawn chunk is submitted every frame whether or not it is on screen. That may matter more
than merging does, and it is a smaller change.

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

---

## Things that will bite you

Each of these cost real time and is now recorded somewhere. Read the record.

- **`ChunkWindow.slotOf` refuses unfilled chunks**, deliberately — a query about a chunk
  whose contents have not arrived has no honest answer (ADR 0007). Anything _holding_
  slots must use `claimedSlotOf` instead. Using the wrong one fails quietly: every
  unfilled chunk looks like it is not in the window at all.
- **A renderer's buffers are keyed by geometry object**, so a dropped geometry is held for
  the renderer's whole life. `dispose` belongs to _replacing_ a mesh, not to shutting
  down — including when a sculpt deletes a chunk's surface.
- **Sending a model cancels every mesh in flight.** Correct, and it means every edit must
  re-request everything unfinished or chunks stay blank until something unrelated scrolls
  the window. It looks like a hanging mesher.
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
