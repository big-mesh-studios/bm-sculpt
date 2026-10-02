# 0017 — The vocabulary is a table, and a payload is accepted whole or refused whole

## Context

A place script is code this repository did not write, running inside a peer that is trying to
render sixty frames a second. ADR 0015 settled where that code runs. ADR 0016 settled what a
place _is_. Neither says what a script is allowed to **ask for**, and that is the remaining
hole — because under the authority model a peer sends its peers _effects_, not operations,
so the thing arriving at the boundary is untrusted input from a machine the host has never
verified.

The sibling project's answer to that boundary is 92 effect tags, 23 event kinds and 97
`MAX_*` bounds across roughly 2,900 lines of validation. Most of that volume is blocky: a
`blocks` table, `block-set`, `block-fill` over a voxel grid, `block-broken` and
`block-placed` events, and a six-shape plan vocabulary to go with them. A smooth landscape
engine has no blocks and no grid — the world is one signed distance field over a list of
operations (ADR 0002, ADR 0016) — so a literal port would have been a larger, blockier and
strictly worse version of the same idea.

The question is therefore not _which_ effects but _how the vocabulary is written down_, and
the failure mode is specific: a validator built as twenty hand-written `if` chains, where
the twenty-first field gets forgotten. The symptom is not a crash. It is a field that is
silently trusted, and a peer that sends `"at": {"x": null}` gets an object where a vector
should be.

## Decision

**The rules are the definition. `parseEffect` is a function over a table, so a tag cannot
exist without being validated, and a payload is either accepted whole or refused whole.**

- **19 effects** in six groups: geometry (`shape-add`, `shape-remove`, `place-remove`,
  `place-clear`), triggers (`zone-add`, `zone-remove`), the clock (`clock-set`,
  `clock-speed`), the player (`player-place`, `player-speed`, `player-jump`, `player-fly`),
  the camera (`camera-look`, `camera-clear`), and output (`log`, `toast`, `timer`,
  `data-set`, `data-delete`). 42 fields.
- **7 events**, with a total order: `player-joined`, `player-left`, `player-died`,
  `zone-entered`, `zone-left`, `timer`, `data-changed`.
- **25 bounds**, in `limits.ts`, each with the reason it has that value.
- Each tag is declared as a list of `FieldRule`s — a kind, a bound, an `about` — and
  `fields.ts` turns that into a check. **The same table is what a generated reference
  document would be read from**, so the documentation cannot describe a field the parser
  does not check, or omit one it does.
- **An undeclared field is a refusal, not an extra.** So is a missing required one. A peer
  sending something this build cannot validate has no safe reading.
- **Events are the only thing that travels.** The operation list is recomputed on each peer
  (ADR 0016), so `events.ts` is where the determinism requirements live.

## Consequences

**A half-valid payload is refused, and that is the whole point.** A shape whose `place` and
`id` are fine and whose `at` is null must not become a shape at the origin — the author asked
for a position and did not give one, and a shape in the wrong place with no record that
anything was wrong is the worst outcome available. `parseEffect` has no partial result type,
so a caller cannot accidentally implement "apply what parsed".

**The rules table is the drift barrier.** Three failures are ruled out by construction rather
than by vigilance, and each has a test that is a _loop over the table_ rather than a
hand-written expectation per tag:

1. A tag in the union with no entry in the table — offered to a script, refused on arrival,
   with nothing in the repository saying so.
2. A field a payload may carry that nothing validates.
3. A payload that is nine-tenths valid and gets applied as far as it parses.

**Per-shape fields are checked against the shape they name, and nothing else is accepted.**
`csg/shapes.ts` has three primitives carrying different numbers — an ellipsoid a radius per
axis, a box a length per axis, a capsule a `lenX` and one radius. A checker that read all
three for every shape would accept a capsule with a `len`, and the shape would then be built
from a field it does not have, which is how a `len` of `undefined` becomes a `NaN` origin
three modules away inside the fold. So `Capsule` with a `len` is refused.

**A boolean is a boolean.** `1` and `"true"` both read as true to a truthiness check and
mean different things to the peer that sent them and the peer that did not. It is the one
field type where that is a plausible bug rather than a far-fetched one, so the `boolean`
kind rejects anything that is not `typeof === "boolean"`.

**A kind supplies a default bound and the field may override it.** `clock-speed`'s
multiplier is a clock multiplier, not a walking speed; a shared ceiling of ten would have
made a hundred-times day unreachable while `player-speed` was allowed to go to ninety. The
first version of `boundsFor` ignored the field's own `max` entirely, which made the
`MAX_CLOCK_MULTIPLIER` test fail and was a real bug rather than a bad expectation.

**The tests found three limits that nothing enforced, and one test that asserted nothing.**
Worth recording because these are the failures this design exists to prevent, arriving anyway
in the implementation:

- `fields.ts` retyped `MAX_PENDING_TIMERS` as a literal `10_000` and `MAX_PLAYERS` as `1`
  inside a `TIMER_LIMITS` / `PLAYER_LIMITS` object. The constants were exported and enforced
  by nothing. Now a scan of the source fails the build if any exported number is unreferenced.
- `MAX_ZONE_NAME_LENGTH` was exported and used by nothing: `zone-add`'s label was a plain
  `text` field, so a zone's _name_ could be longer than a name. The `text` kind now takes a
  `max` of its own.
- `MAX_STEP_MS` had **two** owners — the interpreter's `DEFAULT_STEP_BUDGET_MS` and a copy
  in `limits.ts` — with a test asserting they agreed. That was a test spent on a duplicate
  that should not have existed. The interpreter now reads its default from `limits.ts`, so
  there is one number and no test needed.
- The "accepts at the limit" test asserted only that a payload _builder_ produced a key. It
  passed for a limit enforced by nothing. It now asserts through `parseEffect`, and rows
  declare which end of the range they cover, because `MIN_SHAPE_SIZE + 1` is a perfectly
  good shape and a row that assumed otherwise would read as though the floor did not exist.

**Facts are never forgotten, so `MAX_EVENTS` is a refusal and not an eviction.** A log that
had dropped its oldest events would be a _different_ log from every other peer's, which is
the one outcome the whole design exists to rule out. Four thousand facts is a long session; a
place that needs more needs summaries, not a ring buffer.

**A zone's cap is a per-frame budget, not a memory limit.** The player is tested against
every zone once a frame, so `MAX_ZONES = 256` is what keeps a place from costing a thousand
box tests per player per frame. It is low enough that no spatial index is needed yet, which
is the honest reason for the number rather than the measurement it could be given.

**Ids are the caller's, and the host overwrites the index.** `PlaceHandle.add` assigns the
fold index and refuses an id that is already taken, because "last one wins" would let two
peers disagree about whether an id means the first shape or the second. ADR 0016's range
model could not do this at all, which is what forced the small extension to it this phase.

**A visitor with a stale build is refused rather than misread, and it is visible.** A tag or
event kind this build does not know is refused. `decodeEvents` returns how many it dropped as
well as what it kept, because "some events were refused" is never a whole bug report — and
because a version skew that is invisible is a peer whose world quietly stopped matching
everyone else's.

## Alternatives

**Port the sibling project's 92 effects.** Rejected, and not because of the count. Most of
them are about a grid: `block-set`, `block-fill` over LOD-0 voxels, a `blocks` table, voxel
DDA for `raycast`, and a six-shape plan vocabulary. This engine has no grid — the surface is
the sign of a distance field, and `raycast` is `pickAlong`, which needs no DDA and no step
cap. Porting would have produced a blockier, larger copy of a system whose assumptions do
not hold here.

**Validate by hand, in a `switch` per tag.** Rejected: it is the failure mode named in the
context. Twenty hand-written chains and the twenty-first field gets forgotten, and the
symptom is a silently-trusted field rather than a crash.

**Clamp an out-of-bounds field instead of refusing the payload.** Rejected firmly. A clamped
coordinate is a shape in the wrong place that nobody can explain; a refused effect is a
script with a bug in it and a log line naming the field and the problem, which is a bug
report a person can act on.

**Use one timestamp per peer and let arrival order settle ties.** Rejected: two events can
share a millisecond, and two producers can share an identity, so arrival order is not a total
order and two peers holding the same facts would fold them differently. `at`, then
`producer`, then `id` — the last of which is guaranteed unique, which is what makes the
comparison total.

**Make the log a ring buffer.** Rejected: see above. Eviction is silently divergent.

**Generate the `MAX_*` bounds from the rules rather than declaring them.** Rejected, and this
one is close. Deriving a ceiling from a field's _type_ cannot work — a coordinate and a
channel and a timer are all numbers, and their limits come from entirely different places
(the chunk window, a byte, a day). The bounds are therefore stated, and the test that fails
the build when one is unreferenced is what keeps "stated" from becoming "decorative".

## What v1 deliberately leaves out

Each of these is a real system this engine does not have, and each would have meant a tag
whose host side is a stub — a tag that validates, is offered to a script, and does nothing.

| Omitted                        | What would unlock it                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| figures and NPCs               | An entity model and a figure renderer. `voxelscape`'s is ~600 lines of ray-marched voxel models plus a model file format.                      |
| scripted UI, HUD, leaderboards | A HUD, which this engine has none of — the console is the only overlay.                                                                        |
| items, inventory, dialog trees | An item system and a dialog model.                                                                                                             |
| pathfinding                    | A walkable graph over the terrain. `raycast` and `zone-*` cover what v1 needs.                                                                 |
| cutscenes and camera shots     | A scripted camera. `camera-look` is the whole of v1's camera vocabulary, and it is two lines of host work.                                     |
| accounts                       | An identity system. `data-set`'s `scope` is `global` or `player` and no `account`, so adding one is a data change rather than a format change. |
| sound                          | An audio system. Nothing here plays a sound.                                                                                                   |

The omissions are what make this a _closed_ set: a script cannot ask for a thing that does
nothing, which is a failure mode worth more avoiding than the tags are worth having.

## What this does not do

Nothing here _applies_ anything. `parseEffect` returns something trusted; Phase D's host is
what carries it out. And the interpreter that will eventually produce these payloads is
still the scaffolding from ADR 0015 — the two have not been connected, and nothing in this
vocabulary knows an interpreter exists.
