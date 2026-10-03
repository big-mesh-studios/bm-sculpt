# 0027 — The modeller is a flat list of placed primitives, meshed not marched

## Context

M1–M3 built the parts: five libraries that know about geometry and no chunk size, a
primitive table with nine shapes, and the mobile rules. None of it was used by a second
application, which means none of it was _tested_ by one — a library that only its first
consumer exercises is a library whose second consumer finds the gaps.

`sdf-modeller` is the second application, and its scope was fixed before it was written: a
figure editor built from the primitive table, rendered with Surface Nets, working on a
phone. Four things about that are decisions rather than consequences.

## Decision

### A flat list of parts, each one placed, unioned

**Every part is one placed primitive and the model is the union of all of them.** No
hierarchy, no pivots, no motions, no extrusion, no revolution.

Each omission is a piece of work rather than a setting, which is why they are absent rather
than disabled. The extrusion case is the clearest: an extruded prism is a rounded box minus
two half-spaces, so it is _one subtraction_ away and was still left out — because
`Combine` would then be saying something, and a union-only model cannot express it.

### The transform is a position and an orientation, not a matrix and not Euler angles

**`origin: Vec3` and `orientation: Quat`, because that is already what `Operation` is.**
The CSG fold evaluates a shape in the primitive's own frame by rotating the sample by a
cached conjugate; the file format writes both fields; `shape-add` already accepts an
orientation from a place script. A second representation here would mean a conversion at
the seam, and the seam is where a part's rotation quietly stops being a rotation.

**The panel reads Euler angles out of the quaternion rather than storing them beside it.**
The usual arrangement — keep angles in the model, build a quaternion from them — has the
property that the two representations disagree after any sequence of rotations that does
not commute, which is every sequence a person performs. Here the model holds the
quaternion and the panel asks it what the angles are, so the number on screen is always the
number in the model. `fromEuler` composes **Y-then-X-then-Z**, and the panel composes from
the _displayed_ angles rather than the stored ones, so setting yaw then roll gives the
roll that was asked for rather than one that depends on the order the fields were typed in.

**The capsule's axis change from ADR 0025 is what makes rotation load-bearing rather than
optional.** Every axial primitive runs along Y, so a capsule is a standing limb until
something rotates it. A position-only panel could not build a figure lying down.

### Meshing on a timer, not per edit

**Meshing is tens of milliseconds and a drag sends a change a frame.** The rebuild is
debounced at 90 ms, so a drag shows the model updating a few times a second. The mesh is
the _result_ of the model and never the model, so a mesh a few tens of milliseconds behind
is a picture that is briefly late rather than a state that disagrees with itself.

Two things keep it affordable. **The sample count is derived from the model's own bounds**
rather than fixed, so a small model is not sampled at a large model's resolution — and the
spacing comes from the longest axis, so the cells stay cubic. **The spacing is clamped at
both ends**, and the ceiling is the interesting one: a forty-unit capsule at a quarter-unit
voxel asks for 166 samples, the budget says 96, and the figure is built at the coarser
spacing rather than not at all. A test asserting the _requested_ spacing failed and was
wrong to: the clamping is the feature.

### The camera is written again rather than shared

**The two applications have no camera in common.** The landscape orbits a point 900 units
above an infinite world with a pitch limit and a pan; this orbits a model a person is
holding, which needs a radius measured against the model's own size and a target that is
the model's centre. Sharing one controller would mean a `minRadius` and a `radiusAtZoom` in
its options — the shape of a file split for tidiness rather than because it was the same
thing.

**And `packages/ui`'s `pointer()` is deliberately not used for it**, for the reason ADR 0026
records: the camera needs its own map of pointer ids to _element-local_ positions to
measure a pinch, and `pointer()` follows one pointer per call and reports client
coordinates. Swapping it would replace a correct multi-touch implementation with a
single-pointer one that has to be bent.

## Consequences

- **The nine primitives are reachable from a UI, which is the first thing to have tried
  them all.** A table entry that no caller has used is an untested claim, and six of the
  nine were exactly that. The picker is a flat list of nine buttons, one column on a phone
  and three on a wider screen — three rows of three would give each button under 44px on a
  narrow panel.
- **Undo is a command with an explicit inverse, and the tests found a real bug in it.** The
  first shape of it was a command returning its own inverse, which loses the original as
  soon as it is called — you can undo but not redo. The second had `apply` and `invert`
  backwards for _removal_, so undoing a removal removed it again. Both compiled; both were
  caught by a test that asserted on the parts list rather than on a return value.
- **A removed part is restored at its old index, captured when it was removed.** Looking the
  index up at restore time answers −1, because the part is gone, and appends. For a union
  that is invisible — which is why it is worth the line, and why the test asserts on order
  rather than on contents.
- **Nothing is shared with the landscape that could have been.** Both applications build
  their own viewport, their own orbit camera and their own rmsl geometry from a packed mesh.
  That is three copies of about fifty lines each, and it was chosen over a package that
  would exist to wrap three calls and would give `packages/meshing` a renderer dependency
  it deliberately does not have (ADR 0024).
- **The application is 33 tests and about 1,200 lines of source.** The tests are the model,
  the meshing and the store — the three parts with decisions in them. The panels have none
  yet, which is the honest gap and the obvious next thing to write.
- **The Pages workflow now copies two applications into one site**, the modeller in a
  subdirectory, which works because both are built with `base: "./"`. The alternative — a
  site per application — is recorded in the workflow as the line to move if either grows
  routing or needs an independent deploy.
- **`pnpm dev:sdf-modeller` now resolves.** It has been a script filtering on a workspace
  that did not exist since M1, which ADR 0024 recorded as a deliberate broken script that
  would be right in this phase.
