# 0033 — A project file is a manifest and the model, and Save writes back to where it came from

## Context

ADR 0032 gave the model a way out to a slicer. It did not give it a way back, and it could not
have: `apps/sdf-modeller` had no file I/O of any kind before this. There was no save, no open, no
`Blob` anywhere in `src/`.

The question is not "what format" so much as "whose format". There is already a format, and it is
load-bearing elsewhere:

- **`packages/csg/src/serialise`** writes and reads a fixed-width binary list of operations. It is
  version 3, it is seekable, and it is the same bytes `apps/bm-sculpt/src/session.ts` puts on the
  wire for a multiplayer session.
- **`Part` is not `Operation`, on purpose.** `../model/part.ts` says so at length: _"The file
  format (a later phase) has to record a part's name, its primitive, its transform and its
  boolean; `Operation` has an `index` that means a position in a fold, and no name at all.
  Merging them now would make that migration a rewrite."_ This is that later phase.

So the model was going to be written as something, and the only question left was whether it
would be the bytes that already exist or a second encoding of the same list.

## Decision

### The operations go out as the bytes they already are

**`model.bin` is `serialiseOperations`' output verbatim.** Writing a second encoding — JSON, a
bespoke binary layout — would be two implementations of one idea to keep in step, and the
modeller's file would be the one nobody else in this repository reads.

### The manifest carries the three things the binary cannot

**Because all three are about a part rather than an operation, and all three would otherwise have
meant a version bump of a format the landscape shares.**

| Field             | What the binary cannot say                                                                      | Why it matters                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids`             | `Operation` has an `index` that means a position and no name                                    | `Part.id` promises to be unique and never reused, because a selection, an undo entry and a save file all refer to one                                |
| `coloured`        | `Operation.colour` is optional and `serialiseOperations` writes **white** for one that has none | A part with no colour means _the surface falls through to whatever is underneath_. Coming back as a white ball is a different model, not a lossy one |
| `palette`, `view` | Neither is about an operation                                                                   | The mesher is the one control here that alters what the model **is** rather than how it is drawn                                                     |

`coloured` is the one that is not obvious. **`serialiseOperations` has to write something for the
colour bytes**, and white is the right default for a brush that was always going to be painted. It
is the wrong one here, where "no colour of its own" is a load-bearing distinction. Rather than
bump a shared format to add a presence bit, the manifest records which parts _relied_ on that
default — so the default stays right for the landscape and the exception is stated where the
exception belongs.

**The alternative was `FORMAT_VERSION = 4` in `packages/csg`**, and it is genuinely better for the
binary alone. It is worse for this repository: the same bytes go over the multiplayer wire, so the
bump would change the landscape's protocol to serve a figure editor.

### `Paint` is refused rather than read as an `Add`

**`deserialiseOperations` will return one** — `Combine` has three members and the byte exists. But
a `Part` has no `Paint`, and the reason it has none is a decision (ADR 0028's note on `Part`:
Paint adds no material, only colour, and a coloured `Add` already expresses it). A file naming
one describes a model this application cannot represent, and reading it as a union would put
material in a file that said there was none.

### Opening is one undo step, and the id counter moved to the store

**`ModelStore.load(parts, label)` records one history entry**, not a removal per part. Somebody who
opens a file and presses ctrl-z wants the model they had, not the model minus the parts the file
happened to add — and a five-hundred-part file would be five hundred entries against a limit of a
hundred. It restores the **selection** it had, not the first part of the new model: undoing an
open is getting back to the state before it.

**`ModelStore.nextId` allocates, and skips ids the model holds.** The panel's own counter would
have been wrong the moment a file was opened: a file saved with `part-1`, `part-2` and `part-3`
followed by a counter still near one means the next part a person adds is refused by `add` for
colliding with a part already on screen — a button that silently does nothing. It asks the model
what it holds rather than parsing the ids, because **a file's ids are caller-chosen** (`body`,
`arm`) and there is no numbering in them to resume from.

### One Save, and it becomes Save as by asking

**`FileSystemFileHandle` where the browser has one.** The difference between Save writing back to
the file the model came from and Save downloading a second copy every time is the whole of why
the API is worth a code path: somebody who has just fixed a model and saved it, then saved it
again, should not end up with four files.

**One control, not two.** Whether it writes back or opens a dialog is decided by whether there is
somewhere to write, which is a fact and not a choice — so the person sees one button and the
application does the deciding.

**Dismissed and unsupported are different answers.** `choosePlaceToWrite` returns `undefined` for
both, and the caller has to tell them apart: one means "there is nowhere to write", where a
download is the only way to put a file anywhere; the other is silence. Treating them alike is how
a print ends up on a disk somebody did not ask for it to reach.

### The file layers are imported lazily, and the gate is a separate module

**`jszip` is a hundred kilobytes and nothing on the first frame needs it**, so `./file/project` and
`./print/export-model` are both `await import()`ed from behind a menu. `apps/bm-sculpt` does the
same for its place loader.

**`printProblem` and `printReadout` live in `./print/print-problem`, not in `export-model`.** The
interface needs to say whether a model is printable without the writer in the bundle at all, and
importing the gate through `export-model` reaches `three-mf` and so `jszip`. This was caught by
the build, which prints `INEFFECTIVE_DYNAMIC_IMPORT` and says the dynamic import will not move the
module into another chunk — the split turned a 319 kB first paint into 217 kB with `jszip` in its
own chunk.

### The file menu is a popover, and the export's numbers are in one

**Seven footer buttons do not fit on a phone.** Undo, Redo, New, Open, Save, Save as and Export is
more than the width and none of the height a thumb wants, so the file actions are in one popover
and the print numbers in another. The native `popover` element is the mechanism ADR 0026's note
already points at for this, and the anchor is declared in the markup with `anchor-name` so a menu
covers the corner of the model rather than the middle of it.

**The height and the filament count are asked, not defaulted into the form.** Both are numbers
about the **destination** — the printer's size and its filaments — and neither is a fact about
the model, so neither belongs in the file. A blank or unparseable field is a refusal rather than a
default, because substituting one would print at a height nobody chose, which is the one outcome a
size field exists to prevent.

## Consequences

**A project file is a zip and not a single binary.** `apps/bm-sculpt` writes places the same way
and for the same reason: a manifest is the part of a file that is safe to read, validate and then
trust, and `JSON.parse` on bytes from a file is the one genuinely untrusted parse in the loader.
A binary format with a JSON header would be a worse answer than a zip, because the zip's
membership is the same thing.

**The manifest duplicates three bounds rather than importing them.** `MAX_MANIFEST_PARTS` is
`MAX_PARTS` and `MAX_MANIFEST_COLOURS` is `PALETTE_LIMIT`, written down rather than imported —
`model-store` drags in the meshing package and `ui/palette` imports a stylesheet, and a validator
for a file's contents is not the place to pull either in to read a number. **Duplication is only
safe while something checks it**, and `project-file.test.ts` asserts both agree, along with the
resolution list against `RESOLUTIONS`. That is the whole justification for the three copies.

**A refused save leaves the document unnamed and says why.** `loadInto` checks `store.load`'s
refusal — over `MAX_PARTS`, or two parts sharing an id — and turns it into a sentence, rather than
installing the palette and the view and then discovering the parts would not go in. The order
matters: everything is checked before anything is written.

**Nothing is saved until somebody asks.** There is no autosave and no recent-files list; that is
the next phase, and it is IndexedDB and a `FileSystemFileHandle` in `localStorage`, which is a
different problem from this one.

**A `Float32Array` round trip is not a `Float32Array`.** Every number in `model.bin` is a 32-bit
float, so a capsule of `len: 2.2` comes back as `2.200000047683716`. That is the format being what
it is rather than a defect, and the tests compare field by field with a tolerance for it — a
`toEqual` would call the round trip broken.

**The export's own model is what gets refused, and the gate on the menu is the viewport's.**
`printProblem` in `exportPrint` runs on a freshly meshed model at `PRINT_VOXEL_SIZE`; the disabled
button and its `title` are `printProblem(mesh())` on whatever the viewport last built. **The
button's title is therefore about the mesh on screen rather than a prediction about the file**,
which is why the popover says so next to the readout.

## Alternatives

**A single JSON file, parts and all.** Rejected. The model is kilobytes, so the size argument
does not apply; what applies is that the binary format already exists, is tested, and is the same
bytes another application sends. A JSON file would mean a third reading of an operation list in
this repository and a hand-written JSON encoding of every shape in the `PRIMITIVES` table
(ADR 0025) to keep in step with the byte layout that is already there.

**`FORMAT_VERSION = 4` in `packages/csg`, carrying the ids.** Better for the binary, worse for
this repository: the same bytes are the landscape's multiplayer payload, so the bump would change
a wire protocol to serve a figure editor. Recorded because it is the right answer if the ids ever
need to travel with the operations for their own sake — the record part of an atproto publish, say.

**Bumping the format and fixing the white-colour default at the same time.** The white default is
right for the landscape and wrong here, and the right fix for the binary is a presence bit rather
than a manifest field. What stopped it is only that it rides on the same version bump as the ids,
and the ids do not justify a wire change on their own.

**One Save and one Save as.** Rejected as two controls for one decision. It is defensible, and it
is worse: it asks somebody to know whether the document has a home before they can press the
button they meant, which is a thing the application knows and they should not have to.
