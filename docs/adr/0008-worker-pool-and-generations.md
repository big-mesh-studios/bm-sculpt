# 0008 — One chunk per worker, and a generation on every request

## Context

Meshing a chunk is the expensive part of the application. Measured on the target
machine, one chunk's field sampling is **250-275 ms** (Phase 1's cost test), and the
mesher adds sampling of the padded grid on top. A viewport at a walking pace wants a new
chunk every few frames, so meshing cannot happen on the main thread, and cannot happen
one chunk at a time either.

Four workers, and roughly 34,304 field samples each in flight. The problems that follow
are not about throughput. They are about which answer counts.

## Decision

**Workers are a pool of four. Each is given one chunk at a time. Every request carries a
generation, and a reply is applied only if its generation is exactly the generation last
asked for.**

Messages are data and nothing else: `src/mesh/protocol.ts` carries no classes and no
functions, because structured clone turns a class instance into a plain object with its
fields and none of its methods — a worker handed a `Field` would hold something that looks
like one and cannot sample. The worker builds its own field from the description
(`WorkerModel`), on its own side.

The model goes out cloned and the mesh comes back **transferred**. Ownership of the mesh
buffers moves rather than being duplicated, which is why `ChunkMeshBuilder.finish` copies
to exact length rather than returning a view: a transferred view is detached in flight,
and the main thread would receive an empty array having been told the transfer succeeded.

`handleMeshMessage` is a pure function of the worker's state, the message, and an
injected mesher factory.

## Consequences

**"Exactly the generation last asked for" is the whole rule, and it is not a
conservative choice.** The looser rules each fail in a way that is hard to see:

- _Apply if at least as new._ A chunk re-requested at generation 9 comes back with 9
  while 10 is wanted, and the chunk visibly reverts for a frame. This is the failure
  everyone has seen, and it is not the worst one.
- _Apply if the cell is still in the window._ A chunk evicted and later re-entered is
  meshed again and looks correct, so nothing about it can be wrong — but if the first
  answer is applied on top of the second, a mesh for a cell that is no longer in the slot
  appears at the slot's coordinates. The window recycles slots (0005), so "still in the
  window" and "the slot still holds it" are not the same question.
- _Apply if the level of detail matches._ Both answers are correct meshes of the same
  chunk; only one is at the level asked for. The other is not wrong-looking, it is a
  correct mesh at another level, which presents as a level-of-detail bug that cannot be
  reproduced.

Counting generations rather than comparing timestamps is what makes "exactly" cheap: one
integer per cell, incremented on every request, and an equality test.

**One chunk per worker, and the reason is the model rather than the hardware.** A worker
builds its field from the last `setModel` it received, so a worker given a newer model
than its neighbour answers from a different model. One chunk at a time means a model
change cancels everything in flight, the next requests go out in order, and every worker
has converged on the newest model before any of them is trusted. A `perWorker` option was
written and removed: it contradicts that reasoning, and an option that contradicts the
reasoning is worse than no option.

**An air chunk is answered with a flag, not a mesh.** Most chunks in a terrain world are
entirely air or entirely solid. Transferring four empty typed arrays per air chunk would
be most of the traffic, and building them in the first place would defeat asking whether
the chunk needs meshing at all.

**The pool is testable without a browser, because it takes a `PoolWorker`.** Declaring
the interface the pool uses — rather than taking a `Worker` — is what lets every
staleness rule be tested by delivering answers by hand. The failures above are all about
_when_ an answer arrives relative to a later request, and a fake that answered
automatically could not express any of them. For the same reason the worker's own logic
lives in a pure `handleMeshMessage` rather than in the message handler: a `Worker` cannot
be inspected or asked questions, and none of that logic is worth being unable to test.

**Sending the model to every worker on every edit is O(operations) per keystroke.** The
operation list is serialised once and cloned per worker, which for a few hundred
operations is well under a millisecond, and it happens only when the model changes
rather than per chunk. Transferring it instead would detach the main thread's copy. If
this ever becomes hot the answer is a second revisioned message carrying only the
operations that changed, keyed by revision — not a shared field, which is not possible.

## Alternatives

**A worker per chunk, or an unbounded number of requests in flight.** Rejected. It makes
the model-convergence problem worse — more workers to re-converge after every edit — and
buys nothing, since meshing is CPU-bound and four workers already saturate four cores.

**`SharedArrayBuffer` for the operations.** Rejected. It needs a cross-origin isolation
header, which is a deployment constraint, and it does nothing for the mesh: the mesh is
already transferred, and the operations are a small part of the work.

**WebAssembly.** Not rejected, and not built. `ChunkMesher` is the seam it would come
through, and the protocol deliberately carries nothing a WASM implementation would be
missing. Built if profiling says the TypeScript mesher cannot hold the budget; not before,
because it would add a build step and a second copy of the field's arithmetic to maintain
against a target machine where the arithmetic is currently fast enough.

**A `Worker` per chunk, recycled by a free list.** Rejected as the same thing as the
first item, with the added cost of a worker spawn per chunk.
