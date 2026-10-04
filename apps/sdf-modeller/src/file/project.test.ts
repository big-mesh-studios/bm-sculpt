import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { RGBA } from "@big-mesh-studios/core";
import { parametersToFloats, type OperationShape } from "@big-mesh-studios/sdf";

import { MAX_PARTS } from "../model/model-store";
import { IDENTITY, placedPart, type Part } from "../model/part";
import {
  PROJECT_MANIFEST_FILE,
  PROJECT_MODEL_FILE,
  PROJECT_VERSION,
  type ProjectView,
} from "./project-file";
import { readProject, writeProject } from "./project";

/** A capsule, which is the smallest thing that reads as a figure. */
const body = (id = "body"): Part =>
  placedPart(
    id,
    { type: "Capsule", len: 2.2, radius: 0.7 },
    { x: 0, y: 1.1, z: 0 },
  );

const view: ProjectView = { mode: "surface-nets", resolution: 0.25 };

const PALETTE: RGBA[] = [
  { r: 214, g: 96, b: 84, a: 255 },
  { r: 111, g: 207, b: 151, a: 255 },
];

/**
 * Whether two parts are the same model, to the precision the format can hold.
 *
 * **A field-by-field walk rather than `toEqual`, because the format is `f32`.** Every number in
 * `model.bin` is a 32-bit float, so `2.2` comes back as `2.200000047683716` — which is not a
 * defect in the round trip but the fact that the format is what it is, and a `toEqual` would
 * call it one. Walking the fields also means the assertion says *which* number drifted.
 */
const samePart = (read: Part | undefined, wrote: Part): void => {
  const near = (
    a: number | undefined,
    b: number | undefined,
    what: string,
  ): void => {
    expect(a, what).toBeDefined();
    expect(a as number, what).toBeCloseTo(b as number, 6);
  };

  expect(read?.id, "id").toBe(wrote.id);
  expect(read?.combine, "combine").toBe(wrote.combine);
  near(read?.softness, wrote.softness, "softness");
  // **The colour is compared whole rather than numerically**, because it is `u8` bytes that came
  // through as bytes and `undefined` means "no colour of its own", which `0` does not.
  expect(read?.colour, "colour").toEqual(wrote.colour);
  near(read?.opacity ?? 1, wrote.opacity ?? 1, "opacity");

  near(read?.origin.x, wrote.origin.x, "origin.x");
  near(read?.origin.y, wrote.origin.y, "origin.y");
  near(read?.origin.z, wrote.origin.z, "origin.z");
  near(read?.orientation.x, wrote.orientation.x, "orientation.x");
  near(read?.orientation.y, wrote.orientation.y, "orientation.y");
  near(read?.orientation.z, wrote.orientation.z, "orientation.z");
  near(read?.orientation.w, wrote.orientation.w, "orientation.w");

  // **The shape through the table's own parameter list**, which is what the format writes and
  // what the reader rebuilds from — so comparing the two lists is comparing the bytes rather
  // than two objects that happen to look alike. A union compared whole would say only "the
  // shapes differ" and not which parameter of which primitive.
  expect(read?.shape.type, "shape type").toBe(wrote.shape.type);
  const got = parametersToFloats(read?.shape as OperationShape);
  const wanted = parametersToFloats(wrote.shape);
  expect(got, "parameter count").toHaveLength(wanted.length);
  wanted.forEach((value, index) => {
    near(got[index], value, `shape parameter ${index}`);
  });
};

/** Write and read in one step, which is the only way most of these want to be exercised. */
const roundTrip = async (
  parts: readonly Part[],
  palette: readonly RGBA[] = PALETTE,
  settings: ProjectView = view,
) => readProject(await writeProject(parts, palette, settings));

/** The manifest as the writer wrote it, for tests that need to see or damage it. */
const manifestIn = async (blob: Blob): Promise<Record<string, unknown>> => {
  const zip = await JSZip.loadAsync(blob);
  const text = await zip.file(PROJECT_MANIFEST_FILE)?.async("text");
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
};

/** The writer's output with the manifest replaced, for the refusals a bad manifest causes. */
const withManifest = async (
  blob: Blob,
  replace: (manifest: Record<string, unknown>) => unknown,
): Promise<Blob> => {
  const zip = await JSZip.loadAsync(blob);
  const files = zip.files;
  const rebuilt = new JSZip();
  for (const [path, entry] of Object.entries(files)) {
    if (path === PROJECT_MANIFEST_FILE) continue;
    rebuilt.file(path, await entry.async("uint8array"), {
      createFolders: false,
    });
  }
  const original = JSON.parse(
    (await zip.file(PROJECT_MANIFEST_FILE)?.async("text")) ?? "{}",
  ) as Record<string, unknown>;
  const next = replace(original);
  rebuilt.file(
    PROJECT_MANIFEST_FILE,
    next === undefined ? "" : JSON.stringify(next),
    { createFolders: false },
  );
  return rebuilt.generateAsync({ type: "blob" });
};

describe("writeProject", () => {
  it("writes a manifest and the model, and nothing else", async () => {
    const blob = await writeProject([body()], PALETTE, view);
    const zip = await JSZip.loadAsync(blob);

    // **Two files, named.** A zip with a third thing in it is a zip written by a different tool,
    // and "what is actually in this file" is the question somebody opens a stranger's model to
    // answer.
    expect(Object.keys(zip.files).sort()).toEqual(
      [PROJECT_MANIFEST_FILE, PROJECT_MODEL_FILE].sort(),
    );
  });

  it("writes the manifest first, so a tool that reads it finds it", async () => {
    const blob = await writeProject([body()], PALETTE, view);
    const zip = await JSZip.loadAsync(blob);

    // **The same reason the 3MF writer puts its content types first.** An archive that buries
    // the file describing it is one some tools will not find.
    expect(Object.keys(zip.files)[0]).toBe(PROJECT_MANIFEST_FILE);
  });

  it("records the mesher and the resolution the model was at", async () => {
    const manifest = await manifestIn(
      await writeProject([body()], PALETTE, {
        mode: "marching-cubes",
        resolution: 0.0625,
      }),
    );

    expect(manifest.view).toEqual({
      mode: "marching-cubes",
      resolution: 0.0625,
    });
    expect(manifest.version).toBe(PROJECT_VERSION);
  });

  it("records which parts have a colour of their own, and not their colours", async () => {
    const manifest = await manifestIn(
      await writeProject(
        [
          placedPart(
            "a",
            { type: "Sphere", radius: 1 },
            { x: 0, y: 1, z: 0 },
            {
              colour: { r: 1, g: 2, b: 3 },
            },
          ),
          body("b"),
          placedPart(
            "c",
            { type: "Sphere", radius: 1 },
            { x: 3, y: 1, z: 0 },
            {
              colour: { r: 4, g: 5, b: 6 },
              opacity: 0.5,
            },
          ),
        ],
        PALETTE,
        view,
      ),
    );

    // **Positions, not colours.** The colours are in the binary; this is only the fact of
    // presence, and writing them twice would be two copies to disagree.
    expect(manifest.coloured).toEqual([0, 2]);
    expect(JSON.stringify(manifest)).not.toContain('"r": 4');
  });

  it("writes the ids in the model's own order", async () => {
    const manifest = await manifestIn(
      await writeProject(
        [body("head"), body("arm"), body("leg")],
        PALETTE,
        view,
      ),
    );

    // **Order is the join.** `Operation.index` is a position in a fold and `Part.id` is a name;
    // the only thing tying them together is that they are the same sequence read two ways, so a
    // sort here would attach every name to the wrong part.
    expect(manifest.ids).toEqual(["head", "arm", "leg"]);
  });
});

describe("readProject", () => {
  it("brings back the model it was given", async () => {
    const parts = [
      body(),
      placedPart("arm", { type: "Sphere", radius: 0.4 }, { x: 1, y: 1, z: 0 }),
      placedPart(
        "leg",
        { type: "Box", len: { x: 0.3, y: 0.9, z: 0.3 } },
        { x: 0, y: 0.5, z: 0 },
      ),
    ];
    const read = await roundTrip(parts);

    expect(read.parts).toHaveLength(3);
    parts.forEach((part, index) => {
      samePart(read.parts[index], part);
    });
  });

  it("brings back a part that has no colour of its own as one that has none", async () => {
    // **The whole reason the manifest carries `coloured`.** `serialiseOperations` writes white
    // for an operation with no colour, so without the manifest a part that means "the surface
    // falls through to what is underneath" would come back as a white ball sitting on the model.
    const read = await roundTrip([body()]);

    expect(read.parts[0]?.colour).toBeUndefined();
    expect(read.parts[0]?.opacity).toBeUndefined();
  });

  it("brings back a part that has a colour with it", async () => {
    const painted = placedPart(
      "painted",
      { type: "Sphere", radius: 1 },
      { x: 0, y: 1, z: 0 },
      { colour: { r: 12, g: 34, b: 56 }, opacity: 0.25 },
    );
    const read = await roundTrip([body(), painted]);

    expect(read.parts[1]?.colour).toEqual({ r: 12, g: 34, b: 56 });
    expect(read.parts[1]?.opacity).toBe(0.25);
    expect(read.parts[0]?.colour).toBeUndefined();
  });

  it("keeps a part's place in the list, because the order is the fold order", async () => {
    // **Not a set and not a sort.** A `Subtract` in the list makes the order part of what the
    // model *is*: `A`, `B`, then a difference of `C` is a different solid from the same three
    // parts in another order, and nothing recovers which was meant.
    const parts = [
      placedPart(
        "block",
        { type: "Box", len: { x: 1, y: 1, z: 1 } },
        { x: 0, y: 1, z: 0 },
      ),
      placedPart(
        "bore",
        { type: "Cylinder", len: 2, radius: 0.3 },
        { x: 0, y: 1, z: 0 },
        { combine: "Subtract" },
      ),
    ];
    const read = await roundTrip(parts);

    expect(read.parts.map((part) => part.id)).toEqual(["block", "bore"]);
    expect(read.parts[1]?.combine).toBe("Subtract");
  });

  it("brings back every primitive with the parameters it was given", async () => {
    // **All nine, because a shape's byte layout comes from the table** (ADR 0025) and a
    // parameter count that disagrees between the writer and the reader parses into plausible
    // numbers rather than failing.
    const shapes = [
      { type: "Sphere", radius: 0.5 },
      { type: "Ellipsoid", radius: { x: 0.7, y: 0.5, z: 0.4 } },
      { type: "Box", len: { x: 0.6, y: 0.7, z: 0.8 } },
      { type: "RoundBox", len: { x: 0.5, y: 0.6, z: 0.7 }, radius: 0.15 },
      { type: "Capsule", len: 1.2, radius: 0.35 },
      { type: "Cone", len: 1, radius: 0.5 },
      { type: "Cylinder", len: 1, radius: 0.4 },
      { type: "Torus", majorRadius: 0.6, minorRadius: 0.2 },
      { type: "HexPrism", len: 1, radius: 0.5 },
    ] as const;

    const parts = shapes.map((shape, index) =>
      placedPart(
        `p${index}`,
        shape,
        { x: 0, y: index, z: 0 },
        {
          orientation: IDENTITY,
        },
      ),
    );
    const read = await roundTrip(parts);

    // **Every parameter, not just the type name.** A primitive's byte layout comes from the
    // table (ADR 0025), and a parameter count that disagrees between the writer and the reader
    // parses into plausible numbers rather than failing.
    parts.forEach((part, index) => {
      expect(read.parts[index]?.shape.type).toBe(shapes[index].type);
      samePart(read.parts[index], part);
    });
  });

  it("brings back the palette and the view", async () => {
    const read = await roundTrip([body()], PALETTE, {
      mode: "marching-cubes",
      resolution: 0.125,
    });

    expect(read.palette).toEqual(PALETTE);
    expect(read.view).toEqual({ mode: "marching-cubes", resolution: 0.125 });
  });

  it("round-trips an empty model", async () => {
    const read = await roundTrip([]);

    expect(read.parts).toEqual([]);
    expect(read.view).toEqual(view);
  });

  it("round-trips a model at the parts limit", async () => {
    // **The boundary, because it is the one a file could cross.** `MAX_PARTS` bounds a rebuild's
    // worst case and a save file is not a way around it.
    const parts = Array.from({ length: MAX_PARTS }, (_, i) => body(`p${i}`));

    expect((await roundTrip(parts)).parts).toHaveLength(MAX_PARTS);
  });
});

describe("readProject refusals", () => {
  it("says the bytes were not a project file", async () => {
    await expect(readProject(new Blob(["not a zip"]))).rejects.toThrow(
      /not a file a model was saved as/,
    );
  });

  it("says there was no manifest, by name", async () => {
    const zip = new JSZip();
    zip.file(PROJECT_MODEL_FILE, new Uint8Array([1, 2, 3]));

    await expect(
      readProject(await zip.generateAsync({ type: "blob" })),
    ).rejects.toThrow(new RegExp(`no ${PROJECT_MANIFEST_FILE}`));
  });

  it("says there was no model, by name", async () => {
    // **With a manifest that would otherwise pass**, so the refusal is about the missing model
    // and not about the manifest — the order of the two checks is the thing under test.
    const written = await writeProject([body()], PALETTE, view);
    const kept = await withManifest(written, (manifest) => manifest);
    const zip = await JSZip.loadAsync(kept);
    const rebuilt = new JSZip();
    rebuilt.file(
      PROJECT_MANIFEST_FILE,
      (await zip.file(PROJECT_MANIFEST_FILE)?.async("text")) ?? "",
      { createFolders: false },
    );

    await expect(
      readProject(await rebuilt.generateAsync({ type: "blob" })),
    ).rejects.toThrow(new RegExp(`no ${PROJECT_MODEL_FILE}`));
  });

  it("says the manifest was not JSON, rather than showing a parser's message", async () => {
    const zip = new JSZip();
    zip.file(PROJECT_MANIFEST_FILE, "{ not json");

    await expect(
      readProject(await zip.generateAsync({ type: "blob" })),
    ).rejects.toThrow(/is not valid JSON/);
  });

  it("says the manifest is not one this build opens", async () => {
    const zip = new JSZip();
    zip.file(PROJECT_MANIFEST_FILE, JSON.stringify({ version: 99 }));

    await expect(
      readProject(await zip.generateAsync({ type: "blob" })),
    ).rejects.toThrow(/not a model manifest this build can open/);
  });

  it("carries the model's own refusal as the cause rather than replacing it", async () => {
    // **The only sentence about a wrong version anybody can act on** is the one
    // `deserialiseOperations` writes, so it is kept as a `cause` rather than summarised into
    // "the model could not be read".
    const written = await writeProject([body()], PALETTE, view);
    const zip = await JSZip.loadAsync(written);
    const rebuilt = new JSZip();
    rebuilt.file(
      PROJECT_MANIFEST_FILE,
      (await zip.file(PROJECT_MANIFEST_FILE)?.async("text")) ?? "",
      { createFolders: false },
    );
    // **The version field rewritten and nothing else**, little-endian as the format writes it,
    // so the reader refuses on the version rather than parsing plausible operations out of a
    // file whose version it does not understand.
    const model = await zip.file(PROJECT_MODEL_FILE)?.async("uint8array");
    const wrongVersion = new Uint8Array(model ?? new Uint8Array(0));
    new DataView(wrongVersion.buffer).setUint16(0, 99, true);
    rebuilt.file(PROJECT_MODEL_FILE, wrongVersion, { createFolders: false });

    let thrown: unknown;
    try {
      await readProject(await rebuilt.generateAsync({ type: "blob" }));
    } catch (reason) {
      thrown = reason;
    }

    expect(thrown).toBeInstanceOf(Error);
    const failure = thrown as Error;
    expect(failure.message).toMatch(/is not a model this build reads/);
    // **The version is the sentence somebody can act on**, so it is checked rather than the
    // wrapper's wording alone — a wrapper that said "could not read" would pass the line above.
    expect((failure.cause as Error | undefined)?.message).toMatch(/version 99/);
  });

  it("refuses a file whose manifest and whose model disagree about how many parts there are", async () => {
    // **The zip was written by two tools, or two versions of one.** A manifest naming three
    // parts beside a model holding one is a file nobody can state the contents of.
    const written = await writeProject([body()], PALETTE, view);
    const damaged = await withManifest(written, (manifest) => ({
      ...manifest,
      ids: ["a", "b", "c"],
      coloured: [],
    }));

    await expect(readProject(damaged)).rejects.toThrow(
      /names 3 parts and model.bin holds 1/,
    );
  });

  it("refuses a manifest naming two parts with one id, before reading the model", async () => {
    const written = await writeProject([body(), body("body")], PALETTE, view);
    const damaged = await withManifest(written, (manifest) => ({
      ...manifest,
      ids: ["same", "same"],
    }));

    await expect(readProject(damaged)).rejects.toThrow(
      /not a model manifest this build can open/,
    );
  });

  it("refuses a model of more parts than the store would hold", async () => {
    // **The manifest is made to look legal and the model is not**, which is the only way to
    // reach this check: `isProjectManifest` bounds a manifest's own ids to `MAX_PARTS`, so a
    // file whose manifest was over the limit would have been refused with a different sentence
    // and this test would pass for the wrong reason.
    const parts = Array.from({ length: MAX_PARTS + 1 }, (_, i) =>
      body(`p${i}`),
    );
    const written = await writeProject(parts, PALETTE, view);
    const legalIds = parts.slice(0, MAX_PARTS).map((part) => part.id);

    const damaged = await withManifest(written, (manifest) => ({
      ...manifest,
      ids: legalIds,
      coloured: [],
    }));

    await expect(readProject(damaged)).rejects.toThrow(
      new RegExp(`holds ${MAX_PARTS + 1} parts and the limit is`),
    );
  });

  it("refuses a Paint rather than reading it as a union", async () => {
    // **A `Part` has no `Paint`, and the reason is a decision.** Paint adds no material, only
    // colour, and a coloured `Add` already expresses it — so quietly turning one into a union
    // would put material in a file that said there was none.
    const written = await writeProject([body()], PALETTE, view);
    const zip = await JSZip.loadAsync(written);
    const model = await zip.file(PROJECT_MODEL_FILE)?.async("uint8array");

    // **Byte 6 is the first operation's combine**, after the u16 version and the u32 count.
    const painted = new Uint8Array(model ?? new Uint8Array(0));
    painted[6] = 2;

    const rebuilt = new JSZip();
    rebuilt.file(
      PROJECT_MANIFEST_FILE,
      (await zip.file(PROJECT_MANIFEST_FILE)?.async("text")) ?? "",
      { createFolders: false },
    );
    rebuilt.file(PROJECT_MODEL_FILE, painted, { createFolders: false });

    await expect(
      readProject(await rebuilt.generateAsync({ type: "blob" })),
    ).rejects.toThrow(/is a Paint, which this application has no part for/);
  });
});
