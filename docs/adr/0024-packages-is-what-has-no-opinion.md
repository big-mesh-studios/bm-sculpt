# 0024 — `/packages` is what has no opinion, and `/apps` is what does

## Context

This repository had grown one signed distance field implementation and was about to grow a
second. The second is not a variation on the first. `bm-sculpt` is a landscape: an unbounded
streamed world with an infinite ground plane, where a chunk is 32 voxels on a side and a
`MODEL_FIELDS`-wide painting pass happens on every stroke. `sdf-modeller` is a figure editor: a
bounded object you turn in your hand, built from named primitives, saved to a file that another
application reads.

What the two share is not the application. It is everything underneath it: octahedral vector
arithmetic, the primitive distance functions, the operation list and the CSG fold over it, the
BVH over operations, Surface Nets, and the structural ray picker. Those are five libraries with
no chunk size, no window, no camera and no opinion about what a model is _for_.

None of them were libraries yet. All of them lived in `src/`, in one package, next to
`src/engine/`, `src/render/` and `src/console/`. The first thing M2 has to do is import a
`PrimitiveSpec` table from somewhere, and the answer would have been
`@big-mesh-studios/bm-sculpt/src/sdf/shapes.ts` — an application importing from an application,
across a package boundary it does not have.

**The awkward part is that nothing enforces any of this.** A `ChunkMesher` written into an app
compiles. A library that imports `VOXEL_SIZE` from an application compiles, runs, and is correct
until the second application wants it. The coupling does not announce itself; it is discovered
later, by whoever is holding the second application.

## Decision

**A pnpm workspace with two directories: `/packages` for code with no opinion about what it is
for, `/apps` for code that has one. A workspace's directory is the claim about whether it will
ever be reused.**

The first five packages, and the one application they came out of:

| Workspace                   | What it knows                                                           |
| --------------------------- | ----------------------------------------------------------------------- |
| `@big-mesh-studios/core`    | Vector and box types, `Medium`, and the three numbers every field needs |
| `@big-mesh-studios/sdf`     | Closed-form primitive distance functions and their validation table     |
| `@big-mesh-studios/csg`     | The operation list, the fold, the BVH, terrain, serialisation           |
| `@big-mesh-studios/meshing` | Surface Nets, growable buffers, chunk mesh output                       |
| `@big-mesh-studios/picking` | Which primitive a structural ray hits                                   |
| `apps/bm-sculpt`            | The landscape: chunks, streaming, the renderer, places, the console     |

**Four decisions inside that:**

- **`core` owns the constants that describe a field, not the ones that describe a chunk.**
  `DEFAULT_FIELD_STEP`, `MAX_SOFTNESS`, `SOFTNESS_REACH` and `FAR_DISTANCE` are properties of the
  distance field and travel with it. `VOXEL_SIZE`, `CHUNK_VOXELS`, `BLOCK_WORLD`, `LOD_COUNT`
  and the window bands are properties of _this_ landscape and stayed in the app. `FAR_DISTANCE` is
  the interesting one: it is a fog cutoff that the renderer wanted and a field falloff that CSG
  wanted, and it went to `core` because the second is what it actually is. `SOFTNESS_REACH` came
  with it for the same reason — a soft operation stops affecting the field beyond that distance,
  and that is a statement about the fold, not about chunking.

- **Packages ship raw TypeScript. There is no build step and no `dist`.** Each package's
  `exports` points at `./src/index.ts` and consumers resolve it with `moduleResolution:
"bundler"`. This is the one setting that makes the arrangement possible: five libraries, zero
  build steps, and a broken type in a package fails the _consumer's_ type-check immediately
  instead of after a `tsc -b` someone has to remember to run. The cost is that a package cannot
  be consumed by anything that does not understand TypeScript — which is fine, because the only
  things consuming these are Vite applications in this repository.

- **`OperationBVH` takes its `candidateCell` as an option, and `Field` takes its `step` from
  `core`.** These were package-private constants that both read from the app's `constants.ts`.
  `OperationBVH` in particular is a per-chunk structure: it is built with the candidate cell size
  that matches the resolution the chunk will be sampled at, and a BVH that used a cell size from
  a different application would be correct and slow, or fast and wrong, with no way to tell which
  from reading it. The option is what lets the library be reused by an app with a different cell
  size — which is the entire premise of extracting it.

- **The `/apps` versus `/packages` rule is checked by `tools/workspace.ts`, in CI, before the
  type-check.** It fails on three things: a workspace in the wrong directory for its `private`
  flag, a package depending on an app, and two packages depending on each other by path. Run
  first, because it costs a second and it is the check that has nothing to do with types — every
  other gate compiles a layout that is wrong as happily as one that is right.

### What stayed in the app, and why

Extraction was not "move every file with no renderer import". Four things stayed, and the reasons
are worth recording because the next person will look at them and wonder:

- **`src/mesh/chunk-mesher.ts`, `src/mesh/worker.ts`, `src/mesh/worker-pool.ts` and the LOD
  streaming in `src/world/`** — `ChunkMesher` is a Surface Nets implementation over
  `CHUNK_VOXELS`, and it schedules work by `Lod`. Meshing as an algorithm went to `meshing`; the
  part that knows what this landscape's LOD bands are did not, because there is one of those per
  application and the second application will have a different one.
- **`src/render/`'s node-graph builders** — `Scene`, `Material`, `Node` and the shader graph are
  an `rmsl` concern used by two applications in this repository and by the sibling. They are
  library-shaped and they are the obvious next extraction, but nothing needs them to be one yet,
  and `packages/meshing` returning `rmsl` node graphs would make the meshing package depend on a
  renderer, which is the coupling ADR 0001 already argued against.
- **`src/player/player.ts` and the generic half of `src/world/`** — `updatePlayer` integrates
  velocity against a height function, and that arithmetic is not tied to the landscape's window.
  What _is_ tied to it is which height function, and that arrives as an argument.
- **`src/scratch/`** — three test files (756 lines) that were running under the repository-root
  vitest but sitting outside `src/`, where `tsc` never looked at them. They moved _into_
  `apps/bm-sculpt/src/scratch/`. See Consequences.

### What this does not do

**It does not make the shared model file format exist.** M5 adds it, and `PlaceManifest.models`
returns with a real `/place:open` consumer. This ADR moves code; the format is a separate
decision with a separate cost, because a model format has to serve two readers that do not yet
both exist.

## Consequences

- **Two applications can share five libraries, and neither has to know the other's scale.** The
  second application's `Vite` config names `@big-mesh-studios/meshing` and gets Surface Nets; the
  first keeps `VOXEL_SIZE` to itself.
- **`pnpm -r test` is now the gate, and the count has to match.** The pre-move baseline was 60
  files and 1444 passing tests with 3 expected failures. After the move: the same 60 files and the
  same 1444, because `src/csg/cost.test.ts` moved to `apps/bm-sculpt/src/csg-cost/cost.test.ts`
  rather than into a package. **That test is a case the rule about libraries does not cover.** It
  measures the cost of sampling one chunk, and the field it builds is `CHUNK_VOXELS +
FIELD_BORDER` samples a side at `VOXEL_SIZE` apart — three numbers that belong to the landscape
  and to nothing in `packages/csg`, which has no chunk to name. A CSG package carrying its own
  idea of what a chunk is would be the coupling this ADR removes, with the benchmark's threshold
  silently changing whenever the landscape's chunk size changed.
- **A latent type error was found and fixed by moving files rather than by reading them.**
  `src/places/load-place.test.ts` passed `string | null` to `JSZip.file`, which has no such
  overload — it takes `null` for a directory entry and a data union for a file. This had been
  wrong since ADR 0021 and `pnpm check-types` had been reporting it the whole time. It is called
  out here because the lesson is not "fix the overload"; it is that a gate whose output nobody
  reads to the end is not a gate.
- **`src/scratch/pan-recycle.test.ts` had a loop that marked nothing.** It read
  `for (const slot of window.slots) window.markFilled(slot)`, but `slots` is an array of slot
  _records_ and `markFilled` takes a slot _index_ — so `slots[record]` was `undefined` every time
  and the call returned early. Every slot stayed unfilled, in a test whose subject is what a pan
  does to the meshes. It passed, because nothing in it depends on a slot being filled. Three
  files outside `src/` were run by the root vitest and type-checked by nothing; all three are now
  inside `src/`, all three type-check, and the assertions still hold with slots genuinely filled.
- **The monorepo has a rule that runs.** `pnpm workspace:check` is the only check here that can
  fail on a dependency graph that compiles perfectly.
- **`pnpm dev` runs `apps/bm-sculpt`.** There is one app, so there is one script, named without a
  suffix. When `sdf-modeller` exists it becomes `pnpm dev` with a prompt, or `pnpm dev:bm-sculpt`
  and `pnpm dev:sdf-modeller` — and `pnpm dev:sdf-modeller` is already a script that filters on a
  workspace that does not exist yet, which is a broken script that will be right in M4.
- **GitHub Pages builds from `apps/bm-sculpt/dist`**, because `pnpm -r build` gives each app its
  own output directory and the root no longer has one. The workflow copies it into place rather
  than hard-coding a second path, so adding the modeller later is one more line.
