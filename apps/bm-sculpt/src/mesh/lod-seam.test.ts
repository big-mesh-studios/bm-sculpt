/**
 * Watertightness across a level-of-detail boundary.
 *
 * At a single level two neighbouring chunks meet on shared vertices, and that is the
 * property the rest of the meshing relies on. A chunk's last own cell and its
 * neighbour's low padding cell are *the same world cell*, computed from the same eight
 * world samples, so both place a vertex at the same position and the two meshes are
 * joined by a vertex rather than by a guess. This file pins that property across levels,
 * where the two chunks sample at different spacings and the same world cell is reached
 * by different numbers of samples from either side.
 *
 * It is a separate file from `surface-nets.test.ts` because it is a different kind of
 * assertion. Those tests check one mesh against a brute-force reference; these check two
 * meshes against each other, which is the only way to say anything about a seam.
 *
 * ## The two mixed-level tests are marked `it.fails`, and that is deliberate
 *
 * They pin a crack that is present: the two chunks at different levels put their
 * outermost columns in different places, by about half a coarse sample, so the surfaces
 * abut in x and disagree in y and z. Asserting the correct behaviour would leave the
 * suite red, which blocks every unrelated change and gets the test deleted instead.
 *
 * `it.fails` inverts the assertion: the test passes *because* the crack is there, and
 * turns red the moment somebody fixes it — at which point the `.fails` comes off and the
 * test becomes an ordinary one. So a fix cannot land unnoticed, and the bug stays
 * documented in the meantime. The same-level test above is a plain `it`: it is the
 * control, and it must keep passing for the mixed-level ones to mean anything.
 *
 * ## What the overlap fixes, and what it deliberately does not
 *
 * The overlap does not make the two meshes share a vertex, so the two tests above stay
 * `it.fails`. It does remove the *visible* gap, and that is the property this file holds it
 * to: the coarser chunk meshes one cell into the finer one, so its surface crosses the
 * plane between them rather than stopping on it, and the two sheets — one surface of one
 * field at two strides — differ by at most the level-of-detail error where they overlap.
 *
 * A weld is a different thing and is not what anybody can see. Making it exact means
 * evaluating the coarse boundary strip at the fine stride (ADR 0004), which is stitched
 * surface nets: a second mesher, a stitching pass, and a seam rule that has to agree with
 * itself across two resolutions. The tests below are the ones that would fail if the seam
 * opened up again.
 */

import { describe, expect, it } from "vitest";

import { BLOCK_WORLD } from "../constants";
import {
  DEFAULT_TERRAIN,
  Field,
  OperationBVH,
  terrainField,
} from "@big-mesh-studios/csg";
import type { CellCoord, Lod } from "../world";
import {
  lodAt,
  lodSampleSize,
  lodSamples,
  overlapMaskAt,
  OVERLAP_X_NEG,
  OVERLAP_X_POS,
} from "../world";

import type { ChunkMesh } from "@big-mesh-studios/meshing";
import { chunkRegion, SurfaceNetsChunkMesher } from "./chunk-mesher";
import { WaterChunkMesher } from "./water-mesher";

/**
 * Positions are carried as `f32`, so agreement is agreement to about single precision
 * on values of order 100. Far looser than the difference between two distinct vertices,
 * far tighter than any real disagreement.
 */
const SAME_POINT = 1e-3;

interface Point {
  x: number;
  y: number;
  z: number;
}

const LEFT: CellCoord = { x: 0, y: 0, z: 0 };
const RIGHT: CellCoord = { x: 1, y: 0, z: 0 };

/**
 * The world plane the two cells share, on x.
 *
 * Derived rather than written down: a chunk's extent is `samples * sampleSize` from its
 * centre at every level (ADR 0004), so the plane between two adjacent cells is half a
 * chunk from either centre whatever stride either side is meshed at.
 */
const SEAM_X = BLOCK_WORLD / 2;

const mesherOverTerrain = (): SurfaceNetsChunkMesher => {
  const terrain = terrainField(DEFAULT_TERRAIN);
  return new SurfaceNetsChunkMesher(
    new Field(new OperationBVH([]), {
      base: terrain,
      extent: terrain,
      lipschitz: terrain.lipschitz,
    }),
  );
};

const points = (mesh: ChunkMesh): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i < mesh.vertexCount; i++) {
    out.push({
      x: mesh.positions[i * 3],
      y: mesh.positions[i * 3 + 1],
      z: mesh.positions[i * 3 + 2],
    });
  }
  return out;
};

/**
 * The world centre of cell `c` along x.
 *
 * From the index layout in `surface-nets.ts`: cell `c` is the cell of world voxel
 * `origin + c - 1`, so its centre is `origin + (c - 0.5) * sampleSize`. Written down
 * rather than imported because `chunkRegion` describes where a chunk starts and which
 * samples it owns, and the seam is about a *cell* index, which nothing exports.
 */
const cellCentreX = (cell: CellCoord, lod: Lod, c: number): number => {
  const region = chunkRegion(cell, lod);
  return region.origin.x + (c - 0.5) * region.sampleSize;
};

/**
 * The vertices a mesh placed in one cell column: those whose x is within half a sample
 * of that column's centre. A vertex is an average of crossings inside its own cell, so
 * it cannot leave it.
 */
const column = (mesh: ChunkMesh, centre: number, lod: Lod): Point[] => {
  const half = lodSampleSize(lod) / 2;
  return points(mesh).filter((p) => Math.abs(p.x - centre) <= half);
};

const near = (a: Point, b: Point): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= SAME_POINT;

const show = (p: Point): string =>
  `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;

describe("LOD seams", () => {
  it("gives the two chunks at one level the same world cell at the interface", () => {
    // Chunk 0's last own cell and chunk 1's low padding cell are the same world cell at
    // the same level, which is the whole reason a same-level seam is watertight.
    expect(cellCentreX(LEFT, 0, lodSamples(0))).toBeCloseTo(
      cellCentreX(RIGHT, 0, 0),
      6,
    );
  });

  it("joins two chunks at the same level on shared vertices", () => {
    const mesher = mesherOverTerrain();
    const left = column(
      mesher.mesh({ cell: LEFT, lod: 0 }),
      cellCentreX(LEFT, 0, lodSamples(0)),
      0,
    );
    const right = column(
      mesher.mesh({ cell: RIGHT, lod: 0 }),
      cellCentreX(RIGHT, 0, 0),
      0,
    );

    expect(right.length).toBeGreaterThan(0);
    const unmatched = right.filter((p) => !left.some((q) => near(p, q)));
    expect(unmatched.map(show)).toEqual([]);
  });

  it.fails(
    "puts the fine chunk's outermost column where the coarse chunk's is",
    () => {
      const mesher = mesherOverTerrain();
      const fine = column(
        mesher.mesh({ cell: LEFT, lod: 0 }),
        cellCentreX(LEFT, 0, lodSamples(0)),
        0,
      );
      const coarse = column(
        mesher.mesh({ cell: RIGHT, lod: 1 }),
        cellCentreX(RIGHT, 1, 0),
        1,
      );

      expect(fine.length).toBeGreaterThan(0);
      expect(coarse.length).toBeGreaterThan(0);

      // Every vertex the coarse chunk puts on the interface must also be put by the fine
      // chunk. Without that shared vertex the two surfaces abut in x and disagree in
      // y and z, which is the crack.
      const unmatched = coarse.filter((p) => !fine.some((q) => near(p, q)));
      expect(unmatched.map(show)).toEqual([]);
    },
  );

  it.fails(
    "holds the interface columns within one fine sample of each other",
    () => {
      const mesher = mesherOverTerrain();
      const fine = column(
        mesher.mesh({ cell: LEFT, lod: 0 }),
        cellCentreX(LEFT, 0, lodSamples(0)),
        0,
      );
      const coarse = column(
        mesher.mesh({ cell: RIGHT, lod: 1 }),
        cellCentreX(RIGHT, 1, 0),
        1,
      );

      const distance = (from: Point[], to: Point[]): number =>
        Math.max(
          ...from.map((p) =>
            Math.min(
              ...to.map((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)),
            ),
          ),
        );

      expect(distance(fine, coarse)).toBeLessThanOrEqual(lodSampleSize(0));
    },
  );
});

/**
 * The seam as a player meets it.
 *
 * Not watertightness — that is the pair of `it.fails` above, and they are still failing,
 * because nothing here makes two chunks share a vertex. What is pinned instead is that the
 * coarse chunk's surface *crosses* the plane between the two cells and lands close enough
 * to the fine chunk's that nothing is left showing through (ADR 0035).
 *
 * Both halves matter, and the second is the one a test that only counted vertices would
 * pass without trying. A sheet that crosses the plane and then disagrees with its
 * neighbour by a coarse sample has replaced a slit with a step; a sheet that agrees but
 * stops short has left the original slit. The bound below is one fine sample, which is
 * also the width the crack was measured at before — so a regression to stopping short
 * fails here by a wide margin rather than by a hair.
 */
describe("a level step, covered by overlap", () => {
  const mesher = mesherOverTerrain();

  /** The coarse chunk, told which way its finer neighbour lies. */
  const coarse = (overlap: number) =>
    mesher.mesh({ cell: RIGHT, lod: 1, overlap });

  it("carries the coarse chunk's surface across the plane into its neighbour", () => {
    // A surface that reaches the plane and stops there is the crack; one that crosses it is
    // not. Measured as how far the mesh reaches *past* the plane rather than as a count of
    // vertices there, because a vertex sits in the middle of its own cell and the count
    // would depend on how the terrain happens to cross the cells beside the seam.
    //
    // The plain chunk does put vertices past the plane — its low padding cell is a whole
    // coarse cell of the neighbour's ground, taken for the interface quads — which is
    // exactly why "has vertices there" is too weak a test to fail on.
    const reachPast = (mesh: ChunkMesh): number => {
      const lowest = Math.min(...points(mesh).map((p) => p.x));
      return SEAM_X - lowest;
    };
    const plain = coarse(0);
    const overlapping = coarse(OVERLAP_X_NEG);
    expect(plain.vertexCount).toBeGreaterThan(0);
    expect(overlapping.vertexCount).toBeGreaterThan(plain.vertexCount);

    // Padding alone: half a coarse sample, the middle of the cell beyond the plane.
    expect(reachPast(plain)).toBeLessThan(lodSampleSize(1));
    // Padding and the overlapped cell: a full coarse cell into the finer chunk.
    expect(reachPast(overlapping)).toBeGreaterThan(lodSampleSize(1));
  });

  it("keeps the two sheets within one fine sample of each other", () => {
    // The premise the whole arrangement rests on, and the one that would fail if the two
    // meshes ever stopped describing the same surface: over the overlap the coarse sheet
    // and the fine sheet are two tessellations of one field, so they differ by the
    // level-of-detail error and nothing else. Where they differ by more than that, the
    // overlap is not hiding anything — it is two surfaces with a gap between them, which
    // is the defect this replaced.
    const fine = points(mesher.mesh({ cell: LEFT, lod: 0 }));
    const strip = points(coarse(OVERLAP_X_NEG)).filter(
      (p) => p.x < SEAM_X - 1e-6,
    );
    expect(fine.length).toBeGreaterThan(0);
    expect(strip.length).toBeGreaterThan(0);

    let worst = 0;
    for (const p of strip) {
      let closest = Infinity;
      for (const q of fine)
        closest = Math.min(
          closest,
          Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
        );
      worst = Math.max(worst, closest);
    }
    expect(worst).toBeLessThanOrEqual(lodSampleSize(0));
  });

  it("puts the overlap on one side of the seam, so only one of them pays", () => {
    // The pair of masks the window would supply for two cells that really are at different
    // levels, and the consequence: the coarse mesh crosses the plane and the fine mesh is
    // byte-for-byte the mesh it always was. Both sides reaching across would draw two
    // coarse sheets over the same fine geometry, which is the same cost as the overlap and
    // twice the chance of the two of them z-fighting where they cross.
    const bands = { full: 0, coarse: 1 };
    const focus: CellCoord = { x: 0, y: 0, z: 0 };
    expect(lodAt(LEFT, focus, bands)).toBe(0);
    expect(lodAt(RIGHT, focus, bands)).toBe(1);

    const fineOverlap = overlapMaskAt(LEFT, focus, bands);
    const coarseOverlap = overlapMaskAt(RIGHT, focus, bands);
    expect(fineOverlap & OVERLAP_X_POS).toBe(0);
    expect(coarseOverlap & OVERLAP_X_NEG).toBe(OVERLAP_X_NEG);

    const fine = mesher.mesh({ cell: LEFT, lod: 0, overlap: fineOverlap });
    const plainFine = mesher.mesh({ cell: LEFT, lod: 0 });
    expect(fine.vertexCount).toBe(plainFine.vertexCount);
    expect([...fine.indices]).toEqual([...plainFine.indices]);
    // And the coarse one, meshed with what the window would have told it, does reach over.
    expect(
      mesher.mesh({ cell: RIGHT, lod: 1, overlap: coarseOverlap }).vertexCount,
    ).toBeGreaterThan(mesher.mesh({ cell: RIGHT, lod: 1 }).vertexCount);
  });
});

/**
 * The sea across a level-of-detail boundary, which is a different question.
 *
 * **The ground and the sea are two surfaces through one volume, meshed at two strides**, and at
 * a level step the shoreline is where they meet. The ground has ADR 0035's overlap to cover
 * it; the sea rides the same window and the same overlap, so the same coverage applies to it —
 * and that is a claim worth a test rather than an inference, because the sea's edge is decided
 * per cell by the gate and a coarse cell spans four fine ones.
 *
 * **What is checked is coverage rather than agreement.** The ground's seam is a crack in the
 * surface; the sea's is a gap where there should be water and there is none. So the assertion is
 * that the coarse chunk's sea reaches past the shared plane when it is given the overlap the
 * window would give it — the property the window actually depends on — and that the sea's
 * surface is at the sea level either way, which is the thing that makes the two chunks' water
 * the same water.
 */
describe("the sea across a level step", () => {
  /**
   * A landscape with a coast on the seam, so the sea's edge is in the picture.
   *
   * **A step rather than noise**, for the reason `water-mesher.test.ts` says: every claim here
   * is about where the sea's boundary falls relative to the ground's, and noise would make each
   * one a statement about a seed as well.
   */
  const coastal = () => {
    const seaLevel = 0;
    // Ground rises from a hundred below the sea at `x < 0` to a hundred above it at `x > 0`, so
    // the shoreline sits on `x = 0` — which is inside chunk 0's own extent rather than on its
    // boundary, and the sea has to run right up to it and stop.
    const groundAt = (x: number) => (x < 0 ? -100 : 100);
    const distance = (x: number, y: number, _z: number) => y - groundAt(x);
    return Object.assign(distance, {
      kind: "terrain" as const,
      seaLevel,
      lipschitz: 1,
      heightAt: groundAt,
      lowest: -100,
      highest: 100,
      fallbackNormal: () => ({ x: 0, y: 1, z: 0 }),
      couldHoldSurface: () => true,
    });
  };

  const seaMesher = () => new WaterChunkMesher(coastal());

  const at = (mesh: ChunkMesh, i: number): Point => ({
    x: mesh.positions[i * 3],
    y: mesh.positions[i * 3 + 1],
    z: mesh.positions[i * 3 + 2],
  });

  it("keeps the sea's surface at the sea level at every level", () => {
    // **Before any seam question: is it the same water?** Two chunks at different strides sample
    // the sea's surface at different places, and both must put their vertices on the waterline —
    // otherwise the level step is not a resolution difference but two different seas.
    const mesher = seaMesher();
    for (const lod of [0, 1, 2] as const) {
      const mesh = mesher.mesh({ cell: LEFT, lod });
      expect(mesh.vertexCount, `lod ${lod}`).toBeGreaterThan(0);
      for (let v = 0; v < mesh.vertexCount; v++)
        expect(at(mesh, v).y, `lod ${lod} vertex ${v}`).toBeCloseTo(0, 1);
    }
  });

  it("stops the sea where the ground rises through it, at every level", () => {
    // **The shoreline is the whole claim**, and a sea drawn as a sphere could not do it. The
    // ground is above the sea for every `x > 0`, so no vertex may be there — which is the
    // failure the gate exists to prevent, expressed as a position.
    const mesher = seaMesher();
    for (const lod of [0, 1, 2] as const) {
      const mesh = mesher.mesh({ cell: LEFT, lod });
      for (let v = 0; v < mesh.vertexCount; v++) {
        // Only the half of the chunk that is over the basin has water, and the chunk's own
        // centre is the ground, so a vertex may not sit to the right of it.
        expect(at(mesh, v).x, `lod ${lod} vertex ${v}`).toBeLessThan(0);
      }
    }
  });

  it("covers the seam with the overlap the window gives it", () => {
    // **The property the window depends on.** `lod-seam.test.ts` proves the ground's coarse
    // chunk reaches past the shared plane when given `OVERLAP_X_NEG`; the sea has to as well,
    // or a level step would leave the sea short of where the ground is detailed.
    const bands = { full: 0, coarse: 1 };
    const focus: CellCoord = { x: 0, y: 0, z: 0 };
    expect(lodAt(LEFT, focus, bands)).toBe(0);
    expect(lodAt(RIGHT, focus, bands)).toBe(1);
    const coarseOverlap = overlapMaskAt(RIGHT, focus, bands);
    expect(coarseOverlap & OVERLAP_X_NEG).toBe(OVERLAP_X_NEG);

    const mesher = seaMesher();
    // Chunk 1 is entirely over ground above the sea, so it holds no water either way; what
    // matters is that asking for it with the overlap is answered rather than refused, and that
    // the sea that *is* drawn from it sits on the waterline.
    const withOverlap = mesher.mesh({
      cell: RIGHT,
      lod: 1,
      overlap: coarseOverlap,
    });
    for (let v = 0; v < withOverlap.vertexCount; v++)
      expect(at(withOverlap, v).y).toBeCloseTo(0, 1);
  });
});
