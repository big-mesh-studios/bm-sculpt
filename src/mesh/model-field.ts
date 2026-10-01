/**
 * Building a mesher from a model message, on the worker's side of the boundary.
 *
 * This is the code that makes `ModelMessage` mean something. Everything above it —
 * protocol, worker, pool — is plumbing that assumes this function exists and is honest
 * about what a worker can do; nothing else in the project can check that assumption,
 * because it is the one place where a description becomes a field.
 *
 * It lives in its own file rather than inside `worker.ts` for the same reason the worker
 * is a pure function: this is where the CSG and paint meet the thread boundary, and it
 * needs to be testable without a browser.
 *
 * The rule it exists to enforce: **the worker never reaches back to the main thread.**
 * It is handed a description and builds everything it needs from it, which is why the
 * description carries serialised operations and paint buffers rather than live objects.
 */

import type { Rgb8 } from "../constants";

import {
  Field,
  OperationBVH,
  deserialiseOperations,
  type PaintSource,
  type TerrainField,
  terrainField,
} from "../csg";
import { cellCentre, chunkCellOf, sampleIndexIn, tileIndex } from "../world";

import type { ChunkMesher } from "./chunk-mesher";
import { SurfaceNetsChunkMesher } from "./chunk-mesher";
import type { ModelMessage, PaintTileMessage } from "./protocol";

/**
 * Painted chunks, as the field reads them.
 *
 * A plain map, not a `CoordinateMap`: this is built once per model per worker and then
 * read a few hundred thousand times while meshing, and a string key costs one hash of
 * three short numbers against the coordinate map's integer mix. The trade only holds
 * because the map is small — a whole chunk's tile is 96 KiB, so a world with hundreds of
 * painted chunks is megabytes here, and a worker holds one copy.
 *
 * The alternative of rebuilding a `PaintTiles` and asking it is worse: it would mean
 * re-encoding the tile addressing twice, once here and once there, and the two would
 * drift.
 */
export type WorkerPaint = ReadonlyMap<string, Uint8Array>;

const cellKey = (cell: { x: number; y: number; z: number }): string =>
  `${cell.x},${cell.y},${cell.z}`;

/**
 * Reads painted colour at a world point, nearest sample.
 *
 * Built on the same addressing the main thread's `PaintTiles` uses — `chunkCellOf`,
 * `sampleIndexIn`, `tileIndex` — rather than on arithmetic repeated here. An earlier
 * version inlined the constants, which is precisely how two copies of a chunk's tile
 * layout drift apart: the copy keeps working, and disagrees.
 */
export class TilePaint implements PaintSource {
  constructor(private readonly tiles: WorkerPaint) {}

  at(x: number, y: number, z: number): Rgb8 | undefined {
    const cell = chunkCellOf({ x, y, z });
    const colours = this.tiles.get(cellKey(cell));
    if (colours === undefined) return undefined;

    const centre = cellCentre(cell);
    const sample = sampleIndexIn(x, centre.x);
    const at = tileIndex(
      sample,
      sampleIndexIn(y, centre.y),
      sampleIndexIn(z, centre.z),
    );
    const offset = at * 3;
    const r = colours[offset];
    const g = colours[offset + 1];
    const b = colours[offset + 2];
    // Black is the zero of a fresh tile, so an unpainted sample cannot be told from
    // painted black by reading it — the same convention `PaintTiles` uses, so the two
    // agree about where paint exists.
    if (r === 0 && g === 0 && b === 0) return undefined;
    return { r, g, b };
  }
}

/**
 * Builds a mesher for a model message.
 *
 * Returns a *new* mesher rather than reusing one, because the field it wraps is built
 * from the message and a message may carry a different model. A cached field would answer
 * from an operations list the main thread has already replaced, and nothing about the
 * resulting mesh would look wrong.
 */
export const mesherFor = (model: ModelMessage): ChunkMesher => {
  const operations = deserialiseOperations(model.operations);
  const terrain = terrainOf(model);
  const field = new Field(new OperationBVH(operations), {
    // One value in three slots, because a height field is all three at once: the distance
    // function, the region it can answer for, and the Lipschitz bound that makes its
    // distances safe to step by. Splitting them would allow a caller to send a terrain's
    // distances with another terrain's bound, and the symptom would be a picker that walks
    // through the ground.
    base: terrain,
    extent: terrain,
    lipschitz: terrain?.lipschitz,
    paint: new TilePaint(paintTilesOf(model.paint)),
  });
  return new SurfaceNetsChunkMesher(field);
};

/**
 * The terrain behind the operations, if the model has one.
 *
 * `undefined` for `"none"`, and a field built from the message's four parameters for
 * `"terrain"`. Deterministic in those parameters alone, which is the whole reason the
 * message carries numbers rather than something opaque: the main thread and every worker
 * build the same landscape from the same four numbers, so the picker and the mesher cannot
 * disagree about where the ground is (ADR 0009).
 *
 * A message that claims terrain and omits the parameters is refused rather than given a
 * default. A default would be a landscape nobody asked for, on every worker, discovered
 * wherever the camera happened to be looking.
 */
const terrainOf = (model: ModelMessage): TerrainField | undefined => {
  if (model.base === "none") return undefined;
  if (model.terrain === undefined) {
    throw new Error(
      `model says ${model.base} but carries no terrain parameters`,
    );
  }
  return terrainField(model.terrain);
};

/** The model's painted chunks, keyed for lookup. */
export const paintTilesOf = (
  paint: readonly PaintTileMessage[],
): WorkerPaint => {
  const tiles = new Map<string, Uint8Array>();
  for (const tile of paint) tiles.set(cellKey(tile.cell), tile.colours);
  return tiles;
};
