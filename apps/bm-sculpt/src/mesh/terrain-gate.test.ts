/**
 * The mesher's skip gate, over real terrain.
 *
 * A separate file because this is the one place where a wrong answer is permanent: the
 * mesher that skips a chunk records an answer, so a chunk skipped in error is a hole in the
 * world that nothing will ever re-mesh, and it looks like a modelling bug rather than like
 * an optimisation that was too aggressive.
 *
 * So the property is checked against the ground truth rather than against the reasoning: a
 * chunk is meshed *without* the gate, and if that produced any geometry then the gate must
 * not have claimed the chunk was empty. The converse is checked too, because a gate that
 * never skips anything passes the first test for free and saves nothing.
 */

import { describe, expect, it } from "vitest";

import {
  Field,
  OperationBVH,
  makeOperation,
  terrainField,
} from "@big-mesh-studios/csg";
import type { TerrainParams } from "@big-mesh-studios/csg";
import { BLOCK_WORLD } from "../constants";
import { SurfaceNetsChunkMesher } from "./chunk-mesher";
import type { CellCoord, Lod } from "../world";

const LOD0: Lod = 0;

const TERRAIN: TerrainParams = {
  origin: -70,
  scale: 96,
  octaves: 4,
  seed: 20260901,
};

/**
 * Cells to walk, centred on the origin and spanning the ground's whole vertical range.
 *
 * Kept small on purpose. Each cell is 34,304 field samples and every one of those is a
 * four-octave noise evaluation, so a wide scan here is a CPU competitor rather than a test —
 * it was enough to push `bvh.test.ts`'s brute-force comparisons past vitest's five-second
 * per-test timeout when the suite ran in parallel, which looks like a broken BVH and is
 * nothing of the kind. A wrong bound shows up in any single column, so the width buys
 * confidence slowly and costs other files quickly.
 */
const CELLS: CellCoord[] = [];
for (let x = -1; x <= 1; x++) {
  for (let z = -1; z <= 1; z++) {
    for (let y = -1; y <= 0; y++) CELLS.push({ x, y, z });
  }
}

const mesherOver = (terrain: TerrainParams) => {
  const field = terrainField(terrain);
  const composed = new Field(new OperationBVH([]), {
    base: field,
    extent: field,
    lipschitz: field.lipschitz,
  });
  return { field, mesher: new SurfaceNetsChunkMesher(composed) };
};

describe("the skip gate over terrain", () => {
  it("never claims a chunk with ground in it is empty", () => {
    // The load-bearing assertion. Meshed without the gate, so any geometry at all is
    // ground; and then the gate is asked about the same chunk.
    const { mesher } = mesherOver(TERRAIN);

    let withSurface = 0;
    for (const cell of CELLS) {
      const mesh = mesher.mesh({ cell, lod: LOD0 });
      if (mesh.vertexCount === 0) continue;
      withSurface++;
      expect(
        mesher.couldHaveMesh(cell, LOD0),
        `chunk ${cell.x},${cell.y},${cell.z} has surface but the gate called it empty`,
      ).toBe(true);
    }

    // And the test is not vacuous: these cells really do straddle the ground. About half of
    // them do, which is the right answer — a height field crosses each column once, so a
    // two-layer scan in y finds the surface in one layer and misses it in the other.
    expect(withSurface).toBeGreaterThan(CELLS.length / 4);
  });
  it("does skip the chunks that are all air above the landscape", () => {
    // Without this the first test would pass on a gate that skips nothing, and the whole
    // point of the extent is the saving. The cells here are a full chunk-width above the
    // highest ground the terrain can produce.
    const { field, mesher } = mesherOver(TERRAIN);
    const highestCell = Math.floor(field.highest / BLOCK_WORLD) + 2;

    const air: CellCoord = { x: 0, y: highestCell, z: 0 };
    // Confirmed by meshing, so this is the gate agreeing with the ground truth rather than
    // agreeing with itself.
    expect(mesher.mesh({ cell: air, lod: LOD0 }).vertexCount).toBe(0);
    expect(mesher.couldHaveMesh(air, LOD0)).toBe(false);
  });

  it("does skip the chunks that are all solid below the landscape", () => {
    // The other half, and the one that is easy to forget: deep rock holds no sign change, so
    // it produces no surface either, and in a terrain world most of the window below the
    // landscape is exactly that.
    const { field, mesher } = mesherOver(TERRAIN);
    const lowestCell = Math.floor(field.lowest / BLOCK_WORLD) - 2;

    const rock: CellCoord = { x: 0, y: lowestCell, z: 0 };
    expect(mesher.mesh({ cell: rock, lod: LOD0 }).vertexCount).toBe(0);
    expect(mesher.couldHaveMesh(rock, LOD0)).toBe(false);
  });

  it("keeps a primitive floating in a chunk the terrain calls empty", () => {
    // The composition's half of the arrangement, over real terrain rather than a stub: a
    // sphere well above the ground, in a chunk the base field rules out.
    const terrain = terrainField(TERRAIN);
    const floating = makeOperation(
      0,
      { x: 0, y: 300, z: 0 },
      { type: "Ellipsoid", radius: { x: 60, y: 60, z: 60 } },
      "Add",
    );
    const composed = new Field(new OperationBVH([floating]), {
      base: terrain,
      extent: terrain,
      lipschitz: terrain.lipschitz,
    });
    const mesher = new SurfaceNetsChunkMesher(composed);

    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    expect(mesher.mesh({ cell, lod: LOD0 }).vertexCount).toBeGreaterThan(0);
    expect(mesher.couldHaveMesh(cell, LOD0)).toBe(true);
  });

  it("agrees with itself, so two meshes of the same chunk match", () => {
    // A gate whose answer depended on which instance asked would make the pool's assignment
    // of chunks to workers visible in the model — the same argument as for the mesher itself.
    const one = mesherOver(TERRAIN).mesher;
    const two = mesherOver(TERRAIN).mesher;

    for (const cell of CELLS) {
      expect(two.couldHaveMesh(cell, LOD0)).toBe(one.couldHaveMesh(cell, LOD0));
    }
  });
});
