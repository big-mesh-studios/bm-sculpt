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

Remaining work, and what is left of the phases after this one, is written down in
[`TODO.md`](TODO.md).

|              |                                                                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renderer** | [`@random-mesh/rmsl`](https://www.npmjs.com/package/@random-mesh/rmsl) 1.14.0 — a scene graph and a node-graph shader DSL. Not a three.js fork; see [ADR 0001](docs/adr/0001-rmsl-over-three.md).                                                                          |
| **UI**       | Solid **2.0.0-beta.29**, `solid-js` + `@solidjs/web` + `@solidjs/signals`, coordinated at one version. The JSX transform runs through Babel rather than the native compiler, so the toolchain has no native step and builds anywhere Node does; see `pnpm-workspace.yaml`. |
| **Build**    | Vite 8, `vite-plugin-solid@3.0.0-next.5`, TypeScript in `strict` with `noUnusedLocals` and `noUnusedParameters`.                                                                                                                                                           |
| **Style**    | One Prettier config, no linter. Type safety is `tsc --noEmit`.                                                                                                                                                                                                             |
| **Layout**   | One package. `pnpm-workspace.yaml` exists for the `catalog:` it holds, which every version more than one place needs is written into once.                                                                                                                                 |

## Phase 0 spikes

Three questions were meant to be settled before the mesher is written, because a
wrong answer to any of them would force the mesher's output format to change.
All three are answered, and each is answered twice: once as a unit test that
compiles and inspects the shader on the host, and once visibly on screen.

**Does a packed vertex layout reach the GPU?** The layout is the one the mesher
will target — `float32x3` position, `snorm16x2` octahedral normal, `unorm8x4`
colour, twenty bytes. `vertexFormatOf` infers the format from the array type,
component count and `normalized` flag, and
[`spike-geometry.test.ts`](src/render/spike-geometry.test.ts) asserts the
inference and that `VERTEX_BYTES` matches what those formats actually occupy.
Signed 16-bit pairs beat unsigned 8-bit quads for the normal at the same four
bytes — roughly a hundredth of a degree of error rather than four tenths.

**Does a 3D sampler bind?** There is no `Data3DTexture`; a volume is a
`DataTexture` with a depth, bound through `b.sampler(name, "sampler3D", …)`.
[`spike-material.test.ts`](src/render/spike-material.test.ts) compiles the
material on the host and asserts `sampler3D` appears in the emitted GLSL and in
the program's binding list — the text being the only place the difference between
a `sampler3D` and a `sampler2D` on the same bytes is visible.

**What precision does this device have?** `highp` is mandatory in the vertex stage
and optional in the fragment stage, and an unsupported qualifier is dropped
_silently_ — the shader still compiles and the only symptom is banded lighting.
[`precision.ts`](src/render/precision.ts) measures it with
`getShaderPrecisionFormat` and the spike page reports the answer.

**Is a raw GLSL escape hatch available?** No, and that is worth knowing before
reaching for one: there is no `ShaderMaterial` in this library. Every shader must
be a node graph. `compileGLSL` is how to see what one became.

## Running it

```sh
pnpm install
pnpm dev
```

```sh
pnpm check-types   # tsc --noEmit
pnpm test          # vitest
pnpm build         # vite build
pnpm format        # prettier --write
```

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

|                                                        |                                                       |
| ------------------------------------------------------ | ----------------------------------------------------- |
| [0001](docs/adr/0001-rmsl-over-three.md)               | Render with rmsl, not three.js                        |
| [0002](docs/adr/0002-computed-field-never-stored.md)   | The field is computed, never stored                   |
| [0003](docs/adr/0003-surface-nets.md)                  | Surface Nets per chunk, not marching cubes            |
| [0004](docs/adr/0004-csg-per-chunk.md)                 | Each chunk evaluates the operations at its own LOD    |
| [0005](docs/adr/0005-streaming-shape.md)               | Slot-indexed arrays and a coordinate map              |
| [0006](docs/adr/0006-field-saturation.md)              | The field saturates at a fixed distance               |
| [0007](docs/adr/0007-window-presence-and-lod-reset.md) | Invalidating a slot invalidates what a query may read |
| [0008](docs/adr/0008-worker-pool-and-generations.md)   | One chunk per worker, and a generation per request    |

Phases 1 to 8, in order, are in the project plan. Phases 0 to 5 are the sculpting
application and are independently shippable; 6 to 8 are an infinite streaming
world, and because the field is never stored they add no changes to the CSG or the
mesher — only a `baseField` binding and a camera.

## Phase 5 — sculpting on it

Drag to sculpt. Right-drag orbits, shift-drag pans, ctrl-z undoes. The model is an
operation list, the mesher runs in workers, and the picker traces the same field the
mesher reads — so a dab lands where the field says the surface is, which is the property
the whole design exists to make true.

`src/pick/` traces the ray. `src/edit/` holds the model, the brush, and the tool that
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

`src/session.ts` is where the phases meet, and it is the most bug-prone file in the
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

`src/render/chunk-mesh-store.ts` enforces ADR 0007's rule that a slot is marked unfilled by
whatever invalidates it and refused for a revision the caller does not hold. That rule turned
out to need to be stronger than the record expected: the store owns a revision per slot, so
the invariant is enforced by the owner of the state rather than by every caller remembering
to invalidate.

A renderer's buffers are keyed by geometry object, so a dropped geometry is held for the
renderer's whole life. In a scrolling world that is a leak several times a second, so
`dispose` belongs to _replacing_ a mesh rather than to shutting down — including when a
sculpt deletes a chunk's surface, which is what every deletion produces.

## Phase 3 — meshing

`src/mesh/` turns the field's sign into triangles, in workers. The mesher proper is
a pure algorithm over a sampler; everything project-specific is one layer above it.

|                   |                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `surface-nets.ts` | One vertex per cell whose corners disagree, one quad per sign-changing edge. Owns the seam rule, which is the only subtle thing in it. |
| `chunk-mesher.ts` | `ChunkMesher`, the interface a WebAssembly implementation would come through, and the Surface Nets implementation of it.               |
| `chunk-mesh.ts`   | The twenty-byte vertex the Phase 0 spike proved reaches the GPU.                                                                       |
| `growable.ts`     | The only way geometry is accumulated, with the `array`/`exact` split so a transfer never delivers a detached view.                     |
| `model-field.ts`  | Builds a field from a model message, on the worker's side of the thread boundary.                                                      |
| `protocol.ts`     | The messages, as data and nothing else.                                                                                                |
| `worker.ts`       | `handleMeshMessage`, a pure function of state, message and an injected mesher factory.                                                 |
| `worker-pool.ts`  | Four workers, one chunk each, and the rule for which answer counts.                                                                    |

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

`src/world/` is where chunks live: which cells exist, which slot each is in, and what
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
field, no stored mesh (ADR 0002). `src/csg/` is the whole of it.

|                 |                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shapes.ts`     | Ellipsoid, box, capsule, and the signed distance to each. Two are exact; the ellipsoid is the standard two-term approximation, and its shortfall is bounded rather than assumed away. |
| `operations.ts` | The operation type, the smooth booleans, an operation's world box, and **the fold** — the one piece of arithmetic that has to be exactly right.                                       |
| `bvh.ts`        | A binned surface-area hierarchy over the operations, and the candidate cache that makes a chunk's cost independent of the model.                                                      |
| `field.ts`      | The composition seam: `fold(operations, p, baseField?(p))`. Adding an infinite world is a new `baseField` and nothing else.                                                           |
| `serialise.ts`  | File format v1. The field's _description_, never any voxel data — so a file's size is a function of what the user did, not how big the model is.                                      |

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

`src/csg/cost.test.ts` holds that to a ceiling rather than reporting it as a
benchmark, because the failure worth catching is a change that looks harmless and
costs ten times as much, not a number that drifts.
