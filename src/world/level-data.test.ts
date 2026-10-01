import { describe, expect, it } from "vitest";

import { BLOCK_WORLD, CHUNK_VOXELS, VOXEL_SIZE } from "../constants";
import {
  cellCentre,
  cellDistance,
  cellInSphere,
  cellsInSphere,
  chunkCellOf,
  DEFAULT_LOD_BANDS,
  lodAt,
  lodExtent,
  lodIsOff,
  LOD_OFF,
  lodSampleSize,
  lodSamples,
  sampleIndexIn,
  sampleWorld,
  SKIRT_X_NEG,
  SKIRT_Z_NEG,
  SKIRT_Z_POS,
  skirtMaskAt,
  sphereCells,
  type CellCoord,
} from "./level-data";

describe("chunk cells", () => {
  it("puts the origin at a cell's centre, not its corner", () => {
    // A model built around the origin has to be symmetric across all eight octants.
    // Sampling at corners would put a plane through the middle of it.
    expect(chunkCellOf({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(chunkCellOf({ x: 1, y: 1, z: 1 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(chunkCellOf({ x: -1, y: -1, z: -1 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("is the inverse of a cell's centre", () => {
    // Every cell's centre must name that cell, or a chunk mesh would be built at one
    // place and drawn at another — a bug that shows up only once the camera moves
    // far enough for the two to diverge.
    for (const cell of [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: -2, z: 3 },
      { x: -7, y: 4, z: -9 },
      { x: 1000, y: -1000, z: 250 },
    ]) {
      expect(chunkCellOf(cellCentre(cell)), JSON.stringify(cell)).toEqual(cell);
    }
  });

  it("puts the boundary between two cells halfway between their centres", () => {
    const a = cellCentre({ x: 0, y: 0, z: 0 });
    const b = cellCentre({ x: 1, y: 0, z: 0 });
    const halfway = (a.x + b.x) / 2;
    expect(chunkCellOf({ x: halfway - 0.001, y: 0, z: 0 }).x).toBe(0);
    expect(chunkCellOf({ x: halfway + 0.001, y: 0, z: 0 }).x).toBe(1);
  });

  it("is unbounded in both directions", () => {
    // The difference between a sculpting session and an infinite world is which
    // point the focus is at, never whether these coordinates are legal.
    const far = chunkCellOf({ x: 4_000_000, y: -4_000_000, z: 4_000_000 });
    expect(Number.isInteger(far.x)).toBe(true);
    expect(chunkCellOf(cellCentre(far))).toEqual(far);
  });
});

describe("sample positions", () => {
  it("starts a chunk's samples on its low edge, so chunks tile", () => {
    // Thirty-two samples at interval *centres* would span 310 units of a 320-unit chunk
    // and leave a gap at every boundary. Starting each sample on its interval instead
    // makes a chunk's cells cover its extent exactly, with the next chunk's first cell
    // beginning where this one's last ended.
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    const first = sampleWorld(cell, 0);
    const last = sampleWorld(cell, CHUNK_VOXELS - 1);
    expect(first).toBeCloseTo(-BLOCK_WORLD / 2, 9);
    expect(last).toBeCloseTo(BLOCK_WORLD / 2 - VOXEL_SIZE, 9);
    expect(last - first).toBeCloseTo((CHUNK_VOXELS - 1) * VOXEL_SIZE, 9);

    // And the sample that ends a chunk's last interval is the next chunk's first, which
    // is what lets the two share a boundary.
    expect(sampleWorld({ x: 1, y: 0, z: 0 }, 0) - VOXEL_SIZE).toBeCloseTo(
      last,
      9,
    );
  });

  it("starts a chunk's own samples one voxel apart with no gaps between chunks", () => {
    for (const along of [0, 1, CHUNK_VOXELS - 2, CHUNK_VOXELS - 1]) {
      const here = sampleWorld({ x: 2, y: 0, z: 0 }, along);
      const next = sampleWorld({ x: 3, y: 0, z: 0 }, along);
      expect(next - here).toBeCloseTo(BLOCK_WORLD, 9);
    }
  });

  it("spaces samples one voxel apart", () => {
    const cell: CellCoord = { x: 3, y: 0, z: 0 };
    for (let at = 1; at < CHUNK_VOXELS; at++) {
      expect(sampleWorld(cell, at) - sampleWorld(cell, at - 1)).toBeCloseTo(
        VOXEL_SIZE,
        9,
      );
    }
  });

  it("round-trips a world point back to the sample nearest it", () => {
    const cell: CellCoord = { x: -2, y: 1, z: 0 };
    const centre = cellCentre(cell);
    for (let along = 0; along < CHUNK_VOXELS; along++) {
      const world = sampleWorld(cell, along);
      expect(sampleIndexIn(world, centre.x), `sample ${along}`).toBe(along);
    }
  });

  it("clamps a point in the last interval to the chunk's own last sample", () => {
    // The boundary sample it is nearer to belongs to the next chunk, so an unclamped
    // answer would be an index the caller has to bounds-check — or paint into.
    const centre = 0;
    expect(sampleIndexIn(BLOCK_WORLD / 2 - VOXEL_SIZE / 2, centre)).toBe(
      CHUNK_VOXELS - 1,
    );
    expect(sampleIndexIn(-BLOCK_WORLD / 2 - VOXEL_SIZE, centre)).toBe(0);
  });

  it("rounds a point between two samples the same way every time", () => {
    // A tie has to break consistently or the field stops being a function of
    // position — the one property the whole level-of-detail scheme rests on.
    const centre = 0;
    const between = sampleWorld({ x: 0, y: 0, z: 0 }, 4) + VOXEL_SIZE / 2;
    const first = sampleIndexIn(between, centre);
    const second = sampleIndexIn(between, centre);
    expect(first).toBe(second);
    expect(Math.abs(first - 4)).toBe(1);
  });
});

describe("level of detail", () => {
  it("covers the same ground at every level", () => {
    // The property the design rests on. A level that covered less or more would make
    // swapping one for another as the camera moves a visible change rather than a
    // change of resolution.
    expect(lodExtent(0)).toBe(BLOCK_WORLD);
    expect(lodExtent(1)).toBe(BLOCK_WORLD);
    expect(lodExtent(2)).toBe(BLOCK_WORLD);
  });

  it("divides the sample count by the stride", () => {
    expect(lodSamples(0)).toBe(CHUNK_VOXELS);
    expect(lodSamples(1)).toBe(CHUNK_VOXELS / 2);
    expect(lodSamples(2)).toBe(CHUNK_VOXELS / 4);
  });

  it("grows the sample's world size with the stride", () => {
    expect(lodSampleSize(0)).toBe(VOXEL_SIZE);
    expect(lodSampleSize(1)).toBe(VOXEL_SIZE * 2);
    expect(lodSampleSize(2)).toBe(VOXEL_SIZE * 4);
  });

  it("clamps a level outside the table to the coarsest entry", () => {
    // Callers pass a level from a table, and a table lookup that answered `undefined`
    // for an out-of-range index would put NaN into a chunk's geometry.
    expect(lodSamples(7)).toBe(lodSamples(2));
    expect(lodSamples(-3)).toBe(lodSamples(0));
  });

  it("is chosen by euclidean distance in chunk cells", () => {
    const focus: CellCoord = { x: 0, y: 0, z: 0 };
    const { full, coarse } = DEFAULT_LOD_BANDS;
    // Probing the band boundaries themselves, which is what a comparison against has to
    // decide. Derived from the bands rather than written out, so a retune does not quietly
    // turn this into a test of the old numbers.
    expect(lodAt({ x: 0, y: 0, z: 0 }, focus)).toBe(0);
    expect(lodAt({ x: full, y: 0, z: 0 }, focus)).toBe(0);
    expect(lodAt({ x: coarse, y: 0, z: 0 }, focus)).toBe(1);
    expect(lodAt({ x: coarse + 1, y: 0, z: 0 }, focus)).toBe(2);
    // Measured diagonally, so the same per-axis coordinate is further away when it is
    // taken on three axes at once — the distance is euclidean, not per-axis.
    expect(lodAt({ x: coarse, y: coarse, z: coarse }, focus)).toBe(2);
  });

  it("leaves no lower-detail chunk touching the cell the player stands in", () => {
    // The reason `full` is two rather than one, and the whole point of the band. Distance
    // is measured from the focus *cell*, and the player is anywhere inside it — so at
    // `full: 1` the first coarser chunk is a diagonal neighbour at √2, whose corner is the
    // corner of the cell the player is standing in, and standing on that seam means looking
    // at two levels at once.
    const focus: CellCoord = { x: 0, y: 0, z: 0 };
    // Every face and diagonal neighbour of the focus cell, all of which are within reach of
    // the player standing anywhere in it.
    for (const cell of [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 0, z: 1 },
      { x: 0, y: 1, z: 1 },
      { x: 1, y: 1, z: 1 },
    ]) {
      expect(lodAt(cell, focus), `cell ${JSON.stringify(cell)}`).toBe(0);
    }
  });

  it("is the same everywhere at equal distance", () => {
    const focus: CellCoord = { x: 5, y: -3, z: 7 };
    for (const offset of [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: -1, z: 0 },
    ]) {
      const a = lodAt(
        { x: focus.x + offset.x, y: focus.y + offset.y, z: focus.z + offset.z },
        focus,
      );
      const b = lodAt(
        { x: focus.x - offset.x, y: focus.y - offset.y, z: focus.z - offset.z },
        focus,
      );
      expect(a).toBe(b);
    }
  });

  it("is full resolution everywhere when switched off", () => {
    // The infinite bands compare against infinite squares, so every distance passes
    // the first test and no cell ever reaches the coarse branch. Asserted through
    // the real function rather than a special case, so it stays true if the
    // comparison is ever rewritten.
    expect(lodIsOff(LOD_OFF)).toBe(true);
    expect(lodIsOff(DEFAULT_LOD_BANDS)).toBe(false);
    for (const cell of [
      { x: 0, y: 0, z: 0 },
      { x: 500, y: 500, z: 500 },
      { x: -900, y: 0, z: 40 },
    ]) {
      expect(lodAt(cell, { x: 0, y: 0, z: 0 }, LOD_OFF)).toBe(0);
    }
  });

  it("follows the focus rather than the origin", () => {
    // A window scrolled ten thousand chunks out must make the same decision about
    // its own centre as one at the origin does. A comparison against the origin
    // would make everything beyond the bands coarsest, permanently.
    const bands = DEFAULT_LOD_BANDS;
    const edge = 5000;
    // The focus and its immediate neighbours are full resolution, the next band is one
    // step coarser, and anything past that is the coarsest.
    const focus: CellCoord = { x: edge, y: 0, z: 0 };
    expect(lodAt(focus, focus, bands)).toBe(0);
    expect(lodAt({ x: edge + bands.full, y: 0, z: 0 }, focus, bands)).toBe(0);
    expect(lodAt({ x: edge + bands.coarse, y: 0, z: 0 }, focus, bands)).toBe(1);
    expect(
      lodAt({ x: edge + bands.coarse + 1, y: 0, z: 0 }, focus, bands),
    ).toBe(2);
    // And the same cell, measured from the origin instead, is very far away — which
    // is what "follows the focus" is protecting against.
    expect(
      lodAt(
        { x: edge + bands.coarse + 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        bands,
      ),
    ).toBe(2);
    expect(lodAt({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, bands)).toBe(0);
  });

  it("measures distance the same way cellDistance does", () => {
    const focus: CellCoord = { x: 0, y: 0, z: 0 };
    const { full, coarse } = DEFAULT_LOD_BANDS;
    for (const cell of [
      { x: 2, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      { x: 0, y: 3, z: 4 },
    ]) {
      const distance = cellDistance(cell, focus);
      expect(lodAt(cell, focus)).toBe(
        distance <= full ? 0 : distance <= coarse ? 1 : 2,
      );
    }
  });
});

describe("the window", () => {
  it("is a ball, flattened vertically by default", () => {
    const cells = sphereCells({ x: 0, y: 0, z: 0 }, 3, 1);
    expect(cells.length).toBeLessThan(
      sphereCells({ x: 0, y: 0, z: 0 }, 3, 3).length,
    );
    for (const cell of cells) expect(Math.abs(cell.y)).toBeLessThanOrEqual(1);
  });

  it("includes the centre and nothing outside the radius", () => {
    const centre: CellCoord = { x: 3, y: 1, z: -2 };
    const cells = sphereCells(centre, 3, 2);
    expect(cells).toHaveLength(cellsInSphere(3, 2));
    expect(cells.some((c) => c.x === 3 && c.y === 1 && c.z === -2)).toBe(true);
    for (const cell of cells)
      expect(cellInSphere(cell, centre, 3, 2)).toBe(true);
  });

  it("centres itself on whatever it is given", () => {
    // Same shape, different place — the difference between a sculpting session and an
    // infinite world, with no other difference anywhere in the arithmetic.
    const near = sphereCells({ x: 0, y: 0, z: 0 }, 2, 1);
    const far = sphereCells({ x: 9000, y: -4000, z: 12000 }, 2, 1);
    expect(far.length).toBe(near.length);
    for (const cell of far) {
      expect(cell.x).toBeGreaterThan(8997);
      expect(cell.y).toBeLessThan(-3997);
      expect(cell.z).toBeGreaterThan(11997);
    }
  });

  it("treats a zero vertical radius as one chunk tall", () => {
    // Dividing by a zero radius would make every cell with a non-zero vertical
    // offset infinite distance away, leaving an empty window.
    const cells = sphereCells({ x: 0, y: 0, z: 0 }, 2, 0);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.y).toBe(0);
  });

  it("holds the centre cell of the origin window, which is where a model is", () => {
    const cells = sphereCells({ x: 0, y: 0, z: 0 }, 1, 1);
    expect(cells.map((c) => `${c.x},${c.y},${c.z}`)).toContain("0,0,0");
  });
});

describe("skirt masks", () => {
  const focus: CellCoord = { x: 0, y: 0, z: 0 };

  it("is empty where every neighbour is at the same level", () => {
    // A same-level seam is watertight, so a skirt there would be geometry nobody needs.
    expect(skirtMaskAt({ x: 0, y: 5, z: 0 }, focus)).toBe(0);
  });

  it("sets the face whose neighbour is one band finer", () => {
    // The outermost chunk of a band is one step coarser than the neighbour behind it, so
    // the face towards that neighbour is the one that steps up in detail. Written against
    // `coarse` rather than a literal, since which chunk that is depends on the bands.
    const { coarse } = DEFAULT_LOD_BANDS;
    const mask = skirtMaskAt({ x: coarse, y: 0, z: 0 }, focus);
    expect(lodAt({ x: coarse, y: 0, z: 0 }, focus)).toBe(1);
    expect(lodAt({ x: coarse - 1, y: 0, z: 0 }, focus)).toBe(0);
    expect(mask & SKIRT_X_NEG).toBe(SKIRT_X_NEG);
  });

  it("sets every face that steps, including the outer z side", () => {
    const mask = skirtMaskAt({ x: 0, y: 0, z: 0 }, focus, {
      full: 0,
      coarse: 1,
    });
    // With a single full chunk at the focus, only the origin cell is level 0 and all six
    // faces step down in detail.
    expect(mask).not.toBe(0);
    expect(mask & SKIRT_Z_POS).toBe(SKIRT_Z_POS);
    expect(mask & SKIRT_Z_NEG).toBe(SKIRT_Z_NEG);
  });

  it("does not skirt a face where the level matches, only where it steps", () => {
    const mask = skirtMaskAt({ x: 0, y: 6, z: 0 }, focus);
    // (0,5,0) is level 2 at distance 5, so is its neighbour above; (0,4,0) is also level 2,
    // so no face reports a change.
    expect(mask).toBe(0);
  });
});
