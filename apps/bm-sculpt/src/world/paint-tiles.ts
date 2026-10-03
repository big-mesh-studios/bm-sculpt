/**
 * Painted colour, held as sparse chunk tiles.
 *
 * This is the **only stored voxel data in the whole system** (ADR 0002). Everything
 * else — the shape of the model, its level of detail, its geometry — is computed.
 * Colour is here because arbitrary per-voxel colour has no smooth operation to
 * express, and painting is the one thing a user does that genuinely wants to be
 * arbitrary.
 *
 * **Tiles are keyed by absolute world chunk cell, never by slot.** Slots are a
 * recycled pool: one is freed when its cell leaves the window and claimed by a
 * different cell an instant later. A tile keyed by slot would therefore come back
 * holding a different chunk's paint — invisible while the user works in one place,
 * and lost entirely the moment they walk away and come back.
 *
 * That is what makes the window's own recycling safe. A chunk scrolled out and
 * scrolled back in finds its colour again without anything having been copied,
 * because the tile was never in the window's care.
 *
 * A tile is allocated whole, on the first write to a cell. A sparse structure inside
 * it would cost a hash and a probe in the mesher's innermost loop, once per surface
 * vertex, and paint is sparse only until the user paints a lot — at which point the
 * tile is mostly painted anyway.
 *
 * **Coordinates are sample indices within a cell**, not world units, because that is
 * what the brush and the mesher both hold and it removes an off-by-half-a-voxel class
 * of bug entirely. The world-space methods on top are conveniences for the picker.
 */

import type { Rgb8, Vec3 } from "@big-mesh-studios/core";
import { CHUNK_VOXELS } from "../constants";
import { PaintSource } from "@big-mesh-studios/csg";
import { CoordinateMap } from "./coordinate-map";
import {
  cellCentre,
  chunkCellOf,
  sampleIndexIn,
  type CellCoord,
} from "./level-data";

/** Colours one chunk tile holds. */
export const TILE_COLOURS = CHUNK_VOXELS * CHUNK_VOXELS * CHUNK_VOXELS;

/** Bytes one tile's colour buffer takes. */
export const TILE_BYTES = TILE_COLOURS * 3;

/** The index of a colour within a tile. */
export const tileIndex = (x: number, y: number, z: number): number =>
  (z * CHUNK_VOXELS + y) * CHUNK_VOXELS + x;

/** Whether sample indices name a sample inside a chunk. */
export const sampleInTile = (x: number, y: number, z: number): boolean =>
  x >= 0 &&
  x < CHUNK_VOXELS &&
  y >= 0 &&
  y < CHUNK_VOXELS &&
  z >= 0 &&
  z < CHUNK_VOXELS;

/** The box of a chunk that has been painted. `null` means none of it. */
export interface PaintedBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface Tile {
  colours: Uint8Array;
  /**
   * The smallest box of samples written to, so a tile can be stored as the part that
   * was painted rather than as a whole chunk of mostly nothing. Reported per write
   * rather than tracked with a counter per sample, because the counter would cost a
   * read-modify-write on the path that decides whether to report a change at all.
   */
  written: PaintedBox | null;
}

/** A tile with nothing in it. */
export const emptyTile = (): Tile => ({
  colours: new Uint8Array(TILE_BYTES),
  written: null,
});

/**
 * Builds a tile from a colour buffer it will own.
 *
 * Adopted rather than copied, so a worker can hand a painted chunk back by
 * transferring the array it built rather than cloning it.
 */
export const makeTile = (
  colours: Uint8Array,
  written: PaintedBox | null,
): Tile => ({
  colours,
  written,
});

export interface PaintTilesParams {
  /**
   * Told whenever a cell's colour actually changes, so its chunk can be rebuilt.
   *
   * Per cell rather than per sample: a stroke writes thousands of samples and wants
   * one rebuild, and a per-sample callback would either allocate a list per sample or
   * rebuild the chunk thousands of times.
   */
  onPainted?: (cell: CellCoord) => void;
}

export class PaintTiles implements PaintSource {
  private readonly tiles = new CoordinateMap<Tile>();
  /** Bumped on every change, so a chunk can tell whether its colour is current. */
  private revision = 0;
  private readonly params: PaintTilesParams;

  constructor(params: PaintTilesParams = {}) {
    this.params = params;
  }

  /** How many chunk tiles hold any paint. */
  get size(): number {
    return this.tiles.size;
  }

  /** How many samples a tile's painted box covers, over every tile. */
  get paintedSamples(): number {
    let count = 0;
    this.tiles.forEach((_x, _y, _z, tile) => {
      if (tile.written === null) return;
      const box = tile.written;
      count +=
        (box.maxX - box.minX + 1) *
        (box.maxY - box.minY + 1) *
        (box.maxZ - box.minZ + 1);
    });
    return count;
  }

  /** The current revision, which changes with every write. */
  get currentRevision(): number {
    return this.revision;
  }

  /**
   * The colour at a sample within a cell, or undefined where nothing is painted.
   *
   * The hot path: the mesher asks once per surface vertex, so this is a hash and up
   * to three array reads and nothing else. Everything expensive — allocating a tile,
   * growing a painted box — is behind the write.
   *
   * An out-of-range sample reads as unpainted rather than throwing. A vertex the
   * mesher interpolated slightly past a chunk's edge would otherwise take the whole
   * meshing pass down, and reading nothing is the same answer it would have got.
   */
  atSample(cell: CellCoord, x: number, y: number, z: number): Rgb8 | undefined {
    if (!sampleInTile(x, y, z)) return undefined;
    const tile = this.tiles.get(cell.x, cell.y, cell.z);
    if (tile === undefined) return undefined;
    const at = tileIndex(x, y, z) * 3;
    // Black is the zero of a fresh tile, so zero cannot be told from unpainted by
    // reading it. Painting true black therefore reports as unpainted. That is the
    // one colour this representation cannot hold, and it is cheaper than a presence
    // byte per sample — which would triple the tile.
    if (
      tile.colours[at] === 0 &&
      tile.colours[at + 1] === 0 &&
      tile.colours[at + 2] === 0
    ) {
      return undefined;
    }
    return {
      r: tile.colours[at],
      g: tile.colours[at + 1],
      b: tile.colours[at + 2],
    };
  }

  /**
   * Paints a sample within a cell, allocating the tile on the first write.
   *
   * Reports whether anything changed. A stroke passing over ground that is already
   * that colour must not mark the chunk dirty and rebuild its mesh for nothing, which
   * during a slow drag across a large flat area is most of the writes.
   */
  paintSample(
    cell: CellCoord,
    x: number,
    y: number,
    z: number,
    colour: Rgb8,
  ): boolean {
    if (!this.write(cell, x, y, z, colour)) return false;
    this.params.onPainted?.(cell);
    return true;
  }

  /**
   * Writes one sample, allocating the tile if needed, and reports whether anything
   * changed. Does not notify — see `paintSample` and `paintBox`, which decide the
   * notification because only they know how many samples a change came from.
   */
  private write(
    cell: CellCoord,
    x: number,
    y: number,
    z: number,
    colour: Rgb8,
  ): boolean {
    if (!sampleInTile(x, y, z)) return false;
    let tile = this.tiles.get(cell.x, cell.y, cell.z);
    if (tile === undefined) {
      tile = emptyTile();
      this.tiles.set(cell.x, cell.y, cell.z, tile);
    }
    const at = tileIndex(x, y, z) * 3;
    if (
      tile.colours[at] === colour.r &&
      tile.colours[at + 1] === colour.g &&
      tile.colours[at + 2] === colour.b
    ) {
      return false;
    }
    tile.colours[at] = colour.r;
    tile.colours[at + 1] = colour.g;
    tile.colours[at + 2] = colour.b;
    growWritten(tile, x, y, z);
    this.revision++;
    return true;
  }

  /**
   * Paints a box of samples within a cell, and names the cells it changed.
   *
   * A brush paints a box and a stroke moves that box, so the write path takes the
   * box rather than a point and the per-sample loop lives here rather than in the
   * brush.
   *
   * **Notifies once per cell rather than once per sample.** A brush a hundred samples
   * across writes ten thousand of them, and the caller's reaction is to rebuild a
   * chunk's mesh — so a per-sample notification would either allocate a set ten
   * thousand times or rebuild the same chunk ten thousand times. The single-sample
   * `paintSample` still notifies every time, because a caller that painted one sample
   * wants to hear about it.
   *
   * @returns whether anything changed. The cells are reported through the callback
   *   and through the return value's sibling, so a caller that wants to rebuild
   *   synchronously can use either.
   */
  paintBox(
    cell: CellCoord,
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
    colour: Rgb8,
  ): boolean {
    let changed = false;
    for (
      let z = Math.max(0, min.z);
      z <= Math.min(CHUNK_VOXELS - 1, max.z);
      z++
    ) {
      for (
        let y = Math.max(0, min.y);
        y <= Math.min(CHUNK_VOXELS - 1, max.y);
        y++
      ) {
        for (
          let x = Math.max(0, min.x);
          x <= Math.min(CHUNK_VOXELS - 1, max.x);
          x++
        ) {
          if (this.write(cell, x, y, z, colour)) changed = true;
        }
      }
    }
    if (changed) this.params.onPainted?.(cell);
    return changed;
  }

  /**
   * The colour nearest a world point, or undefined where nothing is painted.
   *
   * This is `PaintSource`, which the field reads it through — the same interface it
   * reads paint operations through, so the two compose without either knowing about
   * the other.
   *
   * Rounds to the nearest sample rather than flooring, because a surface point is
   * generally between samples and picking the nearer one is what a user means by
   * "the colour there".
   */
  at(x: number, y: number, z: number): Rgb8 | undefined {
    const cell = chunkCellOf({ x, y, z });
    const centre = cellCentre(cell);
    return this.atSample(
      cell,
      sampleIndexIn(x, centre.x),
      sampleIndexIn(y, centre.y),
      sampleIndexIn(z, centre.z),
    );
  }

  /** Paints the sample nearest a world point. */
  paintWorld(world: Vec3, colour: Rgb8): boolean {
    const cell = chunkCellOf(world);
    const centre = cellCentre(cell);
    return this.paintSample(
      cell,
      sampleIndexIn(world.x, centre.x),
      sampleIndexIn(world.y, centre.y),
      sampleIndexIn(world.z, centre.z),
      colour,
    );
  }

  /** Forgets a chunk's paint entirely. */
  clearCell(cell: CellCoord): boolean {
    const removed = this.tiles.delete(cell.x, cell.y, cell.z);
    if (removed) this.revision++;
    return removed;
  }

  /** Forgets everything. */
  clear(): void {
    if (this.tiles.size === 0) return;
    this.tiles.clear();
    this.revision++;
  }

  /** The tile for a cell, for serialisation and for a worker transfer. */
  tileAt(cell: CellCoord): Tile | undefined {
    return this.tiles.get(cell.x, cell.y, cell.z);
  }

  /** Every cell holding paint, for serialisation. */
  paintedCells(): CellCoord[] {
    const out: CellCoord[] = [];
    this.tiles.forEach((x, y, z, _tile) => out.push({ x, y, z }));
    return out;
  }

  /**
   * Replaces a chunk's tile wholesale, for a load or a worker result.
   *
   * Adopted by reference rather than copied: the array is transferred rather than
   * cloned, so a worker can hand a painted chunk back without a copy of its colour.
   */
  adoptTile(cell: CellCoord, tile: Tile): void {
    this.tiles.set(cell.x, cell.y, cell.z, tile);
    this.revision++;
  }
}

const growWritten = (tile: Tile, x: number, y: number, z: number): void => {
  if (tile.written === null) {
    tile.written = { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
    return;
  }
  const box = tile.written;
  if (x < box.minX) box.minX = x;
  if (y < box.minY) box.minY = y;
  if (z < box.minZ) box.minZ = z;
  if (x > box.maxX) box.maxX = x;
  if (y > box.maxY) box.maxY = y;
  if (z > box.maxZ) box.maxZ = z;
};
