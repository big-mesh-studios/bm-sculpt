# 0031 — The nearest surface carries a point's colour, not the last one in the list

## Context

ADR 0028 decided that a colour is a property of an `Operation` rather than only of a `Paint`, and
that a point's colour is resolved by `OperationBVH.evalPaint`. It carried one sentence about how
the operation is chosen:

> So "last writer wins" was not a choice to revisit — it was what the original did, and it is the
> right answer for parts of a figure: a red sphere and a blue sphere overlapping should stay red and
> blue rather than go purple.

The rule that went with it was faithful to what ADR 0028 was porting from — `randoms-3d-paint`
evaluates `if (sdf <= 1.0) colour = op.colour` — and a faithful port of a reach is a reach:

```ts
if (operationDistance(indexed, { x, y, z }) <= 1) {
  found = { colour: operation.colour, opacity: operation.opacity };
}
```

The premise underneath it was never tested: **the reach is one world unit, and that is a fraction of
a landscape and the whole of a figure.** In `sdf-modeller`, parts are about a unit across. So
"within a unit of the point" was "within the model", every coloured part in a model satisfied it, and
the last one in the list answered for all of them.

A red sphere of radius 0.7 with a blue box 1.2 units beside it came out **entirely blue** — every
vertex, including the far side from the box, two units away. The model was one colour.

## Decision

**Among the operations near enough to have a say, the one whose own surface is closest takes it.**

The reach stays and stays at one. It is now doing one job instead of two, which is what it was never
fitted for: rejecting a query that is nowhere near any shape, so the caller falls through to a paint
tile and then to a default. It no longer decides _which_ of the near operations wins.

**Ties go to the later operation**, so two coincident surfaces still resolve in list order and the
answer stays deterministic. That is the case ADR 0028's example is actually about, and it is the case
its test in `apps/bm-sculpt/src/places/place-registry.test.ts` uses — two boxes at the same origin
with the same size, which are as near each other as two things can be.

## Consequences

**The reach is no longer load-bearing, and that is the whole fix.** A mesher's vertex sits on the
crossing it was interpolated from, so the operation that owns a vertex is at distance exactly zero and
nothing can beat it — however large the model, however late the other shape appears in the list.
This is why the constant can remain an absolute `1` without needing to become a fraction of the voxel
size: there is no longer a scale at which it changes the answer.

**Two comments in `bm-sculpt` were claiming a rule that had stopped being true** and are corrected in
place. `place-registry.ts` said `evalPaint` "walks `this.all` in plain list order and takes the last
writer", and its test said the surviving colour is "a direct read-out of the order `flatten`
returned". Both are now stated as what is true: list order settles colour between _coincident_
surfaces, which is what that test builds, and which is what the flattening decision is about.

**Every existing colour test still passed, and every one of them was wrong about scale.** The suite in
`packages/csg/src/field.test.ts` works in boxes with half-extents of 25 and 50 and points 40 and 200
units out. Nothing in it is a figure. The two new tests are the first colour assertions in the
repository written at a model's own size, and they are the ones that failed before the change.

**The old rule was not arbitrary — it was the right rule for a landscape.** A streamed world samples
voxels at `VOXEL_SIZE`, so a vertex is within half a voxel of the surface, and the reach existed to
bridge that gap. At that scale one unit is comfortably larger than a voxel and no shape's reach
overlaps another's. The rule degraded quietly as the applications' scales diverged, which is the
failure mode of a constant that means "roughly one voxel" in one application and is copied into
another where it means "the entire subject".

**A union of two touching coloured shapes now has a boundary decided by distance rather than by list
order.** Where two surfaces are a hair apart — a soft join, or two shapes meeting — the colour can
change from one vertex to the next, where before the later shape took the whole run. That is the
correct reading: those vertices _are_ closer to the other shape. It is also a visible difference, and
someone who wants a hard split between two touching parts gets it by making them `Subtract` or by
leaving a gap, not by their order in the list.

## Alternatives

**Make the reach a fraction of the voxel size, and keep last-writer-wins.** Rejected, and it is the
change that looked obvious. It would have fixed the modeller — a reach of a quarter unit excludes the
neighbouring box — and left the rule wrong: it still lets a _nearer_ colour lose to a _later_ one, so
an enclosing solid repaints everything inside it, and two parts of very different sizes take their
colour from whichever the list says last rather than from whichever surface you are looking at. The
reach was never what was wrong.

**Pass the reach in from the mesher, which knows its own sample size.** Rejected as unnecessary once
the nearest rule was in place, and it is worth saying why rather than leaving it unremarked: it would
also have broken every existing test, because those tests query _interior_ points and a tight reach
finds no colour there. Interior points do not have a well-defined colour — the function answers at
surface points — so those tests were pinning behaviour that only a loose reach could produce.

**Give every operation a colour boundary and resolve it in the fold, so a blend region's colour comes
from the operations that made it.** Rejected as a much larger change to a shared package for a bug
that a comparison fixes. It is the right design if soft colour blending is ever wanted, and ADR 0028
explicitly says it is not: `Paint` does not blend, it overwrites.
