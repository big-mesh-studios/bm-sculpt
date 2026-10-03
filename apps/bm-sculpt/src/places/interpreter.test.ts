import { describe, expect, it } from "vitest";

import {
  createInterpreter,
  mulberry32,
  ScriptExecutionError,
  type ScriptErrorKind,
} from "./interpreter";

/**
 * The questions the spike exists to answer, asserted.
 *
 * Each test names a property that the scripting layer cannot be built without,
 * so a failure here is not "the spike broke" — it is "the plan is wrong, or this
 * machine is". Both are worth knowing now rather than after the host exists.
 *
 * The clock is a plain closure advanced by hand rather than a fake timer library,
 * for the reason the interpreter's `Date.now` is injected at all: a test that
 * read real time could not assert that the *injected* one is what a script sees.
 */
let clockMs = 1_700_000_000_000;
const clock = (): number => clockMs;

/**
 * An interpreter with a host attached.
 *
 * The defaults are a host that accepts everything and answers nothing, which is what most of
 * these tests want: they are asking the interpreter questions, not testing the bridge.
 */
const sandbox = (
  overrides: Partial<Parameters<typeof createInterpreter>[0]> = {},
) =>
  createInterpreter({
    seed: 20260901,
    now: clock,
    onDispatch: () => "",
    onQuery: () => "null",
    ...overrides,
  });

/** The kind a failing run reports, so a test can name the cap rather than the text. */
const kind = (run: () => unknown): ScriptErrorKind => {
  try {
    run();
  } catch (error) {
    if (error instanceof ScriptExecutionError) return error.kind;
    throw error;
  }
  throw new Error("expected the run to fail, and it did not");
};

describe("does a QuickJS interpreter run here at all", () => {
  it("runs code, and hands back what it returned", async () => {
    const box = await sandbox();
    expect(box.evaluate("return 1 + 2;")).toBe(3);
    expect(box.evaluate(`return "place";`)).toBe("place");
    box.dispose();
  });

  it("runs code that uses the whole language, not a toy subset", async () => {
    const box = await sandbox();
    // Arrow functions, closures, destructuring, template literals, a class with
    // a method. If any of this is missing the spike has found a stripped build
    // and the guest API has to be written differently.
    const result = box.evaluate(`
      const scale = (n) => n * 2;
      const { a, b } = { a: 3, b: 4 };
      class Shape {
        constructor(n) { this.n = n; }
        get doubled() { return scale(this.n); }
      }
      const list = [1, 2, 3].map((n) => new Shape(n).doubled);
      return \`\${list.join("/")} from \${a + b}\`;
    `);
    expect(result).toBe("2/4/6 from 7");
    box.dispose();
  });

  it("reports a thrown script as an exception, with the script's own message", async () => {
    const box = await sandbox();
    // `run` is synchronous, so this is a plain throw rather than a rejection —
    // which is worth pinning, because the whole design is that a step is a
    // synchronous call and there is no guest async to await.
    expect(() => box.evaluate(`throw new Error("no bridge here");`)).toThrow(
      /no bridge here/,
    );
    // The distinction that matters: a script that throws is a bug in the script,
    // and a script that runs away is a bug in the host's cap. They must not be
    // the same report.
    expect(kind(() => box.evaluate(`throw new Error("boom");`))).toBe(
      "exception",
    );
    box.dispose();
  });

  it("survives a script that throws and then runs another", async () => {
    const box = await sandbox();
    expect(() => box.evaluate(`throw new Error("first");`)).toThrow();
    // A corrupt context would make this the place the breakage shows up, in a
    // message about something that has nothing to do with the first failure.
    expect(box.evaluate("return 'still here';")).toBe("still here");
    box.dispose();
  });

  it("survives a script that overflows the stack, and runs another", async () => {
    const box = await sandbox();
    // **The finding from the spike, and the reason this file exists.**
    //
    // Unbounded recursion overflows the *host's* JavaScript stack rather than
    // the interpreter's, and the result crosses the WebAssembly boundary as a
    // bare `RangeError` with no handle to classify. Worse, the runtime is left
    // unfreeable, and freeing it calls an assertion inside the interpreter that
    // fails as `abort()` — which takes the whole peer down, with no error
    // anywhere that points at the script.
    //
    // `DEFAULT_STACK_LIMIT_BYTES` is what stops that, and this test is why that
    // constant is load-bearing rather than hygiene: if the limit is removed, this
    // is the test that fails, and it fails by killing the test runner.
    expect(
      kind(() => box.evaluate("const f = (n) => f(n + 1); return f(0);")),
    ).toBe("stack");

    // The interpreter is still usable, which is what makes a stack overflow a
    // reportable script error rather than a dead place.
    expect(box.evaluate("return 'still here';")).toBe("still here");

    // And it can be freed, which the second half of the failure above would have
    // made impossible. This line aborts the process if the limit regresses.
    expect(() => box.dispose()).not.toThrow();
  });

  it("reports a stack overflow separately from a script's own throw", async () => {
    const box = await sandbox();
    // Both are `InternalError`-adjacent and both stop a script, but they have
    // different causes and different fixes, and a host that merges them cannot
    // tell a person whether their script loops, allocates, or is wrong.
    expect(
      kind(() => box.evaluate("const f = (n) => f(n + 1); return f(0);")),
    ).toBe("stack");
    expect(kind(() => box.evaluate("while (true) {}"))).toBe("interrupt");
    expect(kind(() => box.evaluate("throw new Error('mine');"))).toBe(
      "exception",
    );
    box.dispose();
  });

  it("allows the recursion a real script would use", async () => {
    const box = await sandbox();
    // The cap that stops the runaway must not stop ordinary work. Five hundred
    // frames is far more than a place script recurses, and it is a tenth of
    // what the limit allows.
    expect(
      box.evaluate(`
        const depth = (n) => (n <= 0 ? 0 : 1 + depth(n - 1));
        return depth(400);
      `),
    ).toBe(400);
    box.dispose();
  });
});

describe("isolation is by construction", () => {
  it("has no host globals to reach", async () => {
    const box = await sandbox();
    // Not "blocked" — *absent*. A Web Worker sandbox would find `fetch` here
    // and would have to deny it; this interpreter has no such global, so there
    // is nothing to deny and nothing a future QuickJS release could re-open.
    const probes = [
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
      "globalThis.engine",
      // The standard library is *supposed* to be here — a script needs `Math`
      // and `Object` — so the assertion is not that the prototype chain is
      // sealed, which would be absurd, but that walking it reaches nothing that
      // can reach the host.
      "globalThis.constructor.constructor",
    ];
    for (const probe of probes) {
      const value = box.evaluate(`return typeof ${probe};`);
      if (probe === "globalThis.constructor.constructor") {
        // `Function`, which is the way a script compiles a string. Harmless
        // here for the same reason it is harmless in a worker: the compiled
        // code still lands in this interpreter, with this interpreter's globals,
        // and so can only reach the bindings this method passed in. Named
        // because it is the probe that looks alarming and is not.
        expect(value, probe).toBe("function");
      } else {
        expect(value, probe).toBe("undefined");
      }
    }
    box.dispose();
  });

  it("reaches engine only as the parameter it is handed", async () => {
    const seen: string[] = [];
    const box = await sandbox({
      onDispatch: (tag, payload): string => {
        seen.push(`${tag}:${payload}`);
        return "";
      },
    });

    // Reached, because it was passed — the script body *is* the function, so
    // `engine` is its own parameter and in scope by construction. So is it to
    // any function defined inside that body, because closures work; that is
    // ordinary JavaScript and there is nothing to defend against in it.
    expect(box.evaluate(`return engine.dispatch("log", "41");`)).toBe("");
    expect(seen).toEqual(["log:41"]);

    // The property is not on the global object, which is what a global `engine`
    // would look like. Everything that can reach the interpreter's global can
    // then reach the host, including code the script's author never wrote.
    expect(box.evaluate(`return typeof globalThis.engine;`)).toBe("undefined");
    expect(
      box.evaluate(`return Object.keys(globalThis).join(",");`),
    ).not.toContain("engine");

    // And it is not inherited, so nothing reaches it by walking a prototype.
    expect(box.evaluate(`return typeof globalThis.__proto__.engine;`)).toBe(
      "undefined",
    );

    // The check that would actually distinguish a parameter from a global: code
    // compiled *outside* the body's scope chain. `Function` builds a function
    // in global scope, so it never sees the parameter — whereas a global would
    // be right there.
    expect(
      box.evaluate(`return new Function("return typeof engine;")();`),
    ).toBe("undefined");
    box.dispose();
  });

  it("carries a host's refusal back as a string, which is all a script can see", async () => {
    const box = await sandbox({
      onDispatch: () => "shape-add: at is required",
    });
    // The refusal is a sentence, not an exception. A script that hits a limit finds out at
    // the line that caused it rather than in a world with a bridge missing from it.
    expect(box.evaluate(`return engine.dispatch("shape-add", "{}");`)).toBe(
      "shape-add: at is required",
    );
    box.dispose();
  });

  it("refuses a query it does not have, rather than asking the host", async () => {
    // A version skew, handled: the closed set is checked at the boundary so a script cannot
    // reach a host function by guessing a name.
    let asked = false;
    const box = await sandbox({
      onQuery: (): string => {
        asked = true;
        return "null";
      },
    });
    expect(box.evaluate(`return engine.query("getSecret", "[]");`)).toContain(
      "no query called",
    );
    expect(asked).toBe(false);
    box.dispose();
  });
});

describe("a runaway step is stopped rather than obeyed", () => {
  it("interrupts a script that will not finish", async () => {
    const box = await sandbox({ stepBudgetMs: 200 });
    const started = Date.now();
    expect(kind(() => box.evaluate("while (true) {}"))).toBe("interrupt");
    // The budget is the assertion as much as the kind is: an interrupt that
    // arrives in ten seconds is a hang that happens to be labelled.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
    box.dispose();
  });

  it("stops an allocation that will not fit, and says so", async () => {
    const box = await sandbox({ memoryLimitBytes: 1024 * 1024 });
    expect(
      kind(() =>
        box.evaluate(
          "const a = []; while (true) a.push(new Array(100000).fill(7));",
        ),
      ),
    ).toBe("memory");
    box.dispose();
  });

  it("leaves ordinary work alone", async () => {
    // The other half of the cap. A handler that said no unconditionally would
    // pass the tests above and fail this one, and would be a sandbox in which no
    // script ever runs.
    const box = await sandbox({ stepBudgetMs: 250 });
    expect(
      box.evaluate(
        "let n = 0; for (let i = 0; i < 200000; i++) n += i; return n;",
      ),
    ).toBe(19999900000);
    box.dispose();
  });

  it("caps each step separately, so a script that fails every frame is bounded", async () => {
    const box = await sandbox({ stepBudgetMs: 120 });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(kind(() => box.evaluate("while (true) {}"))).toBe("interrupt");
    }
    // Three interrupted steps in a row rather than one step allowed three
    // budgets — which is the difference between a cap and an allowance.
    box.dispose();
  });
});

describe("two peers running the same script agree", () => {
  it("draws the same numbers from the same seed", async () => {
    const draws = async (seed: number): Promise<string> => {
      const box = await sandbox({ seed });
      const out = box.evaluate(`
        const n = [];
        for (let i = 0; i < 8; i++) n.push(Math.floor(Math.random() * 1e6));
        return n.join(",");
      `);
      box.dispose();
      return String(out);
    };
    const first = await draws(20260901);
    expect(await draws(20260901)).toBe(first);
    // And a different seed gives a different world, or the seed is not reaching
    // the generator and the agreement above means nothing.
    expect(await draws(20260902)).not.toBe(first);
  });

  it("advances the same sequence across steps, so a step is not a fresh start", async () => {
    // A generator that reseeded per step would draw the same numbers on every
    // frame, and every peer would agree while the place never varied.
    const box = await sandbox({ seed: 7 });
    const first = box.evaluate("return Math.random();");
    const second = box.evaluate("return Math.random();");
    box.dispose();
    expect(first).not.toBe(second);
  });

  it("reads the clock it was given rather than the wall clock", async () => {
    const box = await sandbox();
    expect(box.evaluate("return Date.now();")).toBe(clockMs);
    clockMs += 5000;
    expect(box.evaluate("return Date.now();")).toBe(clockMs);
    box.dispose();
  });

  it("converges two independent sandboxes fed the same clock and seed", async () => {
    // The property the whole multiplayer plan rests on, at the smallest scale
    // it can be checked: two peers, the same seed, the same clock, the same
    // steps, and an identical result. If the interpreter's own globals leak
    // through anywhere, this is where it shows.
    const run = async (): Promise<string> => {
      const box = await sandbox({ seed: 4242 });
      const rows: string[] = [];
      for (let step = 0; step < 3; step++) {
        rows.push(
          String(
            box.evaluate(`
              const n = Math.floor(Math.random() * 1000);
              return \`\${Date.now()}:\${n}\`;
            `),
          ),
        );
        clockMs += 1000;
      }
      box.dispose();
      return rows.join("|");
    };
    clockMs = 1_700_000_000_000;
    const first = await run();
    clockMs = 1_700_000_000_000;
    expect(await run()).toBe(first);
  });
});

describe("the seeded generator itself", () => {
  it("produces the sequence mulberry32 is documented to produce", () => {
    // Pinned to the reference generator's own output, checked here against the
    // canonical transcription rather than copied from this implementation. A
    // change to the generator would change every place's world, on every peer,
    // with nothing on screen to say so — so the sequence is the contract and it
    // has to fail loudly when it moves.
    expect(
      [0, 1, 7, 20260901].map((seed) => {
        const random = mulberry32(seed);
        return [random(), random(), random()];
      }),
    ).toEqual([
      [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197],
      [0.6270739405881613, 0.002735721180215478, 0.5274470399599522],
      [0.011704753153026104, 0.06195825757458806, 0.97690763277933],
      [0.723907511215657, 0.941750347148627, 0.5006567344535142],
    ]);
  });

  it("stays in range over a long draw", () => {
    const random = mulberry32(20260901);
    for (let i = 0; i < 10000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
