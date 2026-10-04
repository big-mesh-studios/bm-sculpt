import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { MeshReport } from "@big-mesh-studios/meshing";

import { placedPart } from "../model/part";
import { DEFAULT_HEIGHT_MM, exportThreeMf } from "./export-model";
import { printProblem, printedMesh } from "./print-problem";
import type { MeshResult } from "../model/mesh-model";
import { quantiseColours } from "./quantise";
import { MODEL_PART } from "./three-mf";

/** A capsule standing on the origin, which is the smallest thing that reads as a figure. */
const body = () =>
  placedPart(
    "body",
    { type: "Capsule", len: 2, radius: 0.7 },
    { x: 0, y: 1, z: 0 },
  );

/**
 * A mesh of these parts, or a thrown error.
 *
 * **So a test can state a fact about the model rather than about a nullable result.** Every
 * assertion here is about a model that exists; `printedMesh` returning `undefined` is tested
 * once, on its own, in `print-problem.test.ts`.
 */
const meshOf = (parts: ReturnType<typeof placedPart>[]): MeshResult => {
  const result = printedMesh(parts);
  if (result === undefined) throw new Error("this model meshed to nothing");
  return result;
};

/** The model part's markup out of an exported file. */
const modelOf = async (blob: Blob): Promise<string> => {
  const zip = await JSZip.loadAsync(blob);
  return (await zip.file(MODEL_PART)?.async("string")) ?? "";
};

/**
 * A mesh whose report says something else, for the one test that needs the gate to be reachable.
 *
 * **The same helper `print-problem.test.ts` has**, written out again rather than imported from a
 * test file — which would make this file's tests depend on another test file running first.
 */
const reporting = (
  result: MeshResult,
  changes: Partial<MeshReport>,
): MeshResult => {
  const was = result.report;
  return {
    ...result,
    report: {
      vertexCount: was.vertexCount,
      triangleCount: was.triangleCount,
      boundaryEdges: was.boundaryEdges,
      nonManifoldEdges: was.nonManifoldEdges,
      inconsistentEdges: was.inconsistentEdges,
      degenerateTriangles: was.degenerateTriangles,
      weldDistance: was.weldDistance,
      volume: was.volume,
      watertight: was.watertight,
      ...changes,
    },
  };
};

/** Every `z` the file writes a vertex at. */
const heightsOf = (model: string): number[] =>
  [...model.matchAll(/<vertex [^>]*?z="([^"]*)"/g)].map((match) =>
    Number.parseFloat(match[1] as string),
  );

describe("exportThreeMf", () => {
  it("writes a file a slicer can open, in millimetres", async () => {
    const model = await modelOf(await exportThreeMf([body()]));

    expect(model).toContain('unit="millimeter"');
    expect(model).toContain("<mesh>");
    expect(model).toContain("<triangles>");
  });

  it("stands the model at the height it was asked for", async () => {
    // **The height is the whole of the sizing.** A 3MF's unit is a millimetre and the modeller's
    // world unit is not one, so the only thing that makes the file the right size is that the
    // tallest corner of it came out at the number that was typed.
    for (const heightMm of [40, 100, 12.5]) {
      const model = await modelOf(await exportThreeMf([body()], { heightMm }));
      const heights = heightsOf(model);

      expect(Math.max(...heights)).toBeCloseTo(heightMm, 3);
      expect(Math.min(...heights)).toBeCloseTo(0, 3);
    }
  });

  it("puts the model on the bed rather than through it", async () => {
    // **Sitting on zero, not hovering.** The part's origin is a unit above the origin, so a
    // stand that shifted by the origin rather than by the mesh would leave the model in the air
    // — which is the failure a slicer reports as "model outside the build volume".
    const model = await modelOf(
      await exportThreeMf([body()], { heightMm: 100 }),
    );

    expect(Math.min(...heightsOf(model))).toBeCloseTo(0, 3);
  });

  it("holds the model to the number of colours asked for", async () => {
    // **The reduction is the export's, not the slicer's.** A slicer handed eight hundred
    // distinct face colours does one of two things with them and neither is what the modeller
    // drew, so the file carries at most what the printer was said to hold.
    const painted = [
      placedPart(
        "base",
        { type: "Sphere", radius: 1 },
        { x: 0, y: 1, z: 0 },
        { colour: { r: 255, g: 0, b: 0 } },
      ),
      placedPart(
        "top",
        { type: "Sphere", radius: 0.5 },
        { x: 0, y: 1.9, z: 0 },
        { colour: { r: 0, g: 0, b: 255 } },
      ),
    ];

    for (const maxColours of [1, 2, 4]) {
      const model = await modelOf(
        await exportThreeMf(painted, { maxColours, heightMm: 40 }),
      );
      const colours = [...model.matchAll(/<m:color color="([^"]*)"/g)].map(
        (match) => match[1],
      );

      expect(colours.length).toBeGreaterThan(0);
      expect(colours.length).toBeLessThanOrEqual(maxColours);
    }
  });

  it("puts the model's dominant colour where an unnamed corner falls back to", async () => {
    // **The coupling between two files that happens to work.** `quantiseColours` orders its
    // palette by use and the writer orders a colour group by slot ascending; those agree only
    // because the slots are dense from zero. Slot zero is the dominant colour and group index
    // zero is `pindex="0"`, so a corner the reduction gave up on becomes the model's own colour
    // rather than an arbitrary one.
    //
    // **Asserted through the real pipeline** — mesh, reduce, write — because through either half
    // it is a fact about that half and the two can drift apart without anything noticing.
    const mostlyRed = [
      placedPart(
        "block",
        { type: "Box", len: { x: 1, y: 1, z: 1 } },
        { x: 0, y: 1, z: 0 },
        {
          colour: { r: 255, g: 0, b: 0 },
        },
      ),
      placedPart(
        "cap",
        { type: "Sphere", radius: 0.3 },
        { x: 0, y: 1.8, z: 0 },
        { colour: { r: 0, g: 0, b: 255 } },
      ),
    ];

    const mesh = meshOf(mostlyRed).mesh;
    const reduced = quantiseColours(mesh.colours, mesh.indices, 4);
    // Red first, by use — which is the half of the claim this file is about.
    expect(reduced.palette[0]).toEqual({ r: 255, g: 0, b: 0, a: 255 });

    // And group index zero is red, which is the half that lives in the writer.
    const model = await modelOf(
      await exportThreeMf(mostlyRed, { heightMm: 40 }),
    );
    const colours = [...model.matchAll(/<m:color color="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(colours[0]).toBe("#FF0000FF");
    expect(model).toContain('pindex="0"');
  });

  it("defaults to a height and a colour count rather than refusing to guess", async () => {
    const model = await modelOf(await exportThreeMf([body()]));

    expect(Math.max(...heightsOf(model))).toBeCloseTo(DEFAULT_HEIGHT_MM, 3);
  });

  it("refuses a model with nothing in it, in the same words the control says", async () => {
    // **One sentence, two places.** The button's `title` and the thrown error are the same
    // string, so a person is never told a different reason from the one the code refused for.
    const problem = printProblem(printedMesh([]));

    await expect(exportThreeMf([])).rejects.toThrow(problem);
  });

  it("refuses a lidless shell rather than writing a file that prints hollow", async () => {
    // The gate is on the report, so what is checked is that the refusal is reachable at all,
    // rather than a mesh that happens to be open today.
    expect(
      printProblem(reporting(meshOf([body()]), { boundaryEdges: 1 })),
    ).toMatch(/not print/);
    expect(printProblem(meshOf([body()]))).toBeUndefined();
  });

  it("carries a thumbnail when it is given one", async () => {
    const picture = new Uint8Array([137, 80, 78, 71]);
    const blob = await exportThreeMf([body()], { thumbnail: picture });
    const zip = await JSZip.loadAsync(blob);

    expect(Object.keys(zip.files)).toContain("Metadata/thumbnail.png");
  });

  it("writes the title into both places a slicer looks for a name", async () => {
    // **Once as metadata and once as the solid's name**, because a slicer's file list reads the
    // first and a consumer looking for what the solid is called reads the second. Writing only
    // one of them leaves a file whose name depends on which program opened it.
    const model = await modelOf(
      await exportThreeMf([body()], { title: "my monster" }),
    );

    expect(model).toContain('<metadata name="Title">my monster</metadata>');
    expect(model).toContain('<metadata name="s:solid:2">my monster</metadata>');
  });
});
