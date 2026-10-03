import { describe, expect, it } from "vitest";

import { asPlaceSource, bundlePlace } from "./bundle";
import { createInterpreter, ScriptExecutionError } from "./interpreter";
import type { GuestQuery } from "./bridge";
import { GUEST_MODULE } from "./bridge";
import { parseEffect } from "./effects";

/**
 * A place, end to end: TypeScript in, effects out, handlers stepping.
 *
 * Every other test in this directory tests one layer. This one runs the real compiler, the
 * real bundler and the real interpreter together, because **the properties that matter are
 * properties of the seams.** A guest function that sends the wrong field name, a bundler that
 * drops a module, an interpreter that hands over the wrong argument — each passes its own
 * layer's tests and fails here, and none of them is visible from either end.
 *
 * The host is a stub that records what it was asked for and answers questions from a
 * hand-written world. It is not a *correct* host — that is Phase D — but it is a real one,
 * so the shapes are checked rather than assumed.
 */

/** What the stub host was asked to do, in order. */
interface Asked {
  readonly tag: string;
  readonly payload: Record<string, unknown>;
}

/**
 * What `getMediumAt` answers above `z = 0`, so a test can stand in a field or out of one.
 *
 * **A real field rather than a stub shape**, because the point of these tests is the seam and a
 * field with the right keys but no meaning would pass a check that a field with the wrong keys
 * fails.
 */
const MEDIUM = {
  pushVx: 0,
  pushVz: 25,
  pushVy: null,
  speedScale: 1,
  sink: 0,
};

/**
 * A stub host: records effects, answers five queries from a flat world, and counts steps.
 *
 * **The world is deliberately trivial** — a floor at `y = 0` and water below `y = -10` —
 * because what is being tested is that a question reaches the host and an answer comes back,
 * not that the host is right about terrain.
 */
const stubHost = (asked: Asked[]) => ({
  onDispatch: (tag: string, payloadJson: string): string => {
    const parsed = parseEffect(tag, JSON.parse(payloadJson));
    if (parsed === null) return `${tag}: refused`;
    asked.push({ tag, payload: parsed.payload as Record<string, unknown> });
    return "";
  },
  onQuery: (name: string, argsJson: string): string => {
    const args = JSON.parse(argsJson) as number[];
    switch (name as GuestQuery) {
      case "getSolidAt":
        return JSON.stringify(args[1] < 0);
      case "getHeightAt":
        return JSON.stringify(0);
      case "getWaterAt":
        return JSON.stringify(args[1] < -10);
      case "raycast":
        return JSON.stringify(null);
      // **A push field beyond `x = 100`, and null before it.** A stub that answered "null"
      // everywhere would leave the "there is a field" branch of every test unreachable, and one
      // that answered everywhere would make "none here" unreachable — so the answer varies with
      // the point asked about, which is what makes one step cover both branches.
      case "getMediumAt":
        return JSON.stringify(args[0] > 100 ? MEDIUM : null);
      // The one query that reads a place's own state. "null" here is enough for the query to
      // be *asked for*, which is what the bridge's closed set is about.
      case "getData":
        return "null";
    }
  },
});

const run = async (
  files: Record<string, string>,
  entry = "main.ts",
  /**
   * The clock. **A function rather than a number so a test can move it**, which is the only way a
   * timer comes due under a stub host: `now` fixed at one value means no delay is ever elapsed,
   * and a test that asserted a timer had fired would be asserting nothing.
   */
  now: () => number = () => 1_700_000_000_000,
): Promise<{
  asked: Asked[];
  interpreter: Awaited<ReturnType<typeof createInterpreter>>;
}> => {
  const asked: Asked[] = [];
  const interpreter = await createInterpreter({
    seed: 20260901,
    now,
    ...stubHost(asked),
  });
  interpreter.load(bundlePlace(files, entry));
  return { asked, interpreter };
};

describe("a place builds itself when it is loaded", () => {
  it("runs its top-level code, which is when it decides what it is", async () => {
    // A place's effects are dispatched from `load`, not from the first step. A place that
    // only built itself on the first tick would be invisible for a frame and would have to
    // be special-cased in the host's very first frame.
    const { asked, interpreter } = await run({
      "main.ts": `
        import { createShape, log } from "${GUEST_MODULE}";
        log("starting");
        createShape({
          place: "bridge", id: "deck",
          at: [0, 10, 0],
          shape: { type: "Box", len: { x: 80, y: 4, z: 12 } },
          combine: "Add",
        });
      `,
    });

    expect(asked.map((a) => a.tag)).toEqual(["log", "shape-add"]);
    expect(asked[1].payload).toMatchObject({
      place: "bridge",
      id: "deck",
      at: [0, 10, 0],
      combine: "Add",
    });
    interpreter.dispose();
  });

  it("survives TypeScript, so a place is written in TypeScript", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { createShape } from "${GUEST_MODULE}";
        type Deck = { readonly at: readonly [number, number, number] };
        const build = (d: Deck): void => {
          createShape({
            place: "quay", id: "deck-" + d.at[0],
            at: d.at,
            shape: { type: "Box", len: { x: 20, y: 4, z: 20 } },
            combine: "Add",
          });
        };
        const decks: readonly Deck[] = [{ at: [0, 0, 0] }, { at: [40, 0, 0] }];
        for (const deck of decks) build(deck);
      `,
    });
    // Type annotations, an interface and a `readonly` tuple are erased; the loop and the
    // template literal are not. Both had to survive for this to produce two effects.
    expect(asked).toHaveLength(2);
    expect(asked.map((a) => a.payload["id"])).toEqual(["deck-0", "deck-40"]);
    interpreter.dispose();
  });

  it("reaches the guest library from more than one file", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { buildDeck } from "./deck";
        import { buildLantern } from "./lantern";
        buildDeck([0, 0, 0]);
        buildLantern([0, 20, 0]);
      `,
      "deck.ts": `
        import { createShape } from "${GUEST_MODULE}";
        export const buildDeck = (at: readonly [number, number, number]): void =>
          createShape({ place: "bridge", id: "deck", at, shape: { type: "Box", len: { x: 40, y: 4, z: 8 } }, combine: "Add" });
      `,
      "lantern.ts": `
        import { createShape } from "${GUEST_MODULE}";
        export const buildLantern = (at: readonly [number, number, number]): void =>
          createShape({ place: "bridge", id: "lantern", at, shape: { type: "Ellipsoid", radius: { x: 3, y: 3, z: 3 } }, combine: "Add" });
      `,
    });
    expect(asked).toHaveLength(2);
    expect(asked.map((a) => a.payload["id"]).sort()).toEqual([
      "deck",
      "lantern",
    ]);
    interpreter.dispose();
  });
});

describe("a place is asked, and answers, once per step", () => {
  it("runs its tick handler with the clock and the events", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { log, onTick } from "${GUEST_MODULE}";
        onTick((info) => {
          log("tick " + info.now + " " + info.events.length);
          for (const event of info.events) log(event.kind + ":" + (event.zoneId ?? ""));
        });
      `,
    });
    expect(asked).toHaveLength(0);
    expect(interpreter.handlerCount).toBe(1);

    interpreter.step("1700000000000", "[]");
    interpreter.step("1700000001000", "[]");

    expect(asked.map((a) => a.payload["text"])).toEqual([
      "tick 1700000000000 0",
      "tick 1700000001000 0",
    ]);
    interpreter.dispose();
  });

  it("reads an event's fields off the object, not off arguments", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { log, onTick } from "${GUEST_MODULE}";
        onTick((info) => { for (const e of info.events) log(e.kind + "/" + e.zoneId + "/" + e.producer); });
      `,
    });
    interpreter.step(
      "1700000000000",
      JSON.stringify([
        {
          kind: "zone-entered",
          at: 1,
          producer: "peer-a",
          payload: { zoneId: "door" },
        },
      ]),
    );
    // The host's wire form nests the fields under `payload`; the library flattens them onto
    // the event so a script reads `event.zoneId`. That flattening is the seam this asserts.
    expect(asked.map((a) => a.payload["text"])).toEqual([
      "zone-entered/door/peer-a",
    ]);
    interpreter.dispose();
  });

  it("runs its handlers in the order it registered them", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { log, onTick } from "${GUEST_MODULE}";
        onTick(() => log("first"));
        onTick(() => log("second"));
        onTick(() => log("third"));
      `,
    });
    expect(interpreter.handlerCount).toBe(3);
    interpreter.step("1", "[]");
    expect(asked.map((a) => a.payload["text"])).toEqual([
      "first",
      "second",
      "third",
    ]);
    interpreter.dispose();
  });

  it("skips the rest of a step when one handler throws, and says why", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { log, onTick } from "${GUEST_MODULE}";
        onTick(() => { throw new Error("handler is broken"); });
        onTick(() => log("never reached"));
      `,
    });

    // **A choice, and it is worth stating.** A script whose first handler throws would
    // otherwise throw on every frame forever, and the symptom would be a frame-rate problem
    // rather than a bug report. So one handler ending the step turns a stall into an error.
    expect(() => interpreter.step("1", "[]")).toThrow(/handler is broken/);
    expect(asked).toHaveLength(0);
    interpreter.dispose();
  });

  it("spends one step's budget on all its handlers together", async () => {
    // A per-handler budget would be a way for a place with fifty handlers to buy itself
    // fifty times the time, which is what makes a cap not a cap.
    const handlers = Array.from(
      { length: 40 },
      () => "onTick(() => { while (true) {} });",
    ).join("\n");
    const { interpreter } = await run({
      "main.ts": `import { onTick } from "${GUEST_MODULE}";\n${handlers}`,
    });

    expect(interpreter.handlerCount).toBe(40);
    const started = Date.now();
    let kind: string | undefined;
    try {
      interpreter.step("1", "[]");
    } catch (error) {
      kind = (error as ScriptExecutionError).kind;
    }
    expect(kind).toBe("interrupt");
    // One budget, not forty. A per-handler budget would have taken 40× as long.
    expect(Date.now() - started).toBeLessThan(4000);
    interpreter.dispose();
  });
});

describe("a place asks the world questions", () => {
  it("reaches the host's query path and uses the answer", async () => {
    // Recorded on *both* channels, because the seam being tested is the round trip: a
    // question leaves as a string, and an answer comes back as a string the script can do
    // arithmetic on. Either half alone would pass with the other broken.
    const asked: Asked[] = [];
    const queried: string[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 0,
      onDispatch: (tag, payloadJson): string => {
        const parsed = parseEffect(tag, JSON.parse(payloadJson));
        if (parsed === null) return "refused";
        asked.push({ tag, payload: parsed.payload as Record<string, unknown> });
        return "";
      },
      onQuery: (name, argsJson): string => {
        queried.push(`${name}(${argsJson})`);
        switch (name) {
          case "getSolidAt":
            return "true";
          case "getHeightAt":
            return "42.5";
          case "getWaterAt":
            return "false";
          default:
            return "null";
        }
      },
    });

    interpreter.load(
      bundlePlace(
        {
          "main.ts": `
            import { getHeightAt, getSolidAt, getWaterAt, log, onTick } from "${GUEST_MODULE}";
            onTick(() => {
              // The answers are used, not merely fetched: "42.5" as a string would make the
              // addition below produce something a script author would have to debug.
              log("sum=" + (getHeightAt(3, 4) + 0.5));
              log("solid=" + getSolidAt(0, -1, 0));
              log("water=" + getWaterAt(0, -99, 0));
            });
          `,
        },
        "main.ts",
      ),
    );
    interpreter.step("1", "[]");

    expect(queried).toEqual([
      "getHeightAt([3,4])",
      "getSolidAt([0,-1,0])",
      "getWaterAt([0,-99,0])",
    ]);
    expect(asked.map((a) => a.payload["text"])).toEqual([
      "sum=43",
      "solid=true",
      "water=false",
    ]);
    interpreter.dispose();
  });

  it("asks nothing when a script asks nothing", async () => {
    const queried: string[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 0,
      onDispatch: () => "",
      onQuery: (name): string => {
        queried.push(name);
        return "null";
      },
    });
    interpreter.load(
      bundlePlace(
        { "main.ts": `import { log } from "${GUEST_MODULE}"; log("built");` },
        "main.ts",
      ),
    );
    expect(queried).toEqual([]);
    interpreter.dispose();
  });
});

describe("a place is contained", () => {
  it("cannot reach a host global, and cannot name the bridge by anything but its parameter", async () => {
    const asked: Asked[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 0,
      ...stubHost(asked),
    });
    interpreter.load(
      bundlePlace(
        {
          "main.ts": `
            import { log, onTick } from "${GUEST_MODULE}";
            onTick(() => {
              const reached = [
                typeof fetch, typeof setTimeout, typeof document, typeof window,
                typeof process, typeof globalThis.engine,
              ].join(",");
              // The last is the interesting one: code compiled in *global* scope, outside the
              // body's scope chain, which is where a global \`engine\` would be right there.
              const compiledElsewhere = new Function("return typeof engine;")();
              log(reached + "|" + compiledElsewhere);
            });
          `,
        },
        "main.ts",
      ),
    );
    interpreter.step("1", "[]");

    expect(asked.map((a) => a.payload["text"])).toEqual([
      "undefined,undefined,undefined,undefined,undefined,undefined|undefined",
    ]);
    interpreter.dispose();
  });

  it("has a require, and every literal one was resolved before anything ran", async () => {
    // **Not an escape, and the tidier version of this claim would have been wrong.** The
    // bundle defines its module resolver and the transpiled code calls it as `require`, so
    // the name is in a place's scope. A test asserting `typeof require === "undefined"` would
    // have failed — and would have kept failing, inviting someone to "fix" the bundler by
    // hiding a name that is doing its job.
    //
    // What matters is that the name reaches nothing. The bundler scanned every literal
    // `require` in the source and resolved it against the place's own files, so by the time
    // anything runs the arguments left in the text are module ids *the bundler chose*. There
    // is no path from a place to the runtime resolver with anything it picked, which is a
    // stronger answer than "the resolver refuses bad ids" — it never gets the chance.
    const asked: Asked[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 0,
      ...stubHost(asked),
    });
    interpreter.load(
      bundlePlace(
        {
          "main.ts": `
            import { log, onTick } from "${GUEST_MODULE}";
            import { answer } from "./answer";
            onTick(() => {
              log("same=" + (require("./answer").answer === answer));
              log("library=" + (typeof require("${GUEST_MODULE}").createShape));
            });
          `,
          "answer.ts": `export const answer = 42;`,
        },
        "main.ts",
      ),
    );
    interpreter.step("1", "[]");
    expect(asked.map((a) => a.payload["text"])).toEqual([
      "same=true",
      "library=function",
    ]);

    // Every way of naming something the place does not have is refused at bundle time, with
    // the file and the specifier, before an interpreter exists.
    const refused: Array<[string, RegExp]> = [
      [`require("./not-a-file");`, /not one of this place's files/],
      [`require("9999");`, /not one of this place's files/],
      [`require("https://elsewhere.test/x");`, /outside itself/],
      [`require(spec);`, /not a string/],
    ];
    for (const [source, expected] of refused) {
      expect(
        () =>
          bundlePlace(
            {
              "main.ts": `import { onTick } from "${GUEST_MODULE}";
onTick(() => { ${source} });`,
            },
            "main.ts",
          ),
        source,
      ).toThrow(expected);
    }

    interpreter.dispose();
  });

  it("cannot be loaded twice into one interpreter without losing its first handlers", async () => {
    // A re-load must not leave a dead place's script driving the new place's world — which
    // would look like the new script misbehaving rather than like two places.
    const asked: Asked[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 0,
      ...stubHost(asked),
    });

    const withHandler = (text: string): string =>
      bundlePlace(
        {
          "main.ts": `import { log, onTick } from "${GUEST_MODULE}";\nonTick(() => log("${text}"));`,
        },
        "main.ts",
      );

    interpreter.load(withHandler("first"));
    expect(interpreter.handlerCount).toBe(1);
    interpreter.load(withHandler("second"));
    expect(interpreter.handlerCount).toBe(1);

    interpreter.step("1", "[]");
    // Only the second place's handler, once.
    expect(asked.map((a) => a.payload["text"])).toEqual(["second"]);
    interpreter.dispose();
  });

  it("frees cleanly after a place has run, which is the point of the stack cap", async () => {
    const { interpreter } = await run({
      "main.ts": `
        import { onTick } from "${GUEST_MODULE}";
        onTick(() => { const f = (n: number): number => f(n + 1); f(0); });
      `,
    });
    // Overflowing the host's stack leaves the interpreter unfreeable, and freeing it calls an
    // assertion that fails as `abort()` — which is `DEFAULT_STACK_LIMIT_BYTES`'s whole reason.
    expect(() => interpreter.step("1", "[]")).toThrow();
    // With the cap set, this line runs. Without it, the test runner dies here.
    expect(() => interpreter.dispose()).not.toThrow();
  });
});

describe("two peers running the same place dispatch the same effects", () => {
  it("agrees exactly, in order, including the indices a script never names", async () => {
    // The end-to-end form of ADR 0016's claim. Not a claim about any one layer — the
    // bundler's ids, the interpreter's clock and the library's serialisation all have to hold
    // at once, and each is separately correct without the others.
    const place: Record<string, string> = {
      "main.ts": `
        import { createShape, random, randint } from "${GUEST_MODULE}";
        for (let i = 0; i < 20; i++) {
          createShape({
            place: "quarry", id: "rock-" + i,
            at: [i * 12, randint(0, 4), Math.floor(random() * 5)],
            shape: { type: "Ellipsoid", radius: { x: 6, y: 5, z: 6 } },
            combine: i % 3 === 0 ? "Subtract" : "Add",
          });
        }
      `,
    };

    const once = async (): Promise<string> => {
      const asked: Asked[] = [];
      const interpreter = await createInterpreter({
        seed: 20260901,
        now: () => 1_700_000_000_000,
        ...stubHost(asked),
      });
      interpreter.load(bundlePlace(place, "main.ts"));
      interpreter.dispose();
      return JSON.stringify(asked);
    };

    expect(await once()).toBe(await once());
    // And it is a real world-building payload rather than an empty array, so the comparison
    // above is not vacuous.
    expect(JSON.parse(await once())).toHaveLength(20);
  });

  it("is unaffected by the order the files were written in", async () => {
    // The bundler's half of the same claim, checked through the interpreter rather than on
    // the bundle text — because the thing that has to agree is the *effects*.
    const forwards = {
      "main.ts": `import { createShape } from "${GUEST_MODULE}"; createShape({ place: "p", id: "a", at: [1,0,0], shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" });`,
      "deck.ts": `export const x = 1;`,
      "post.ts": `export const y = 2;`,
    };
    const backwards = {
      "post.ts": `export const y = 2;`,
      "deck.ts": `export const x = 1;`,
      "main.ts": forwards["main.ts"],
    };

    const effectsOf = async (
      files: Record<string, string>,
    ): Promise<string> => {
      const asked: Asked[] = [];
      const interpreter = await createInterpreter({
        seed: 1,
        now: () => 0,
        ...stubHost(asked),
      });
      interpreter.load(bundlePlace(files, "main.ts"));
      interpreter.dispose();
      return JSON.stringify(asked);
    };

    expect(await effectsOf(forwards)).toBe(await effectsOf(backwards));
  });
});

describe("a place that is not well behaved", () => {
  it("is refused at bundle time rather than failing inside the interpreter", async () => {
    // The whole point of bundling before loading: the message names the file and the import,
    // where the person who wrote the place can act on it. The alternative is an error inside a
    // WebAssembly module about a line number in a scope nobody wrote.
    const asked: Asked[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 0,
      ...stubHost(asked),
    });
    expect(() =>
      interpreter.load(
        bundlePlace(
          {
            "main.ts": `import { log } from "${GUEST_MODULE}";\nimport x from "https://elsewhere.test/x";\nlog("x");`,
          },
          "main.ts",
        ),
      ),
    ).toThrow(/outside itself/);
    interpreter.dispose();
  });

  it("is told when the host refuses one of its effects", async () => {
    // A place that silently lost its shape would be a world with a bridge missing from it. A
    // `PlaceError` naming the refusal fails at the line that caused it instead.
    const asked: Asked[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 0,
      onDispatch: (tag): string => (tag === "log" ? "" : "bridge is full"),
      onQuery: () => "null",
    });
    expect(() =>
      interpreter.load(
        asPlaceSource(`
          engine.dispatch("shape-add", JSON.stringify({ place: "bridge", id: "deck" }));
        `),
      ),
    ).not.toThrow();

    // And through the library, which is the path a place actually takes.
    const withLibrary = await createInterpreter({
      seed: 1,
      now: () => 0,
      onDispatch: (): string => "bridge is full",
      onQuery: () => "null",
    });
    expect(() =>
      withLibrary.load(
        bundlePlace(
          {
            "main.ts": `
              import { createShape } from "${GUEST_MODULE}";
              createShape({ place: "bridge", id: "deck", at: [0,0,0], shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" });
            `,
          },
          "main.ts",
        ),
      ),
    ).toThrow(/shape-add: bridge is full/);
    void asked;
    interpreter.dispose();
    withLibrary.dispose();
  });

  it("keeps working after a place throws, so one bad step is not a dead place", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { log, onTick } from "${GUEST_MODULE}";
        let n = 0;
        onTick(() => {
          n++;
          if (n === 2) throw new Error("second step is broken");
          log("step " + n);
        });
      `,
    });

    interpreter.step("1", "[]");
    expect(() => interpreter.step("2", "[]")).toThrow(/second step is broken/);
    interpreter.step("3", "[]");
    expect(asked.map((a) => a.payload["text"])).toEqual(["step 1", "step 3"]);
    interpreter.dispose();
  });
});

/**
 * The light functions, through the real interpreter.
 *
 * ## Why this file rather than `host.test.ts`
 *
 * That one tests the host: given a `light-add` effect, does it keep a light? It cannot catch a
 * guest function that sends the wrong field name, a bridge that drops the tag, or a bundler that
 * fails to export the symbol — each of which passes every layer's own test and fails here, and
 * none of which is visible from either end. This file runs the real compiler, the real bundler and
 * the real interpreter together, which is the only place the seam itself is under test.
 */
describe("a place lights the world", () => {
  it("sends a light-add with every field the host needs, named as the effect expects", async () => {
    const { asked } = await run({
      "main.ts": `
        import { createLight } from "voxelscape";
        createLight({
          id: "lamp",
          at: [10, 20, 30],
          colour: { r: 255, g: 128, b: 0 },
          radius: 40,
          intensity: 2,
        });
      `,
    });

    expect(asked).toEqual([
      {
        tag: "light-add",
        payload: {
          id: "lamp",
          at: [10, 20, 30],
          colour: { r: 255, g: 128, b: 0 },
          radius: 40,
          intensity: 2,
        },
      },
    ]);
  });

  it("sends a light-remove by id, and one that is absent is not an error", async () => {
    // **A cleanup path that refuses is a script that cannot be re-run.** Removing something that
    // is not there is what a handler does on its second call.
    const { asked, interpreter } = await run({
      "main.ts": `
        import { removeLight } from "voxelscape";
        removeLight("never-existed");
      `,
    });
    expect(asked).toEqual([
      { tag: "light-remove", payload: { id: "never-existed" } },
    ]);
    // Nothing to hand it: the place registered no handler, so a step is a no-op rather than a
    // throw. That is what "removing something absent does nothing" means from a script's side.
    expect(() => interpreter.step("1700000000000", "[]")).not.toThrow();
  });

  it("is sent from inside a handler, which is the only way a place reacts to anything", async () => {
    // **A place has no promises and no `await` (ADR 0015),** so a lantern cannot simply "come on
    // in a moment": something has to hand the script an event. This asserts the light a script
    // builds *in response to one* is as well-formed as one built at load — the case a timer-driven
    // lantern actually takes.
    //
    // The timer is passed in as an event rather than waited for, because this file's stub host
    // records effects and does not schedule them; which timers are due is `host.test.ts`'s
    // business and is tested there.
    const { asked, interpreter } = await run({
      "main.ts": `
        import { createLight, log, onTick } from "voxelscape";
        onTick((info) => {
          for (const event of info.events) {
            if (event.kind !== "timer") continue;
            createLight({
              id: "lamp",
              at: [1, 2, 3],
              colour: { r: 255, g: 214, b: 140 },
              radius: 90,
              intensity: 1,
            });
            log("lit from " + event.timerId);
          }
        });
      `,
    });

    interpreter.step(
      "1700000000000",
      JSON.stringify([
        {
          kind: "timer",
          at: 1,
          producer: "peer-a",
          payload: { timerId: "lantern-0" },
        },
      ]),
    );

    expect(asked.map((one) => one.tag)).toEqual(["light-add", "log"]);
    expect(asked[0]!.payload).toEqual({
      id: "lamp",
      at: [1, 2, 3],
      colour: { r: 255, g: 214, b: 140 },
      radius: 90,
      intensity: 1,
    });
    interpreter.dispose();
  });

  it("refuses a light the vocabulary will not accept, and says so to the place", async () => {
    // **The all-or-nothing payload rule (ADR 0017), at the seam.** A negative radius is not a dim
    // light, it is a light the renderer would then have to guard against — so it is refused rather
    // than clamped, and the refusal is *thrown into the script* rather than logged. A place that
    // carried on regardless would be a place with a light in it that no renderer honours.
    await expect(
      run({
        "main.ts": `
          import { createLight } from "voxelscape";
          createLight({
            id: "lamp",
            at: [0, 0, 0],
            colour: { r: 255, g: 255, b: 255 },
            radius: -5,
            intensity: 1,
          });
        `,
      }),
    ).rejects.toThrow(/light-add/);
  });
});

/**
 * The field functions, through the real interpreter.
 *
 * ## Why this file and not `host.test.ts`
 *
 * That file proves the host keeps what it is given. It cannot catch a guest function that sends
 * the wrong field name, a bridge that drops the tag, or a bundler that fails to export the symbol
 * — each of which passes its own layer's test and fails here, and none of which is visible from
 * either end.
 *
 * ## And the one that is about the *absence* of a field
 *
 * `getMediumAt` returns `undefined` where no field stands, and that is a value the guest library
 * has to recognise rather than pass on. A field object with four of its five numbers would be added
 * to a velocity and produce a NaN that travels; the check is here so that cannot happen at the
 * boundary.
 */
describe("a place declares a field", () => {
  it("sends a medium-add with every field the host needs", async () => {
    const { asked } = await run({
      "main.ts": `
        import { createMedium } from "voxelscape";
        createMedium({
          id: "belt",
          box: [[-10, 0, -5], [10, 4, 5]],
          pushVx: 0,
          pushVz: 60,
          speedScale: 1,
          sink: 8,
        });
      `,
    });

    expect(asked).toEqual([
      {
        tag: "medium-add",
        payload: {
          id: "belt",
          box: [
            [-10, 0, -5],
            [10, 4, 5],
          ],
          pushVx: 0,
          pushVz: 60,
          speedScale: 1,
          sink: 8,
        },
      },
    ]);
  });

  it("leaves pushVy and sink out entirely when they were not asked for", async () => {
    // **Absent rather than zero or null.** A field that named no vertical pull must not fight the
    // fall, and a payload that spelled out `pushVy: 0` would be an updraft that pins the player to
    // the ground — which is the whole difference between a conveyor and a conveyor in a lift shaft.
    const { asked } = await run({
      "main.ts": `
        import { createMedium } from "voxelscape";
        createMedium({ id: "flat", box: [[0,0,0],[4,4,4]], pushVx: 0, pushVz: 10, speedScale: 1 });
      `,
    });

    expect(asked[0]!.payload).not.toHaveProperty("pushVy");
    expect(asked[0]!.payload).not.toHaveProperty("sink");
  });

  it("sends a medium-remove by id, and one that is absent is not an error", async () => {
    const { asked } = await run({
      "main.ts": `
        import { removeMedium } from "voxelscape";
        removeMedium("never-existed");
      `,
    });
    expect(asked).toEqual([
      { tag: "medium-remove", payload: { id: "never-existed" } },
    ]);
  });

  it("refuses a field the vocabulary will not accept, and says so to the place", async () => {
    // **The all-or-nothing payload rule (ADR 0017) at the seam.** A negative push is not a belt
    // going the other way, it is a number that would carry the player backwards off the map; the
    // rule is refused rather than clamped, and thrown into the script rather than logged, because a
    // place that carried on would have a field no renderer or physics agrees about.
    await expect(
      run({
        "main.ts": `
          import { createMedium } from "voxelscape";
          createMedium({ id: "belt", box: [[0,0,0],[4,4,4]], pushVx: 0, pushVz: -9999, speedScale: 1 });
        `,
      }),
    ).rejects.toThrow(/medium-add/);
  });

  it("reads a field back, and reports none where there is none", async () => {
    const { asked, interpreter } = await run({
      "main.ts": `
        import { getMediumAt, log, onTick } from "voxelscape";
        onTick(() => {
          const inside = getMediumAt(200, 2, 5);
          const outside = getMediumAt(0, 2, 5);
          log(inside === undefined ? "none" : "push " + inside.pushVz);
          log(outside === undefined ? "none" : "push " + outside.pushVz);
        });
      `,
    });
    // The stub answers with a field beyond `x = 100` and nothing before it, so both branches are
    // covered by one step — and `undefined` rather than a null-ish object is what the script sees.
    interpreter.step("1700000000000", "[]");
    expect(asked.map((one) => one.payload["text"])).toEqual([
      "push 25",
      "none",
    ]);
    interpreter.dispose();
  });

  it("refuses to hand back a field that is missing one of its numbers", async () => {
    // **The check at the boundary.** The host's own `Medium` has five fields and the physics adds
    // every one of them to something; four would produce `undefined` in a velocity and a NaN that
    // then travels through the frame. If the bridge ever answered with a partial object, the script
    // must see `undefined` rather than something that looks usable.
    const asked: Asked[] = [];
    const interpreter = await createInterpreter({
      seed: 1,
      now: () => 1_700_000_000_000,
      onDispatch: (tag, payloadJson) => {
        const parsed = parseEffect(tag, JSON.parse(payloadJson));
        if (parsed === null) return `${tag}: refused`;
        asked.push({ tag, payload: parsed.payload as Record<string, unknown> });
        return "";
      },
      // **Four of the five**, and the missing one is `sink`.
      onQuery: () =>
        JSON.stringify({ pushVx: 0, pushVz: 10, pushVy: null, speedScale: 1 }),
    });
    interpreter.load(
      bundlePlace(
        {
          "main.ts": `
            import { getMediumAt, log, onTick } from "voxelscape";
            onTick(() => { log(getMediumAt(0, 0, 0) === undefined ? "none" : "a field"); });
          `,
        },
        "main.ts",
      ),
    );
    interpreter.step("1700000000000", "[]");
    expect(asked.map((one) => one.payload["text"])).toEqual(["none"]);
    interpreter.dispose();
  });
});
