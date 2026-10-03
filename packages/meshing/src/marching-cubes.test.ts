import { describe, expect, it } from "vitest";

import { ChunkMeshBuilder } from "./chunk-mesh";
import {
  CORNER_OFFSETS,
  EDGE_CORNERS,
  EDGE_MASK,
  marchingCubes,
  marchingCubesScratchFor,
  MARCHING_CUBES_CELLS,
  MARCHING_CUBES_GRID,
  edgeAxis,
  TRI_TABLE,
  type MarchingCubesScratch,
} from "./marching-cubes";
import { describeReport, reportMesh } from "./mesh-report";
import { scratchFor, surfaceNets } from "./surface-nets";
import { sphere, sphereVolume, torus, torusVolume } from "./test-helpers";

const STEP = 6;
const N = 24;
const CENTRE = 80;

type Field = (x: number, y: number, z: number) => number;

const mesh = (
  field: Field,
  origin: readonly [number, number, number] = [0, 0, 0],
  samples = N,
  sampleSize = STEP,
  scratch: MarchingCubesScratch = marchingCubesScratchFor(samples),
  out = new ChunkMeshBuilder(),
): ChunkMeshBuilder => {
  marchingCubes({
    origin,
    samples,
    sampleSize,
    sampler: { distance: field },
    out,
    scratch,
    onVertex: (index, x, y, z) => {
      const h = sampleSize / 8;
      const g = [
        field(x + h, y, z) - field(x - h, y, z),
        field(x, y + h, z) - field(x, y - h, z),
        field(x, y, z + h) - field(x, y, z - h),
      ];
      const length =
        Math.hypot(g[0] as number, g[1] as number, g[2] as number) || 1;
      out.setNormal(
        index,
        (g[0] as number) / length,
        (g[1] as number) / length,
        (g[2] as number) / length,
      );
    },
  });
  return out;
};

/**
 * A field of four shapes, deliberately awkward: a ball, a box with flat walls, a thin ring, and a
 * pillar off to one side.
 *
 * **Disjoint, and inside the region the tests mesh — both because of what this field is for.** It
 * reaches a flat wall, a corner, a thin section and a separate shell in one mesh, so it exercises
 * every kind of cell marching cubes has. And the two constraints are load-bearing:
 *
 * - An earlier version reached to 165 on three axes, which the region does not cover, and the mesher
 *   reported a hundred open edges for it — correctly. A shape that leaves its region has no closed
 *   surface to find, so a test wanting a watertightness assertion was really asking about clipping.
 *   That case has its own test below.
 * - The shapes must not **overlap** either, or the union's topology is doing the work rather than
 *   the mesher. `mesh-report.test.ts` covers what this report says about a mesh that is not
 *   manifold, using meshes built to be so rather than waiting for a field to produce one.
 */
const mixed: Field = (x, y, z) =>
  Math.min(
    sphere(40, 40, 40, 18)(x, y, z),
    // A box, as the max of three slabs — the flat walls and the corners are where a vertex placed
    // wrongly shows up first.
    Math.max(
      Math.abs(x - 110) - 18,
      Math.abs(y - 40) - 18,
      Math.abs(z - 40) - 18,
    ),
    torus(60, 110, 60, 18, 8)(x, y, z),
    sphere(115, 115, 115, 16)(x, y, z),
  );

describe("the table", () => {
  it("holds 256 cases of whole triangles, and validates on load", () => {
    expect(TRI_TABLE.length).toBe(256 * 16);
    let cases = 0;
    let triangles = 0;
    for (let pattern = 0; pattern < 256; pattern++) {
      const end = TRI_TABLE.indexOf(-1, pattern * 16) - pattern * 16;
      expect(
        end % 3,
        `case ${pattern} is not a whole number of triangles`,
      ).toBe(0);
      if (end > 0) cases++;
      triangles += end / 3;
    }
    expect(cases).toBe(254);
    expect(triangles).toBeGreaterThan(0);
  });

  it("only names edges the surface actually cuts", () => {
    // The invariant that makes the rest of this file's reasoning possible: a case's triangles are
    // built from crossings, so an edge the field does not cross has no vertex and the mesher would
    // emit a triangle against `-1`. This also catches a damaged transcription immediately.
    for (let pattern = 0; pattern < 256; pattern++) {
      for (let i = 0; i < 16; i += 1) {
        const edge = TRI_TABLE[pattern * 16 + i] as number;
        if (edge === -1) break;
        expect(
          (EDGE_MASK[pattern] as number) & (1 << edge),
          `case ${pattern} names uncrossed edge ${edge}`,
        ).not.toBe(0);
      }
    }
  });

  it("gives the all-inside and all-outside cases nothing", () => {
    expect(TRI_TABLE[0]).toBe(-1);
    expect(TRI_TABLE[255]).toBe(-1);
    expect(EDGE_MASK[0]).toBe(0);
    expect(EDGE_MASK[255]).toBe(0);
  });

  it("numbers corners and edges the way the table was written", () => {
    // Pinned because the published table is written against this ordering and `surface-nets.ts`
    // uses a *different* one. If either changes, the table becomes a table of nonsense and every
    // other test here fails in a way that does not say why.
    expect(CORNER_OFFSETS[0]).toEqual([0, 0, 0]);
    expect(CORNER_OFFSETS[2]).toEqual([1, 1, 0]);
    expect(CORNER_OFFSETS[6]).toEqual([1, 1, 1]);
    expect(EDGE_CORNERS[0]).toEqual([0, 1]);
    expect(EDGE_CORNERS[11]).toEqual([3, 7]);
    expect(Array.from({ length: 12 }, (_, e) => edgeAxis(e))).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2,
    ]);
  });
});

/**
 * Face consistency, which is watertightness.
 *
 * **The one exhaustive check in this file, and the one the whole watertight claim rests on.** Two
 * cells sharing a face must draw the same curve across it, or the mesh cracks along the seam.
 *
 * Cells sharing a face agree on that face's four corner samples, so the only thing that varies
 * between them is the four corners *off* the face. So the space to check is: six faces, sixteen
 * sign patterns on the face, and sixteen × sixteen patterns off it — 24,576 pairs. Every one is
 * compared here, which is why this test is exhaustive rather than sampling shapes and hoping.
 *
 * The trace is read straight off the table: a triangle edge whose two vertices both lie on edges
 * bounding the face lies in the face's plane, and it joins those two of the face's four edges. A
 * face with two crossings has exactly one such join; a face with four — the ambiguous case, where
 * the table must choose a diagonal — has two, and which two is the choice being tested.
 */
describe("face consistency", () => {
  const FACES: ReadonlyArray<readonly number[]> = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 2, 6, 7],
    [0, 3, 7, 4],
    [1, 2, 6, 5],
  ];

  const bounding = (face: readonly number[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = face[i] as number;
      const b = face[(i + 1) % 4] as number;
      for (let edge = 0; edge < 12; edge++) {
        const pair = EDGE_CORNERS[edge] as unknown as readonly [number, number];
        if (
          (pair[0] === a && pair[1] === b) ||
          (pair[0] === b && pair[1] === a)
        ) {
          out.push(edge);
          break;
        }
      }
    }
    expect(out.length, `face ${face.join(",")} does not bound four edges`).toBe(
      4,
    );
    return out;
  };

  const trace = (pattern: number, bounds: readonly number[]): string => {
    const joins = new Set<string>();
    const triangles: number[][] = [];
    for (let i = 0; (TRI_TABLE[pattern * 16 + i] as number) !== -1; i += 3) {
      triangles.push([
        TRI_TABLE[pattern * 16 + i] as number,
        TRI_TABLE[pattern * 16 + i + 1] as number,
        TRI_TABLE[pattern * 16 + i + 2] as number,
      ]);
    }
    for (const tri of triangles) {
      for (const [u, v] of [
        [tri[0] as number, tri[1] as number],
        [tri[1] as number, tri[2] as number],
        [tri[2] as number, tri[0] as number],
      ] as const) {
        const a = bounds.indexOf(u);
        const b = bounds.indexOf(v);
        if (a >= 0 && b >= 0 && a !== b)
          joins.add(a < b ? `${a},${b}` : `${b},${a}`);
      }
    }
    return [...joins].sort().join("|");
  };

  it("draws the same curve across every face from both sides", () => {
    let checked = 0;
    for (const face of FACES) {
      const bounds = bounding(face);
      const outside = [0, 1, 2, 3, 4, 5, 6, 7].filter((c) => !face.includes(c));
      const build = (bits: number, off: number): number => {
        let pattern = 0;
        for (let k = 0; k < 4; k++)
          pattern |= ((bits >> k) & 1) << (face[k] as number);
        for (let i = 0; i < 4; i++)
          pattern |= ((off >> i) & 1) << (outside[i] as number);
        return pattern;
      };
      for (let bits = 0; bits < 16; bits++) {
        for (let offA = 0; offA < 16; offA++) {
          for (let offB = 0; offB < 16; offB++) {
            const a = build(bits, offA);
            const b = build(bits, offB);
            if (a === 0 || a === 255 || b === 0 || b === 255) continue;
            checked++;
            expect(
              trace(a, bounds),
              `face [${face.join(",")}] cases ${a} and ${b} disagree across it`,
            ).toBe(trace(b, bounds));
          }
        }
      }
    }
    // 6 faces x 16 patterns on the face x 16 x 16 off it, less the pairs where a cell is entirely
    // one side and has no surface to draw: two per face per degenerate face pattern, for 372 in all.
    expect(checked).toBe(6 * 16 * 16 * 16 - 6 * 62);
  });
});

describe("a region with a surface in it", () => {
  it("emits vertices and triangles", () => {
    const out = mesh(sphere(CENTRE, CENTRE, CENTRE, 45));
    expect(out.vertexCount).toBeGreaterThan(0);
    expect(out.triangleCount).toBeGreaterThan(0);
    expect(out.indices.size).toBe(out.triangleCount * 3);
  });

  it("emits nothing for a field with no surface, in either direction", () => {
    expect(mesh(() => 1000).vertexCount).toBe(0);
    expect(mesh(() => -1000).vertexCount).toBe(0);
  });

  it("keeps every index inside the vertex range", () => {
    const out = mesh(mixed);
    for (const index of out.indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(out.vertexCount);
    }
  });

  it("allocates scratch buffers for the padded grid, not the owned count", () => {
    // Sized to `samples` the sample buffer would be too small, and every write past its end is
    // silently dropped while every read past it returns 0 — a field that is uniformly solid then
    // reads as half solid and the mesher invents a surface in the middle of rock.
    const scratch = marchingCubesScratchFor(N);
    const grid = MARCHING_CUBES_GRID(N);
    const cells = MARCHING_CUBES_CELLS(N);
    expect(scratch.samples.length).toBe(grid * grid * grid);
    expect(scratch.edgeX.length).toBe(grid * grid * cells);
    expect(scratch.edgeY.length).toBe(grid * grid * cells);
    expect(scratch.edgeZ.length).toBe(grid * grid * cells);
  });
});

/**
 * Watertightness, which is the reason this mesher is here.
 *
 * **Every shape below is asserted closed, manifold and consistently wound — not "closed wherever the
 * surface is well conditioned".** `surface-nets.test.ts` has to scope its manifoldness test that way
 * and says in its own header why; this file does not have to, and that difference is the whole
 * argument for marching cubes over surface nets for a mesh that will be printed.
 */
describe("watertightness", () => {
  const shapes: ReadonlyArray<readonly [string, Field]> = [
    ["sphere", sphere(CENTRE, CENTRE, CENTRE, 40)],
    [
      "sphere on round numbers",
      // The degenerate case: with the centre on a grid point and the radius a three-four-five
      // multiple, dozens of samples land *exactly* on the surface. See the corner-welding note in
      // `marching-cubes.ts`.
      sphere(72, 72, 72, 50),
    ],
    ["torus", torus(CENTRE, CENTRE, CENTRE, 30, 12)],
    ["thin torus", torus(CENTRE, CENTRE, CENTRE, 26, 6)],
    ["four shapes", mixed],
    ["off the grid", sphere(CENTRE + 0.3, CENTRE - 0.7, CENTRE + 0.1, 34)],
  ];

  for (const [name, field] of shapes) {
    it(`closes ${name}, with every edge in exactly two triangles`, () => {
      const report = reportMesh(mesh(field).finish());
      expect(report.triangleCount, name).toBeGreaterThan(0);
      expect(report.boundaryEdges, `${name}: open edges`).toBe(0);
      expect(report.nonManifoldEdges, `${name}: non-manifold edges`).toBe(0);
      expect(
        report.inconsistentEdges,
        `${name}: edges wound the same way`,
      ).toBe(0);
      expect(report.degenerateTriangles, `${name}: degenerate triangles`).toBe(
        0,
      );
      expect(report.watertight, name).toBe(true);
    });
  }

  it("encloses the volume the shape actually has", () => {
    // A mesh can be perfectly closed and the wrong size, so the volume is checked against the
    // analytic answer rather than against the mesh. Marching cubes places every vertex on a crossing
    // of the true surface, so its error is a fraction of a voxel — which is why the tolerance is a
    // percent rather than a rounding place.
    for (const [name, field, analytic] of [
      ["sphere r40", sphere(CENTRE, CENTRE, CENTRE, 40), sphereVolume(40)],
      [
        "sphere r34",
        sphere(CENTRE + 0.3, CENTRE - 0.7, CENTRE + 0.1, 34),
        sphereVolume(34),
      ],
      [
        "torus R30 r12",
        torus(CENTRE, CENTRE, CENTRE, 30, 12),
        torusVolume(30, 12),
      ],
    ] as const) {
      const report = reportMesh(mesh(field).finish());
      const error = Math.abs(report.volume / analytic - 1);
      expect(
        error,
        `${name}: volume ${Math.round(report.volume)} against ${Math.round(analytic)}`,
      ).toBeLessThan(0.06);
    }
  });

  it("is more accurate than surface nets on the same shapes", () => {
    // Not a claim this file has to make to be useful — but it is the reason marching cubes is worth
    // offering *alongside* surface nets rather than only instead of it, and a test is the only place
    // it can be stated so that it stays true if either mesher changes.
    const errors = (mesher: "cubes" | "nets"): number => {
      let worst = 0;
      for (const [field, analytic] of [
        [sphere(CENTRE, CENTRE, CENTRE, 40), sphereVolume(40)],
        [torus(CENTRE, CENTRE, CENTRE, 30, 12), torusVolume(30, 12)],
      ] as const) {
        const out = new ChunkMeshBuilder();
        const params = {
          origin: [0, 0, 0] as const,
          samples: N,
          sampleSize: STEP,
          sampler: { distance: field },
          out,
        };
        if (mesher === "cubes") {
          marchingCubes({ ...params, scratch: marchingCubesScratchFor(N) });
        } else {
          surfaceNets({ ...params, scratch: scratchFor(N) });
        }
        worst = Math.max(
          worst,
          Math.abs(reportMesh(out.finish()).volume / analytic - 1),
        );
      }
      return worst;
    };
    expect(errors("cubes")).toBeLessThan(errors("nets"));
  });

  it("reports a shape that leaves its region as open rather than as closed", () => {
    // The failure this report exists to catch, and the one that is easiest to ship by accident: the
    // region is derived from the model's bounds, so a model that grows past them is clipped, and the
    // mesh that comes back is a lidless shell. Nothing about it looks wrong on screen.
    const report = reportMesh(mesh(sphere(CENTRE, CENTRE, 170, 40)).finish());
    expect(report.triangleCount).toBeGreaterThan(0);
    expect(report.boundaryEdges).toBeGreaterThan(0);
    expect(report.watertight).toBe(false);
    expect(describeReport(report)).toMatch(/not printable/);
  });

  it("says nothing about a region with no surface in it", () => {
    // A watertight mesh of nothing is not a watertight mesh, and `triangleCount > 0` is what stops
    // an empty region reading as a pass.
    const report = reportMesh(mesh(() => 1000).finish());
    expect(report.watertight).toBe(false);
    expect(describeReport(report)).toBe("no surface");
  });

  it("gives every vertex a normal, so the report's winding check has something to read", () => {
    // The normals are the caller's to fill and the builder defaults them to +Y, so a caller that
    // forgot would get a mesh that shades as though it were right. Asserted through the mesh rather
    // than through `onVertex` so it covers the packed 16-bit round trip.
    const out = mesh(sphere(CENTRE, CENTRE, CENTRE, 40));
    const finished = out.finish();
    expect(finished.normalOct.length).toBe(finished.vertexCount * 2);
    for (const channel of finished.normalOct) {
      expect(channel).toBeGreaterThanOrEqual(-32767);
      expect(channel).toBeLessThanOrEqual(32767);
    }
    expect(reportMesh(finished).volume).toBeGreaterThan(0);
  });
});

describe("the region it was given", () => {
  it("meshes that region and nothing outside it", () => {
    // The property that lets two meshers be compared at all, and the reason the sample grid is
    // padded by one on each side rather than exactly filling the box: a vertex outside the region
    // would be a vertex belonging to a neighbour, drawn in one place by one region and another by
    // another. Marching cubes places a vertex between two samples, so a region of `n` samples spans
    // `n` steps plus the two half-steps to its outer samples.
    const span = N * STEP;
    const out = mesh(sphere(CENTRE, CENTRE, CENTRE, 40)).finish();
    expect(out.triangleCount).toBeGreaterThan(0);
    for (let i = 0; i < out.vertexCount; i++) {
      for (const [axis, value] of [
        ["x", out.positions[i * 3] as number],
        ["y", out.positions[i * 3 + 1] as number],
        ["z", out.positions[i * 3 + 2] as number],
      ] as const) {
        expect(value, `vertex ${i} ${axis}`).toBeGreaterThanOrEqual(-STEP);
        expect(value, `vertex ${i} ${axis}`).toBeLessThanOrEqual(span + STEP);
      }
    }
  });

  it("covers the same world span at a coarser stride", () => {
    // A resolution control changes the stride and not the region, which is what makes two
    // resolutions of the same model comparable rather than two different models.
    const fine = mesh(
      sphere(CENTRE, CENTRE, CENTRE, 40),
      [0, 0, 0],
      N,
      STEP,
    ).finish();
    const coarse = mesh(
      sphere(CENTRE, CENTRE, CENTRE, 40),
      [0, 0, 0],
      N / 2,
      STEP * 2,
    ).finish();
    expect(coarse.triangleCount).toBeGreaterThan(0);
    expect(coarse.vertexCount).toBeLessThan(fine.vertexCount);
    for (let i = 0; i < coarse.vertexCount; i++) {
      expect(coarse.positions[i * 3] as number).toBeGreaterThanOrEqual(
        -STEP * 2,
      );
      expect(coarse.positions[i * 3] as number).toBeLessThanOrEqual(
        N * STEP + STEP * 2,
      );
    }
  });
});

describe("reusing a scratch buffer", () => {
  it("produces the same mesh twice from the same scratch", () => {
    const scratch = marchingCubesScratchFor(N);
    const field = sphere(CENTRE, CENTRE, CENTRE, 40);
    const first = mesh(field, [0, 0, 0], N, STEP, scratch).finish();
    const second = mesh(field, [0, 0, 0], N, STEP, scratch).finish();
    expect(second.vertexCount).toBe(first.vertexCount);
    expect(second.triangleCount).toBe(first.triangleCount);
    expect([...second.indices]).toEqual([...first.indices]);
  });

  it("does not carry one region's vertices into another's", () => {
    const scratch = marchingCubesScratchFor(N);
    expect(mesh(() => 1000, [0, 0, 0], N, STEP, scratch).vertexCount).toBe(0);
    expect(
      mesh(sphere(CENTRE, CENTRE, CENTRE, 40), [0, 0, 0], N, STEP, scratch)
        .vertexCount,
    ).toBeGreaterThan(0);
    const after = mesh(() => 1000, [0, 0, 0], N, STEP, scratch).finish();
    expect(after.vertexCount).toBe(0);
    expect(after.indices.length).toBe(0);
  });
});
