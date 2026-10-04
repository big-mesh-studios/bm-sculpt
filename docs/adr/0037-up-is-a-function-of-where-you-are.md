# 0037 — Up is a function of where you are, not a field you carry

## Context

`Player` held `yaw` and `pitch`, and the world's up was `(0, 1, 0)`. Movement turned a yaw and a
pitch into a direction, and the player's feet were `position.y`.

Every one of those four things is a flat-world assumption, and a spherical world breaks all four at
once rather than one at a time. There is no yaw on a planet — walk far enough in one direction and
you have walked over the pole and your heading has reversed. There is no pitch, because "pitch" is
relative to a horizon that is now under your feet. `position.y` is not height above ground; on a
planet it is a coordinate that means nothing on its own. And up at `(0, 1, 0)` is outward at one
point on the planet, sideways at two and inward on the far side.

The tempting fix is to add a "planet mode": a centre, and code that branches on whether the world
has one. It was tried in a scratch file and the branch count was the finding. The decision is not
where the branch goes — it is that **`Player` should never learn what a planet is.**

## Decision

**The world answers "which way is up, here", and the player carries the answer it was last given.**

`Frame` is that answer, and it is a function of position:

- `flatFrame.upAt` ignores its argument and returns `(0, 1, 0)`. Which is not a special case — it is
  what a frame of infinite radius evaluates to.
- `sphericalFrame(centre).upAt(p)` returns `normalize(p − centre)`. Which is what a frame of finite
  radius evaluates to.

`BodyBasis` is the player's copy of it, stored as `forward`/`right`/`up` rather than as yaw/pitch,
so that "which way am I facing" and "which way is down" are the same kind of question and neither is
recomputed from an angle.

**Between frames the answer is carried, not recomputed.** `carryBasis` reorients the player's basis
by the rotation that takes the old up to the new one, and does it with `Basis.turn` — an explicit
rotation — rather than by rebuilding an orthonormal basis from a direction. This is the load-bearing
part. Frisvad's `onbFromDirection` is the textbook answer and it is **not continuous**: it has a
seam where the reference vector flips, so a player walking across that seam would have their right
vector reverse in one frame. The continuity has to come from the rotation, because the rotation is
continuous by construction.

Four bugs were found by writing the tests rather than the code, and all four are the kind that look
correct:

- `reorientUp` rotated by the wrong angle — it took the angle between up and _forward_ rather than
  between up and _new up_.
- The basis was not carried each frame, so it was rebuilt from a direction and picked up the
  reference-vector seam.
- The collision footprint was built from the _body_ basis rather than the _feet_ basis, so on a
  slope the player collided with a box tilted the wrong way about the wrong point.
- Ground snapping used the sign of the movement rather than the sign of the distance, so on a
  surface that curves away from the player the snap fought the trace.

## Consequences

**Every call site that assumed world up has to be given a frame, and the compiler finds them.** This
is the main argument for the design. `getGroundDistanceAt(feet, up)` takes a direction; a caller that
does not have one does not typecheck. That is the entire defence against the alternative, where the
planet paths get written and tested and the flat paths keep working because nothing changed their
signature.

**The player's `up` is a hypothesis, and the world's is the answer.** They differ between frames by
the rotation between two world points. `GameWorld` samples the frame at the player's position, so
they agree to within one frame of travel, which at walking speed is under a unit.

**Nothing about the player knows about spheres, and the tests say so by running four worlds** — a
flat one, one whose up is `-X`, a pole, and the antipode. `player.test.ts` passes against all four
unchanged. A design that grew a planet branch would have to grow a test per branch, and the test
that would catch it is the one that runs the same code against a world where up is somewhere
unexpected.

**`Medium` keeps its scalar `pushVx`/`pushVz`/`pushVy` semantics, frame-relative.** This is the one
place where a flat assumption survived on purpose. Those three fields mean "right", "forward" and
"up" and are relative to the player's frame, so they are already correct on a planet. Converting
them to vectors is deferred to the wire-format change rather than done now, on the grounds that
doing both at once makes the diff unreadable.

**Frame radius has to answer one question** — `radiusAt(p)` — and `flatFrame` returns `Infinity`
rather than having callers special-case it. The two places that would otherwise branch are the
world bound and the sea, and both now take the answer.

**Measured:** walking 1786 units of a 4110-unit-radius surface, the player's up turned by 0.4352
against an arc of 0.4345 radians — the frame follows the surface to two parts in a thousand. The
test that asserts this also asserts the player never rose more than `stepHeight` above the ground,
because a frame that had drifted would be four hundred units up by the end of the walk. Both
numbers are in `world/planet-world.test.ts` and neither is a tolerance I chose to make the test
pass.

## Alternatives

**Add a planet mode to `Player`, branching on whether the world has a centre.** Rejected by
measurement: the scratch implementation needed a branch in movement, in collision, in jumping, in
swimming, in the camera and in every `Medium` interaction. Six branches that each need a test, for a
planet that is the only world this game has.

**Recompute the basis from a direction each frame** rather than carrying it. Rejected: it is the
seam bug above, and it is invisible until a player walks across a specific line on a specific
heading. The Frisvad construction is correct everywhere and discontinuous somewhere, which is the
worst combination for something a person is looking at.

**Keep yaw and pitch, and rotate the world under them.** Rejected: it moves the flat world's
assumptions into the player rather than out of it, and every one of them is still there. It also
puts a gimbal problem back into a design that had just removed one.

**Make `up` a getter that asks the world.** Rejected as the only option, kept as an optimisation
later. Asking the world every time `up` is read is correct but costs a `normalize` in the middle of
collision, which is the hottest loop in the player. The stored basis is the answer the world gave on
the last frame, and the two differ by less than a frame of travel.

**Interpolate the frame between two positions** rather than carrying a basis. Deferred. It is the
right answer for a camera that must not jitter, and it is not needed for a player whose movement is
integrated — carrying the rotation is already the continuous version of it.
