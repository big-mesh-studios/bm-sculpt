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

| #                                                    | Decision                                                       | Status   |
| ---------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](docs/adr/0001-rmsl-over-three.md)             | Render with `@random-mesh/rmsl`, not three.js                  | accepted |
| [0002](docs/adr/0002-computed-field-never-stored.md) | The field is computed from an operation list, never stored     | accepted |
| [0003](docs/adr/0003-surface-nets.md)                | Surface Nets per chunk, not marching cubes                     | accepted |
| [0004](docs/adr/0004-csg-per-chunk.md)               | Each chunk evaluates the operation list at its own LOD         | accepted |
| [0005](docs/adr/0005-streaming-shape.md)             | Slot-indexed flat arrays and a coordinate map, not a keyed map | accepted |
