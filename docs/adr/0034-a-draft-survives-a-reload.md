# 0034 — A draft survives a reload, the files you opened are remembered, and "your files" is a dialogue

## Context

ADR 0033 gave a model a way to disk and back. Two things were left out of it deliberately, and both
are things a person notices within one session of using it:

**Nothing survives closing the tab.** `apps/sdf-modeller` has no autosave, no recent-files list and
nowhere to record where the document came from beyond the lifetime of the page. A reload gives you
the default capsule, and everything built since the last Save is gone with no warning — because
there was no warning to give.

**The layout does not fit what it now has to hold.** ADR 0033 put five file actions and two export
numbers into two anchored popovers in the footer. That was the right call for the actions and the
wrong one for everything after them: the recent-files list is a _grid of files_, and a grid of files
does not fit in the corner of a screen. A footer of Undo, Redo, New, Open, Save, Export, Height and
Filaments is eight `--ui-size` targets across the bottom of a phone.

## Decision

### The draft is the project file, verbatim

**`writeProject`'s output, stored as a `Blob`, read back through `readProject`.** It already
contains the parts, their ids, which of them have a colour of their own, the palette and the
mesher and the resolution, so a draft cannot be a different shape from a `.sdfmod` and cannot be a
version this build does not read. Restoring is the same code that opens a file, on the same bytes,
with the same refusals.

**Restored silently, and that is a decision.** Every editor worth using does it — a reload giving
you an empty canvas after you have just built something is how an autosave becomes something people
turn off. The cost is somebody who wanted a new document and reloaded instead of pressing New.

**A draft this build cannot read is cleared rather than kept**, so that every reload from now on
does not spend the same work failing the same way.

### The undo history is not saved, and could not be

**rm-stacker persists its undo stack** because a `Command` is data it can serialise
(`Command.toJSON`). **This application's history entries are a pair of closures** — `ModelStore.load`
and `add` build `apply`/`invert` out of captured variables — and closures cannot be written to a
database in any format worth having. So a restored document has no history and ctrl-Z does nothing
until the next edit.

**Which is the right behaviour anyway.** Undoing back through a page reload to edits somebody can no
longer see is a worse thing to offer than not offering it. Recorded because the absence looks like
an omission from the outside and is not one.

### The draft is armed from the rebuild, not from an effect of its own

**The rebuild is the one place that runs when the model has actually changed**, after the debounce
that keeps it off a finger's every frame. Arming the draft there means it is written once per
settled model rather than once per keystroke, with no second timer to keep in step with the first.

**A second timer is not obviously wrong and is a real cost:** two debounces over the same signal
drift, and the one that drifts is the one nobody can see.

### Two writes never overlap

**A change arriving mid-write re-arms rather than starting another write.** Without this, a person
editing continuously has write two start before write one finished, and the database keeps whichever
landed last — which is the _older_ of the two as often as not, because the later one waits behind an
open transaction. **The symptom is a restored document that is an earlier version than the one being
typed**, which is the kind of bug that gets reported as "autosave loses my work" and believed.

### Nothing in the storage layer ever throws

**`indexedDB` is missing in a browser with it disabled, unavailable in some private modes, and
absent under Node**; a quota failure is a thing that happens on a phone. So `put` resolves without
having done anything, `read` resolves to `null`, and a failed autosave is swallowed one level up.

**A draft is a backup, and a backup that could stop the editor accepting edits has the priorities
backwards.** There is nothing a caller could do about any of these except stop working.

### A file handle is what is remembered, and it survives because IndexedDB clones it

**A `FileSystemFileHandle` is a live reference to a file on disk and the only thing in a browser that
will keep one** — it survives a structured clone where a string would not. That is the whole reason
the list exists across a reload.

Permission does **not** survive that long, which is why:

- **A name is kept beside every handle**, so the list can be drawn without reading a single file.
- **`queryPermission` and `requestPermission` are separated.** Drawing a list only ever _asks_;
  `requestPermission` outside a gesture is refused by the browser, and asking for twelve files to
  draw a menu would be refused twelve times and would open twelve browser prompts.

**`mayAlreadyRead` and `mayRead` are two functions rather than one with a flag**, because the
difference is _whose gesture_ and a boolean parameter would let a caller pass the wrong one.

### The same file opened twice is one entry

**By `isSameEntry`, which is the only way to ask** — two handles to one file are different objects,
so comparing by identity would show it twice, and the two entries would then race each other on
every subsequent save.

### Twelve remembered files, not sixty

**The number is about the menu rather than about memory.** This is a list somebody picks a file out
of, and a picker a person scrolls past its first screen is not a picker. The sibling keeps sixty
because its list mixes in published models and has room to scroll.

### A card shows how many parts, not a picture

**Rendering a thumbnail per remembered file means rendering on every autosave** to store a picture
that will mostly never be looked at again. How many parts a file holds is what tells a sphere from
a character, and it is already known.

### "Your files" is a modal dialogue, and the tools stay in the shell

**A dialogue, because it is a list of files.** The five actions fit anywhere; the grid of cards
wants the whole screen, and goes full-bleed under 500px. The native `<dialog>` is what makes the
`Esc` key, the backdrop click, the focus trap and the top layer free — four small features with
four small ways to be subtly wrong.

**Click-outside is `event.target === element`,** because a modal dialogue's backdrop _is_ its own
background area, so a click on the backdrop lands on the dialogue and a click on anything inside it
lands on that thing instead. One comparison, no sentinel element, no document-level listener.

**All of the dialogue's positioning is in `app.module.css`, none of it in the panel's own
stylesheet.** One stylesheet owns the screen's composition instead of each component owning a piece
of it — which is the sibling's arrangement and the reason to copy it.

### The dialogue responds to its own width and not the window's

**Because it is inset from the window by a clearance on a desktop screen.** At a 712px window the
dialogue is 620px and wants the narrow layout, while the window is nowhere near a breakpoint of its
own. So `.panel` declares `container-type: inline-size` and everything below it is a `@container`
query. **This is the single most worth-copying detail of the layout.**

The card grid is `repeat(auto-fill, minmax(min(132px, 100%), 1fr))`, where the outer `min()` is the
overflow guard: four across on a desktop dialogue, three on a full-width phone, two on a small one,
with no media query involved in any of those.

### The export stays a popover, and is drawn without a portal

**Because it is three things and two of them are numbers**, asked once per file rather than held on
screen. And `portal: false` is mandatory: a modal dialogue sits in the **top layer**, above
everything including a portal-to-body popover, so a portalled panel would open in the right place and
**take no clicks at all**.

## Consequences

**A document can be open, have a draft, and have no home** — which is a normal state, not a
contradiction. It is what a restored draft is, and it is what a file opened as a download is. The
first Save after either asks where the document goes rather than quietly claiming the draft slot can
be written back to.

**Two tabs are a lost argument.** `database.ts` resolves `onblocked` to `null` and gives up rather
than waiting, because waiting for the other tab to close would hang the one trying to save somebody's
work. So the second tab autosaves nothing rather than corrupting the first, and the person finds out
from a missing draft rather than from a frozen tab.

**The autosaved model is one second behind at worst, and that is the number.** The cost is not the
bytes — a project file is kilobytes — it is the transaction, and a person editing a figure pauses
for whole seconds between edits while they look at it.

**The recent list disappears entirely on Firefox and Safari rather than degrading.** Opening a file
there yields its contents and no handle, so there is nothing to remember, and the panel says so
instead of drawing an empty grid that looks broken.

**The undo history ends at a reload**, for the reason above and because it cannot be otherwise.

**The `.openHere` highlight was left out.** The sibling applies a class for "this is the document
you have open" and has no rule for it; here there is one document and no list of them, so the case
does not arise and the class would have been dead.

## Alternatives

**Persisting the undo history by re-encoding each entry as data.** Rejected for now and recorded as
the obvious next thing. `HistoryEntry` would need the same treatment rm-stacker's `Command` got —
each entry becoming a tagged union of serialisable shapes rather than a pair of closures — and it is
a real change to `model-store` rather than to the storage layer. It would also mean undoing through
a reload, which is a thing to want deliberately rather than by default.

**A thumbnail per remembered file.** Rejected as described above, and it is reversible: the card
already has a square well to put one in, and `ui/print/thumbnail.ts` already knows how to render
one.

**One `put` of the draft and its timestamp together.** Rejected because this API takes one value at
a time. The pair is small, a crash between them leaves a draft reading as saved-at-the-epoch, and the
next write corrects it — a cosmetic inconsistency in a backup, which is the right way round.

**Keeping the file actions in the footer and only the list in a dialogue.** Rejected as two places to
look for one thing. The panel carries the current document's name, so the footer would have had
either a duplicate of it or nothing — and a Save button somewhere other than the name it belongs to
is a button somebody has to hunt for.

**`sessionStorage` or `localStorage` for the draft.** Rejected: `localStorage` is synchronous and
string-only, so a zip would have to be base64 through a quota that is a fifth of what a model needs,
and it cannot hold a `FileSystemFileHandle` at all — which is the whole of the recent list.
