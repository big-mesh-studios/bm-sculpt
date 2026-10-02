# 0018 — A place is bundled into one reproducible program, and the guest library is a real file

## Context

ADR 0015 settled that a place's code runs in a QuickJS interpreter with no filesystem and no
module loader. ADR 0017 settled the vocabulary it may speak. Two things stand between them
and a place that runs:

1. **Somebody has to turn a set of TypeScript files that import each other into one scope.**
   The interpreter has no filesystem, so the files arrive as text and something must resolve
   them.
2. **There has to be a guest API** — the functions a script actually calls, rather than five
   raw bridge methods.

Both have an obvious-looking wrong answer, and the sibling project's answers are instructive
in exactly the places they are not obviously wrong.

## Decision

**`bundle.ts` compiles a place's files with pinned options, assigns module ids in sorted
order, rewrites every import to an id at bundle time, and emits one string. The guest library
is a real TypeScript file in this repository, type-checked by its own `tsc`, and the
declaration a place author reads re-exports it.**

- **Reproducible output, or nothing works.** Under ADR 0016 the operation list is _recomputed_
  on each peer rather than received, so two peers bundling different text for the same source
  would derive the same operations from different programs — with no way to tell afterwards,
  because the fold looks identical either way. Three things make it a function of its inputs
  alone: ids assigned in `Object.keys(files).sort()` order, compiler options pinned rather than
  inherited from this repository's `tsconfig`, and nothing read from the host environment.
- **A place's namespace is flat.** `./door` and `door` both mean `door.ts`; anything with
  `://`, a leading `/`, a `..`, or a directory in it is refused by name.
- **`verbatimModuleSyntax` is the load-bearing compiler option**, and it was found by a test
  failing.
- **The guest library is `guest/place-api.ts`, compiled here.** `guest/voxelscape.d.ts` is a
  two-line module declaration that re-exports it, so the declaration cannot restate the API.
- **Five bridge methods**, in `bridge.ts`: `dispatch`, `query`, `onTick`, `now`, `random`.

## Consequences

**`verbatimModuleSyntax` rather than `isolatedModules`, and the difference is a silent
failure.** A bundler needs every import to survive into the output, because _it_ — not the
type checker — decides what exists. TypeScript's default is to **elide an import nothing
appears to use**, and so the first version of this bundler silently dropped an import of a
file that did not exist: a place could write `import { door } from "./door"` and never learn,
because nothing referenced `door` and the import evaporated before the bundler saw it. With
`verbatimModuleSyntax` an ordinary import is preserved exactly as written and `import type` is
still erased — which is what makes it safe for the guest library, whose single import is a
type. `bundle.test.ts` asserts the compiled library requires nothing, because a surviving
`require` there would fail inside the interpreter with an error about a module a place author
never wrote.

**The guest library being a `.ts` file is worth more than it looks.** The obvious alternative
is to keep it as a string in a template literal, which is what the sibling project does — and
that means the guest API is never type-checked, never gets a compile error, and drifts from
the declaration a place author reads with nothing to notice. Here the two are one file: a
function added to `place-api.ts` is in the declaration, because the declaration re-exports it.
The test that checks it asserts the re-export is _real_ rather than checking it by hand,
because the direction a hand-written declaration gets wrong invisibly is promising a name the
library does not have.

**The library is 32 functions and one class, and every one is a thin wrapper over one of the
19 effects.** That ratio is the point. `engine.dispatch("shape-add", JSON.stringify({...}))` in
every place is the vocabulary of ADR 0017 leaking into every script, and the first place to
spell `combine` wrong writes a shape that silently does nothing. The wrappers also make the
**one place a host's refusal is visible**: `dispatch` returns a sentence and the library turns
a non-empty one into a thrown `PlaceError`, so a place that hits `MAX_OPERATIONS_PER_PLACE`
fails at the line that caused it rather than producing a world with a bridge missing from it.

**A place has a `require` in scope, and a test asserting it did not would have been wrong.**
The bundle defines its module resolver and the transpiled code calls it by that name, so a
place's `require` _is_ that resolver. It is not an escape, and the reason is stronger than "the
resolver refuses bad ids": **every literal `require` in the source was resolved before the
bundle was rendered**, so the only arguments left in the text are module ids the bundler
chose. A place cannot hand the runtime resolver anything it picked. The tidier claim
(`typeof require === "undefined"`) would have failed on every run and invited someone to "fix"
the bundler by hiding a name that is doing its job.

**`dispatch` and `query` are separate methods rather than one with a discriminator.** They are
both strings in and strings out, so they could have been one. Keeping them apart is about what
the host can do wrong: `dispatch` changes the world and its arguments are a peer's bytes, so it
validates and reports a refusal; `query` reads it, cannot change anything, and cannot be
refused for being out of bounds — a query that _failed_ would be a script that could not tell a
solid surface from no answer at all. Merged, they would be one validated path and one
unvalidated one, and the mistake would be a `query` reaching the applier.

**A tick handler receives an object, and both arguments are strings.** `onTick` hands the
handler `{ now, events }` rather than positional arguments, because the event list grows and a
script written against two positional arguments would break silently when a third appeared.
The object is assembled _inside_ the interpreter from two strings the host produced, so it is
the one structured value in the guest library and it never crossed the boundary.

**A step's budget covers all its handlers together.** A per-handler budget would be a way for
a place with fifty handlers to buy itself fifty times the time, which is what makes a cap not
a cap. The test asserts forty handlers all spinning still stop inside one budget.

**One handler that throws ends the step, and the rest are skipped.** That is a choice. A script
whose first handler throws would otherwise throw on every frame forever, and the symptom would
be a frame-rate problem rather than a bug report. One handler ending the step turns a stall
into an error, and the interpreter stays usable — the next step runs normally.

**`load` and `step` are separate, and the distinction is load-bearing.** The bundle is
evaluated once, which is when a place's top-level code runs and it decides what it is, and then
the host steps it every frame. A place that built itself per frame would rebuild itself per
frame. Reloading disposes the previous place's handlers first: leaving them would mean a dead
place's script driving the new place's world, which would look like the new script misbehaving.

**A file's name never appears in the output.** The bundle carries module ids only. A filename
in the output would be a thing two peers could disagree about that a place author cannot see,
and nothing in the API needs it — a handler is called, it is not addressed.

## Alternatives

**Keep the guest library as a string in a template literal, as the sibling project does.**
Rejected, and this is the decision most worth arguing about. It means the guest API is compiled
in the interpreter and nowhere else: no `tsc` over it, no autocomplete that is checked, and a
declaration file maintained by hand beside it. The reason to consider it is that it avoids
`?raw` and a bundler input — a real but small cost against a whole API that is type-checked.

**Let the interpreter have a module loader instead of bundling.** Rejected: it would need a
filesystem or a resolver inside a runtime whose isolation argument rests on there being
neither. Bundling is a few dozen lines and it moves resolution to a point where a refusal can
name the file and the import.

**Give each module its name as its id rather than a number.** Rejected: it makes the output
depend on what a place _called_ its files, and a file name is a thing two peers could spell
differently. Numbers assigned in sorted order cannot.

**Preserve import elision, and tell authors to use what they import.** Rejected: it makes an
author's mistake invisible at bundle time and visible only as a name that is not defined inside
the interpreter, several steps later. Refusing an unresolvable import is a better place to
find out, and the message can name the file.

**One `call(name, args)` bridge method instead of five.** Rejected, and it is the failure that
produced the two halves of the split: a general method is how a _write_ ends up on the
unvalidated path. Five hand-written bindings beat one clever one — `onTick` returns nothing and
takes a function, so a helper that assumed "numbers in, string out" would be a shape the next
binding got wrong silently.

**Give the guest library a `Vector3` that crosses as an object.** Rejected: object identity
crossing is what ADR 0015 rules out, and every function that takes a position takes a
`Vec3Like` triple, which `toArray()` produces. The class is guest-side only, and that is stated
on it rather than being a surprise.

## What this does not decide

**Nothing here applies an effect to a world.** `parseEffect` returns something trusted (ADR 0017) and the library dispatches strings; Phase D's host is what carries them out, and it is
where `PlaceRegistry`, `EventLog` and the player come together.

**No place is loaded from anywhere yet.** `bundlePlace` takes a set of files as an argument, so
the on-disk form — a zip with a manifest, as the sibling project has — is Phase F's decision and
unchanged by this one.

**`onPlan` is not here, deliberately.** The sibling project has it: a callback that runs once
against a region and returns shapes declaratively, before any streaming. It exists there to
make chunk generation a pure function of a region, which is worth having. It is not needed
here, because a place's geometry goes into `PlaceRegistry` as ordinary operations and one bulk
edit is one `setOperations` — a single stall while a place appears, which is the same thing
`onPlan` would have bought at the cost of a second execution mechanism and a compile step.
Worth revisiting if place geometry ever becomes the streaming bottleneck.
