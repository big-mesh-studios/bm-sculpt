# 0016 — A place is a named group of operations, and `flatten` is the only fold order

## Context

Everything in this application that reads the world reads one thing: a list of
operations, folded into a single signed distance field. The mesher evaluates it, the
picker traces it, the player collides with it, and ADR 0009's entire point is that they
cannot disagree. That is a good design and it is not what constrains places.

What constrains places is that `Operation` has exactly one field for identity, and it is
`index` — a number meaning _position in the fold_ and nothing else. There is no name, no
owner, no parent, no tag. So the questions a place has to answer were all unanswerable:

- **"Which operations did the script make?"** There is no way to ask.
- **"Load a second place."** The only way in is `SculptDocument.add` and the only way out
  is undo, which is a stack rather than a name. A second place either lands on top of the
  first or destroys it.
- **"Undo must not remove the bridge."** `document.undo()` pops the last command. With a
  place's two thousand operations on that stack, one ctrl-z either deletes the entire place
  or — worse — is blocked, because the top of the stack is geometry the user never made.

ADR 0015 settled where a place's _code_ runs. This settles what a place _is_, and it had
to come second: every handle, every effect and every event needs an owner, and nothing
could be written before one existed.

## Decision

**A place owns its own `Operation[]`. `PlaceRegistry.flatten` sorts them, together with
the document's, into the one list every reader uses. `flatten` is the only place the fold
order is decided.**

- `src/places/place-registry.ts` holds the places. It does **not** hold the document — it
  takes the document's list as an argument, because the document is the _other_ kind of
  owner and this is a place's registry. Making it represent both would mean neither could
  change without it changing.
- The session builds the registry over **its own** `document.order`, so the two allocate
  fold indices from one counter. See the consequence below; this is not incidental.
- `flatten` sorts by index rather than concatenating, and it is the only reader's entry
  point. Four call sites in `sculpt.ts` — the main thread's field, the model sent to the
  workers, the live preview, the discarded-stroke rebuild — all go through one
  `model()` method, which is the fix for ADR 0009's invariant having four independent
  copies of it.
- A place is **not in the history**. Its operations never enter `document.undoStack`.
- A place's name is **supplied by the caller and never generated**. So is its index.
- `MAX_OPERATIONS_PER_PLACE` is 2,000, refused rather than truncated.

## Consequences

**A place cannot be reached by undo, and that falls out of the design rather than being
enforced by it.** The operations live in an array the document has never heard of. There
is no guard to forget and no interaction to get wrong between two history systems — which
is the actual argument for this shape over a place-as-a-range, where the range _would_ be
on the undo stack and every interaction between the two would be a case to think about.

**The document's length stopped being the next fold index, and that broke the brush.** A
stroke used to take `document.count` as its base (`src/edit/brush.ts`), which is only the
next index when the document is the only thing allocating. The moment a second thing
allocates, a place created after the first hundred operations hands out index 100 while
the user's hundred-and-first stroke hands out the same one. The fix is one shared counter,
`src/edit/fold-order.ts`, and every owner asks it. Two operations sharing an index is
invisible in review and quietly changes the surface, because the fold combines with a
smooth minimum — symmetric, not associative — so the order _is_ the surface.

**`flatten` sorts, and the first version concatenated, and that was wrong in a way the
first test missed.** Concatenating document-then-places looks obviously right: the
document came first, so it folds first. It breaks as soon as a place keeps building. The
place then sits at the _end_ of the list holding indices _above_ the document's later
ones — and two things read this list and want different orders:

- The **fold** runs over candidates `bvh.ts` sorts with `byIndex`, commented "List order,
  which is the order the fold has to run in". So the fold order is **index** order,
  whatever `flatten` returns.
- **Paint resolution** — `bvh.evalPaint` walks `this.all` in plain list order and takes
  the last writer. So `flatten`'s order is what decides which paint wins.

Concatenation made those disagree, and the disagreement only shows up once a place builds
twice: the surface folded chronologically while colour resolved by owner, so a user
painting over a script's painted wall lost because the script's operations came later in
the list despite having been made first. Sorting makes list order and index order the same
order. The test that catches it is
`place-registry.test.ts`'s "resolves paint in fold order", which is built so the two orders
give opposite answers — it fails on the concatenating version and passes on this one.

**Sorted rather than merged, because each source is usually sorted but not always.**
`SculptDocument.add` trusts its caller's indices, so a deserialised model appended to a
non-empty document can arrive out of order. Sorting makes the invariant hold regardless of
what a caller passed, and `Array.prototype.sort` has been stable since ES2019, so equal
indices still resolve identically on every peer. The document goes in first and places
follow in creation order purely so that _equal_ indices have a defined winner — which is
also chronological, because `FoldOrder` hands indices out in the order things are made.

**A recreated name folds last, not back where it was.** An index must never be reused, so
a place cannot return to a position whose indices its predecessor already spent.
Restoring the position would change the surface rather than reproduce it, silently.

**`MAX_OPERATIONS_PER_PLACE` is 2,000, and it is measured rather than guessed.** The
question is what one chunk's 39,936 field samples cost, and what drives that is _how many
operations overlap the chunk_ rather than how many exist — so the sweep packs every
operation inside the sampled region, which is the worst a place can be. Run on its own:

| operations              | ms        | ratio to a session's worth |
| ----------------------- | --------- | -------------------------- |
| 310 — a session's worth | 144       | 1×                         |
| 1,000                   | 637       | 4.4×                       |
| **2,000**               | **1,218** | **8.5×**                   |
| 4,000                   | 3,893     | 27×                        |
| 8,000                   | 10,855    | 75×                        |

Superlinear, about n^1.3, because the candidate set per sample grows with the cluster.
Two thousand is the last round number inside `csg/cost.test.ts`'s ceiling and the first
over it, so the boundary is not a matter of taste.

**The test that holds the limit asserts a ratio, not a wall clock, and warms up on a
fraction of a sweep.** Both are corrections worth recording, because the first version of
each failed.
same sweep takes about a second alone and **3.5 seconds** as part of the full suite, where
every file runs in parallel, against a 2.5 second ceiling — so a time-based assertion was
measuring the runner's willingness to serve threads, which is precisely what
`csg/cost.test.ts`'s own comment warns about. Both numbers now come from the same run, so
the machine's mood is in both and the quotient is stable where neither absolute is. The
ratio straddles the threshold usefully: 2,000 is about 7–8× and 4,000 is about 27×, so
raising the limit without measuring is a failing test rather than a slower world nobody
notices until they are holding a phone.

And the sweep warms up on four layers rather than the whole chunk, which halves a test
that was the densest CPU consumer in the suite. That is not tidiness: with the full
length, `world/cloud-bake-client.test.ts` — timing-sensitive, and running in parallel
with this — timed out at vitest's 5 s default in two suite runs while passing in isolation,
and passed in nine consecutive suite runs once the sweep was halved. A test's cost is paid
by its neighbours, which is the same lesson the ratio is.

**A place cannot reliably carve into a stroke made after it was created — actually it can,
because of the sort, and that is the better answer.** Had flatten concatenated, a place's
later operations would have folded _before_ the document's later ones and a script could
never carve into anything the user did afterwards. Sorting makes the fold chronological,
so it can. The cost is that "creation order" is no longer by itself the fold order, and
the only thing keeping that honest is `FoldOrder` being the single allocator.

**A refused operation is not a silent one.** `PlaceHandle.add` returns undefined at the
limit and `full` reports it, so the host can name the limit and stop. A truncated place
would be a world with a missing bridge and nothing to say why.

**Two operations a script draws now cost what the mesher costs to evaluate them, and the
editor pays for the registry's existence.** `flatten` is one array copy plus one sort per
commit — nothing next to `OperationBVH.set`, which rebuilds its whole tree on the same
call. With no places registered it returns the document's own list untouched.

## Alternatives

**An `owner: string` field on `Operation`.** Rejected. It costs a string reference on
every operation for the process's lifetime, on a field the fold never reads and the BVH
never indexes; it forces `FORMAT_VERSION` 1 → 2 and a migration decision for a field
nothing consumes; and it would have to survive `deserialiseOperations`, which reads a
fixed-width record with no room for it. Ownership that is structural rather than stored is
free here, and the price is only that this ADR exists.

**A place as a contiguous range in the document's list.** Rejected, and this was the
closest call. It reuses `document.add`, `Range` and range-based undo exactly as they are,
and adds no file. It breaks the moment a place grows _between_ two hand edits: its
operations are contiguous only within one `add`, so a script building over several ticks
would interleave with the user's and stop being addressable. It also puts every place on
the undo stack, which is the ctrl-z problem above, and it cannot express "this place is
empty right now but still exists".

**A `Field` and a BVH per place, composed with a boolean.** Rejected. It is the most
powerful of the three — per-place LOD, per-place culling, and a place could be streamed
separately from the document — and it is also a real change to `foldOperations` and to
`Field`, which `README.md` calls "the one piece of arithmetic that has to be exactly
right". Nothing in a place needs it yet: a place's geometry is in the same field as
everything else, which means the picker, the collision and the workers already see it with
no work at all. It is the right answer if places ever need to cost less to stream than the
document, and it should be revisited with a measurement then.

**Nested places, or a place containing places.** Rejected as premature. Nothing in v1
needs it and it multiplies the fold-order question by every ancestor.

**A place per document — give every place its own `SculptDocument`.** Rejected: undo is
on the document, so this would give every place its own undo stack and reintroduce the
ctrl-z problem with extra steps.

## What this does not decide

Nothing here runs a script. `PlaceRegistry` is the noun a script's effects will land in
and nothing in it knows an interpreter exists; ADR 0015's sandbox is still scaffolding
under `src/places/interpreter.ts`. The effect vocabulary, the guest API and the bundler
are the work after this, and the next decision among them is what a script is allowed to
ask for — which is bounded by `MAX_OPERATIONS_PER_PLACE` and therefore by the table above.
