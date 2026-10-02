/**
 * `isPlaceManifest` and `isSafePathName`: what a manifest has to be before a byte of it is read.
 *
 * **Table-driven, because the cases are a table.** The validator exists to say no to a
 * particular list of things, and a list of things is what a table is; writing them as prose
 * means the next case someone adds goes in the file wherever they happened to think of it.
 *
 * Every refusal here is checked *against the reason*, not merely as a `false`. A validator whose
 * tests assert `isPlaceManifest(x) === false` pass just as well when the function is
 * `() => false`, and would then be a test suite for the absence of a validator.
 */

import { describe, expect, it } from "vitest";

import {
  isPlaceManifest,
  isSafePathName,
  MAX_PLACE_FILES,
  MAX_PLACE_FILE_NAME,
  MAX_PLACE_NAME,
  MAX_PLACE_SPAWN,
  PLACE_MANIFEST_FILE,
  PLACE_MIME_TYPE,
} from "./place-file";

/** A manifest that passes, for a test to spoil one field of. */
const good = () => ({
  name: "bridge",
  seed: 20260901,
  entry: "main.ts",
  scripts: ["main.ts", "span.ts"],
});

/** `isPlaceManifest` over a field set to each of these, expecting refusal. */
const refuses: readonly (readonly [string, unknown])[] = [
  ["not an object", "bridge"],
  ["null", null],
  ["an array", []],
  ["no name", { ...good(), name: undefined }],
  ["a name that is not a string", { ...good(), name: 7 }],
  ["an empty name", { ...good(), name: "" }],
  [
    "a name over the limit",
    { ...good(), name: "x".repeat(MAX_PLACE_NAME + 1) },
  ],
  ["no seed", { ...good(), seed: undefined }],
  ["a seed that is a string", { ...good(), seed: "20260901" }],
  ["a seed that is NaN", { ...good(), seed: Number.NaN }],
  ["a seed that is infinite", { ...good(), seed: Infinity }],
  ["no entry", { ...good(), entry: undefined }],
  ["an entry that is not a string", { ...good(), entry: 1 }],
  [
    "an entry that is not among the scripts",
    { ...good(), entry: "missing.ts" },
  ],
  ["no scripts", { ...good(), scripts: undefined }],
  ["scripts that is not a list", { ...good(), scripts: "main.ts" }],
  ["an empty scripts list", { ...good(), scripts: [] }],
  [
    "more scripts than a place may hold",
    {
      ...good(),
      scripts: Array.from(
        { length: MAX_PLACE_FILES + 1 },
        (_, at) => `f${at}.ts`,
      ),
    },
  ],
  ["a duplicate script name", { ...good(), scripts: ["main.ts", "main.ts"] }],
  [
    "a script name that is not a string",
    { ...good(), scripts: ["main.ts", 3] },
  ],
  [
    "a script name walking out of the root",
    { ...good(), scripts: ["../evil.ts"] },
  ],
  ["an absolute script name", { ...good(), scripts: ["/etc/passwd"] }],
  ["a script name with a backslash", { ...good(), scripts: ["..\\evil.ts"] }],
  [
    "a script name with an empty segment",
    { ...good(), scripts: ["src//main.ts"] },
  ],
  [
    "a script name with a dot segment",
    { ...good(), scripts: ["src/./main.ts"] },
  ],
  ["a script name with a NUL", { ...good(), scripts: ["main\0.ts"] }],
  [
    "a script name over the limit",
    { ...good(), scripts: [`${"d".repeat(MAX_PLACE_FILE_NAME)}.ts`] },
  ],
  ["a spawn that is not a list", { ...good(), spawn: "0,0,0" }],
  ["a spawn of two numbers", { ...good(), spawn: [0, 0] }],
  ["a spawn of four numbers", { ...good(), spawn: [0, 0, 0, 0] }],
  ["a spawn that is not numbers", { ...good(), spawn: [0, "0", 0] }],
  ["a spawn of NaN", { ...good(), spawn: [Number.NaN, 0, 0] }],
  [
    "a spawn beyond the world",
    { ...good(), spawn: [MAX_PLACE_SPAWN + 1, 0, 0] },
  ],
];

describe("a manifest this can open", () => {
  it.each(refuses)("refuses %s", (_why, value) => {
    expect(isPlaceManifest(value)).toBe(false);
  });

  it("accepts the smallest place there is", () => {
    expect(
      isPlaceManifest({
        name: "a",
        seed: 0,
        entry: "main.ts",
        scripts: ["main.ts"],
      }),
    ).toBe(true);
  });

  it("accepts a seed of zero, which is a seed and not a missing one", () => {
    // **`0` is falsy and a seed is a number.** A `seed || DEFAULT` anywhere in this path would
    // make a place authored against seed zero load someone else's world, and the world would be
    // wrong in a way nothing reports.
    expect(isPlaceManifest({ ...good(), seed: 0 })).toBe(true);
  });

  it("accepts a negative seed", () => {
    // The seed is hashed rather than summed (see `csg/terrain.ts`), so the whole number line is
    // meaningful and half of it is negative.
    expect(isPlaceManifest({ ...good(), seed: -1 })).toBe(true);
  });

  it("accepts a spawn", () => {
    expect(isPlaceManifest({ ...good(), spawn: [1, 2, 3] })).toBe(true);
  });

  it("accepts a spawn exactly at the limit", () => {
    // The boundary belongs in the tests, not only the one past it: a validator using `<` where
    // the constant means `<=` refuses a place the limit allows, and no test above notices.
    expect(
      isPlaceManifest({
        ...good(),
        spawn: [MAX_PLACE_SPAWN, -MAX_PLACE_SPAWN, 0],
      }),
    ).toBe(true);
  });

  it("accepts a place whose scripts are nested in folders", () => {
    expect(
      isPlaceManifest({
        ...good(),
        entry: "main.ts",
        scripts: ["main.ts", "lib/door.ts", "lib/deep/window.ts"],
      }),
    ).toBe(true);
  });

  it("ignores a field it does not know", () => {
    // **Refused nowhere, and deliberately.** ADR 0017 refuses an undeclared field on an effect
    // because that field is arriving at a place's handler; a manifest is read once by this code
    // and never reaches a place, so a field from a later version is inert rather than
    // dangerous — and refusing it would make every added field a breaking change.
    expect(
      isPlaceManifest({ ...good(), mode: "multi", levels: ["hub.json"] }),
    ).toBe(true);
  });

  it("names the file and the type it agrees with the reference on", () => {
    // **Both are the reference's strings**, so a place authored there opens here. They are
    // constants rather than literals at the call sites precisely so that a change to either is
    // a change to one line and a test failure rather than a silent incompatibility.
    expect(PLACE_MANIFEST_FILE).toBe("manifest.json");
    expect(PLACE_MIME_TYPE).toBe("application/zip");
  });
});

describe("a path a zip may hold", () => {
  it("accepts a plain file name", () => {
    expect(isSafePathName("main.ts")).toBe(true);
  });

  it("accepts a nested name", () => {
    expect(isSafePathName("lib/door.ts")).toBe(true);
  });

  it("accepts a name at the length limit", () => {
    expect(isSafePathName("d".repeat(MAX_PLACE_FILE_NAME))).toBe(true);
  });

  it("refuses a name one character over the limit", () => {
    expect(isSafePathName("d".repeat(MAX_PLACE_FILE_NAME + 1))).toBe(false);
  });

  it("refuses the empty name", () => {
    expect(isSafePathName("")).toBe(false);
  });

  it.each([
    ["a parent segment", "../main.ts"],
    ["a parent segment at the end", "src/.."],
    ["a parent segment in the middle", "src/../../main.ts"],
    ["a parent segment spelled with backslashes", "..\\main.ts"],
    ["a Windows-style absolute path", "C:\\place\\main.ts"],
    ["a root-relative path", "/main.ts"],
    ["an empty segment", "src//main.ts"],
    ["a trailing slash", "src/"],
    ["a dot segment", "./main.ts"],
    ["only a dot", "."],
    ["only a parent", ".."],
    ["a NUL byte", "main\0.ts"],
  ])("refuses %s", (_why, name) => {
    expect(isSafePathName(name)).toBe(false);
  });

  it("refuses nothing that a zip wrote by a normal tool would write", () => {
    // **The over-refusal case, which is the one that costs a person their place.** A validator
    // that refuses anything unusual is safe and useless; these are the shapes that have to keep
    // working, asserted so that adding a rule has to come here and say so.
    for (const name of [
      "main.ts",
      "index.ts",
      "a.ts",
      "with spaces.ts",
      "lib/door.ts",
      "lib/deep/window.ts",
      "UPPER.TS",
      "dash-and_underscore.ts",
      "dots.in.the.name.ts",
      "9lives.ts",
    ]) {
      expect(isSafePathName(name)).toBe(true);
    }
  });
});
