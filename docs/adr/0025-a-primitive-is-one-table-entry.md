# 0025 — A primitive is one table entry, and the capsule points up

## Context

M2 exists because the second application was going to need six primitives the first one
has never heard of, and `packages/sdf` had no way to describe them.

What it found on the way was worse than the estimate. **Seven places in this repository
knew what a primitive was**, and every one of them was an exhaustive switch over
`shape.type`:

| #   | Place                                                                    | What it knew                               |
| --- | ------------------------------------------------------------------------ | ------------------------------------------ |
| 1   | `sdShape`                                                                | the signed distance                        |
| 2   | `shapeHalfExtents` in `csg/operations.ts`                                | the AABB the BVH indexes by                |
| 3   | `readShape` / `writeShape` / `shapeParameterCount` in `csg/serialise.ts` | the file format's bytes                    |
| 4   | `checkShape` in `places/fields.ts`                                       | what a script is allowed to ask for        |
| 5   | `SHAPE_TYPES` in `places/fields.ts`                                      | which primitives exist, for the vocabulary |
| 6   | `shapeHalfExtentsOf` in `edit/document.ts`                               | the AABB again, for edit invalidation      |
| 7   | `PlaceShape` in `places/guest/place-api.ts`                              | the shape type every place author writes   |

Entry 6 was the interesting one, because its comment argued _against_ fixing it. It said a
table there would be "a second place to update when a shape is added and the wrong place to
be wrong: the invalidation box would be too small and the edit would only half appear." The
reasoning was correct and the conclusion has since inverted — but the entry was a
**duplicate**, not a table. It was not merely a second place to remember; it was a second
place whose error mode is _silent_. A half-extent box that is too small does not throw, and
does not fail any existing test. It makes one edit, for one primitive, on one axis, half
appear.

Two of the seven were invisible in a different way. `SHAPE_TYPES` and the `about` string on
the `shape` field were prose: a list of primitive names written out in a string, where no
compiler looks. The second one is the more interesting, because it is the text a place
author reads. `"a primitive: Ellipsoid, Box or Capsule"` was true when written and became a
lie the moment the table gained six entries, and nothing failed.

**The capsule was also specified against its own world.** It was `lenX`, along X, in a
repository where `updatePlayer` integrates `gravity` onto `vy` and "up" is positive Y
throughout `player.ts`.

## Decision

**`PRIMITIVES` in `packages/sdf` is the only list of primitives, and adding one is adding
one entry.**

Each entry carries four things: its type name, its file-format byte, its parameter names and
arities, its half-extents, and its distance function. Four more things are _derived_ from
those rather than written a seventh time:

- the parameter count the file format needs,
- the reader and the writer, which walk the parameter list,
- the script validator's field checks,
- and the names a script may use, including the prose that documents them.

The derived list is the point. Adding a primitive is one entry, and the compiler then reports
every file that needs to learn about it.

### Nine primitives, all closed form

Sphere, Ellipsoid, Box, RoundBox, Capsule, Cone, Cylinder, Torus, HexPrism.

**Closed form only, and that is a limit rather than an accident.** It means meshing can walk
a gradient to the surface, and a primitive costs the same wherever it sits in the fold — no
marching, no precomputation, no dependence on a chunk's resolution. It also means **no
extrusion and no revolution**, which is what a modeller reaches for first and what this table
does not have. An extruded prism is a rounded box minus two half-spaces, so it is one
subtraction away and was left out rather than smuggled in as a special case.

**Plane is not a primitive either, and for a different reason: it cannot be indexed.** An
infinite shape has no AABB, and every other primitive here is indexed by one. A plane belongs
on the `BaseField` seam — `fold(operations, p, baseField(p))` — which already exists and is
already how the landscape gets its ground.

### One word, `len`, and one axis, Y

An axial primitive takes `len` as a **number along its own axis**, and that axis is **Y**.
`Box` takes `len` as three numbers; the asymmetry is deliberate, because an axial primitive's
cross-section is round and a second length would be a number that has to be kept equal to the
first.

**The axis is a decision, not an observation.** Every axial primitive added here would
otherwise have had to remember which way round it was — a detail a modeller author cannot be
expected to hold, and one that would have been wrong for the only world this repository has.
`capsule`'s `lenX` became `len` along Y, and `PRIMITIVES.test.ts` has one test that fails if
that convention moves.

### The format version went to 2

**Because six primitives need type bytes version 1 did not have, and because the capsule's
axis changed.** Reading version 1 bytes as version 2 would put a capsule's length where its
radius was, so the reader refuses the version rather than trying to notice.

The three original primitives **kept their bytes** — Ellipsoid 0, Box 1, Capsule 2 — which
the table's test asserts. That does **not** make a version 1 file readable: a version 1
operation is 34 or 30 bytes depending on its shape and a version 2 one is 40 or 36, so the
counts disagree and the reader refuses before it reads an operation. Keeping the bytes means
a reader can be told what the numbers meant, not that the files are interchangeable.

### `exact: true` on eight entries and `false` on one

**The table is entirely closed form, and "closed form" is not "exact".** `sdEllipsoid` is an
approximation, so its entry says `exact: false`, and the flag is there for a second
application that sphere-traces rather than meshes.

The old code claimed this approximation's shortfall was "bounded by `ellipsoidError`", and
`ellipsoidError` **did not exist** — a dangling reference in a comment that had been there
longer than the package. Rather than invent a number, the two properties that actually matter
were measured and are now asserted:

- **Its zero set is the exact ellipsoid surface**, to 2.7e-15 — nine orders of magnitude below
  the f32 epsilon the field is stored in. The surface is in exactly the right place.
- **It never over-reports the distance to that surface, along any ray.** Worst over-report
  across eccentricities up to 500:1 is exactly zero.

Those are the properties meshing and tracing both need: the surface is right, and the number
is a lower bound, so a tracer may take more steps than necessary and can never step through a
surface. **Its error far from the surface is unbounded in relative terms**, which is the
constraint a future raymarcher inherits, and it is why the gradient test measures 0.948 where
an exact distance gives 1.000 — a 5% error in where a mesher places every vertex on an
ellipsoid.

### A torus is not star-shaped, and `exact: true` does not mean it is

**The torus has a hole, so a ray from its centre meets its surface twice.** That is not a
defect for meshing or for picking — the field is evaluated pointwise and the surface is the
zero set — but it means `exact: true` cannot be read as "safe to sphere-trace from anywhere".

This was found by a test that asserted something true and slightly wrong: that every ray from
the origin crosses zero exactly once. It holds for eight of the nine. It is now asserted for
eight of the nine **with the ninth named in the test**, and the torus is checked instead by
its exact surface points, which it has a closed form for. A fact written as a comment is a
fact that rots; a fact a test has to opt out of is a fact that gets looked at.

### The transform was already there, and this record says so

It is worth being explicit, because it looks like the thing M2 changed and it is not.
`Operation` has carried `origin: Vec3` and `orientation: Quat` since before the places layer,
`operationDistance` rotates by a cached conjugate, `shape-add` takes an optional
`orientation` quaternion, and the file format persists `orientation x, y, z, w`. **The
primitive's local frame has always been rotatable; the capsule's axis was simply pinned to a
fixed direction, and pinning it to Y is a convention rather than a limitation.**

## Consequences

- **Six places became table reads, and a seventh — a duplicate — was deleted.** The app's
  `shapeHalfExtentsOf` is now a one-line call into `sdf`.
- **`PlaceShape`, the type every place author writes, is derived from the table.** It is a
  mapped type over `PRIMITIVE_NAMES`, so a new primitive is available to every script with no
  edit to `place-api.ts`. The guest library imports `PRIMITIVES` **as a type only** — a value
  import pulled the whole table into every place's bundle to read nine field names, and
  `bundle.test.ts`'s "requires nothing" assertion caught it.
- **A new primitive is one entry plus the tests in `PRIMITIVES.test.ts`,** which are written
  against the whole table rather than against named shapes: one crossing per ray, a unit
  gradient, never over-reporting, the surface inside the reported half-extents, a degenerate
  size staying finite, and a round trip through the flat parameter list. Each asserts **a
  count**, so a primitive with no coverage fails rather than passing vacuously.
- **The half-extent test caught a real bug that was mine.** `sdCone` had the base radius at
  the top of its slant segment instead of the bottom — a cone that was upside down, still
  negative inside and still zero on _a_ surface, and wrong everywhere else. Its error was
  `0.703` on the gradient test and `1.446` on the half-extent test. **A hand-checked cone
  would have passed everything except these**, which is the argument for testing the table
  rather than the entries.
- **The hex prism's `radius` is the circumradius, and that was nearly the other way round.**
  A hexagon is built from its distance to a _flat_, so the construction wants an inradius; a
  caller who asks for `radius: 2` means two units to a _corner_, because that is what they
  drew. Passing the circumradius where the construction wants the inradius gives a prism 15%
  larger than asked for — wrong in the direction nobody notices, because a slightly large
  shape still joins up with its neighbours.
- **`OperationShape` grew from three variants to nine,** so every exhaustive switch over it
  became one. `bvh.test.ts`'s surface-point helper had an `else` that meant "not an ellipsoid
  and not a box, so a capsule"; with nine primitives that would have silently measured six new
  shapes as capsules. It is now an explicit `switch` whose `default` is empty and visible.
- **`serialise.test.ts` stopped comparing parameters by hand.** It had a two-branch
  conditional — a capsule's scalars, everything else's three axes — which was correct for three
  primitives and would have fallen through to the vec3 branch on a torus, reading `radius` off
  a shape that has `minorRadius`. It now flattens both sides through `parametersToFloats` and
  covers all nine without knowing how many there are.
- **The suite is 1463 passing with 3 expected failures, from 1444.** Nineteen added, none
  removed: 16 in `sdf` for the table, 3 in `csg` for the format. Four of the `sdf` tests are
  corrections to existing ones — the capsule's four pre-M2 tests were written for an X-axis
  capsule and were _moved_, not weakened, and one of them ("a capsule of zero length is a
  sphere") had to stop asserting floating-point equality, because clamping a zero length up to
  `MIN_RADIUS` leaves the segment a half-length of `MIN_RADIUS / 2` and the disagreement with
  a true sphere is 2.45e-4. It now asserts that bound, which is more useful than the equality
  it replaced.
- **The mesh cost of a chunk did not change.** The fold calls the same `sdShape` through one
  extra property read per candidate, and `cost.test.ts`'s ceiling is a ratio rather than a
  wall clock, so it is the test to watch if that is ever in doubt.
