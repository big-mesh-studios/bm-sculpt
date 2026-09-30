import { describe, expect, it } from "vitest";

import { BLOCK_WORLD, CHUNK_VOXELS, VOXEL_SIZE } from "../constants";
import {
  cellCentre,
  chunkCellOf,
  sampleWorld,
  type CellCoord,
} from "./level-data";
import {
  makeTile,
  PaintTiles,
  sampleInTile,
  TILE_BYTES,
  tileIndex,
} from "./paint-tiles";

const RED = { r: 255, g: 0, b: 0 };
const GREEN = { r: 0, g: 255, b: 0 };

/** The world position of a sample along one axis, given that axis's cell coordinate. */
/**
 * The world position of a sample, read through the one definition rather than a copy.
 *
 * This file previously repeated the formula, and when the convention was corrected to
 * start samples on a chunk's low edge the copy silently kept the old one — so the tests
 * went on agreeing with each other about a chunk that had a gap in it.
 */
const axisWorld = (cellAlongAxis: number, along: number): number =>
  sampleWorld({ x: cellAlongAxis, y: 0, z: 0 }, along);

describe("tile addressing", () => {
  it("is a bijection over a chunk's samples", () => {
    // Two samples sharing an index would overwrite each other, and two indices
    // covering one sample would leave half of a stroke unpainted. Neither shows up
    // until a stroke crosses a chunk, which is exactly when the tile stops being
    // small enough to look at by eye.
    const seen = new Set<number>();
    for (let z = 0; z < CHUNK_VOXELS; z++) {
      for (let y = 0; y < CHUNK_VOXELS; y++) {
        for (let x = 0; x < CHUNK_VOXELS; x++) {
          const at = tileIndex(x, y, z);
          expect(seen.has(at), `collision at ${x},${y},${z}`).toBe(false);
          seen.add(at);
        }
      }
    }
    expect(seen.size).toBe(CHUNK_VOXELS ** 3);
    expect(TILE_BYTES).toBe(CHUNK_VOXELS ** 3 * 3);
  });

  it("recognises its own samples and nobody else's", () => {
    expect(sampleInTile(0, 0, 0)).toBe(true);
    expect(
      sampleInTile(CHUNK_VOXELS - 1, CHUNK_VOXELS - 1, CHUNK_VOXELS - 1),
    ).toBe(true);
    expect(sampleInTile(-1, 0, 0)).toBe(false);
    expect(sampleInTile(CHUNK_VOXELS, 0, 0)).toBe(false);
  });
});

describe("painting a sample", () => {
  it("reads back what it wrote", () => {
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    tiles.paintSample(cell, 1, 2, 3, RED);
    expect(tiles.atSample(cell, 1, 2, 3)).toEqual(RED);
    expect(tiles.atSample(cell, 3, 2, 1)).toBeUndefined();
  });

  it("allocates nothing until something is written", () => {
    const tiles = new PaintTiles();
    expect(tiles.size).toBe(0);
    expect(tiles.atSample({ x: 0, y: 0, z: 0 }, 0, 0, 0)).toBeUndefined();
    tiles.paintSample({ x: 4, y: 0, z: 0 }, 0, 0, 0, RED);
    expect(tiles.size).toBe(1);
  });

  it("reports a change once and no change thereafter", () => {
    // A stroke crossing ground that is already the right colour must not rebuild the
    // chunk, which during a slow drag across a flat area is most of the writes.
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    expect(tiles.paintSample(cell, 5, 5, 5, RED)).toBe(true);
    expect(tiles.paintSample(cell, 5, 5, 5, RED)).toBe(false);
    expect(tiles.paintSample(cell, 5, 5, 5, GREEN)).toBe(true);
  });

  it("ignores a sample outside the chunk rather than corrupting the tile", () => {
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    expect(tiles.paintSample(cell, -1, 0, 0, RED)).toBe(false);
    expect(tiles.paintSample(cell, CHUNK_VOXELS, 0, 0, RED)).toBe(false);
    expect(tiles.size).toBe(0);
  });

  it("reads a sample outside the chunk as unpainted", () => {
    // A vertex the mesher interpolated slightly past a chunk's edge must not take the
    // meshing pass down.
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    tiles.paintSample(cell, 0, 0, 0, RED);
    expect(tiles.atSample(cell, -1, 0, 0)).toBeUndefined();
    expect(tiles.atSample(cell, 0, CHUNK_VOXELS + 4, 0)).toBeUndefined();
  });

  it("tracks the box of what has been painted", () => {
    // So a tile can be stored as the part that was painted rather than as a whole
    // chunk of mostly nothing.
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 2, y: 0, z: 0 };
    expect(tiles.tileAt(cell)).toBeUndefined();
    tiles.paintSample(cell, 10, 12, 14, RED);
    tiles.paintSample(cell, 4, 3, 2, GREEN);
    tiles.paintSample(cell, 20, 25, 30, RED);
    expect(tiles.tileAt(cell)?.written).toEqual({
      minX: 4,
      minY: 3,
      minZ: 2,
      maxX: 20,
      maxY: 25,
      maxZ: 30,
    });
  });

  it("counts the samples its boxes cover, which is an upper bound", () => {
    // An upper bound rather than an exact count: the boxes are tracked per write, not
    // per sample, so a hole inside one is not known about.
    const tiles = new PaintTiles();
    tiles.paintSample({ x: 0, y: 0, z: 0 }, 0, 0, 0, RED);
    tiles.paintSample({ x: 0, y: 0, z: 0 }, 3, 3, 3, RED);
    expect(tiles.paintedSamples).toBe(64);
  });
});

describe("painting a box", () => {
  it("fills every sample inside it and nothing outside", () => {
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    expect(
      tiles.paintBox(cell, { x: 2, y: 2, z: 2 }, { x: 4, y: 4, z: 4 }, RED),
    ).toBe(true);

    expect(tiles.atSample(cell, 3, 3, 3)).toEqual(RED);
    expect(tiles.atSample(cell, 2, 2, 2)).toEqual(RED);
    expect(tiles.atSample(cell, 4, 4, 4)).toEqual(RED);
    expect(tiles.atSample(cell, 1, 3, 3)).toBeUndefined();
    expect(tiles.atSample(cell, 5, 3, 3)).toBeUndefined();
    expect(tiles.atSample(cell, 3, 3, 5)).toBeUndefined();
  });

  it("reports no change for a box that is already that colour", () => {
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    tiles.paintBox(cell, { x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }, RED);
    expect(
      tiles.paintBox(cell, { x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }, RED),
    ).toBe(false);
    expect(
      tiles.paintBox(cell, { x: 0, y: 0, z: 0 }, { x: 4, y: 3, z: 3 }, RED),
    ).toBe(true);
  });

  it("clips a box that runs past the chunk rather than writing out of bounds", () => {
    // A brush at a chunk's edge is the normal case, not an edge case.
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    tiles.paintBox(cell, { x: -5, y: -5, z: -5 }, { x: 5, y: 5, z: 5 }, RED);
    expect(tiles.atSample(cell, 0, 0, 0)).toEqual(RED);
    expect(tiles.atSample(cell, 5, 5, 5)).toEqual(RED);
    expect(tiles.atSample(cell, 6, 0, 0)).toBeUndefined();
  });
});

describe("addressing by world position", () => {
  it("finds the colour at the sample a world point names", () => {
    // Round-trips the two coordinate systems against each other, which is where an
    // off-by-half-a-voxel would show up.
    // Each axis is placed independently, from that axis's own cell coordinate. A
    // chunk's centre differs on all three axes, so one world position reused for all
    // three would resolve two of them into *different* chunks — which is the
    // confusion this test exists to catch.
    const tiles = new PaintTiles();
    for (const cell of [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: -2, z: 1 },
      { x: -7, y: 0, z: -9 },
    ]) {
      for (const along of [0, 7, CHUNK_VOXELS - 1]) {
        tiles.paintSample(cell, along, along, along, RED);
        expect(
          tiles.at(
            axisWorld(cell.x, along),
            axisWorld(cell.y, along),
            axisWorld(cell.z, along),
          ),
          `cell ${cell.x},${cell.y},${cell.z} sample ${along}`,
        ).toEqual(RED);
      }
    }
  });

  it("resolves a world point to the chunk that holds it", () => {
    const tiles = new PaintTiles();
    // A point just inside a chunk's edge belongs to that chunk; a point outside its
    // range does not.
    // Painted at one corner sample, and read at the far corner of the same chunk —
    // which must not wrap round to the painted one.
    const cell = chunkCellOf({ x: 0, y: 0, z: 0 });
    tiles.paintSample(cell, 0, 0, 0, RED);
    expect(
      tiles.at(
        axisWorld(cell.x, CHUNK_VOXELS - 1),
        axisWorld(cell.y, CHUNK_VOXELS - 1),
        axisWorld(cell.z, CHUNK_VOXELS - 1),
      ),
    ).toBeUndefined();
    expect(tiles.atSample(cell, CHUNK_VOXELS - 1, 0, 0)).toBeUndefined();
    // And the painted one reads back through the same path.
    expect(
      tiles.at(
        axisWorld(cell.x, 0),
        axisWorld(cell.y, 0),
        axisWorld(cell.z, 0),
      ),
    ).toEqual(RED);
  });

  it("paints every part of a chunk, including its last interval", () => {
    // The last interval's midpoint is nearer the boundary sample than any sample this
    // chunk owns, so an unclamped nearest-sample lookup would refuse to paint there and
    // the last ten units of every chunk would be unpaintable.
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    const centre = cellCentre(cell);
    const late = BLOCK_WORLD / 2 - VOXEL_SIZE / 2;
    expect(chunkCellOf({ x: late, y: late, z: late })).toEqual(cell);
    expect(tiles.paintWorld({ x: late, y: late, z: late }, RED)).toBe(true);
    expect(tiles.at(late, late, late)).toEqual(RED);
    expect(centre.x).toBeLessThan(late);
  });

  it("cannot be confused between neighbouring chunks", () => {
    // Two chunks' tiles holding different colours, with the world-space read landing
    // in the right one. A tile keyed by slot would pass this test only until the
    // window scrolled and recycled the slot.
    const tiles = new PaintTiles();
    const a: CellCoord = { x: 0, y: 0, z: 0 };
    const b: CellCoord = { x: 1, y: 0, z: 0 };
    // Painted at each chunk's centre sample, which is where the world-space read
    // below will look.
    const centreA = cellCentre(a);
    const centreB = cellCentre(b);
    const middleA = CHUNK_VOXELS / 2;
    tiles.paintSample(a, middleA, middleA, middleA, RED);
    tiles.paintSample(b, middleA, middleA, middleA, GREEN);
    expect(tiles.size).toBe(2);

    expect(tiles.at(centreA.x, centreA.y, centreA.z)).toEqual(RED);
    expect(tiles.at(centreB.x, centreB.y, centreB.z)).toEqual(GREEN);
    // And each chunk's tile holds only its own colour.
    expect(tiles.atSample(a, middleA, middleA, middleA)).toEqual(RED);
    expect(tiles.atSample(b, middleA, middleA, middleA)).toEqual(GREEN);
  });

  it("survives the window scrolling away and back", () => {
    // The whole reason tiles are keyed absolutely. A tile keyed by slot would come
    // back empty, and a user who sculpted something, walked away and returned would
    // find their work gone.
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    tiles.paintSample(cell, 16, 16, 16, RED);

    // Stand in for the window recycling every slot, which is all it takes to lose a
    // slot-keyed tile: nothing about a tile's storage depends on the window at all.
    const other: CellCoord = { x: 9, y: 0, z: 9 };
    tiles.paintSample(other, 0, 0, 0, GREEN);

    expect(tiles.atSample(cell, 16, 16, 16)).toEqual(RED);
    expect(tiles.atSample(other, 0, 0, 0)).toEqual(GREEN);
    expect(tiles.paintedCells()).toHaveLength(2);
    expect(tiles.paintedCells()).toContainEqual(cell);
    expect(tiles.paintedCells()).toContainEqual(other);
  });
});

describe("notifying and replacing", () => {
  it("names a cell once per box, not once per sample", () => {
    // The caller's reaction is to rebuild a chunk's mesh, so a per-sample
    // notification would rebuild the same chunk thousands of times per stroke.
    const painted: CellCoord[] = [];
    const tiles = new PaintTiles({ onPainted: (cell) => painted.push(cell) });
    expect(
      tiles.paintBox(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 15, y: 15, z: 15 },
        RED,
      ),
    ).toBe(true);
    expect(painted).toHaveLength(1);
    expect(painted[0]).toEqual({ x: 0, y: 0, z: 0 });

    // And a single-sample paint still notifies, because a caller that painted one
    // sample wants to hear about it.
    tiles.paintSample({ x: 4, y: 0, z: 0 }, 0, 0, 0, GREEN);
    expect(painted).toHaveLength(2);
    expect(painted[1]).toEqual({ x: 4, y: 0, z: 0 });

    // And a box that changed nothing does not notify at all.
    tiles.paintBox(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      RED,
    );
    expect(painted).toHaveLength(2);
  });

  it("forgets a cell and reports whether there was one", () => {
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 3, y: 0, z: 0 };
    expect(tiles.clearCell(cell)).toBe(false);
    tiles.paintSample(cell, 0, 0, 0, RED);
    expect(tiles.clearCell(cell)).toBe(true);
    expect(tiles.atSample(cell, 0, 0, 0)).toBeUndefined();
    expect(tiles.size).toBe(0);
  });

  it("adopts a tile without copying it, so a transfer costs nothing", () => {
    // A worker handing a painted chunk back transfers its array; a copy here would
    // quietly give the whole point up.
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    const colours = new Uint8Array(TILE_BYTES);
    colours[tileIndex(1, 1, 1) * 3] = 255;
    tiles.adoptTile(
      cell,
      makeTile(colours, {
        minX: 1,
        minY: 1,
        minZ: 1,
        maxX: 1,
        maxY: 1,
        maxZ: 1,
      }),
    );
    expect(tiles.tileAt(cell)?.colours).toBe(colours);
    expect(tiles.atSample(cell, 1, 1, 1)).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("bumps its revision on every change and only on changes", () => {
    const tiles = new PaintTiles();
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    const first = tiles.currentRevision;
    tiles.paintSample(cell, 0, 0, 0, RED);
    const second = tiles.currentRevision;
    expect(second).toBeGreaterThan(first);
    tiles.paintSample(cell, 0, 0, 0, RED);
    expect(tiles.currentRevision).toBe(second);
    tiles.paintSample(cell, 0, 0, 0, GREEN);
    expect(tiles.currentRevision).toBeGreaterThan(second);
  });

  it("empties, and stays empty", () => {
    const tiles = new PaintTiles();
    tiles.paintSample({ x: 0, y: 0, z: 0 }, 0, 0, 0, RED);
    tiles.paintSample({ x: 5, y: 0, z: 0 }, 0, 0, 0, GREEN);
    tiles.clear();
    expect(tiles.size).toBe(0);
    expect(tiles.paintedSamples).toBe(0);
    expect(tiles.atSample({ x: 0, y: 0, z: 0 }, 0, 0, 0)).toBeUndefined();
  });
});
