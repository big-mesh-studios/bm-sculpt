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

| #                                                               | Decision                                                       | Status   |
| --------------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](docs/adr/0001-rmsl-over-three.md)                        | Render with `@random-mesh/rmsl`, not three.js                  | accepted |
| [0002](docs/adr/0002-computed-field-never-stored.md)            | The field is computed from an operation list, never stored     | accepted |
| [0003](docs/adr/0003-surface-nets.md)                           | Surface Nets per chunk, not marching cubes                     | accepted |
| [0004](docs/adr/0004-csg-per-chunk.md)                          | Each chunk evaluates the operation list at its own LOD         | accepted |
| [0005](docs/adr/0005-streaming-shape.md)                        | Slot-indexed flat arrays and a coordinate map, not a keyed map | accepted |
| [0006](docs/adr/0006-field-saturation.md)                       | The field saturates at a fixed distance                        | accepted |
| [0007](docs/adr/0007-window-presence-and-lod-reset.md)          | Invalidating a slot invalidates what a query may read from it  | accepted |
| [0008](docs/adr/0008-worker-pool-and-generations.md)            | One chunk per worker, and a generation on every request        | accepted |
| [0009](docs/adr/0009-picking-and-history.md)                    | The picker and the mesher read one field, and edits undo       | accepted |
| [0010](docs/adr/0010-suspend-the-pointer-lock-not-the-input.md) | Suspend the pointer lock, not the input                        | accepted |

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

**Superchunk membership is deferred from phase 4.** ADR 0007 named it, and rmsl's
`Mesh.drawRange` is built for it — several meshes sharing one uploaded geometry, each
drawing its own run of indices. It is not built yet, and the reason is that its benefit is
unmeasured: nothing was on screen until this phase's last commit, so there is no count of
draw calls to reduce. Merging is an optimisation, and it costs a second code path — merged
and per-chunk — that doubles what has to stay correct. It should be built against a
measured number, not against an expectation, and the number is now obtainable.

The phases themselves are in the repository history, one commit per phase, each verified
before the next began.
