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

| #                                                                       | Decision                                                                               | Status   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| [0001](0001-rmsl-over-three.md)                                         | Render with `@random-mesh/rmsl`, not three.js                                          | accepted |
| [0002](0002-computed-field-never-stored.md)                             | The field is computed from an operation list, never stored                             | accepted |
| [0003](0003-surface-nets.md)                                            | Surface Nets per chunk, not marching cubes                                             | accepted |
| [0004](0004-csg-per-chunk.md)                                           | Each chunk evaluates the operation list at its own LOD                                 | accepted |
| [0005](0005-streaming-shape.md)                                         | Slot-indexed flat arrays and a coordinate map, not a keyed map                         | accepted |
| [0006](0006-field-saturation.md)                                        | The field saturates at a fixed distance                                                | accepted |
| [0007](0007-window-presence-and-lod-reset.md)                           | Invalidating a slot invalidates what a query may read from it                          | accepted |
| [0008](0008-worker-pool-and-generations.md)                             | One chunk per worker, and a generation on every request                                | accepted |
| [0009](0009-picking-and-history.md)                                     | The picker and the mesher read one field, and edits undo                               | accepted |
| [0010](0010-suspend-the-pointer-lock-not-the-input.md)                  | Suspend the pointer lock, not the input                                                | accepted |
| [0011](0011-the-sun-is-placed-by-a-solar-model.md)                      | The sun is placed by a solar model, not by a drawn curve                               | accepted |
| [0012](0012-the-cloud-layer-is-a-raymarched-slab.md)                    | The cloud layer is a raymarched slab with a carrier geometry                           | accepted |
| [0013](0013-fog-is-exponential-and-closes-at-the-window.md)             | Fog is exponential, and closes at the window's radius                                  | accepted |
| [0014](0014-the-sky-dome-is-drawn-first.md)                             | The sky dome is drawn first and ignores depth                                          | accepted |
| [0015](0015-place-scripts-run-in-a-quickjs-interpreter.md)              | Place scripts run in QuickJS, and all three caps are set                               | accepted |
| [0016](0016-a-place-is-a-named-group-of-operations.md)                  | A place is a named group of operations, and `flatten` decides the fold order           | accepted |
| [0017](0017-the-vocabulary-is-a-table.md)                               | The vocabulary is a table, and a payload is accepted whole or refused whole            | accepted |
| [0018](0018-a-place-is-bundled-and-the-guest-library-is-a-real-file.md) | A place is bundled into one reproducible program, and the guest library is a real file | accepted |
| [0019](0019-the-host-owns-what-it-can-own.md)                           | The host owns what it can own, and asks for the eight things it cannot                 | accepted |
| [0020](0020-a-place-runs-on-the-frame.md)                               | A place runs on the frame, and the console is how a person meets it                    | accepted |
| [0021](0021-a-place-arrives-as-a-zip-with-a-manifest.md)                | A place arrives as a zip with a manifest at its root                                   | accepted |

## What is decided so far

Phases 1 through 3, in the order the decisions constrain each other:

- **0001, 0002** — the renderer, and the fact that there is no grid to store. Everything
  after this is a consequence of the field being computed.
- **0003, 0004** — how that field becomes triangles, per chunk, at a chunk's own level of
  detail. 0003 carries the seam rule; 0004 carries the LOD cracks it does not solve.
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

The phases themselves are in the repository history, one commit per phase, each verified
before the next began.
