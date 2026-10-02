# 0019 — The host owns what it can own, and asks for the eight things it cannot

## Context

Everything so far has been either vocabulary or machinery: a place's code runs in an isolated
interpreter (ADR 0015), is a named group of operations (ADR 0016), may only say the nineteen
things ADR 0017 defines, is bundled into one reproducible program (ADR 0018). None of it has
_touched the world_. A place's effects currently go nowhere, because the trusted side that
carries them out does not exist.

The sibling project's answer to that is `script-host.ts`: 2,810 lines with about forty `on*`
callbacks, one per effect family, plus its own `ScriptConsole` at 830 more.

## Decision

**`src/places/host.ts` is a plain object that owns the interpreter, the event log, the place
registry, the zones, the timers and the stored data. What it cannot own is eight callbacks.**

- The split is by **ownership**, not by event. Geometry, zones, timers and data are the host's
  and are read through a getter. Putting the player somewhere, pointing the camera, and
  writing a line are the application's, and are the eight methods of `HostEffects`.
- **`HostWorld` is reads plus one callback**, `geometryChanged(bounds)`. All four queries are
  reads, so there is no path from the query half of the bridge to the fold.
- **One step is a loop with a depth cap**, `MAX_CASCADE_STEPS = 8`.
- **Timers fire in sorted id order, and their event ids are minted when they fire.**
- **Setting a timer id that is already pending does nothing.**

## Consequences

**`HostEffects` has eight methods where voxelscape has forty callbacks, and the difference is
ownership rather than restraint.** A callback per effect family is the shape a host takes when
it has no idea who is listening; here the question "how do I find out a toast happened?" has
the answer "the host called `effects.toast`", because the host owns the application boundary
and the application owns the screen. Everything else is a property, so there is no way for a
listener to disagree with the log about what the host holds.

**`geometryChanged` is the seam that makes a place visible, and it did not exist until a test
made it necessary.** The host writes into the registry directly, so nothing else finds out —
a `SculptSession` re-meshes when _it_ applies a change, and a shape a script made bypasses it
entirely. The symptom is not subtle geometry: it is a bridge that exists in the collision field
and in no mesh, so the player stands on something nobody can see and the console reports no
operations. It carries the same `bounds` contract as `edit/document.ts`'s `Change`, and for the
same reason: a caller is handed the box rather than being asked to work it out.

**A removal re-meshes the box the shape _had_, and that is backwards on purpose.** A removal
has no new bounds, and `undefined` means "re-mesh nothing" — which is exactly wrong, because
the surface that is now missing is the box the removed shape was in. So the box is read before
the removal and handed over afterwards. A remove of an absent id re-meshes nothing, because
nothing changed.

**Two timer semantics were wrong in the first version, and both failed silently.**

1. **Re-setting an id replaced it.** That made the obvious pattern —
   `if (!fired) after("later", 1000)` inside a per-frame handler — re-arm the timer before it
   could ever come due, so it **never fired**, with no error anywhere. It is now ignored while
   one with that id is pending, which makes the natural pattern work and gives a repeating
   timer a clear rule: re-arm when the event arrives, by which point the id is free.
2. **The event id was minted when the timer was _set_.** That quietly defeated the sort — the
   ids were already assigned in the order the script set them, so sorting the timers afterwards
   could not reorder anything and the log's own total order (`at`, then producer, then id) put
   them back the way they came in. An event's identity belongs to when the event _happened_,
   which is also what makes two peers agree: same timers, same order, same ids.

**A place's geometry is walkable, and that needed asserting.** Everything before this phase
established that a place's operations fold into the field. The claim that the _player's feet_
are on them is a separate thing, and it is the reason a place is worth loading rather than
worth looking at. `host.test.ts` stands a `GameWorld` on a box a script built, carves a doorway
through a wall it built, and checks both paths — the registry and the session's flatten — agree.
The third test is the one that would catch `sculpt.ts` quietly stopping flattening, which every
other test would survive.

**One handler that throws ends the step; the rest are skipped and the step carries on.** A
script whose first handler throws would otherwise throw on every frame forever, and the symptom
would be a frame rate problem rather than a bug report. `MAX_CASCADE_STEPS = 8` is the other
half of the same concern: an effect can author an event and an event can make a script dispatch
an effect, so without a depth limit two handlers that disagree hold the frame with no way out.
Eight is far more than a place needs.

**A place that fails while loading is reported, not thrown.** `load` catches and records it,
because `load` is called from a session that is already running, and letting the error out
would put a place's `PlaceError` into the frame loop's error handling, where nothing knows what
one is. The interpreter is kept either way, so a place that failed to build can be stepped and
will do nothing — the same outcome as one that built half of itself.

**The host's clock _is_ the console's `ClockCommands`.** The first version declared its own
shape and claimed in a comment to be a reuse, which it was not — it differed in both argument
and return type, so `DayNightController` satisfied one and not the other and the compiler would
have said so at the wiring. Declaring it as the same interface means a place and `/clock:` cannot
drift apart on what a clock is asked to do.

**`getData` was missing from the bridge's closed set, and `loadData` had been answering
`undefined` forever.** The interpreter refuses a query name that is not in `GUEST_QUERIES`, so
a name that is off the list never reaches a host at all — a query nobody is asked about, with
no error anywhere. Found by reading rather than by a failing test, which is the argument for the
list being short enough to read.

**The eight callbacks are the one place determinism does not reach, and deliberately.**
`player-place` on one peer moves that peer's player and nobody else's, which is correct —
each peer is running a different player. It does mean a script cannot use them to keep two
players in agreement, and that is a property rather than an oversight.

## Alternatives

**One `on*` callback per effect family, as the sibling project does.** Rejected: forty
callbacks is the shape a host takes when it does not know who is listening. The split by
ownership gives eight, and every one of them is a thing a plain object genuinely cannot do.

**The host creates its own `PlaceRegistry`.** Rejected, and it was the first version. The fold
index comes from the session's `FoldOrder`; a registry over a different counter hands out
indices the brush also hands out, and two operations sharing an index is a surface quietly
wrong. The caller passes its registry and the host writes into it — which is also what makes
`geometryChanged` possible, since only the caller knows how to re-mesh.

**Have `SculptSession` own the registry and let the host call methods on it.** Rejected: a
sculpting session is about _a hand making an edit_, with a history and a tool. A place is a
named group of operations with neither. Making the session the host's interface would put
`document`, `tool` and undo in reach of a script's effects.

**Drain the cascade until nothing is left, rather than capping it.** Rejected: that is how two
handlers that disagree hold a peer inside the loop holding the frame. The cap is the whole
reason the loop terminates.

**Author a timer event when it is _set_, which is simpler.** Rejected: an event is a fact, and
a fact that has not happened yet is a timer. Authoring at set time also meant the id reflected
set order rather than fire order, which is what defeated the sort above.

**Let a script query the host for its own state beyond the four world queries.** Rejected for
v1: `getData` is the only one, and it reads a table the host owns. Anything else would be a
second question the bridge's closed set has to grow, and the closed set is the thing that makes
a version skew visible rather than quiet.

## What is deliberately not here

**`getMediumAt`, `getSeatYawAt` and `getSurfaceVelocityAt` on `GameWorld` are still
unimplemented**, and that is now a decision rather than an oversight. All three have been
declared and consumed by `updatePlayer` since before places existed, with a doc comment on
`Medium` reading "the field _a script has declared_". None has a source, because a source would
be effect vocabulary this phase did not define: `field-add` for a medium, a seat tag for
`getSeatYawAt`, a moving surface for `getSurfaceVelocityAt`. Stubbing them would mean
implementing a thing no script can ask for, which is worse than leaving them absent — a method
that always answers "none" reads as "no fields here" and "fields are not supported" the same
way, and only one of those is true.

So they wait on a phase that adds the vocabulary, and the record says which. That is the
difference between a decision and an oversight.

**No renderer reads the host's collections yet.** `zoneList` and `storedData` exist and are
tested, and nothing draws them. That is Phase E's job, along with the console commands and the
per-frame `host.step()` in `app.tsx`.

**No place is loaded from anywhere.** `PlaceHost` takes its files as an argument, so the
on-disk form — a zip with a manifest — is still Phase F's.
