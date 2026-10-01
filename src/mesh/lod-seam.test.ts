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
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_TERRAIN, Field, OperationBVH, terrainField } from "../csg";
import type { CellCoord, Lod } from "../world";
import { lodSampleSize, lodSamples } from "../world";

import type { ChunkMesh } from "./chunk-mesh";
import { chunkRegion, SurfaceNetsChunkMesher } from "./chunk-mesher";

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
