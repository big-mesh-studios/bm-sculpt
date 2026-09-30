# 0006 — The field saturates at a fixed distance

## Context

The field is folded from a base field and a list of operations (ADR 0002, 0004).
Two shortcuts are available for making a chunk's evaluation fast, and both turned
out to be wrong, in different ways and for related reasons.

**The candidate skip.** Folding an operation's distance into the field means running
its shape. Most operations cannot change the answer at most points, so each is
rejected before it is evaluated. The obvious test is "is the point inside this
operation's bounding box", and it is **unsound**: a minimum is won by the nearest
_surface_, not the nearest _box_, so a point a unit outside a box's corner can be a
unit from the shape inside it. The randomised comparison against a brute-force fold
found this immediately — a field reading −24 where it should have read −110.

The sound test is a distance rather than a box, and it needs a threshold derived from
what the boolean actually requires: an `Add` can change the result when its distance
is below `field + k`, a `Subtract` when it is below `k − field`. And since a shape is
contained in its own box, its distance is never below the distance to that box — _so
long as the point is outside it_. Inside, the box distance is zero while the true
distance can be deeply negative, which is where the first version of this test was
wrong in the other direction.

**The candidate cache.** Operations that cannot be near the query point are gathered
once per chunk rather than per sample. How wide that gather has to be depends on how
large the field can get — and the first assumption was that the field only ever
falls, since a `min` only lowers it.

That is false. A `Subtract` is a `max`, and a `max` _raises_ the field: subtracting a
shape whose distance is deeply negative leaves the field reading hundreds of units of
"outside". While the field is high, an addition a long way off can still win the next
minimum. Sizing the gather box for that meant sizing it by the largest primitive in
the model, and a model with one thousand-unit primitive then gathered the entire model
and pruned nothing — 236 of 240 operations in the candidate set, in a measurement.

## Decision

**Saturate the field at `FAR_DISTANCE` after every step of the fold**, and size the
candidate gather by a fixed margin.

`FAR_DISTANCE` is already the "nothing is near here" sentinel the fold starts from.
A value that large is not a measurement, and nothing downstream can tell the two
apart: the sign is positive either way, so the mesher finds no crossing; a picker
steps by a smaller amount, which is conservative and converges; a gradient is only
read near zero, where nothing is clamped.

With the field bounded, `threshold` is bounded, so an operation further than
`FAR_DISTANCE + k` from the query point provably cannot set the answer, and the
gather box is a chunk plus a constant.

## Consequences

**The gather box is now a constant rather than a function of the model.** Measured:
236 candidates of 240 before, and the candidate set no longer grows when a thousand
operations are added elsewhere — which is the case that matters, because a sculptor's
second hour is spent on one corner of the model.

**A field can no longer report more than `FAR_DISTANCE` of "outside".** That is a
definitional change, and it is asserted directly (`cost.test.ts`) rather than left
for a test comparing two implementations to discover. No sign moves as a result.

**A picker steps more slowly through empty space.** Stepping by at most
`FAR_DISTANCE` rather than by the true distance means crossing a thousand units of
nothing takes twenty steps instead of one. This is the cost, it is the only cost, and
a picker's reach is a few hundred units anyway.

**`FAR_DISTANCE` is now load-bearing in three places** — the initial field, the
saturation, and the gather margin — so it is a constant in `constants.ts` with its
reasoning rather than a literal in a fold.

**Not clamping would also have worked, at a cost that scales with the model.** The
alternative is a gather box sized by the largest primitive, which is exact and which
degrades precisely as a user sculpts more.

## Alternatives

**A gather box sized by the largest primitive.** Rejected: correct, and it makes a
chunk's cost a function of the whole model instead of the chunk. The whole point of
the cache is that a stroke in one corner does not make the opposite corner more
expensive to mesh.

**Sort candidates nearest-first and stop early.** Rejected for now. It is the standard
answer to this problem and it is better than both of the above — the fold converges
on the nearest operation and the rest are rejected by cone culling rather than by
box distance. It needs a sorted candidate list per _point_ rather than per chunk,
which is a different data structure, and it would make the answer depend on a sort
whose ties are a floating-point question. Worth revisiting if measurement says the
box distance is the remaining cost; for now the candidate _count_ is the cost, and
this reduces it.

**Report the field unbounded and accept an approximate cache.** Rejected: the
approximation would be invisible in review and would show up as a crack along a
level-of-detail boundary, which is the failure mode this whole design is arranged to
avoid.
