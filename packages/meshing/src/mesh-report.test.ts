import { describe, expect, it } from "vitest";

import { ChunkMeshBuilder, type ChunkMesh } from "./chunk-mesh";
import { describeReport, reportMesh } from "./mesh-report";

/**
 * A mesh built to order, so each counter can be made to fire on its own.
 *
 * **Hand-built rather than coaxed out of a mesher.** Every pathology this file reports is
 * something a correct mesher refuses to produce, so the only way to test the reader is to build the
 * broken thing directly — and a test that waits for a field to be pathological is a test that either
 * fails to find one or fails for a reason that has nothing to do with the counter under test.
 */
const meshOf = (
  vertices: ReadonlyArray<readonly [number, number, number]>,
  triangles: ReadonlyArray<readonly [number, number, number]>,
): ChunkMesh => {
  const out = new ChunkMeshBuilder();
  for (const [x, y, z] of vertices) out.vertex(x, y, z);
  for (const [a, b, c] of triangles) out.triangle(a, b, c);
  return out.finish();
};

/**
 * A tetrahedron, wound so that its faces point away from the centroid.
 *
 * **The base case every other test here is a modification of**, because a counter that cannot be
 * shown to be zero on a good mesh cannot be shown to mean anything when it is not zero.
 */
const TETRAHEDRON = meshOf(
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ],
);

describe("a closed mesh", () => {
  it("reports every edge in two triangles and nothing wrong", () => {
    const report = reportMesh(TETRAHEDRON);
    expect(report.triangleCount).toBe(4);
    expect(report.boundaryEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.inconsistentEdges).toBe(0);
    expect(report.degenerateTriangles).toBe(0);
    expect(report.watertight).toBe(true);
  });

  it("encloses a positive volume, which is what outward winding means", () => {
    // The divergence theorem on a unit tetrahedron: the determinant over six.
    expect(reportMesh(TETRAHEDRON).volume).toBeCloseTo(1 / 6, 12);
  });

  it("reports a negative volume for the same mesh wound inside out", () => {
    const insideOut = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [0, 1, 2],
        [0, 3, 1],
        [0, 2, 3],
        [1, 3, 2],
      ],
    );
    const report = reportMesh(insideOut);
    expect(report.volume).toBeCloseTo(-1 / 6, 12);
    expect(report.boundaryEdges).toBe(0);
    // Every edge is still walked in opposite directions by its two triangles — the surface is
    // consistently wound, just the wrong way round. Which is why `watertight` needs the sign too.
    expect(report.inconsistentEdges).toBe(0);
    expect(report.watertight).toBe(false);
  });
});

describe("a mesh with a hole in it", () => {
  it("counts the open edges a missing face leaves behind", () => {
    // A tetrahedron with one face removed: three of its six edges are now walked once.
    const holed = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
      ],
    );
    const report = reportMesh(holed);
    expect(report.boundaryEdges).toBe(3);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.watertight).toBe(false);
    expect(describeReport(report)).toMatch(/not printable/);
  });
});

describe("a mesh with two shells sharing an edge", () => {
  it("counts the edge as non-manifold rather than as closed", () => {
    // Two tetrahedra meeting along one edge. Nothing here is a hole and nothing is wound wrongly —
    // there are simply four faces where a manifold surface has two, which is the case
    // `nonManifoldEdges` exists to name.
    const shared = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [0, -1, 0],
        [0, 0, -1],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
        [0, 1, 4],
        [0, 4, 5],
        [0, 5, 1],
        [1, 4, 5],
      ],
    );
    const report = reportMesh(shared);
    expect(report.nonManifoldEdges).toBe(1);
    expect(report.boundaryEdges).toBe(0);
    expect(report.watertight).toBe(false);
    expect(describeReport(report)).toMatch(/non-manifold/);
  });
});

describe("a mesh whose winding turned over", () => {
  it("counts the edge both triangles walk the same way", () => {
    // The tetrahedron with one face reversed. The mesh is still closed — every edge still has two
    // faces — but the surface has been turned inside out across that face, and no reference
    // direction would report it as cleanly as this does.
    const flipped = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 3, 2],
      ],
    );
    const report = reportMesh(flipped);
    expect(report.boundaryEdges).toBe(0);
    expect(report.inconsistentEdges).toBeGreaterThan(0);
    expect(report.watertight).toBe(false);
    expect(describeReport(report)).toMatch(/wound the same way/);
  });
});

describe("degenerate geometry", () => {
  it("counts a triangle that repeats a vertex", () => {
    const repeated = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 3, 3],
      ],
    );
    expect(reportMesh(repeated).degenerateTriangles).toBe(1);
  });

  it("counts a triangle with no area, and leaves it out of the volume", () => {
    // Three distinct vertices in a line. It is not a repeated vertex, so it is caught by the area
    // rather than by the indices — and it contributes nothing to the volume, which is why the volume
    // of this mesh is the tetrahedron's rather than undefined.
    const collinear = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [0, 0, 2],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
        [0, 3, 4],
      ],
    );
    const report = reportMesh(collinear);
    expect(report.degenerateTriangles).toBe(1);
    expect(Number.isFinite(report.volume)).toBe(true);
  });
});

describe("what it needs and what it does not", () => {
  it("says so about a mesh with nothing in it", () => {
    const empty = new ChunkMeshBuilder().finish();
    const report = reportMesh(empty);
    expect(report.triangleCount).toBe(0);
    expect(report.watertight).toBe(false);
    expect(describeReport(report)).toBe("no surface");
  });

  it("welds by position, so a duplicated surface reads as one and not as two", () => {
    // The tetrahedron twice over, with a second, independent set of vertices at the same four
    // positions. **Every edge now has four faces where a manifold surface has two** — which is the
    // point: by index this mesh is six clean edges and reports nothing wrong at all, and by position
    // it is one surface lying on top of itself. ADR 0003 says this is why an index-wise watertight
    // check cannot be trusted, and here is the check catching it.
    const twice = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
        [4, 6, 5],
        [4, 5, 7],
        [4, 7, 6],
        [5, 6, 7],
      ],
    );
    const report = reportMesh(twice);
    expect(
      report.boundaryEdges,
      "nothing is open, there are just too many faces",
    ).toBe(0);
    expect(report.nonManifoldEdges, "all six edges have four faces").toBe(6);
    expect(report.watertight).toBe(false);
    expect(describeReport(report)).toMatch(/non-manifold/);
  });

  it("does not need the normals, and says nothing about them", () => {
    // A report that read normals would be a report about the shading rather than about the mesh, and
    // would need a caller to have filled them in first.
    const bare = meshOf(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
      ],
    );
    expect(reportMesh(bare).watertight).toBe(true);
    expect(bare.normalOct.every((channel) => channel === 0)).toBe(true);
  });
});
/**
 * The welding resolution, which is the one thing this file is inexact about.
 *
 * **And it is a fraction of the mesh's size rather than a fixed number of decimal places, because a
 * fixed number cannot serve two scales at once.** These tests are the argument for that: they build
 * the same shape twice, once at unit size and once at a thousandth of it, and a fixed four decimal
 * places welds the small one's real edges together and reports it as non-manifold.
 */
describe("the welding resolution", () => {
  /** A closed tetrahedron, scaled. */
  const scaled = (s: number): ChunkMesh => {
    const out = new ChunkMeshBuilder();
    const at = (x: number, y: number, z: number): number =>
      out.vertex(x * s, y * s, z * s);
    const a = at(0, 0, 0);
    const b = at(1, 0, 0);
    const c = at(0, 1, 0);
    const d = at(0, 0, 1);
    out.triangle(a, c, b);
    out.triangle(a, b, d);
    out.triangle(a, d, c);
    out.triangle(b, c, d);
    return out.finish();
  };

  it("scales with the mesh, and reads the same on both scales", () => {
    const big = reportMesh(scaled(1));
    const small = reportMesh(scaled(0.001));
    expect(big.watertight).toBe(true);
    expect(
      small.watertight,
      "the same shape a thousandth the size is still closed",
    ).toBe(true);
    // Its edges are a thousandth as long, so a resolution fitted to the large one would fuse them.
    expect(small.weldDistance).toBeLessThan(big.weldDistance / 100);
    // **Not to six figures**, because the ratio is read off a `Float32Array` whose smallest shape
    // has coordinates near 1e-3 and so seven significant digits is the best its extent can be. Three
    // figures is well inside that and still says the resolution followed the size.
    expect(big.weldDistance / small.weldDistance).toBeCloseTo(1000, 3);
  });

  it("is relative to the mesh's size and not to where the mesh sits", () => {
    // **A model can be at any distance from the origin**, and a resolution read from the coordinates
    // would be coarser than the model the further out it was placed.
    const out = new ChunkMeshBuilder();
    const at = (x: number, y: number, z: number): number =>
      out.vertex(x + 1e6, y, z);
    const a = at(0, 0, 0);
    const b = at(1, 0, 0);
    const c = at(0, 1, 0);
    const d = at(0, 0, 1);
    out.triangle(a, c, b);
    out.triangle(a, b, d);
    out.triangle(a, d, c);
    out.triangle(b, c, d);
    expect(reportMesh(out.finish()).weldDistance).toBeCloseTo(
      reportMesh(scaled(1)).weldDistance,
      12,
    );
  });

  it("takes an explicit resolution when the caller knows the mesh's features are smaller", () => {
    // **A model can legitimately have features below a fraction of its own size**, and then the
    // derived resolution welds them and the report is wrong. So the resolution is an argument rather
    // than a constant, and this is what it is for.
    const tight = reportMesh(scaled(1), { quantum: 1e-12 });
    expect(tight.weldDistance).toBe(1e-12);
    expect(tight.watertight).toBe(true);
  });

  it("does not divide by zero on a mesh with no extent", () => {
    // A mesh whose every vertex is in one place has no edges to count, and a zero quantum would turn
    // every position into `Infinity`, weld the whole mesh into a single vertex and report a great deal
    // of nonsense very calmly.
    const flat = new ChunkMeshBuilder();
    const a = flat.vertex(2, 2, 2);
    const b = flat.vertex(2, 2, 2);
    const c = flat.vertex(2, 2, 2);
    flat.triangle(a, b, c);
    const report = reportMesh(flat.finish());
    expect(Number.isFinite(report.weldDistance)).toBe(true);
    expect(report.degenerateTriangles).toBe(1);
    expect(report.watertight).toBe(false);
  });
});
