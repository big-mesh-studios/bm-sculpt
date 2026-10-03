import { describe, expect, it } from "vitest";

import {
  EFFECTS,
  EFFECT_TAGS,
  fieldsFor,
  parseEffect,
  parseEffectJson,
  type EffectTag,
} from "./effects";
import { checkField, checkPayload, SHAPE_TYPES } from "./fields";
import {
  MAX_CLOCK_MULTIPLIER,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_ZONES,
  MIN_SHAPE_SIZE,
  MAX_SHAPE_SIZE,
} from "./limits";

/**
 * The vocabulary is only worth anything if it is exhaustive, and "exhaustive" is not a thing
 * a test file can assert by reading — it has to be derived. So most of what follows is a
 * loop over `EFFECT_TAGS` or `EFFECTS` rather than a hand-written expectation per tag, and
 * a hand-written expectation appears only where there is a specific claim to make.
 *
 * The three failures this file exists to prevent:
 *
 * 1. A tag that exists in the union but has no entry in the table, so it is never checked.
 * 2. A field that a payload is *allowed* to carry but nothing validates.
 * 3. A payload that is nine-tenths valid and gets applied as far as it parses.
 */

/** A payload that satisfies every rule for a tag, so a test can spoil one field. */
const validFor = (tag: EffectTag): Record<string, unknown> => {
  const sample: Record<EffectTag, Record<string, unknown>> = {
    "shape-add": {
      place: "bridge",
      id: "deck",
      at: [10, 20, 30],
      shape: { type: "Box", len: { x: 40, y: 40, z: 40 } },
      combine: "Add",
    },
    "shape-remove": { place: "bridge", id: "deck" },
    "place-remove": { place: "bridge" },
    "place-clear": { place: "bridge" },
    "zone-add": {
      id: "door",
      box: [
        [0, 0, 0],
        [10, 10, 10],
      ],
    },
    "zone-remove": { id: "door" },
    "light-add": {
      id: "lamp",
      at: [4, 5, 6],
      colour: { r: 255, g: 214, b: 140 },
      radius: 40,
      intensity: 1,
    },
    "light-remove": { id: "lamp" },
    "medium-add": {
      id: "belt",
      box: [
        [-10, 0, -5],
        [10, 4, 5],
      ],
      pushVx: 0,
      pushVz: 40,
      speedScale: 1,
    },
    "medium-remove": { id: "belt" },
    "clock-set": { seconds: 300 },
    "clock-speed": { multiplier: 1 },
    "player-place": { at: [1, 2, 3] },
    "player-speed": { multiplier: 1.5 },
    "player-jump": { multiplier: 1.5 },
    "player-fly": { on: true },
    "camera-look": { at: [0, 0, 0] },
    "camera-clear": {},
    log: { text: "hello" },
    toast: { text: "hello" },
    timer: { id: "later", afterMs: 1000 },
    "data-set": { scope: "global", key: "seen", value: "yes" },
    "data-delete": { scope: "global", key: "seen" },
  };
  return { ...sample[tag] };
};

describe("every tag is a tag", () => {
  it("has a table entry, so it cannot exist without being validated", () => {
    // Failure 1. A tag in the union with no entry would be offered to a script and then
    // refused on arrival, with nothing in this repository saying so.
    for (const tag of EFFECT_TAGS) {
      expect(EFFECTS[tag], tag).toBeDefined();
      expect(EFFECTS[tag].tag, tag).toBe(tag);
    }
    expect(Object.keys(EFFECTS).sort()).toEqual([...EFFECT_TAGS].sort());
  });

  it("accepts a well-formed payload for every tag", () => {
    for (const tag of EFFECT_TAGS) {
      expect(parseEffect(tag, validFor(tag)), tag).not.toBeNull();
    }
  });

  it("refuses a tag it does not know", () => {
    // A tag from a future build, or a peer's idea of one. Refused rather than ignored,
    // which is what makes the vocabulary safe to extend.
    expect(parseEffect("shape-explode", { place: "bridge" })).toBeNull();
    expect(parseEffect("npc", { id: "zombie" })).toBeNull();
    expect(parseEffect("", {})).toBeNull();
  });

  it("refuses a tag that is not a string at all", () => {
    expect(parseEffect(undefined, {})).toBeNull();
    expect(parseEffect(7, {})).toBeNull();
    expect(parseEffect({ tag: "log" }, {})).toBeNull();
  });

  it("refuses a payload that is not an object", () => {
    for (const bad of ["a string", 42, null, undefined, [1, 2, 3], true]) {
      expect(parseEffect("log", bad), String(bad)).toBeNull();
    }
  });
});

describe("every field is bounded", () => {
  it("refuses a name over the limit and one that is empty", () => {
    expect(
      parseEffect("place-remove", { place: "x".repeat(MAX_NAME_LENGTH) }),
    ).not.toBeNull();
    expect(
      parseEffect("place-remove", { place: "x".repeat(MAX_NAME_LENGTH + 1) }),
    ).toBeNull();
    expect(parseEffect("place-remove", { place: "" })).toBeNull();
  });

  it("refuses text over the limit", () => {
    expect(
      parseEffect("log", { text: "x".repeat(MAX_TEXT_LENGTH) }),
    ).not.toBeNull();
    expect(
      parseEffect("log", { text: "x".repeat(MAX_TEXT_LENGTH + 1) }),
    ).toBeNull();
  });

  it("refuses a coordinate outside the world and one that is not finite", () => {
    const at = (x: number): Record<string, unknown> => ({
      place: "p",
      id: "i",
      at: [x, 0, 0],
      shape: { type: "Box", len: { x: 1, y: 1, z: 1 } },
      combine: "Add",
    });
    expect(parseEffect("shape-add", at(1e6))?.tag).toBe("shape-add");
    expect(parseEffect("shape-add", at(1e9))).toBeNull();
    expect(parseEffect("shape-add", at(Number.POSITIVE_INFINITY))).toBeNull();
    expect(parseEffect("shape-add", at(Number.NaN))).toBeNull();
    // The vector is three numbers, not three hundred.
    expect(parseEffect("shape-add", { ...at(0), at: [1, 2] })).toBeNull();
  });

  it("refuses a shape dimension outside the size bounds or degenerate", () => {
    const withLen = (n: number): Record<string, unknown> => ({
      ...validFor("shape-add"),
      shape: { type: "Box", len: { x: n, y: 40, z: 40 } },
    });
    expect(parseEffect("shape-add", withLen(MIN_SHAPE_SIZE))?.tag).toBe(
      "shape-add",
    );
    expect(parseEffect("shape-add", withLen(MAX_SHAPE_SIZE))?.tag).toBe(
      "shape-add",
    );
    expect(parseEffect("shape-add", withLen(MAX_SHAPE_SIZE * 2))).toBeNull();
    expect(parseEffect("shape-add", withLen(0))).toBeNull();
    expect(parseEffect("shape-add", withLen(-1))).toBeNull();
    expect(parseEffect("shape-add", withLen(Number.NaN))).toBeNull();
  });

  it("refuses a colour channel outside a byte or not a whole number", () => {
    const withColour = (channel: number): Record<string, unknown> => ({
      ...validFor("shape-add"),
      colour: { r: 255, g: 128, b: channel },
    });
    expect(parseEffect("shape-add", withColour(0))?.tag).toBe("shape-add");
    expect(parseEffect("shape-add", withColour(255))?.tag).toBe("shape-add");
    expect(parseEffect("shape-add", withColour(256))).toBeNull();
    expect(parseEffect("shape-add", withColour(-1))).toBeNull();
    expect(parseEffect("shape-add", withColour(128.5))).toBeNull();
    // And a missing channel is not a colour.
    expect(
      parseEffect("shape-add", {
        ...validFor("shape-add"),
        colour: { r: 1, g: 2 },
      }),
    ).toBeNull();
  });

  it("refuses a multiplier over its own bound, and not a walking speed for a clock", () => {
    // The two multipliers have separate bounds on purpose: raising how fast a player walks
    // must not also raise how fast a day passes.
    expect(parseEffect("player-speed", { multiplier: 10 })?.tag).toBe(
      "player-speed",
    );
    expect(parseEffect("player-speed", { multiplier: 10.1 })).toBeNull();
    expect(
      parseEffect("clock-speed", { multiplier: MAX_CLOCK_MULTIPLIER })?.tag,
    ).toBe("clock-speed");
    expect(
      parseEffect("clock-speed", { multiplier: MAX_CLOCK_MULTIPLIER + 1 }),
    ).toBeNull();
    // A negative speed is nonsense; a clock may be stopped, but not run backwards.
    expect(parseEffect("player-speed", { multiplier: -1 })).toBeNull();
    expect(parseEffect("clock-speed", { multiplier: -1 })).toBeNull();
    expect(parseEffect("clock-speed", { multiplier: 0 })?.tag).toBe(
      "clock-speed",
    );
  });

  it("requires a boolean to be a boolean", () => {
    // The one field type where a truthiness check would be a plausible bug: `1` and
    // `"true"` both read as true, and mean different things to the peer that sent them.
    expect(parseEffect("player-fly", { on: true })?.tag).toBe("player-fly");
    expect(parseEffect("player-fly", { on: false })?.tag).toBe("player-fly");
    expect(parseEffect("player-fly", { on: 1 })).toBeNull();
    expect(parseEffect("player-fly", { on: "true" })).toBeNull();
    expect(parseEffect("player-fly", { on: null })).toBeNull();
  });

  it("refuses a timer beyond a day and accepts one at the limit", () => {
    expect(parseEffect("timer", { id: "t", afterMs: 86_400_000 })?.tag).toBe(
      "timer",
    );
    expect(parseEffect("timer", { id: "t", afterMs: 86_400_001 })).toBeNull();
    expect(parseEffect("timer", { id: "t", afterMs: -1 })).toBeNull();
    expect(parseEffect("timer", { id: "t" })).toBeNull();
  });

  it("refuses a zone box that is not two corners, or reaches too far", () => {
    const withBox = (box: unknown): Record<string, unknown> => ({
      id: "door",
      box,
    });
    expect(
      parseEffect(
        "zone-add",
        withBox([
          [0, 0, 0],
          [1, 1, 1],
        ]),
      )?.tag,
    ).toBe("zone-add");
    expect(parseEffect("zone-add", withBox([0, 0, 0]))).toBeNull();
    expect(
      parseEffect(
        "zone-add",
        withBox([
          [0, 0, 0],
          [1, 1, 1],
          [2, 2, 2],
        ]),
      ),
    ).toBeNull();
    expect(parseEffect("zone-add", withBox([[0, 0, 0], 1]))).toBeNull();
    expect(
      parseEffect(
        "zone-add",
        withBox([
          [0, 0, 0],
          [1e6, 0, 0],
        ]),
      ),
    ).toBeNull();
  });

  it("refuses a quaternion that is not four parts inside the unit ball", () => {
    const withOrientation = (
      orientation: unknown,
    ): Record<string, unknown> => ({
      ...validFor("shape-add"),
      orientation,
    });
    expect(parseEffect("shape-add", withOrientation([0, 0, 0, 1]))?.tag).toBe(
      "shape-add",
    );
    expect(parseEffect("shape-add", withOrientation([0, 0, 1]))).toBeNull();
    expect(parseEffect("shape-add", withOrientation([0, 0, 0, 2]))).toBeNull();
  });

  it("refuses a yaw that is not an angle", () => {
    const at = { at: [0, 0, 0], yaw: 0 };
    expect(parseEffect("player-place", { ...at, yaw: Math.PI })?.tag).toBe(
      "player-place",
    );
    expect(parseEffect("player-place", { ...at, yaw: 4 * Math.PI })).toBeNull();
    expect(parseEffect("player-place", { ...at, yaw: 180 })).toBeNull();
  });
});

describe("a payload is refused whole or not at all", () => {
  it("refuses a payload with one bad field rather than applying the rest", () => {
    // Failure 3, and the reason `parseEffect` has no partial result type. A shape whose id
    // and place are fine and whose `at` is null must not become a shape at the origin: the
    // author asked for a position and did not give one.
    const half = { ...validFor("shape-add"), at: null };
    expect(parseEffect("shape-add", half)).toBeNull();
  });

  it("refuses a payload with a field it does not declare", () => {
    // Failure 2. An unknown key is a peer sending something this build cannot check, and
    // there is no safe reading of a field nobody validated. It also means a future field
    // cannot arrive at an old peer and be silently dropped there.
    expect(parseEffect("log", { text: "hi", colour: "#ff0000" })).toBeNull();
    expect(
      parseEffect("place-remove", { place: "bridge", force: true }),
    ).toBeNull();
  });

  it("refuses a payload missing a required field", () => {
    expect(parseEffect("shape-add", { place: "p", id: "i" })).toBeNull();
    expect(parseEffect("log", {})).toBeNull();
    expect(parseEffect("zone-add", { id: "door" })).toBeNull();
  });

  it("refuses a payload that survives every field check by being the wrong shape", () => {
    // A `shape` that names a type but carries another type's fields. The per-shape fields
    // are checked against the shape named, because a capsule read from a `len` is a `NaN`
    // origin three modules away, inside the fold.
    const capsuleWithLen = {
      ...validFor("shape-add"),
      shape: { type: "Capsule", len: { x: 40, y: 40, z: 40 } },
    };
    expect(parseEffect("shape-add", capsuleWithLen)).toBeNull();

    const capsuleRight = {
      ...validFor("shape-add"),
      shape: { type: "Capsule", len: 40, radius: 10 },
    };
    expect(parseEffect("shape-add", capsuleRight)?.tag).toBe("shape-add");

    // **And the reverse, which is the case the table made checkable for free**: a
    // payload with every field a primitive wants *and* one it does not. `Torus` takes
    // `majorRadius` and `minorRadius`, so a `radius` alongside them is a field this
    // build cannot check — and there is no safe reading of a field nobody validated.
    // Six new primitives arrived with the table, and each one is a new way for a
    // hand-written checker to accept a field it never looked at.
    const torusWithExtra = {
      ...validFor("shape-add"),
      shape: { type: "Torus", majorRadius: 40, minorRadius: 10, radius: 5 },
    };
    expect(parseEffect("shape-add", torusWithExtra)).toBeNull();
  });

  it("refuses a shape with no type", () => {
    expect(
      parseEffect("shape-add", { ...validFor("shape-add"), shape: {} }),
    ).toBeNull();
    expect(
      parseEffect("shape-add", {
        ...validFor("shape-add"),
        shape: { type: "Tetrahedron", radius: { x: 1, y: 1, z: 1 } },
      }),
    ).toBeNull();
  });

  it("refuses a combine it does not know", () => {
    for (const combine of ["Add", "Subtract", "Paint"]) {
      expect(
        parseEffect("shape-add", { ...validFor("shape-add"), combine })?.tag,
        combine,
      ).toBe("shape-add");
    }
    expect(
      parseEffect("shape-add", { ...validFor("shape-add"), combine: "Union" }),
    ).toBeNull();
  });
});

describe("a payload arrives as JSON text, and text can be wrong", () => {
  it("reads a well-formed one", () => {
    const parsed = parseEffectJson("log", JSON.stringify({ text: "hello" }));
    expect(parsed?.tag).toBe("log");
    expect(parsed?.payload).toEqual({ text: "hello" });
  });

  it("refuses truncated JSON without throwing", () => {
    // What a connection cut mid-message looks like. Throwing here would put the host's own
    // error handling in the path of a peer's bytes, which is exactly where it must not be.
    expect(parseEffectJson("log", '{"text":"hel')).toBeNull();
    expect(parseEffectJson("log", "")).toBeNull();
    expect(parseEffectJson("log", "not json at all")).toBeNull();
  });

  it("refuses JSON that parses to the wrong thing", () => {
    expect(parseEffectJson("log", '"a string"')).toBeNull();
    expect(parseEffectJson("log", "null")).toBeNull();
    expect(parseEffectJson("log", "[1,2,3]")).toBeNull();
    expect(parseEffectJson("log", 42)).toBeNull();
    expect(parseEffectJson("log", undefined)).toBeNull();
  });

  it("still checks the fields after parsing", () => {
    expect(parseEffectJson("log", JSON.stringify({ text: 42 }))).toBeNull();
    expect(
      parseEffectJson(
        "place-remove",
        JSON.stringify({ place: "x".repeat(200) }),
      ),
    ).toBeNull();
  });
});

describe("the rules are the definition, not a copy of it", () => {
  it("refuses an unparseable payload for every tag", () => {
    // The loop that makes a tag's presence in the table mean something: for each tag, a
    // payload that is wrong in one required field, and the parser must say no.
    for (const tag of EFFECT_TAGS) {
      expect(
        parseEffect(tag, { ...validFor(tag), __nonsense: true }),
        tag,
      ).toBeNull();
    }
  });

  it("gives every tag a readable description and field documentation", () => {
    // The table is also what a generated reference document would be read from, so a tag or
    // field with no prose in it is a gap in the documentation that nothing else catches.
    for (const tag of EFFECT_TAGS) {
      expect(EFFECTS[tag].about.length, tag).toBeGreaterThan(20);
      for (const field of EFFECTS[tag].fields) {
        expect(field.about, `${tag}.${field.name}`).toBeDefined();
      }
    }
  });

  it("names every primitive in the shape field's documentation", () => {
    // **This caught a real staleness.** The `shape` field's `about` was the literal
    // string "a primitive: Ellipsoid, Box or Capsule" — true when written, and a lie the
    // day the table gained six more. It was in the one place a place author actually
    // reads, and nothing failed when it went out of date, because documentation is not
    // a compiler and a prose list of primitive names is exactly what ADR 0025 removed
    // everywhere else.
    //
    // So the description is generated, and this asserts the generation happened: every
    // primitive in the table is named, and nothing is named that is not in the table.
    const about = EFFECTS["shape-add"].fields.find(
      (f) => f.name === "shape",
    )?.about;
    expect(about).toBeDefined();
    for (const type of SHAPE_TYPES) {
      expect(
        about,
        `${type} is missing from the shape documentation`,
      ).toContain(type);
    }
    // And no leftover prose naming a primitive that does not exist.
    const named = about!.match(/[A-Z][a-zA-Z]+/g) ?? [];
    for (const word of named) {
      if (word === "A") continue;
      expect(
        SHAPE_TYPES as readonly string[],
        `"${word}" is documented but is not a primitive`,
      ).toContain(word);
    }
  });

  it("gives every field a name that is a plausible identifier", () => {
    for (const tag of EFFECT_TAGS) {
      for (const field of fieldsFor(tag) ?? []) {
        expect(field.name, tag).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
    }
  });

  it("refuses a depth the checker will not follow", () => {
    // Untrusted input can be arbitrarily deep or cyclic, and the thing that validates a
    // peer's data cannot be what runs out of stack.
    const deep = (n: number): Record<string, unknown> => {
      let value: Record<string, unknown> = { type: "Box" };
      for (let i = 0; i < n; i++) value = { nested: value };
      return value;
    };
    expect(
      checkPayload([{ name: "at", kind: "vec3" }], { at: deep(2) }),
    ).not.toBeNull();
    expect(
      checkPayload([{ name: "at", kind: "vec3" }], { at: deep(200) }),
    ).not.toBeNull();
  });

  it("survives a cyclic payload", () => {
    // The same hazard with an edge rather than a depth. A cyclic object reaches the shape
    // check, which reads three named keys and never recurses into them.
    const cyclic: Record<string, unknown> = { type: "Box" };
    cyclic["self"] = cyclic;
    const refusal = checkPayload([{ name: "shape", kind: "shape" }], {
      shape: cyclic,
    });
    expect(refusal).not.toBeNull();
  });

  it("names the field it refused, so a log line is a bug report", () => {
    const refusal = checkPayload(fieldsFor("shape-add") ?? [], {
      ...validFor("shape-add"),
      at: ["nope", 0, 0],
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.field).toBe("at");
    // "shape-add was rejected" is not actionable. "at has a part that is not a finite
    // number" is.
    expect(refusal?.why).toContain("finite number");
  });

  it("checks a field in isolation, for a caller testing one rule", () => {
    expect(checkField({ name: "n", kind: "unit" }, 0.5)).toBeNull();
    expect(checkField({ name: "n", kind: "unit" }, 1.5)).not.toBeNull();
    expect(checkField({ name: "n", kind: "count" }, 1.5)).not.toBeNull();
    expect(checkField({ name: "n", kind: "count" }, 2)).toBeNull();
  });
});

describe("the zone and data caps are stated where a host reads them", () => {
  it("caps zones below what an unbounded list would cost per frame", () => {
    // The player is tested against every zone once a frame, so this number is a per-frame
    // budget rather than a memory limit. Exported so the host's own cap and the documented
    // one cannot differ.
    expect(MAX_ZONES).toBeLessThanOrEqual(1024);
    expect(MAX_ZONES).toBeGreaterThan(0);
  });
});
