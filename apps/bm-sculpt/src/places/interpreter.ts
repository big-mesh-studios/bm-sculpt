/**
 * The interpreter: a place's code, running, with the caps that keep it from taking the peer
 * with it.
 *
 * ## What it is
 *
 * A QuickJS interpreter compiled to WebAssembly, into which a bundle from `bundle.ts` is
 * loaded once and then stepped. The script reaches the host through exactly one object,
 * passed as a *function parameter*, and everything that crosses that boundary is a string or
 * a number. ADR 0015 is the decision this implements; this file and `bridge.ts` are its
 * consequences.
 *
 * ## The five properties that hold here
 *
 * 1. **Isolation is by construction.** No `fetch`, no timers, no DOM, no `process`. Not
 *    denied — *absent*. Nothing a future QuickJS release could re-open.
 * 2. **`engine` is a parameter**, so a script that never received it has no way to name it —
 *    including code compiled later by a `Function` constructor, which happens in global
 *    scope and sees nothing.
 * 3. **Nothing crosses as an object.** `bridge.ts` says what crosses; this file is what
 *    enforces it, one binding at a time.
 * 4. **Three caps: step, memory, interpreter stack.** The third is load-bearing rather than
 *    hygiene — `DEFAULT_STACK_LIMIT_BYTES` records the measurement, and without it a script
 *    is a remote kill of the peer.
 * 5. **`Math.random` is seeded and `Date.now` answers from an injected clock**, so two peers
 *    running the same place agree.
 *
 * ## Load once, step many times
 *
 * **`load` and `step` are separate, and that is the shape the host needs.** The bundle is
 * evaluated once — which is when a place's `onTick` calls run, and so when its top-level code
 * decides what the place *is* — and then the host calls `step` every frame with the clock
 * and whatever events arrived. A place that built itself per frame would be a place that
 * rebuilt itself per frame.
 *
 * **A step's budget is spent by the handlers the place registered**, in the order it
 * registered them, and a handler that throws ends the step rather than the interpreter: the
 * remaining handlers are skipped and the error is reported, because a script that throws on
 * the first tick would otherwise throw on every tick forever.
 */

import { MAX_STEP_MS } from "./limits";
import { GUEST_QUERIES, type GuestBridge } from "./bridge";
import { asPlaceSource } from "./bundle";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

/**
 * The most memory one interpreter may allocate, in bytes.
 *
 * Sixteen mebibytes is roughly a QuickJS runtime plus a modest script. It is
 * generous for the scripts a person writes and small enough that a runaway
 * allocation is stopped before the tab's own heap is the thing under pressure.
 */
export const DEFAULT_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * The most interpreter stack one script may use, in bytes. **Load-bearing.**
 *
 * Measured on this machine, one process per value, each running an unbounded
 * recursion and then trying to free the runtime:
 *
 * | limit      | unbounded recursion        | context after | runtime freed | honest depth |
 * | ---------- | -------------------------- | ------------- | ------------- | ------------ |
 * | *none*     | **process dies**           | —             | —             | —            |
 * | 64 KiB     | `InternalError` stack overflow | still alive | yes        | 250          |
 * | 128 KiB    | `InternalError` stack overflow | still alive | yes        | 500          |
 * | 256 KiB    | `InternalError` stack overflow | still alive | yes        | 1000         |
 * | 384 KiB    | **process dies**           | —             | —             | —            |
 *
 * The row that matters is the first one. **Without this limit a script is a
 * remote kill.** Unbounded recursion overflows the *host's* JavaScript stack,
 * not the interpreter's, and that arrives as a `RangeError` thrown straight
 * through the WebAssembly boundary — and then the runtime cannot be freed,
 * because the overflow left objects on a list the interpreter asserts is empty.
 * Freeing it calls into an assertion that fails, which in WebAssembly is not an
 * exception but `abort()`. The peer does not get an error it can report; the tab
 * goes away. `list_empty(&rt->gc_obj_list)` is what that looks like in a
 * console, and nothing in the failure points at the script that did it.
 *
 * With the limit set, the interpreter trips its own counter first and reports an
 * ordinary catchable error, the context survives, and the runtime frees cleanly.
 *
 * **128 KiB rather than 256**, which also works and allows deeper recursion: the
 * window between "works" and "process dies" is only about one and a half times
 * wide, and it is a function of the *host's* stack, which differs between a
 * browser main thread, a worker and Node. A quarter-mebibyte limit sits far
 * enough below the failure to survive being wrong about the host. Five hundred
 * frames of honest recursion is far more than a place script will ever use — the
 * recursion in these tests is unbounded precisely because no real script does it.
 */
export const DEFAULT_STACK_LIMIT_BYTES = 128 * 1024;

/** Why a step stopped, which is what the host reports and what a test asserts. */
export type ScriptErrorKind =
  /** Ran past its deadline. The interpreter's own `InternalError`. */
  | "interrupt"
  /** Asked for more memory than the cap allows. */
  | "memory"
  /** Recursed past the interpreter's stack limit. Also an `InternalError`. */
  | "stack"
  /** The script threw. Whatever it threw is in `message`. */
  | "exception"
  /** The interpreter could not run the code at all. */
  | "fatal";

/**
 * A script that failed, and why.
 *
 * A class rather than a plain object because the host catches this across an
 * `await` boundary and `instanceof` is the cheapest thing that survives that.
 * `kind` is the part anything branches on; `message` is what a person reads.
 */
export class ScriptExecutionError extends Error {
  readonly kind: ScriptErrorKind;

  constructor(kind: ScriptErrorKind, message: string) {
    super(message);
    this.name = "ScriptExecutionError";
    this.kind = kind;
  }
}

/**
 * The interpreter binary, shared by every sandbox in the peer.
 *
 * One instance rather than one per place: the WebAssembly module is half a
 * megabyte and is immutable once loaded, and a peer running four places should
 * not pay for it four times. Each sandbox still gets its own *runtime*, so the
 * memory cap and the interrupt handler are genuinely per script.
 */
let modulePromise: Promise<QuickJSWASMModule> | undefined;

/** Whether this is Node rather than a browser. */
const runningUnderNode = (): boolean =>
  typeof process !== "undefined" && process.versions?.node !== undefined;

/**
 * Loads the interpreter.
 *
 * **The two branches are the point of this function, and the reason is measured
 * rather than assumed.** A bundler picks a package's `browser` export condition
 * in preference to its Node one, and this package's browser build fetches the
 * WebAssembly over the network. Under Vitest — which uses Vite's pipeline — the
 * result is not a diagnostic but an abort:
 *
 * ```
 * Aborted(both async and sync fetching of the wasm failed)
 *   at node_modules/…/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.browser.mjs
 * ```
 *
 * The failure is an `abort()` from inside the Emscripten module — not an
 * exception, so it cannot be caught and reported — and nothing in it names the
 * cause. Under a dev server or a production build the same fetch *would*
 * succeed, which is why this is invisible until a test runs: the browser path
 * is not wrong, it is simply not the Node path.
 *
 * So the Node branch bypasses the package's loader entirely and reaches its own
 * shipped files (`dist/ffi.mjs` and `dist/emscripten-module.mjs`) by absolute
 * path. The browser branch does the opposite: it takes the bytes as an explicit
 * asset URL from a `?url` import, which Vite *does* rewrite correctly, because
 * the loader's own guess from its own module location is the thing that cannot
 * be trusted once a bundler has moved it.
 *
 * Only the Node half is asserted in a unit test; the browser half needs a real
 * page, which is what `/places-probe.html` and `src/places-probe.ts` are for.
 */
const loadModule = (): Promise<QuickJSWASMModule> => {
  if (!runningUnderNode()) {
    return (async () => {
      // The `?url` is what makes this work, and it is the only thing here that
      // is specific to a bundler: Vite rewrites it to the URL it will actually
      // serve the binary from, with the right content type. What it must not do
      // is rewrite the loader's own idea of where the binary is.
      const { default: wasmUrl } =
        await import("@jitl/quickjs-wasmfile-release-sync/wasm?url");
      // Dynamic so the variant's own module — and with it the browser build of
      // the Emscripten loader — is only fetched in a browser. Under Node this
      // branch never runs and the test never pays for it.
      const { default: variant } =
        await import("@jitl/quickjs-wasmfile-release-sync");
      return newQuickJSWASMModuleFromVariant(
        newVariant(variant, { wasmLocation: wasmUrl }),
      );
    })();
  }
  return (async () => {
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const require = createRequire(import.meta.url);
    const jitlRoot = dirname(
      require.resolve("@jitl/quickjs-wasmfile-release-sync/package.json"),
    );
    return newQuickJSWASMModuleFromVariant({
      type: "sync",
      importFFI: () =>
        import(pathToFileURL(join(jitlRoot, "dist", "ffi.mjs")).href).then(
          (module) => module.QuickJSFFI,
        ),
      importModuleLoader: () =>
        import(
          pathToFileURL(join(jitlRoot, "dist", "emscripten-module.mjs")).href
        ).then((module) => module.default),
    });
  })();
};

/**
 * A seeded `Math.random`, so two peers drawing the same place agree.
 *
 * `mulberry32`: thirty-two-bit state, no dependencies, and — the property that
 * matters here — the *same sequence for the same seed on every machine*, since
 * it is defined entirely in terms of `Math.imul`, `>>>` and `|0`. The host's own
 * `Math.random` cannot be used for this: it draws from system entropy, so two
 * peers would diverge on the first call and never re-converge.
 *
 * Not security-reviewed and not claimed to be. A place script has no access to
 * anything worth attacking it for.
 */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * A dumped guest error, as far as it is worth reading.
 *
 * The interpreter's own errors are objects, so `dump` gives a structure rather
 * than a string; the two that matter are `InternalError` with a message of
 * `interrupted` or `out of memory`, and they are how a runaway script announces
 * which cap caught it.
 */
interface GuestError {
  readonly name?: string;
  readonly message?: string;
}

/**
 * Reads the name and message out of a thrown guest value, whatever shape it is.
 *
 * A script can throw anything, so this cannot assume an object. A thrown
 * number has no `.message`, and reading one off it yields `undefined` rather
 * than throwing — but only because QuickJS boxes primitives on property access,
 * which is a detail worth not depending on. Hence the typeof guard.
 */
const describeGuestError = (
  context: QuickJSContext,
  handle: QuickJSHandle,
): GuestError | string => {
  const kind = context.typeof(handle);
  if (kind !== "object" && kind !== "string") {
    return `threw a ${kind}`;
  }
  const dumped: unknown = context.dump(handle);
  if (typeof dumped === "string") return dumped;
  if (dumped !== null && typeof dumped === "object") {
    return dumped as GuestError;
  }
  return "threw nothing recognisable";
};

/**
 * Turns a guest error into the kind the host branches on.
 *
 * The interpreter reports all three of its own limits the same way — an
 * `InternalError`, distinguished only by message — so this is the one place they
 * are told apart. That is the whole reason `ScriptErrorKind` exists: `onNotice`
 * wants to say "this step ran too long" rather than print a stack trace from
 * inside a WebAssembly module.
 */
const classify = (error: GuestError | string): ScriptErrorKind => {
  if (typeof error !== "string" && error.name === "InternalError") {
    if (error.message === "interrupted") return "interrupt";
    if (error.message === "out of memory") return "memory";
    if (error.message === "stack overflow") return "stack";
  }
  return "exception";
};

const messageOf = (error: GuestError | string): string => {
  if (typeof error === "string") return error;
  const message = error.message;
  return message === undefined
    ? "no message"
    : `${error.name ?? "Error"}: ${message}`;
};

/** What the host gives the interpreter to work with. */
export interface InterpreterOptions {
  /** Seed for `Math.random`. Peers running the same place pass the same one. */
  readonly seed: number;
  /** Answers `Date.now`. Injected rather than read so peers can be given a shared clock. */
  readonly now: () => number;
  /** What `engine.dispatch` reaches. */
  readonly onDispatch: (tag: string, payloadJson: string) => string;
  /** What `engine.query` reaches. */
  readonly onQuery: (name: string, argsJson: string) => string;
  readonly stepBudgetMs?: number;
  readonly memoryLimitBytes?: number;
  /** Interpreter stack. See `DEFAULT_STACK_LIMIT_BYTES` before changing it. */
  readonly stackLimitBytes?: number;
}

/** One registered tick handler, and where it came from. */
interface TickHandler {
  readonly handle: QuickJSHandle;
  /** How many handlers were registered before this one, for the error message. */
  readonly ordinal: number;
}

export interface Interpreter {
  /**
   * Evaluates a bundle once, as the body of a function whose one parameter is `engine`.
   *
   * **This is when a place's top-level code runs**, which is when its `onTick` calls
   * register and when it decides what it is. The result is not kept: a bundle is a program,
   * not a library, so its only outputs are the effects it dispatched and the handlers it
   * registered.
   *
   * May be called again to load a different place into the same interpreter, which disposes
   * the previous place's handlers first — so a re-load cannot leave a dead place's handler
   * running against the new one's world.
   */
  load(bundle: string): void;

  /**
   * Evaluates source as a function body and hands back what it returned.
   *
   * **A host's tool, not a place's.** It exists because two callers genuinely need it and
   * neither is a place: the interpreter's own tests ask the interpreter questions it has no
   * other way to answer (is `fetch` defined in here?), and `places-probe.html` prints a
   * verdict per claim by evaluating an expression. A place cannot reach it — the bindings
   * are the whole of what `engine` carries, and this is not one of them.
   */
  evaluate(source: string): unknown;

  /**
   * Runs every registered handler once, inside one step budget.
   *
   * @param clockJson the shared clock, as JSON — a number, so a malformed one is visible
   * @param eventsJson the events since the last step, as a JSON array
   *
   * **The budget covers all of them together, not each.** A place with fifty handlers gets
   * one step's worth of time, so adding handlers cannot buy a place more time than one with
   * a single handler — which a per-handler budget would have allowed, and which is a way to
   * make the cap meaningless.
   */
  step(clockJson: string, eventsJson: string): void;

  /** How many handlers the loaded place registered. */
  readonly handlerCount: number;

  /** Frees the interpreter's memory. An interpreter that is not disposed leaks. */
  dispose(): void;
}

/**
 * Builds one isolated interpreter.
 *
 * **Every binding is a string or a number in and a string out**, and the arithmetic is
 * written out rather than shared, because a general `bind("numbers to strings")` helper would
 * be a way for the next binding to be added by accident with the wrong shape. Five
 * hand-written bindings beat one clever one.
 */
export const createInterpreter = async (
  options: InterpreterOptions,
): Promise<Interpreter> => {
  modulePromise ??= loadModule();
  const wasm = await modulePromise;

  const runtime: QuickJSRuntime = wasm.newRuntime();
  runtime.setMemoryLimit(
    options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
  );
  // The third cap, and the only one whose absence is fatal rather than merely
  // unhelpful. `DEFAULT_STACK_LIMIT_BYTES` says why this line is not optional.
  runtime.setMaxStackSize(options.stackLimitBytes ?? DEFAULT_STACK_LIMIT_BYTES);

  // The deadline is a field rather than a closure over a local because the handler is
  // installed once and read on every interrupt the interpreter raises — and because
  // `Infinity` outside a step is what lets ordinary work through: the handler runs constantly
  // while code executes, so a handler that always said yes would be the default and one that
  // always said no would make nothing run.
  let deadline = Infinity;
  runtime.setInterruptHandler(() => Date.now() > deadline);

  const context = runtime.newContext();
  const random = mulberry32(options.seed);
  const stepBudgetMs = options.stepBudgetMs ?? MAX_STEP_MS;

  installDeterministicGlobals(context, random, options.now);

  /** The place's handlers, in the order it registered them. */
  let handlers: TickHandler[] = [];
  // The engine object is built once and held here rather than installed on the context's
  // global. Nothing on the global object can reach it; only `load` can hand it over.
  const engine = context.newObject();
  bind(context, engine, "dispatch", (args): string => {
    if (args.length !== 2) return "dispatch takes a tag and a payload";
    return options.onDispatch(
      context.getString(args[0]),
      context.getString(args[1]),
    );
  });

  bind(context, engine, "query", (args): string => {
    if (args.length !== 2) return "query takes a name and arguments";
    const name = context.getString(args[0]);
    // **Checked here as well as by the host.** `GUEST_QUERIES` is the closed set, and a
    // script asking for a query this build does not have should be told so rather than
    // handed whatever the host happens to return for an unknown name — which is how a
    // version skew becomes a world that quietly answers the wrong question.
    if (!(GUEST_QUERIES as readonly string[]).includes(name)) {
      return JSON.stringify({ error: `no query called ${name}` });
    }
    return options.onQuery(name, context.getString(args[1]));
  });

  bind(context, engine, "onTick", (args): undefined => {
    // **The only thing handed from the guest to the host without being validated**, and safe
    // because it is a reference rather than data: the host can only call it, and only with
    // what the host itself produced.
    //
    // `dup`ed because the handle has to outlive this call — QuickJS frees an argument when
    // its call frame ends, so keeping the argument itself would leave the handler pointing
    // at freed memory and the interpreter would abort rather than throw.
    const [first] = args;
    if (first === undefined || context.typeof(first) !== "function")
      return undefined;
    handlers.push({ handle: first.dup(), ordinal: handlers.length });
    return undefined;
  });

  bind(context, engine, "now", () => options.now());
  bind(context, engine, "random", () => random());

  /**
   * Asserts the bridge a caller is holding is the one this interpreter implements.
   *
   * **Never called at runtime** — it exists so that the shape in `bridge.ts` and the shape
   * installed on the `engine` object cannot drift without `tsc` noticing. The cast below is
   * what makes that work: if a method were added to `GuestBridge` and not bound here, this
   * would stop compiling.
   */
  const bridgeShape: GuestBridge = {
    dispatch: () => "",
    query: () => "",
    onTick: () => undefined,
    now: () => 0,
    random: () => 0,
  };
  void Object.keys(bridgeShape);

  /**
   * Evaluates and calls, translating both of the ways that can fail.
   *
   * **There are two, and the second one is only visible because this was a spike once.**
   * The documented way is a returned `{ error }` handle carrying `InternalError`. But a
   * script that recurses without end overflows the *host's* stack rather than the guest's,
   * and that arrives as an ordinary `RangeError` thrown straight through the WebAssembly
   * boundary, with no handle and nothing to classify.
   *
   * So a host that catches only `ScriptExecutionError` lets a one-line script escape its own
   * error handling. Both are caught, and both come out as the same type, because "the
   * interpreter refused" is the only distinction a caller can act on.
   */
  function call(body: string): unknown {
    try {
      const fn = context.evalCode(asPlaceSource(body), "place.js");
      if (!isValue(fn)) throw guestFailure(context, fn.error);

      try {
        const called = context.callFunction(
          fn.value,
          context.undefined,
          engine,
        );
        if (!isValue(called)) throw guestFailure(context, called.error);
        try {
          return context.dump(called.value);
        } finally {
          called.value.dispose();
        }
      } finally {
        fn.value.dispose();
      }
    } catch (error) {
      if (error instanceof ScriptExecutionError) throw error;
      // Not a guest error: the interpreter itself could not continue. Reported as an
      // exception because it is the script's doing and the fix is the script's, but the
      // message says what actually happened, because "Maximum call stack size exceeded" from
      // inside a WebAssembly module is otherwise unreadable.
      throw new ScriptExecutionError(
        "exception",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Spends one step's budget running `body`, or throws explaining why it stopped. */
  const withinBudget = (body: () => unknown): unknown => {
    deadline = Date.now() + stepBudgetMs;
    try {
      return body();
    } finally {
      // Past the deadline rather than reset to it: a step that throws has still spent its
      // budget, and a script that fails on every frame must not get a fresh allowance each
      // time or the cap is not a cap.
      deadline = Infinity;
    }
  };

  const releaseHandlers = (): void => {
    for (const handler of handlers) handler.handle.dispose();
    handlers = [];
  };

  return {
    load(bundle: string): void {
      // A previous place's handlers go first. Leaving them would mean a re-loaded place's
      // world being driven by a dead place's script — which would look like the new script
      // misbehaving.
      releaseHandlers();
      withinBudget(() => call(bundle));
    },

    evaluate(source: string): unknown {
      return withinBudget(() => call(source));
    },

    step(clockJson: string, eventsJson: string): void {
      if (handlers.length === 0) return;

      const clock = context.newString(clockJson);
      const events = context.newString(eventsJson);
      try {
        withinBudget(() => {
          for (const handler of handlers) {
            const called = context.callFunction(
              handler.handle,
              context.undefined,
              clock,
              events,
            );
            // One handler that throws ends the step, and the rest are skipped. Which is a
            // choice: a script whose first handler throws would otherwise throw on every
            // frame forever, and the notice would be a frame-rate problem rather than a bug
            // report.
            if (!isValue(called)) throw guestFailure(context, called.error);
            called.value.dispose();
          }
        });
      } finally {
        clock.dispose();
        events.dispose();
      }
    },

    get handlerCount(): number {
      return handlers.length;
    },

    dispose(): void {
      releaseHandlers();
      engine.dispose();
      context.dispose();
      runtime.dispose();
    },
  };
};

/**
 * Installs one host function on the `engine` object.
 *
 * `implementation` returns either a number or a string and is given the guest's arguments as
 * handles, so it reads them itself. **Deliberately not a general "numbers in, strings out"
 * helper**: `onTick` returns nothing and takes a function, so a helper that assumed the
 * common shape would be a shape a future binding got wrong silently.
 */
const bind = (
  context: QuickJSContext,
  engine: QuickJSHandle,
  name: string,
  implementation: (args: QuickJSHandle[]) => number | string | undefined,
): void => {
  const method = context.newFunction(name, (...args: QuickJSHandle[]) => {
    const result = implementation(args);
    if (result === undefined) return context.undefined;
    if (typeof result === "number") return context.newNumber(result);
    return context.newString(result);
  });
  context.setProp(engine, name, method);
  method.dispose();
};

/**
 * Whether an interpreter call returned a value rather than an error.
 *
 * The library types every call as `{ value } | { error }` and does not narrow
 * it, so this is the narrowing. Written as a type predicate rather than an
 * `instanceof` because the two results are plain objects, and there is no class
 * to test.
 */
const isValue = <T>(
  result: { readonly value: T } | { readonly error: T },
): result is { readonly value: T } => "value" in result;

/** Builds the thrown error for a failed interpreter call. */
const guestFailure = (
  context: QuickJSContext,
  handle: QuickJSHandle,
): ScriptExecutionError => {
  const described = describeGuestError(context, handle);
  handle.dispose();
  return new ScriptExecutionError(classify(described), messageOf(described));
};

/**
 * Replaces the two sources of nondeterminism a script could otherwise reach.
 *
 * Both are *replacements* rather than additions, which is why nothing has to be
 * revoked afterwards: `Math.random` and `Date.now` are assigned over, so a
 * script cannot reach the originals at all.
 *
 * `Date.now` is the one that matters for the shared-clock plan. Wall time is
 * what a peer reads if it is left alone, and two peers a few hundred
 * milliseconds apart would then order the same events differently and diverge
 * permanently.
 */
const installDeterministicGlobals = (
  context: QuickJSContext,
  random: () => number,
  now: () => number,
): void => {
  const math = context.getProp(context.global, "Math");
  const randomFn = context.newFunction("random", () =>
    context.newNumber(random()),
  );
  context.setProp(math, "random", randomFn);
  randomFn.dispose();
  math.dispose();

  const date = context.getProp(context.global, "Date");
  const nowFn = context.newFunction("now", () => context.newNumber(now()));
  context.setProp(date, "now", nowFn);
  nowFn.dispose();
  date.dispose();
};
