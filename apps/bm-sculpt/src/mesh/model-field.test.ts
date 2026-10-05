import { describe, expect, it } from "vitest";

import { makeOperation, serialiseOperations } from "@big-mesh-studios/csg";
import type {
  BaseFieldSpec,
  Operation,
  TerrainParams,
} from "@big-mesh-studios/csg";
import { BLOCK_WORLD, CHUNK_VOXELS } from "../constants";
import { type CellCoord, cellCentre, tileIndex, TILE_COLOURS } from "../world";

import { meshersFor, paintTilesOf, TilePaint } from "./model-field";
import { emptyWorkerState, handleMeshMessage } from "./worker";
import { meshTransferables, type ModelMessage } from "./protocol";
import { runWorker } from "./mesh-worker";
import { surfaceNets } from "@big-mesh-studios/meshing";
import { scratchFor } from "@big-mesh-studios/meshing";
import { ChunkMeshBuilder } from "@big-mesh-studios/meshing";

const cell = (x: number, y = 0, z = 0): CellCoord => ({ x, y, z });

/** The three arguments `PaintSource.at` takes, from a point. */
const sampleOf = (point: {
  x: number;
  y: number;
  z: number;
}): [number, number, number] => [point.x, point.y, point.z];

const model = (
  operations: readonly Operation[],
  paint: ModelMessage["paint"] = [],
): ModelMessage => ({
  kind: "setModel",
  revision: 1,
  operations: serialiseOperations(operations),
  paint,
  base: undefined,
});

/** A base field spec for a landscape, as `ModelMessage` now carries it. */
const terrainBase = (params: TerrainParams): BaseFieldSpec => ({
  kind: "terrain",
  params,
});

/**
 * One sphere, in the chunk at the origin. An ellipsoid is a sphere when its radii agree.
 *
 * The operation index is the operation's own number in the list, not an identifier: the
 * field folds in index order and `applyOperation` uses it to pick between the two
 * incoming values at every step.
 */
const aSphere = (radius: number): Operation =>
  makeOperation(
    0,
    { x: 0, y: 0, z: 0 },
    { type: "Ellipsoid", radius: { x: radius, y: radius, z: radius } },
    "Add",
    { colour: { r: 200, g: 180, b: 160 } },
  );

const aTile = (
  cellHere: CellCoord,
  colour: { r: number; g: number; b: number },
): ModelMessage["paint"][number] => {
  const colours = new Uint8Array(TILE_COLOURS * 3);
  const at = tileIndex(4, 5, 6) * 3;
  colours[at] = colour.r;
  colours[at + 1] = colour.g;
  colours[at + 2] = colour.b;
  return { cell: cellHere, colours };
};

describe("building the meshers from a model message", () => {
  it("reads operations back out of the serialised form", () => {
    // The whole point of the description: what the main thread sends has to become a
    // field the worker can sample. A round trip that loses an operation would mesh a
    // model nobody asked for.
    const operations = [aSphere(45)];
    const mesh = meshersFor(model(operations)).ground.mesh({
      cell: cell(0),
      lod: 0,
    });
    expect(mesh.vertexCount).toBeGreaterThan(0);
  });

  it("gives the same mesh as the operations it was sent", () => {
    // The worker and the main thread must agree about the model, or two chunks meshed on
    // different sides of the thread boundary would not fit together.
    const operations = [aSphere(45)];
    const fromMessage = meshersFor(model(operations)).ground.mesh({
      cell: cell(0),
      lod: 0,
    });

    // The same field built directly, which is what the main thread has.
    const builder = new ChunkMeshBuilder();
    surfaceNets({
      origin: [-BLOCK_WORLD / 2, -BLOCK_WORLD / 2, -BLOCK_WORLD / 2],
      samples: CHUNK_VOXELS,
      sampleSize: 10,
      sampler: { distance: (x, y, z) => Math.hypot(x, y, z) - 45 },
      out: builder,
      scratch: scratchFor(CHUNK_VOXELS),
    });
    const direct = builder.finish();

    expect(fromMessage.vertexCount).toBe(direct.vertexCount);
    expect([...fromMessage.indices]).toEqual([...direct.indices]);
  });

  it("refuses a base field kind it does not know", () => {
    // Failing loudly costs one message and says why. A default landscape would be one
    // nobody asked for, on every worker, discovered wherever the camera happened to be
    // pointing — which is the worst of both: it costs a session and explains nothing.
    //
    // **Unreachable through the type**, which is the point of the union: `base` carries its own
    // parameters, so a message cannot name a planet and arrive holding a landscape's four numbers.
    // The runtime check is for a *third* kind added on one side of the thread boundary, which is
    // exactly the case the type cannot see.
    expect(() =>
      meshersFor({ ...model([]), base: { kind: "moon", params: {} } } as never),
    ).toThrow(/unknown base field/);
  });

  it("gives a model that says which terrain the same landscape twice", () => {
    // The property the four parameters exist for: the main thread and every worker build
    // their field independently, from numbers, and have to arrive at the same one. Anything
    // that made the terrain depend on call order or on a shared cache would break the
    // agreement the picker and the mesher rely on (ADR 0009).
    const withTerrain = {
      ...model([aSphere(45)]),
      base: terrainBase({ origin: -70, scale: 96, octaves: 4, seed: 7 }),
    };
    const first = meshersFor(withTerrain).ground.mesh({
      cell: cell(0),
      lod: 0,
    });
    const second = meshersFor(withTerrain).ground.mesh({
      cell: cell(0),
      lod: 0,
    });

    expect(first.vertexCount).toBeGreaterThan(0);
    expect([...second.indices]).toEqual([...first.indices]);
  });

  it("gives a different seed a different landscape", () => {
    // Otherwise the seed is decoration. Asserted on the mesh rather than on the noise,
    // because the mesh is what anyone can see.
    const terrain = { origin: -70, scale: 96, octaves: 4 };
    const one = meshersFor({
      ...model([]),
      base: terrainBase({ ...terrain, seed: 1 }),
    }).ground.mesh({ cell: cell(0), lod: 0 });
    const two = meshersFor({
      ...model([]),
      base: terrainBase({ ...terrain, seed: 2 }),
    }).ground.mesh({ cell: cell(0), lod: 0 });

    expect(one.vertexCount).toBeGreaterThan(0);
    expect(two.vertexCount).toBeGreaterThan(0);
    expect([...one.indices]).not.toEqual([...two.indices]);
  });

  it("produces nothing for a model with no operations", () => {
    expect(
      meshersFor(model([])).ground.mesh({ cell: cell(0), lod: 0 }).vertexCount,
    ).toBe(0);
  });

  it("gives a different model a different field, not a cached one", () => {
    // A cached field would answer from an operations list the main thread has replaced,
    // and the resulting mesh would not look wrong.
    const withSphere = meshersFor(model([aSphere(45)]));
    expect(
      withSphere.ground.mesh({ cell: cell(0), lod: 0 }).vertexCount,
    ).toBeGreaterThan(0);

    const emptied = meshersFor({
      ...model([aSphere(45)]),
      revision: 2,
      operations: serialiseOperations([]),
    });
    expect(emptied.ground.mesh({ cell: cell(0), lod: 0 }).vertexCount).toBe(0);
  });
});

describe("reading paint inside a worker", () => {
  it("finds a painted sample by world position", () => {
    const tile = aTile(cell(0), { r: 12, g: 34, b: 56 });
    const paint = new TilePaint(paintTilesOf([tile]));

    // The same point, reached through the world's own addressing.
    const centre = cellCentre(cell(0));
    const x = centre.x + (4 - CHUNK_VOXELS / 2) * 10;
    const y = centre.y + (5 - CHUNK_VOXELS / 2) * 10;
    const z = centre.z + (6 - CHUNK_VOXELS / 2) * 10;
    expect(paint.at(x, y, z)).toEqual({ r: 12, g: 34, b: 56 });
  });

  it("reports no paint where none was painted", () => {
    const paint = new TilePaint(
      paintTilesOf([aTile(cell(0), { r: 12, g: 34, b: 56 })]),
    );
    expect(paint.at(-BLOCK_WORLD, 0, 0)).toBeUndefined();
  });

  it("treats pure black as unpainted, as the main thread does", () => {
    // Black is the zero of a fresh tile, so the two sides must agree about it or a
    // chunk's colour would depend on which thread meshed it.
    const paint = new TilePaint(
      paintTilesOf([aTile(cell(0), { r: 0, g: 0, b: 0 })]),
    );
    const centre = cellCentre(cell(0));
    expect(
      paint.at(
        centre.x + (4 - CHUNK_VOXELS / 2) * 10,
        centre.y + (5 - CHUNK_VOXELS / 2) * 10,
        centre.z + (6 - CHUNK_VOXELS / 2) * 10,
      ),
    ).toBeUndefined();
  });

  it("does not read a neighbouring chunk's tile", () => {
    // A tile keyed by anything but the cell would hand one chunk's colour to another.
    const paint = new TilePaint(
      paintTilesOf([aTile(cell(1), { r: 9, g: 9, b: 9 })]),
    );
    const other = cellCentre(cell(0));
    const mine = cellCentre(cell(1));
    const sampleAt = (centre: { x: number; y: number; z: number }) => ({
      x: centre.x + (4 - CHUNK_VOXELS / 2) * 10,
      y: centre.y + (5 - CHUNK_VOXELS / 2) * 10,
      z: centre.z + (6 - CHUNK_VOXELS / 2) * 10,
    });
    expect(paint.at(...sampleOf(sampleAt(other)))).toBeUndefined();
    expect(paint.at(...sampleOf(sampleAt(mine)))).toEqual({ r: 9, g: 9, b: 9 });
  });

  it("is empty when the model carries no paint", () => {
    expect(paintTilesOf([]).size).toBe(0);
  });
});

describe("a worker end to end, against a fake scope", () => {
  /** A scope that records what was posted and lets a test feed messages in. */
  const scope = () => {
    const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
    let deliver: ((data: unknown) => void) | undefined;
    return {
      posted,
      postMessage: (message: unknown, transfer?: Transferable[]) => {
        posted.push({ message, transfer });
      },
      addEventListener: (
        _type: string,
        listener: (event: { data: unknown }) => void,
      ) => {
        deliver = (data: unknown) => listener({ data });
      },
      send: (message: unknown) => {
        if (deliver === undefined) throw new Error("nothing is listening");
        deliver(message);
      },
    };
  };

  it("answers a request for a chunk with a mesh", () => {
    const fake = scope();
    runWorker(fake);

    fake.send(model([aSphere(45)]));
    fake.send({ kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 });

    expect(fake.posted).toHaveLength(1);
    const reply = fake.posted[0].message as { kind: string; empty: boolean };
    expect(reply.kind).toBe("meshReady");
    expect(reply.empty).toBe(false);
  });

  it("transfers the mesh's buffers rather than cloning them", () => {
    // Cloned instead of transferred would not throw; it would cost a copy per chunk for
    // the rest of the session.
    const fake = scope();
    runWorker(fake);

    fake.send(model([aSphere(45)]));
    fake.send({ kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 });

    expect(fake.posted[0].transfer).toHaveLength(4);
  });

  it("posts no buffers for an air chunk", () => {
    const fake = scope();
    runWorker(fake);

    fake.send(model([]));
    fake.send({ kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 });

    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0].transfer).toEqual([]);
    expect(fake.posted[0].message).toMatchObject({ empty: true });
  });

  it("declines a request that arrives before the model", () => {
    // Not silently: the pool is holding a slot for this generation and only an answer
    // releases it, so a decline has to be posted back even when nothing is wrong.
    const fake = scope();
    runWorker(fake);
    fake.send({ kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 });
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0].message).toMatchObject({
      kind: "meshCancelled",
      reason: "no model",
    });
    // A decline carries no buffers, so nothing is transferred for it.
    expect(fake.posted[0].transfer).toEqual([]);
  });

  it("declines work the main thread has abandoned", () => {
    const fake = scope();
    runWorker(fake);
    fake.send(model([aSphere(45)]));
    fake.send({ kind: "cancel", belowGeneration: 3 });
    fake.send({ kind: "meshChunk", cell: cell(0), lod: 0, generation: 2 });
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0].message).toMatchObject({
      kind: "meshCancelled",
      reason: "cancelled",
    });
  });

  it("reports a bad model rather than dying", () => {
    // A worker that throws is a worker the main thread's request waits on forever.
    const fake = scope();
    runWorker(fake);
    fake.send({
      ...model([aSphere(45)]),
      base: { kind: "moon", params: {} } as never,
    });
    fake.send({ kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 });

    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0].message).toMatchObject({ kind: "meshFailed" });
  });

  it("keeps its state across messages", () => {
    const fake = scope();
    runWorker(fake);
    fake.send(model([aSphere(45)]));

    fake.send({ kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 });
    fake.send({ kind: "meshChunk", cell: cell(1), lod: 0, generation: 2 });
    expect(fake.posted).toHaveLength(2);
    expect(
      fake.posted.every(
        (entry) => (entry.message as { kind: string }).kind === "meshReady",
      ),
    ).toBe(true);
  });

  it("refuses a second chunk while one is in flight", () => {
    // The pool sends one at a time, so this is the belt to the pool's braces. It cannot
    // be produced by a synchronous fake, so it is asserted at the state level.
    const factory = () => meshersFor(model([aSphere(45)]));
    let state = handleMeshMessage(
      emptyWorkerState(),
      model([aSphere(45)]),
      factory,
    ).state;
    state = { ...state, pending: { cell: cell(0), lod: 0, generation: 1 } };
    expect(
      handleMeshMessage(
        state,
        { kind: "meshChunk", cell: cell(1), lod: 0, generation: 2 },
        factory,
      ).reply,
    ).toMatchObject({ kind: "meshCancelled", reason: "busy" });
  });
});

describe("the transfer list", () => {
  it("lists the buffers a worker would post", () => {
    // The pool sends the buffers and the worker lists them. If the two disagreed the
    // mesh would be cloned instead — silently, and once per chunk, for the rest of the
    // session.
    const mesh = meshersFor(model([aSphere(45)])).ground.mesh({
      cell: cell(0),
      lod: 0,
    });
    const list = meshTransferables({
      kind: "meshReady",
      cell: cell(0),
      lod: 0,
      generation: 1,
      ground: mesh,
      empty: mesh.vertexCount === 0,
    });
    expect(list).toHaveLength(4);
    expect(list).toContain(mesh.positions.buffer);
    expect(list).toContain(mesh.indices.buffer);
  });
});
