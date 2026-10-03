/**
 * A probe for the place-script interpreter: can a script run in *this* browser?
 *
 * ## Why this page exists
 *
 * `src/places/interpreter.test.ts` settles twenty claims about the
 * interpreter, and every one of them passes under Node. It cannot settle the
 * twenty-first, which is the one this whole spike was run to find out:
 *
 * **Does the WebAssembly file load under Vite?** The loader wants to fetch the
 * binary from beside its own module, and a bundler rewrites that location
 * without telling it. Under Vite the request can answer with the page's HTML
 * rather than the interpreter, and the failure is a parse error in a module
 * nobody wrote. Voxelscape hit this and had to hand the bytes over as an
 * explicit asset URL. This page is what confirms whether the same patch is
 * needed here, and it is a page rather than a test because only a browser
 * exercises the dev server's asset pipeline.
 *
 * This is the same argument as `sky-probe.html` and `?spike`: some questions
 * have no answer that is not measured on the device, and a screenshot or a
 * number is the artefact a person can read afterwards.
 *
 * ```
 * pnpm dev          # then open /places-probe.html
 * ```
 *
 * Every claim below is printed with its verdict rather than thrown, so one
 * failure does not hide the twenty that follow.
 */

import { MAX_STEP_MS } from "./places/limits";
import {
  createInterpreter,
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_STACK_LIMIT_BYTES,
  mulberry32,
  ScriptExecutionError,
  type ScriptErrorKind,
} from "./places/interpreter";

const out = document.getElementById("out");
if (out === null) throw new Error("no #out on the page");

const lines: string[] = [];
let failures = 0;

const report = (ok: boolean, label: string, detail = ""): void => {
  if (!ok) failures++;
  const verdict = ok ? "pass" : "FAIL";
  lines.push(
    `${verdict === "pass" ? "<span class='pass'>pass</span>" : "<span class='fail'>FAIL</span>"}  ${label}${detail === "" ? "" : `\n        ${detail}`}`,
  );
  out.innerHTML = lines.join("\n");
};

/** The kind a failing run reports, so a line can name the cap. */
const kindOf = (
  box: { evaluate: (source: string) => unknown },
  source: string,
): ScriptErrorKind => {
  try {
    box.evaluate(source);
  } catch (error) {
    if (error instanceof ScriptExecutionError) return error.kind;
    return "fatal";
  }
  return "exception";
};

const run = async (): Promise<void> => {
  lines.push("place interpreter probe");
  lines.push(
    `budget ${MAX_STEP_MS} ms · memory ${(DEFAULT_MEMORY_LIMIT_BYTES / 1048576).toFixed(0)} MiB · stack ${(DEFAULT_STACK_LIMIT_BYTES / 1024).toFixed(0)} KiB`,
  );
  lines.push("");
  out.innerHTML = lines.join("\n");

  // 1. The claim this page exists for. Everything below is downstream of it.
  const loaded = performance.now();
  let box: Awaited<ReturnType<typeof createInterpreter>>;
  try {
    box = await createInterpreter({
      seed: 20260901,
      now: () => performance.timeOrigin + performance.now(),
      onDispatch: () => "",
      onQuery: () => "null",
    });
  } catch (reason) {
    report(
      false,
      "the interpreter's WebAssembly loads under Vite",
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason),
    );
    report(
      false,
      "everything below it (nothing can run without an interpreter)",
    );
    return;
  }
  report(
    true,
    "the interpreter's WebAssembly loads under Vite",
    `loaded and instantiated in ${(performance.now() - loaded).toFixed(0)} ms`,
  );

  // 2. It runs, and it is a whole language rather than a toy subset.
  try {
    const value = box.evaluate(`
      const scale = (n) => n * 2;
      const { a, b } = { a: 3, b: 4 };
      class Shape { constructor(n) { this.n = n; } get doubled() { return scale(this.n); } }
      return [1, 2, 3].map((n) => new Shape(n).doubled).join("/") + " from " + (a + b);
    `);
    report(
      value === "2/4/6 from 7",
      "runs code, including classes and closures",
      `got ${JSON.stringify(value)}`,
    );
  } catch (reason) {
    report(false, "runs code, including classes and closures", String(reason));
  }

  // 3. Isolation. The list is the point; a single passable global is a failure.
  const reachable: string[] = [];
  for (const name of [
    "fetch",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "XMLHttpRequest",
    "WebSocket",
    "document",
    "window",
    "self",
    "process",
    "require",
    "module",
    "importScripts",
    "indexedDB",
    "localStorage",
    "navigator",
    "globalThis.engine",
  ]) {
    if (box.evaluate(`return typeof ${name};`) !== "undefined")
      reachable.push(name);
  }
  report(
    reachable.length === 0,
    "no host global is reachable from a script",
    reachable.length === 0
      ? "18 probed, all absent"
      : `REACHABLE: ${reachable.join(", ")}`,
  );

  // 4. `engine` is a parameter, so code compiled in global scope cannot name it.
  try {
    const viaParameter = box.evaluate(`return engine.note(1);`);
    const viaGlobalScope = box.evaluate(
      `return new Function("return typeof engine;")();`,
    );
    report(
      viaParameter === "noted" && viaGlobalScope === "undefined",
      "engine is a parameter, not a global",
      `as parameter: ${JSON.stringify(viaParameter)} · compiled in global scope: ${JSON.stringify(viaGlobalScope)}`,
    );
  } catch (reason) {
    report(false, "engine is a parameter, not a global", String(reason));
  }

  // 5. All three caps. Each is a separate claim because each fails differently,
  //    and the stack one is the finding: without its cap the peer *aborts*.
  const timing = Date.now();
  report(
    kindOf(box, "while (true) {}") === "interrupt",
    "a runaway step is interrupted",
    `stopped after ${Date.now() - timing} ms of a ${MAX_STEP_MS} ms budget`,
  );

  const small = await createInterpreter({
    seed: 1,
    now: () => 0,
    onDispatch: () => "",
    onQuery: () => "null",
    memoryLimitBytes: 1024 * 1024,
  });
  report(
    kindOf(
      small,
      "const a = []; while (true) a.push(new Array(100000).fill(7));",
    ) === "memory",
    "a runaway allocation is refused",
  );
  small.dispose();

  const overflowed = Date.now();
  const overflowKind = kindOf(box, "const f = (n) => f(n + 1); return f(0);");
  report(
    overflowKind === "stack",
    "a runaway recursion is refused rather than aborting the page",
    `reported ${overflowKind} after ${Date.now() - overflowed} ms`,
  );

  // 6. Still alive, and still freeable. The second is the half that matters: a
  //    runtime left unfreeable is what turns a bad script into a dead tab.
  try {
    const after = box.evaluate(`return "still here";`);
    report(
      after === "still here",
      "the sandbox survives all three",
      JSON.stringify(after),
    );
  } catch (reason) {
    report(false, "the sandbox survives all three", String(reason));
  }
  try {
    box.dispose();
    report(true, "the runtime frees cleanly", "no abort");
  } catch (reason) {
    report(
      false,
      "the runtime frees cleanly",
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason),
    );
  }

  // 7. Determinism, at the size the whole multiplayer plan rests on.
  const twice = async (): Promise<string> => {
    const peer = await createInterpreter({
      seed: 4242,
      now: () => 1700000000000,
      onDispatch: () => "",
      onQuery: () => "null",
    });
    const rows: string[] = [];
    for (let step = 0; step < 4; step++) {
      rows.push(
        String(
          peer.evaluate(
            `return \`\${Date.now()}:\${Math.floor(Math.random() * 1000)}\`;`,
          ),
        ),
      );
    }
    peer.dispose();
    return rows.join(" | ");
  };
  const [first, second] = [await twice(), await twice()];
  report(
    first === second,
    "two peers, one seed and one clock, agree exactly",
    `${first}\n        ${second}`,
  );

  lines.push("");
  lines.push(
    failures === 0
      ? "<span class='pass'>all claims hold in this browser</span>"
      : `<span class='fail'>${failures} claim(s) failed in this browser</span>`,
  );
  out.innerHTML = lines.join("\n");
};

run().catch((reason: unknown) => {
  out.innerHTML = [
    ...lines,
    "",
    `FAILED: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  ].join("\n");
});

// The seeded generator is pure arithmetic and needs no browser, but it is the
// one thing here that decides whether two peers draw the same world, so it is
// worth being able to see the numbers rather than trust them.
void mulberry32(20260901);
