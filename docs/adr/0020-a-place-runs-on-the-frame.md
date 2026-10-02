# 0020 — A place runs on the frame, and the console is how a person meets it

## Context

ADR 0019 built the trusted side: the host, its eight effects, `geometryChanged`. Nothing had
called it. The application had no `PlaceHost`, no way to load one, no way to stop it, no frame
loop that stepped it, and no way to see a zone — which meant every capability in ADR 0017
through 0019 was reachable only from a test.

That is a real gap rather than a finishing touch, because a capability nothing in the
application can reach is not a capability. It is a library with tests.

Two things had to be decided rather than merely written.

**Where the host sits in a frame.** `Game.tick` places the camera, `DayNightController.tick`
derives the light, and a place's timers are measured against a clock. Any order that is
consistent is correct; an inconsistent one produces places that react a frame late to the
player and to the hour, which is a bug nobody can describe.

**What a command that takes time looks like.** `/place:load` bundles, starts an interpreter and
runs a script's top-level code. Every existing command is synchronous, and `CommandEntry.run`
was typed to return a `string`.

## Decision

**The host is stepped on the application frame, in three parts, in this order: `movePlayer`,
then the clock's own `tick`, then `step`, then rebuild the zone overlay.**

- **`movePlayer` before the step** so a zone crossed during this frame's movement fires now
  rather than next. A zone that is one frame late is indistinguishable from a zone in slightly
  the wrong place, and only one of those is a bug a person can chase.
- **The clock ticks between them** so a timer coming due is measured against the second the
  player is standing in, and `step` after that so the effects it dispatches are in the world
  before `render` is called. A place therefore never builds something a frame draws without.
- **The overlay is rebuilt after the step**, because a place can change its zones mid-step and
  the boxes would otherwise trail the world by a frame — visible exactly when someone watches a
  zone appear.

**`nowMs()` on the clock, not `Date.now()`.** A place's events are timestamped from the same
object that draws the sky, so two peers a few hundred milliseconds apart cannot order the same
facts differently and never re-converge (ADR 0016). It reports the _shown_ second, so a pinned
sky is a pinned world: the distinction ADR 0019's clock already makes for light, extended to
events.

**`CommandEntry.run` may return a promise, and the console replaces a pending line rather than
appending to it.**

- **`Commander.with()` merges a second table.** `/place:` is its own table in its own file,
  because nothing outside the game should have to know a place exists, and merging keeps
  `/help`'s order reading as "the game's commands, then the place's".
- **`ConsoleState.print()` for a place's `log`,** which is not a command and has no echo of its
  own. It lands in the same scrollback, so a place's output and a person's commands interleave
  in the order they happened rather than in two stacks.
- **A pending entry carries an id.** Replacing by position works; replacing by content does not,
  because two pending commands can print the same `…`.

**A `/place:` command says what the place did, not that it loaded.**

## Consequences

**`setPlayerSpeed` and `clearPlayerSpeed` were both wrong the first time, and only one of them
was obvious.** The first implementation scaled from `DEFAULT_PLAYER_CONFIG` and cleared by
reading a field it had itself overwritten — so `clearPlayerSpeed` did not clear, and a world
built with `player: { speed: 30 }` had its walking speed silently replaced by the default's.
Both now scale from a snapshot of the player's own config, taken after construction, which also
makes the two order-independent: setting a multiplier twice replaces rather than compounding,
and clearing twice is the same as clearing once.

**`clearCameraLook` had the same shape of bug, and the test for it is the reason it does not
still have it.** Stopping to set the field of view is not the same as putting it back, so a
place that zoomed the camera and then went away left the player looking through a lens they
never chose. The camera's own fov is captured on the first claim — not on every call, or a
place that re-aims every tick would capture its own zoom and clearing would restore that.

**Three seams that had no test now do**, and one of them was passing for the wrong reason.
`SculptSession.refreshPlaces` is what makes a place's geometry reach the meshes at all, and it
had no test; the test that checks the document's operations survive it compared by `id`, which
`Operation` does not have — two `undefined`s compared equal and the assertion said nothing. It
compares by fold index now, which is what identifies an operation to the fold.

**The lanterns demo was wrong in a way only a test could see.** `demos.test.ts` asserts that
every shipped place does _something_, and the honest form of that is "operations **or** a
pending timer" — a timer demo builds nothing at load and a build-on-arrival demo arms no timer.
Writing it as "operations" would have failed a demo for being a timer demo, and writing it as
"either" would have let a demo that did neither pass.

**`bridge` now ships as two files, because a single-file demo demonstrates the case that needs
no bundler.** Its geometry moved to `span.ts` and the entry imports it, which is the same
`./span` rewrite any real place with a dozen files gets. It also removes a phantom: the registry
had been mapping `span.ts` to the _lanterns_ source, naming a module nothing imported.

**A place's notices appear in two places, and one of them is not the console.** `onNotice` feeds
a line over the game as well as `/place:notices`, because a place that fails while the console
is closed would otherwise be silent until someone opened it. The overlay line is
`pointer-events: none`; a place that logs every tick must not stop the player playing.

**The zone overlay is one mesh for every zone, and that is a draw-call claim.** `MAX_ZONES` is
256, so a mesh each would be 256 draws for boxes a player can count on their fingers. The cost
is that adding a zone rewrites every zone's vertices — 24 floats each, at the cap about six
thousand, on an add rather than per frame.

**A raycast reports `kind: "terrain"` always, and names it so before a place is written against
a better promise.** The field is one signed distance function over the terrain and every
operation in every place, so it cannot say which of them it met. Splitting it later means
adding a case to the type, not changing what it means.

**Two things are still not implemented, and both are because the engine cannot yet express
them.** There is no way to turn a light off, so a lantern is a shape that appears and stays.
There is no way to ask what a place's own medium or seat is, because there are no items, seats
or moving surfaces in v1 to ask about.

## Notes

`app.tsx` is where the host is constructed, which is deliberate: it is the only scope that has a
`Game`, a `SculptSession`, a clock and a scene at once, and it is where the other five materials
receive the light. A `place-manager.ts` that took them as arguments would be a place the
application boundary is not.
