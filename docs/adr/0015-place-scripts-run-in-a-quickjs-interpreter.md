# 0015 — Place scripts run in a QuickJS interpreter, and all three of its caps are set

## Context

A place is a piece of code someone else wrote that runs inside the peer while the peer is
trying to render sixty frames a second. That is the whole problem, and every part of it
follows from who wrote it: a script is not trusted, it is not fast, and it is not ours to
debug.

The sibling project (`big-mesh-studios/apps/voxelscape`) already answers this, with a
QuickJS interpreter compiled to WebAssembly and a host that validates every effect a
script dispatches. The question here was never whether to copy that. It was whether it
_works_, in this repository and on this machine — and that is a real question rather than
a formality, because **this repository has already been broken once by a dependency that
did not run here.** `vite-plugin-solid` from `3.0.0-next.21` drives the native Solid
compiler, a platform binary, whose published `linux-arm64-gnu` build cannot load on
Termux: Linux on arm64 that uses Bionic rather than glibc. That is why the entire
framework toolchain is pinned back to the Babel line, and the cost of finding out is
written into `pnpm-workspace.yaml`.

So the interpreter was spiked before the feature, the way this repository settles a
question that would otherwise force a redesign later: `src/places/interpreter.ts` and its
twenty tests, plus `/places-probe.html` for the one claim a test process cannot make.
`@jitl/quickjs-wasmfile-release-sync@0.32.0`, which is
`quickjs@2025-09-13+f1139494`, half a megabyte of WebAssembly, no native binary anywhere in
it.

## Decision

**A place's code runs inside a QuickJS interpreter compiled to WebAssembly. It reaches the
engine through exactly one object, passed as a function parameter. All three of the
interpreter's limits are set, and the third one is load-bearing.**

- **Isolation is by construction, not by policy.** A script has no `fetch`, no
  `setTimeout`, no `document`, no `window`, no `process`, no `require`, no `importScripts`,
  no `localStorage`. Not denied — _absent_. `places-probe.ts` probes eighteen names and the
  probe asserts all eighteen are `undefined`. A Web Worker sandbox would find `fetch`
  there and would have to refuse it; this one has nothing to refuse, and so nothing a
  future interpreter release could quietly re-open.
- **`engine` is a parameter.** The script's source is the body of
  `(function (engine) { … })`, so a script that never receives the object cannot name it.
  A global would be reachable from anywhere, including from a `Function` constructor's
  body or any prototype method; the probe asserts that
  `new Function("return typeof engine;")()` is `undefined`.
- **Nothing crosses as an object.** Numbers in, strings out, in both directions.
- **`Math.random` is seeded and `Date.now` answers from a caller-supplied clock**, so two
  peers running the same place agree. Both are _replacements_ rather than additions, so
  nothing has to be revoked afterwards. The seed generator is pinned to its own output in a
  test, because a change to it would change every place's world on every peer with nothing
  on screen to say so.
- **Three caps: 250 ms of step, 16 MiB of memory, 128 KiB of interpreter stack.** Each is
  one `setInterruptHandler` deadline, one `setMemoryLimit`, one `setMaxStackSize`.

## Consequences

**The stack cap is not hygiene. Without it a place script is a remote kill of the peer.**
This is the finding the spike was run for, and it is worth stating in full.

Unbounded recursion overflows the _host's_ JavaScript stack rather than the interpreter's,
so it arrives as a `RangeError` thrown straight through the WebAssembly boundary with no
handle to inspect. That is survivable on its own. What is not survivable is what it leaves
behind: the overflow strands objects on a list the interpreter asserts is empty, and
freeing the runtime calls that assertion, which in WebAssembly is not an exception but
`abort()`. The peer does not get an error it can report. The tab goes away, and
`list_empty(&rt->gc_obj_list)` names neither the cause nor the script.

Measured on this machine, one process per value, each running an unbounded recursion and
then trying to free the runtime:

| stack limit | unbounded recursion             | context after | runtime freed | honest depth |
| ----------- | ------------------------------- | ------------- | ------------- | ------------ |
| _none_      | **process dies**                | —             | —             | —            |
| 64 KiB      | `InternalError: stack overflow` | alive         | yes           | 250          |
| 128 KiB     | `InternalError: stack overflow` | alive         | yes           | 500          |
| 256 KiB     | `InternalError: stack overflow` | alive         | yes           | 1000         |
| 384 KiB     | **process dies**                | —             | —             | —            |

So the limit makes an ordinary catchable error out of a fatal one, and
`interpreter.test.ts` asserts all three halves of that: the kind is `stack`, the context
still runs afterwards, and `dispose()` does not abort. **128 KiB rather than 256**, which
also works and allows deeper recursion, because the window between "works" and "process
dies" is only about one and a half times wide — and that window is a function of the
_host's_ stack, which differs between a browser main thread, a worker and Node. Five
hundred frames of honest recursion is far more than a place script will use.

**There are two ways a step can fail, not one, and only one is in the API.** The
documented failure is a returned `{ error }` handle carrying `InternalError`. The
undocumented one is the host-side `RangeError` above. A host that catches only its own
error type — the obvious reading of the API, and what the first draft of the spike did —
lets a one-line script escape into whatever frame called it. Both are caught, and both come
out as the same type, because "the interpreter refused" is the only distinction a caller can
act on. `ScriptErrorKind` then tells them apart by message.

**The interpreter must be loaded two different ways, and the reason is not stylistic.** A
bundler prefers a package's `browser` export condition over its Node one, and this
package's browser build fetches the WebAssembly over the network. Under Vitest — which
uses Vite's pipeline — the result is not a diagnostic but
`Aborted(both async and sync fetching of the wasm failed)` from inside the Emscripten
module, uncatchable, naming nothing. Under a dev server or a production build the same
fetch _would_ succeed, which is why this is invisible until a test runs. So the Node branch
bypasses the package's loader and reaches its shipped `dist/ffi.mjs` and
`dist/emscripten-module.mjs` by absolute path, and the browser branch does the opposite: it
takes the bytes as an explicit `?url` asset, which Vite rewrites correctly, because the
loader's own guess from its own module location is the one thing a bundler cannot be
trusted to leave alone. `places-probe.ts` exists because only the browser half needs a real
page, and a screenshot or a number is the artefact a person can read afterwards.

**The interpreter binary is shared, the runtime is not.** One module per peer — it is half
a megabyte and immutable once loaded, and a peer running four places should not pay for it
four times — but a runtime each, because the memory cap and the interrupt handler are
genuinely per script. A step is a _synchronous_ call, and the whole design rests on that: no
guest promises, no `await`, no microtask drain, so a script cannot suspend and be resumed
against a world that moved underneath it.

**Determinism is now an input to every API rather than a property of one.** The seed, the
clock and the sorted delivery order are arguments, not accidents, and every handle a script
holds has to be derivable rather than generated. Retrofitting that later means re-auditing
every signature; this is the cheap moment to have it.

## Alternatives

**`new Function` in the page.** Rejected: zero dependencies is not worth it. A script
reaches `window`, `document` and `fetch`; an exception kills the frame rather than the
script; and there is no interrupt handler, so "250 ms" becomes a hope. Worth it only if
places were never anything but our own code, and the premise here is that they are not.

**A Web Worker with `postMessage`.** Rejected: cheaper than an interpreter and off the
main thread, but the containment is weaker than it looks — a worker still has `fetch`,
`importScripts` and dynamic `import()`. It also puts an asynchronous boundary through every
host call, which is the one thing this design is shaped to avoid.

**Rely on the memory and interrupt caps alone, leaving the stack alone.** Rejected on the
measurement above. It is also the mistake that looks harmless: the other two caps turn a
runaway script into a reportable error, and this one turns it into an `abort()`.

**Set the stack limit generously, at 256 KiB or more.** Rejected for a reason about the
host rather than the script: the safe window is narrow and moves between runtimes, so a
limit picked for its recursion depth is a limit picked for the wrong property.

**`WebAssembly.instantiateStreaming`, or a hand-rolled loader.** Rejected: the loader is
not the interesting part, and the package's own is fine once its module location is
corrected. Writing our own would be a second thing to keep working.

## What this does not decide

The effect vocabulary, the guest API, bundling a place's TypeScript into one scope, and
what a place _is_ in the operation list — that last one is the next decision, and it is
about ownership rather than about execution. `src/places/interpreter.ts` is named for what
it is and is expected to be absorbed or replaced by that work rather than built on as
though it were the design.
