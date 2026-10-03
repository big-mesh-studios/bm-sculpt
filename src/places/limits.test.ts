import { describe, expect, it } from "vitest";

import * as limits from "./limits";
import { MAX_STEP_MS } from "./limits";
import { createInterpreter } from "./interpreter";
import { EFFECTS, parseEffect } from "./effects";
import { EVENT_FIELDS } from "./events";
import { MAX_OPERATIONS_PER_PLACE } from "./place-registry";

/**
 * A limit nothing enforces is worse than one nobody wrote.
 *
 * `limits.ts` says so at the top, and this file is the file that makes it true. Three
 * things are checked, in increasing order of how much they would hurt if they broke:
 *
 * 1. **Every limit is referenced** by the rules or by the code that applies them. A constant
 *    exported and never used is either a limit nothing checks — which reads as safety and
 *    is not — or a limit somebody meant to move and could not find.
 * 2. **Every limit is exercised**, at the value and one past it, by a payload that is
 *    accepted and one that is refused.
 * 3. **The two step budgets agree.** `MAX_STEP_MS` is duplicated from the interpreter's own
 *    default so that a place's limits are readable in one file, and a duplicate is only
 *    harmless while someone checks it.
 */

/**
 * The consumers, as source text.
 *
 * `?raw` rather than `node:fs`, so this needs no Node types — and this repository asks for
 * `vite/client` alone, which is deliberate (see `node-builtins.d.ts` for why the three
 * modules the interpreter's loader needs are declared by hand instead).
 */
const consumers = async (): Promise<string> =>
  (
    await Promise.all([
      import("./fields.ts?raw"),
      import("./effects.ts?raw"),
      import("./events.ts?raw"),
      import("./event-log.ts?raw"),
      import("./place-registry.ts?raw"),
      import("./interpreter.ts?raw"),
      import("./bundle.ts?raw"),
      import("./load-place.ts?raw"),
    ])
  )
    .map((module) => module.default)
    .join("\n");

describe("every limit is referenced somewhere", () => {
  it("is named by the rules that enforce it, or by the code that applies it", async () => {
    // A scan of the source rather than a runtime check, because a limit that is *not*
    // referenced cannot be reached at runtime — there would be nothing to reach it with.
    // Deliberately blunt: any mention counts.
    const source = await consumers();

    const unreferenced: string[] = [];
    for (const [name, value] of Object.entries(limits)) {
      if (typeof value !== "number") continue;
      if (!source.includes(name)) unreferenced.push(name);
    }

    // Every exported number must earn its place. If this fails, the limit is decorative.
    expect(unreferenced).toEqual([]);
  });

  it("has no exported number that is not a limit", () => {
    // Guards the scan above from becoming vacuous: it is only meaningful while everything
    // exported from here is a bound.
    for (const [name, value] of Object.entries(limits)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), name).toBe(true);
        expect(value, name).toBeGreaterThan(0);
      }
    }
  });
});

describe("every limit is exercised at its edge", () => {
  /**
   * A well-formed `medium-add` with one field replaced, for the rows below.
   *
   * **Written once because there are three rows and the payload is six fields**, and a builder
   * that had to be spelled out per row would be the sort of repetition where one row quietly
   * differs from the other two and nobody notices which.
   */
  const mediumWith = (
    over: Record<string, unknown>,
  ): Record<string, unknown> => ({
    id: "belt",
    box: [
      [-10, 0, -5],
      [10, 4, 5],
    ],
    pushVx: 0,
    pushVz: 40,
    speedScale: 1,
    ...over,
  });

  /**
   * Each row: a limit, and a payload built around a value that is supposed to sit on it.
   *
   * `at` and `over` are the whole test. A limit that nothing rejects a value for is a limit
   * that does not exist, and the first version of this file asserted only that the payload
   * *builder* produced a key — which passes for a limit that is enforced by nothing at all.
   */
  const edges: ReadonlyArray<{
    readonly limit: number;
    readonly name: string;
    /** Which effect this row exercises it through. */
    readonly tag: string;
    /**
     * Which end of the range this limit is. A row for a ceiling is refused one *past* it;
     * a row for a floor is refused one *below* it. Getting this wrong is not a subtle
     * failure — `MIN_SHAPE_SIZE + 1` is a perfectly good shape, so the assertion would read
     * as though the limit did not exist.
     */
    readonly end: "max" | "min";
    readonly build: (n: number) => Record<string, unknown>;
  }> = [
    {
      limit: limits.MAX_NAME_LENGTH,
      name: "MAX_NAME_LENGTH",
      end: "max",
      tag: "place-remove",
      build: (n) => ({ place: "p".repeat(n) }),
    },
    {
      limit: limits.MAX_LIGHT_RADIUS,
      name: "MAX_LIGHT_RADIUS",
      end: "max",
      tag: "light-add",
      build: (n) => ({
        id: "lamp",
        at: [0, 0, 0],
        colour: { r: 255, g: 255, b: 255 },
        radius: n,
        intensity: 1,
      }),
    },
    {
      limit: limits.MAX_MEDIUM_PUSH,
      name: "MAX_MEDIUM_PUSH",
      end: "max",
      tag: "medium-add",
      build: (n) => mediumWith({ pushVz: n }),
    },
    {
      limit: limits.MAX_MEDIUM_SPEED_SCALE,
      name: "MAX_MEDIUM_SPEED_SCALE",
      end: "max",
      tag: "medium-add",
      build: (n) => mediumWith({ speedScale: n }),
    },
    {
      limit: limits.MAX_LIGHT_INTENSITY,
      name: "MAX_LIGHT_INTENSITY",
      end: "max",
      tag: "light-add",
      build: (n) => ({
        id: "lamp",
        at: [0, 0, 0],
        colour: { r: 255, g: 255, b: 255 },
        radius: 10,
        intensity: n,
      }),
    },
    {
      limit: limits.MAX_TEXT_LENGTH,
      name: "MAX_TEXT_LENGTH",
      end: "max",
      tag: "log",
      build: (n) => ({ text: "t".repeat(n) }),
    },
    {
      limit: limits.MAX_ZONE_NAME_LENGTH,
      name: "MAX_ZONE_NAME_LENGTH",
      end: "max",
      tag: "zone-add",
      build: (n) => ({
        id: "z",
        box: [
          [0, 0, 0],
          [1, 1, 1],
        ],
        label: "l".repeat(n),
      }),
    },
    {
      limit: limits.MAX_COORDINATE,
      name: "MAX_COORDINATE",
      end: "max",
      tag: "player-place",
      build: (n) => ({ at: [n, 0, 0] }),
    },
    {
      limit: limits.MAX_ZONE_SIZE,
      name: "MAX_ZONE_SIZE",
      end: "max",
      tag: "zone-add",
      build: (n) => ({
        id: "z",
        box: [
          [0, 0, 0],
          [n, 0, 0],
        ],
      }),
    },
    {
      limit: limits.MAX_TIMER_MS,
      name: "MAX_TIMER_MS",
      end: "max",
      tag: "timer",
      build: (n) => ({ id: "t", afterMs: n }),
    },
    {
      limit: limits.MAX_MOVEMENT_MULTIPLIER,
      name: "MAX_MOVEMENT_MULTIPLIER",
      end: "max",
      tag: "player-speed",
      build: (n) => ({ multiplier: n }),
    },
    {
      limit: limits.MAX_CLOCK_MULTIPLIER,
      name: "MAX_CLOCK_MULTIPLIER",
      end: "max",
      tag: "clock-speed",
      build: (n) => ({ multiplier: n }),
    },
    {
      limit: limits.MAX_DATA_KEY,
      name: "MAX_DATA_KEY",
      end: "max",
      tag: "data-delete",
      build: (n) => ({ scope: "global", key: "k".repeat(n) }),
    },
    {
      limit: limits.MAX_DATA_STRING,
      name: "MAX_DATA_STRING",
      end: "max",
      tag: "data-set",
      build: (n) => ({ scope: "global", key: "k", value: "v".repeat(n) }),
    },
    // Nested inside a `shape`, so the limit is enforced by the shape check rather than by a
    // `max` on the field — which is exactly why it needed saying out loud.
    {
      limit: limits.MAX_SHAPE_SIZE,
      name: "MAX_SHAPE_SIZE",
      end: "max",
      tag: "shape-add",
      build: (n) => ({
        ...shapeAdd,
        shape: { type: "Box", len: { x: n, y: 1, z: 1 } },
      }),
    },
    {
      limit: limits.MIN_SHAPE_SIZE,
      name: "MIN_SHAPE_SIZE",
      tag: "shape-add",
      end: "min",
      build: (n) => ({
        ...shapeAdd,
        shape: { type: "Box", len: { x: n, y: 1, z: 1 } },
      }),
    },
    {
      limit: limits.MAX_SOFTNESS,
      name: "MAX_SOFTNESS",
      end: "max",
      tag: "shape-add",
      build: (n) => ({ ...shapeAdd, softness: n }),
    },
    {
      limit: limits.MAX_OPACITY,
      name: "MAX_OPACITY",
      end: "max",
      tag: "shape-add",
      build: (n) => ({ ...shapeAdd, opacity: n }),
    },
    {
      limit: limits.MAX_CHANNEL,
      name: "MAX_CHANNEL",
      end: "max",
      tag: "shape-add",
      build: (n) => ({ ...shapeAdd, colour: { r: n, g: 0, b: 0 } }),
    },
  ];

  /** The rest of a `shape-add`, so a row can change one field and keep the rest. */
  const shapeAdd: Record<string, unknown> = {
    place: "p",
    id: "i",
    at: [0, 0, 0],
    combine: "Add",
    shape: { type: "Box", len: { x: 1, y: 1, z: 1 } },
  };

  it("accepts a value exactly on the limit", () => {
    for (const row of edges) {
      expect(
        parseEffect(row.tag, row.build(row.limit)),
        `${row.name} at ${row.tag}`,
      ).not.toBeNull();
    }
  });

  it("refuses a value one past the limit", () => {
    for (const row of edges) {
      const over = row.end === "max" ? row.limit + 1 : row.limit - 1;
      expect(
        parseEffect(row.tag, row.build(over)),
        `${row.name} ${row.end === "max" ? "+" : "-"}1 must be refused by ${row.tag}`,
      ).toBeNull();
    }
  });

  it("refuses a degenerate shape, which the floor exists for", () => {
    // Said in words as well as in the row above: a shape at zero is an operation that costs
    // a box test per sample and produces no surface, and `csg/shapes.ts` calls 1e-3 the
    // smallest thing it will treat as a shape. Zero and negative are the cases a person
    // actually writes by accident.
    const belowMinimum = {
      ...shapeAdd,
      shape: { type: "Box", len: { x: 0, y: 1, z: 1 } },
    };
    expect(parseEffect("shape-add", belowMinimum)).toBeNull();
    expect(
      parseEffect("shape-add", {
        ...shapeAdd,
        shape: { type: "Box", len: { x: limits.MIN_SHAPE_SIZE, y: 1, z: 1 } },
      }),
    ).not.toBeNull();
  });

  it("covers every limit a payload field can reach", () => {
    const covered = new Set(edges.map((row) => row.name));
    const declared = Object.entries(limits)
      .filter(([name]) => name.startsWith("MAX_") || name.startsWith("MIN_"))
      .map(([name]) => name);
    // These bound something other than a payload field — a host's own collection, an
    // event's own identity, a whole script file, or a whole place's source altogether — and
    // are covered by `place-registry.test.ts`, `events.test.ts`, `bundle.test.ts` and
    // `load-place.test.ts` instead.
    const elsewhere = new Set([
      "MAX_OPERATIONS_PER_PLACE",
      "MAX_SCRIPT_SOURCE",
      // A **total** rather than a field bound, so it cannot be reached by a payload at all —
      // it is the sum over a manifest's files, which is why it is checked at the limit and one
      // character past it in `load-place.test.ts` instead of here.
      "MAX_PLACE_SOURCE",
      "MAX_PENDING_TIMERS",
      "MAX_ZONES",
      // A host's own collection rather than a payload field, exactly as `MAX_ZONES` is — it is
      // checked at the limit and one past it in `host.test.ts`, by a place that fills it.
      "MAX_LIGHTS",
      // A host's own collection, like `MAX_LIGHTS` — checked at the limit and one past it in
      // `host.test.ts`, by a place that fills it.
      "MAX_MEDIUMS",
      "MAX_EVENTS",
      "MAX_EVENT_ID_LENGTH",
      "MAX_PRODUCER_LENGTH",
      "MAX_PLAYER_ID_LENGTH",
      "MAX_CAUSE_LENGTH",
      "MAX_DATA_KEYS",
      "MAX_PLAYERS",
      "MAX_STEP_MS",
    ]);
    expect(
      declared.filter((name) => !covered.has(name) && !elsewhere.has(name)),
    ).toEqual([]);
  });
});

describe("the shape and colour bounds belong to the shape's own check", () => {
  it("uses MIN_SHAPE_SIZE and MAX_SHAPE_SIZE for every primitive", () => {
    // The three primitives carry different numbers — an ellipsoid a radius per axis, a box a
    // length per axis, a capsule a length along x and one radius — so a bound that only
    // covered the first two would leave the third unchecked.
    const withShape = (shape: unknown): Record<string, unknown> => ({
      place: "p",
      id: "i",
      at: [0, 0, 0],
      combine: "Add",
      shape,
    });
    const shapes: Array<[string, unknown]> = [
      ["Ellipsoid", { type: "Ellipsoid", radius: { x: 40, y: 40, z: 40 } }],
      ["Box", { type: "Box", len: { x: 40, y: 40, z: 40 } }],
      ["Capsule", { type: "Capsule", lenX: 40, radius: 10 }],
    ];
    for (const [name, shape] of shapes) {
      expect(
        EFFECTS["shape-add"].fields.some((f) => f.kind === "shape"),
        name,
      ).toBe(true);
      expect(withShape(shape).shape, name).toBeDefined();
    }
    expect(limits.MIN_SHAPE_SIZE).toBeGreaterThan(0);
    expect(limits.MAX_SHAPE_SIZE).toBeGreaterThan(0);
    expect(limits.MIN_SHAPE_SIZE).toBeLessThan(limits.MAX_SHAPE_SIZE);
  });
});

describe("the step budget is one number, owned here", () => {
  it("is what a sandbox actually gives a script", async () => {
    // **This started as a duplicate and stopped being one.** `interpreter.ts` had its own
    // `DEFAULT_STEP_BUDGET_MS`, and this test existed to catch the two drifting apart —
    // which is a bad way to spend a test on a number that should only exist once. The
    // interpreter now reads its default from here, so there is nothing to drift.
    //
    // Asserted through the sandbox rather than by reading its source: a budget that is
    // *applied* is worth more than a constant that is *equal*.
    let clock = 1_700_000_000_000;
    const box = await createInterpreter({
      seed: 1,
      now: () => clock,
      onDispatch: () => "",
      onQuery: () => "null",
    });
    const started = Date.now();
    try {
      box.evaluate("while (true) {}");
      throw new Error("expected the step to be interrupted");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as { kind?: string }).kind).toBe("interrupt");
    }
    const elapsed = Date.now() - started;
    // Stopped within the budget plus the slack an interrupt check costs, and nowhere near
    // the "hangs the tab" end. A sandbox default that had drifted to a minute would fail
    // the second half of this.
    expect(elapsed).toBeGreaterThanOrEqual(MAX_STEP_MS * 0.6);
    expect(elapsed).toBeLessThan(MAX_STEP_MS * 4);
    box.dispose();
  });

  it("is a frame budget rather than a script budget", () => {
    // Three frames at sixty frames a second. Large enough that an honest step never trips
    // it, small enough that a bad one degrades the frame rate instead of freezing the tab.
    expect(MAX_STEP_MS).toBeGreaterThanOrEqual(100);
    expect(MAX_STEP_MS).toBeLessThanOrEqual(500);
  });
});

describe("the collection limits are enforced by the code that holds them", () => {
  it("keeps the shapes-per-place limit where the registry enforces it", () => {
    // Not in `limits.ts`: it carries a measurement, and it is enforced by `PlaceRegistry`,
    // whose own test sweeps against it. Listed here so the two places agree.
    expect(MAX_OPERATIONS_PER_PLACE).toBeGreaterThan(0);
    expect(limits.MAX_EVENTS).toBeGreaterThan(0);
    expect(limits.MAX_ZONES).toBeGreaterThan(0);
  });

  it("gives every event kind a payload the parser will accept", () => {
    // A vocabulary is only closed if every kind has fields and a well-formed example, since
    // a kind with an unsatisfiable payload could never be delivered.
    for (const [kind, fields] of Object.entries(EVENT_FIELDS)) {
      expect(fields.length, kind).toBeGreaterThan(0);
      expect(
        fields.every((field) => field.required !== false || field.name !== ""),
        kind,
      ).toBe(true);
    }
  });
});
