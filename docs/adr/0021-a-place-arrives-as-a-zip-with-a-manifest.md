# 0021 — A place arrives as a zip with a manifest at its root

## Context

Everything through ADR 0020 works, and none of it can be handed to anybody. A place is a
`PlaceFiles` record — a `Record<string, string>` — built in `demos.ts` from `?raw` imports of
files that are in the tree. There is no format, so:

- a place cannot be exported, sent, or fetched;
- a place cannot be authored outside this repository at all, because nothing outside it can
  produce the record the host wants;
- and `/place:load` can only ever name one of three demos.

`big-mesh-studios`'s voxelscape has solved this already, in `apps/voxelscape/src/places/`, and the
brief for this repository has been to agree with it rather than invent a second answer. Its format
is a **zip carrying a `manifest.json` at the root**, read by `readPlaceZip`, validated by
`isPlaceManifest` before any of it goes anywhere.

## Decision

**`src/places/place-file.ts` is the manifest and its validator. `src/places/load-place.ts` turns a
`Blob` into the `{ files, entry }` the host already takes. `jszip` is the only new runtime
dependency, and it is dynamically imported so it reaches only `/place:open`.**

- **`entry` is this repository's one addition.** voxelscape's manifest names `scripts[]` and lets
  its runtime decide which is the program; `PlaceHost` is handed an explicit entry and refuses one
  that is not among the place's files. Stating it means the artefact says what runs, and
  `/place:list` can say so without opening the place.
- **`levels`, `models` and `mode` are omitted rather than accepted and ignored.** They are
  voxelscape's level plans, its rm-stacker models, and its multiplayer switch — a plan handler, a
  figure system and a networked session, none of which exist in v1. **A field this accepts is a
  promise**, and each is one line to add when the thing it names does.
- **`/place:open` is a file picker, not a URL.** voxelscape's `browser-fs-access` dependency turns
  out not to be what opens a place — it uses a plain `<input type="file">` — so no UI dependency was
  added either.
- **A place that cannot be fully read is refused entirely.** ADR 0017's all-or-nothing rule one
  level up: a place with one import resolving to nothing is a different place, and the failure
  would surface as an interpreter stack frame in a scope nobody wrote.
- **`MAX_PLACE_SOURCE` is a new total**, in `limits.ts`, because `MAX_SCRIPT_SOURCE` bounds one file
  and `MAX_PLACE_FILES` bounds how many — and the product is forty million characters arriving into
  a tab that then compiles each with a real TypeScript `Program`.
- **`isSafePathName` is the whole path-traversal defence**, as four rules rather than
  normalise-then-check, which would have to be right about symlinks, drive letters, NUL bytes,
  percent-encoding and Unicode normalisation.

## Consequences

**The loader refuses an undeclared `.ts` in the zip, and the reference drops it.** This is the one
deliberate divergence, and it was a judgement rather than an oversight. Two things are true of an
archive carrying a script its manifest does not name: declaring is what makes a file part of the
program, so an undeclared `.ts` is dead weight — and the archive and the manifest were written by
different tools, or different versions of one, which means "what is actually in this zip" is not a
question anybody can answer. The second is the reason it refuses. A `LICENSE` or a `README.md` is
ignored, because somebody handing over a folder of scripts has a licence in it and this loader has
no opinion about licences.

**A file picker is the one place a promise must settle that nothing else decides.** The console
replaces its `…` line when the command's promise resolves (ADR 0020), so a picker the person
dismissed — the common case the first time anyone tries this — would leave that line on screen for
the rest of the session. `openFromDisk` therefore resolves on the input's `cancel` event as well as
on `change`, and `place-commands.ts` asserts the dismissal is passed through rather than swallowed.

**`jszip` is 97 kB in its own chunk and is not in the first frame.** The dynamic import is the
whole of that: `dist/assets/load-place-*.js` is 29 kB gzipped and `pako` appears in it and nowhere
else. A top-level import would have put a zip reader in every session's critical path for a feature
most sessions never use.

**The bytes are read to an `ArrayBuffer` before JSZip sees them, for the second time in this
repository's history.** `JSZip.loadAsync` reads a `Blob` through the browser's `FileReader`, which
Node does not provide; the reference hit this and left the reason in a comment. It is here for the
same reason, and the test file hit it again independently — `generateAsync` returns a
`Uint8Array<ArrayBufferLike>`, which is not a `BlobPart`, so a view over a larger buffer would also
hand the loader trailing bytes that are not in the archive.

**A manifest's `spawn` is honoured, because a field that is read is a field the format keeps.**
`startPlace` teleports the player when the manifest names one. Had it been left unread, `spawn`
would have been exactly the thing this repository criticises elsewhere: a promise in an artefact
that nothing in the engine keeps.

**Two repo guards caught real mistakes, which is the argument for having them.**

- `limits.test.ts` refuses an exported limit that nothing references. It failed on `MAX_PLACE_SOURCE`
  the moment it was written, because the guard scans a fixed list of consumer files and
  `load-place.ts` was not on it. Adding the file to the list was the fix; inventing a second
  enforcement site would have left the guard blind.
- Its second test, "covers every limit a payload field can reach", holds a register of limits
  covered elsewhere. `MAX_PLACE_SOURCE` had to be added there too — it is a **sum over a manifest's
  files** and so cannot be reached by any payload at all, which is precisely why it is checked at
  the limit and one character past it in `load-place.test.ts` rather than in the table.

**What is still not here.** A place cannot be _written_ — there is no exporter, and
`demos.test.ts` now covers a place only from a hand-built zip. `/place:open` reads a file a person
produced with some other tool; this repository does not yet produce one. And `getSurfaceVelocityAt`
and `getSeatYawAt` remain absent, because they need moving surfaces and figures respectively —
which the props phase is now expected to bring.

## Notes

One place on disk is `LoadedPlace`: the manifest, the files the manifest named, and the entry.
`PlaceHost` was not changed, and neither was the bundler — which is the property worth having. A
place in the tree and a place out of a zip are the same `{ files, entry }` by the time they reach
the host, so `/place:load bridge` and `/place:open` differ only in where the files came from and
which seed the world is built under. Two paths would have meant two places where a geometry change
stops reaching the mesh.
