import { describe, expect, it } from "vitest";
import type { MeshReport } from "@big-mesh-studios/meshing";

import { budgetFor, meshModel, type MeshResult } from "../model/mesh-model";
import { placedPart } from "../model/part";
import {
  PRINT_VOXEL_SIZE,
  printProblem,
  printedMesh,
  printReadout,
} from "./print-problem";

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
 * once, on its own.
 */
const meshOf = (parts: ReturnType<typeof placedPart>[]): MeshResult => {
  const result = printedMesh(parts);
  if (result === undefined) throw new Error("this model meshed to nothing");
  return result;
};

/**
 * A mesh whose report says something else.
 *
 * **Every field named, rather than spread over the original**, because a spread of a value read
 * through an optional chain widens each field to `number | undefined` and the result is no
 * longer a `MeshReport`. Naming them is also what makes it obvious that a test is asserting
 * about a report and not about a different mesh.
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

describe("printedMesh", () => {
  it("comes back closed, which is the whole reason the export re-meshes", () => {
    // **The gate depends on this and nothing else does.** `printProblem` looks at
    // `report.boundaryEdges`, so a mesh that is not watertight here is a model the export will
    // refuse — and ADR 0030's reason for preferring marching cubes is that it is closed at
    // every resolution rather than closed-where-resolved.
    //
    // **Measured, and worth saying plainly: at print resolution surface nets closed every
    // model tried here too**, so this is a guarantee rather than an observed rescue. The
    // choice does not rest on the preview failing today; it rests on not having to know whether
    // it will.
    const printed = meshOf([body()]);

    expect(printed.report.boundaryEdges).toBe(0);
    expect(printed.report.watertight).toBe(true);
    expect(printProblem(printed)).toBeUndefined();
  });

  it("holds a subtraction closed, which is where a boolean makes a hole", () => {
    // **A difference is the case that matters and it is not the same as a union.** A `Subtract`
    // introduces a surface with nothing behind it, so a mesher that leaves an edge in one
    // triangle leaves the rim of the cut open.
    const carved = [
      placedPart(
        "block",
        { type: "Box", len: { x: 1, y: 1, z: 1 } },
        { x: 0, y: 1, z: 0 },
      ),
      placedPart(
        "bore",
        { type: "Cylinder", len: 2, radius: 0.35 },
        { x: 0, y: 1, z: 0 },
        { combine: "Subtract" },
      ),
    ];

    expect(meshOf(carved).report.watertight).toBe(true);
  });

  it("meshes finer than the viewport's default, because a print is not a preview", () => {
    // **A resolution chosen for the destination.** `0.25` is what the screen rebuilds at so a
    // rebuild lands while a finger is down; a file going to a printer is not that, and this is
    // the measurable consequence.
    expect(PRINT_VOXEL_SIZE).toBeLessThan(budgetFor(0.25).voxelSize);

    const coarse = meshModel([body()], budgetFor(0.25), "marching-cubes");

    expect(meshOf([body()]).triangles).toBeGreaterThan(coarse?.triangles ?? 0);
  });

  it("has nothing to say about a model with no parts", () => {
    expect(printedMesh([])).toBeUndefined();
  });
});

describe("printProblem", () => {
  it("says nothing about a model that is ready to print", () => {
    expect(printProblem(meshOf([body()]))).toBeUndefined();
  });

  it("says a model with no parts has nothing in it", () => {
    expect(printProblem(undefined)).toMatch(/nothing in it to print/);
  });

  it("refuses a lidless shell, and says how badly", () => {
    // **The one failure that is not a matter of degree.** A mesh with an edge in one triangle
    // is not a solid, and a slicer will decide for itself what to do with the hole. ADR 0030
    // calls a clipped model the failure most likely to ship, so this is the gate and the others
    // are not.
    const printed = meshOf([body()]);

    expect(printProblem(reporting(printed, { boundaryEdges: 3 }))).toMatch(
      /3 open edges/,
    );
    // **Singular too**, because the sentence is shown to a person and "1 open edges" is the kind
    // of thing that teaches somebody not to read the messages.
    expect(printProblem(reporting(printed, { boundaryEdges: 1 }))).toMatch(
      /1 open edge —/,
    );
  });

  it("refuses a model with no surface rather than writing an empty file", () => {
    // **The real way to get here** is a model whose features are thinner than the sampling
    // grid's spacing — the budget caps samples per axis, so a model's own size decides its
    // spacing, and a small enough torus falls between samples. The threshold is a sampling
    // coincidence rather than a number, so what is tested is the branch and not a model that
    // happens to land on the wrong side of it today.
    //
    // **`triangles` and not `report.triangleCount`**, which is the field the gate reads: the
    // two are the same number by construction and reading the wrong one here would leave this
    // test passing on a refusal that is not the one being described.
    expect(printProblem({ ...meshOf([body()]), triangles: 0 })).toMatch(
      /no surface/,
    );
  });

  it("lets through the faults a printer's own slicing absorbs", () => {
    // **Non-manifold edges, wound-backwards winding and degenerate triangles are worse news
    // **but not this news.** Refusing every mesh with one of them would refuse meshes that
    // come out fine, and the report beside the control is where those are said.
    const poor = reporting(meshOf([body()]), {
      nonManifoldEdges: 2,
      inconsistentEdges: 1,
      degenerateTriangles: 3,
    });

    expect(printProblem(poor)).toBeUndefined();
  });
});

describe("printReadout", () => {
  it("says the report, so the control beside the button has something to show", () => {
    expect(printReadout(printedMesh([body()]))).toMatch(/watertight|triangle/);
    expect(printReadout(undefined)).toBe("nothing to print");
  });
});
