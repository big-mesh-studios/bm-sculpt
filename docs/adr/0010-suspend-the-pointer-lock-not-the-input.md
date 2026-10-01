# 0010 — Suspend the pointer lock, not the input

## Context

The console (`src/console/`) is the first thing in this application that wants the
keyboard for itself. Press `/` and a terminal opens; every keystroke after that has
to reach its input rather than the movement keys, and the cursor has to be somewhere
a player can aim it at the trigger and the fullscreen button.

Pointer lock is what stands in the way of both halves of that. A locked pointer
delivers its movement as deltas and sends **no** keyboard events at all — the
specification's whole model is that a locked pointer is the game, not the document.
So a console opened over a locked canvas is a console that cannot be typed into: the
input never receives a key, and the cursor is pinned to the centre of the screen
behind it.

Three things could be done about that, and the choice has to be made by the input
controller rather than by the console, because the console only knows it wants a
cursor and not what else holds one.

## Decision

**`InputController` grows `suspendPointerLock()`, and the console holds it for
exactly as long as its panel is showing. Nothing re-takes the lock on release.**

Holds are a set of tokens rather than a flag or a count, because two holders may want
the cursor at once and the first to finish must not take it back from the second — and
because a count has two ways of getting that wrong that a flag does not. A disposer
called twice drives a count below zero, and every later suspension then reads as a
_second_ one and never lets the lock go again. A disposer called after a teardown —
the console's hold already cleared with everything else — does the same thing from the
other side. A set settles both in one line: the disposer deletes its own token, and
whether that succeeds is the whole of what it needs to know.

## Consequences

**Closing the console costs a click.** The player is returned to the state the
application was in before they ever played, minus the pointer they were holding: the
"click to play" prompt comes back and the next click on the canvas takes the lock.
That is the whole price, and it is paid in the currency the game already charges for
starting. It is also the reason the console has to be told when the lock is _suspended_
rather than only when it is _gone_: `App` gates its click-to-play prompt on the
suspension too, so the prompt does not appear behind an open terminal, inviting a click
at a moment when the world is already being played.

**The suspension is not the same fact as the lock's absence, and neither is the same as
input being disabled.** Three states, three accessors — `pointerLocked()`,
`pointerLockSuspended()`, `setEnabled()` — because they answer three different
questions and the console needs the middle one. A caller that wanted "the player is
not playing right now" and reached for `pointerLocked()` would be right for a browser
that has no pointer lock at all and wrong everywhere else.

**The world keeps running behind the terminal.** Nothing here pauses the frame loop,
the streaming window or the physics. Movement keys stop reaching the player —
`isEditableTarget` already skips an event aimed at an input, and the console's input is
an input — but a held mouse button is still carving, and the window is still streaming
after the player. This is deliberate: a debug console that pauses the world is a
different tool, and this one is for tuning a world that keeps going.

**A hold that a teardown has already cleared is not a hold any more, and the disposer
that goes with it has to be able to tell.** `teardown()` empties the set, because a
teardown that left holds behind would have the next suspension read as a second one —
which is the corruption above, arriving by a different road.

## Alternatives

**Leave the lock held and read the keyboard anyway.** Rejected: impossible. A locked
pointer delivers no key events, which is the mechanism being relied upon and not a
shortcoming of it.

**Disable the input instead — `setEnabled(false)` while the console is open.**
Rejected: it stops the movement keys reaching the player, which is half of what is
needed, and leaves the cursor pinned for the other half. It would have to be paired
with the same lock release anyway, at which point the release is the decision and the
disable is decoration.

**Re-take the lock on release, as the sibling project does.**
`big-mesh-studios`'s `apps/voxelscape` re-requests it from a 100ms timer when the
console closes. Rejected here for two reasons. A timer that fires without a user
gesture is refused outright by some browsers, so it is a race the console does not
control; and where it does succeed, the lock is taken back behind a cursor the player
has not moved yet, so their first click lands on the crosshair and digs. That
application's canvas does not re-take the lock on click the way this one does, so it
needed the timer; here the click already asks, and asking is the version that works.

**Hold the lock and put the terminal somewhere the pointer can reach.**
Rejected: the pointer is not a cursor when it is locked. It cannot be aimed anywhere.
