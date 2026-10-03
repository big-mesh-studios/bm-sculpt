# 0022 — A field is a box that moves the player, and the physics was already there

## Context

ADR 0020 closed out the places track with one gap left on the list: `getMediumAt`, one of the
three queries the reference has and this engine did not. The other two — `getSeatYawAt` and
`getSurfaceVelocityAt` — needed figures and moving surfaces respectively, and were deferred to the
props phase.

The plan for this was the obvious one and it was wrong in an interesting way.

## The discovery

**`PlayerWorld` has declared `getMediumAt`, `getSeatYawAt` and `getSurfaceVelocityAt` since before
the places layer existed, and `updatePlayer` consumes all three.** `src/player/player.ts:83` declares
the medium hook; `src/player/player.ts:590` reads it once a frame at the player's centre and
applies `speedScale` to the horizontal target, adds `pushVx`/`pushVz` to it, and in the vertical
branch ramps toward `pushVy` and clamps the fall to `sink`. The `Medium` interface is right there
with all five fields and a doc comment on each.

`GameWorld implements PlayerWorld` and supplied none of them. So the physics half of this phase was
not to be written — it was to be **connected**. The other two hooks are the same story: waiting for
props, which is why they are still empty.

## Decision

**A medium is a host-owned box, and the three links between it and the physics are each a function
rather than a stored collection.**

- **`HostMedium` is a re-export of `player.ts`'s own `Medium`**, for exactly the reason `HostClock`
  is `ClockCommands`: a second declaration would be a second thing that has to agree with the first,
  and a stub shaped like a copy would compile happily while proving nothing. One type, and the
  compiler checks that the host produces what the physics consumes.
- **`GameWorldOptions.mediumAt` is a reader, not the fields.** `Game` builds its `GameWorld` in its
  constructor and the place host does not exist until someone types `/place:load`, so the world is
  handed a function that reaches into the host when asked. **It is read fresh every call**, because a
  place adds and removes fields while the game runs and a world holding a snapshot would keep
  pushing a player standing on a belt that no longer exists.
- **A world with no reader has no `getMediumAt` at all** — `undefined` rather than a function
  returning null. Both read the same to the physics's optional chaining today, so the difference is a
  claim rather than an observable: "this world has no fields" is not the same claim as "none here".
- **Overlapping fields: the first one added wins.** Stated as a rule rather than inherited from
  `Map` iteration order. The determinism claim is not that the answer is the same for every
  possible pair of ids — it is that a _script_ produces the same answer every time, because the
  effects arrive in the script's own order on every peer (ADR 0016).
- **`MAX_MEDIUMS = 64`, a quarter of `MAX_ZONES`,** and the difference is what a medium does. A zone
  is read and produces an event; a medium is read and moves the player.

## Consequences

**The test that found the bug was measuring the right thing and the fixture was wrong.** A belt
should slow a walking player to a quarter of their speed. It measured 0.66. The physics was correct
at every point: the player ramps to 15 units a second and holds it. The test's _geometry_ was at
fault — the player was in free fall for the whole half-second of frames and left the belt's
five-unit-tall box after about fourteen of them, so the remaining sixteen frames were open ground.
Widen the box and the ratio is 0.25. **A test that needs its fixture corrected towards the physics
is a test that was measuring something other than what it claimed**, which is now the third time
that has happened and is recorded as a habit worth keeping.

**`getMediumAt` in the guest library validates every field of the answer.** Five numbers, all of
which the physics adds to something; four of them would put `undefined` into a velocity and produce
a NaN that then travels through the frame. A query that cannot fail should still refuse to hand
back something that would.

**`pushVy` and `sink` are absent from the payload rather than null.** A field that named no
vertical pull must not fight the fall, and a payload spelling out `pushVy: 0` would be an updraft
that pins the player to the ground. Making a conveyor definition also a floor is the point.

**A Solid signal setter treats a bare function as an updater**, so `setPlaceMedium(next.mediumAt)`
would have called a three-argument query with one `undefined` and stored the result. It is wrapped
in an arrow, with a comment saying why, because it compiles either way and reads as an assignment.

**`conveyor.ts` draws nothing.** Zones have an overlay and lights do not need one, and there is no
overlay for a field. The demonstration is that the only way to find a belt is to walk onto it —
which is either the right answer or a missing feature, and this ADR records it as the former
pending someone disagreeing in a browser.

**The physics was already correct, and that is worth saying plainly.** `updatePlayer` reads the
medium once per frame at the player's centre "so the horizontal and vertical branches of this frame
agree on what is acting on them", ramps rather than snaps, and only clamps the fall when `sink > 0`.
None of it needed changing, and none of it needed testing _for this phase_ — `game-world.test.ts`
already covered the movement rules. What was missing was a test crossing all four links
(place → host → `GameWorld` → `PlayerWorld`), and that is what was added.

## Notes

`getSeatYawAt` and `getSurfaceVelocityAt` remain unimplemented, and now for a sharper reason than
"v1 does not have figures": the physics for both is written and waiting, exactly as this phase
found. They need a thing to sit and a thing that moves. If the props phase makes a prop a
_declared_ seat and a _declared_ moving surface — data a place owns rather than geometry the CSG
folds — both queries become a few lines each, with no change to `player.ts`. If it makes props out
of real SDF geometry instead, both need the geometry side built first. That choice is not made here,
and the ADR is written so that whichever is chosen, the receiving end already exists.
