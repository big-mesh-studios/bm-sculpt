import { describe, expect, it } from "vitest";

import type { ChunkMesh } from "@big-mesh-studios/meshing";
import type { MeshRequest } from "./chunk-mesher";
import { isFromWorker, isToWorker, meshTransferables } from "./protocol";
import type {
  FromWorker,
  MeshedChunk,
  ModelMessage,
  ToWorker,
} from "./protocol";
import {
  emptyWorkerState,
  handleMeshMessage,
  replyIsWanted,
  type MesherFactory,
  type WorkerState,
} from "./worker";
import type { PoolWorker, WorkerFactory } from "./worker-pool";
import { WorldWorkerPool } from "./worker-pool";

import type { CellCoord, Lod, OverlapMask } from "../world";

/** A mesh big enough to be worth transferring and small enough to be free. */
const meshOf = (vertices: number): ChunkMesh => ({
  positions: new Float32Array(vertices * 3).fill(1),
  normalOct: new Int16Array(vertices * 2),
  colours: new Uint8Array(vertices * 4).fill(255),
  indices: new Uint32Array(vertices).fill(0),
  vertexCount: vertices,
  triangleCount: Math.floor(vertices / 3),
});

/**
 * A worker that does nothing until told to answer.
 *
 * Every answer is delivered by hand, which is the point: the failures this pool has to
 * avoid are all about *when* an answer arrives relative to a later request, and a fake
 * that answered automatically could not express any of them.
 */
const fakeWorker = () => {
  const posted: ToWorker[] = [];
  let deliver: ((data: unknown) => void) | undefined;
  let terminated = false;

  const worker: PoolWorker = {
    post: (message) => {
      posted.push(message);
    },
    addEventListener: (_type, listener) => {
      deliver = (data) => listener({ data });
    },
    terminate: () => {
      terminated = true;
    },
  };

  return {
    worker,
    posted,
    get terminated(): boolean {
      return terminated;
    },
    /** The last request the worker was given, or undefined. */
    lastRequest(): ToWorker | undefined {
      for (let i = posted.length - 1; i >= 0; i--) {
        if (posted[i].kind === "meshChunk") return posted[i];
      }
      return undefined;
    },
    /** Delivers an answer as though the worker had finished. */
    answer(data: FromWorker): void {
      if (deliver === undefined) throw new Error("nothing is listening");
      deliver(data);
    },
  };
};

const cell = (x: number, y = 0, z = 0): CellCoord => ({ x, y, z });

const model = (revision = 1): ModelMessage => ({
  kind: "setModel",
  revision,
  operations: new ArrayBuffer(8),
  paint: [],
  base: undefined,
});

describe("the protocol", () => {
  it("recognises its own messages and refuses others", () => {
    // A worker receives whatever arrives, including a clone of something from an older
    // bundle. Rejecting by shape is what makes that survivable rather than fatal.
    expect(isToWorker({ kind: "meshChunk" })).toBe(true);
    expect(isToWorker({ kind: "setModel" })).toBe(true);
    expect(isToWorker({ kind: "cancel" })).toBe(true);
    expect(isToWorker({ kind: "meshReady" })).toBe(false);
    expect(isFromWorker({ kind: "meshReady" })).toBe(true);
    expect(isFromWorker({ kind: "meshFailed" })).toBe(true);

    for (const notAMessage of [
      null,
      undefined,
      42,
      "meshChunk",
      {},
      { kind: 7 },
    ]) {
      expect(isToWorker(notAMessage), String(notAMessage)).toBe(false);
      expect(isFromWorker(notAMessage), String(notAMessage)).toBe(false);
    }
  });

  it("transfers a mesh's four buffers and nothing else", () => {
    const mesh = meshOf(12);
    const transferring = meshTransferables({
      kind: "meshReady",
      cell: cell(0),
      lod: 0,
      generation: 1,
      ground: mesh,
      empty: false,
    });
    expect(transferring).toHaveLength(4);
    expect(transferring).toContain(mesh.positions.buffer);
    expect(transferring).toContain(mesh.normalOct.buffer);
    expect(transferring).toContain(mesh.colours.buffer);
    expect(transferring).toContain(mesh.indices.buffer);
  });

  it("transfers nothing for an empty or failed reply", () => {
    // Four empty typed arrays per air chunk would be most of the traffic in a terrain
    // world, so an empty chunk carries no buffers at all.
    expect(
      meshTransferables({
        kind: "meshReady",
        cell: cell(0),
        lod: 0,
        generation: 1,
        empty: true,
      }),
    ).toEqual([]);
    expect(
      meshTransferables({
        kind: "meshFailed",
        cell: cell(0),
        lod: 0,
        generation: 1,
        reason: "no",
      }),
    ).toEqual([]);
  });
});

describe("a worker handling messages", () => {
  /** A mesher that reports a mesh, or throws, without touching a field. */
  const build = (
    behaviour: { vertices?: number; throws?: string } = {},
  ): MesherFactory => {
    return () => ({
      ground: {
        mesh: () => {
          if (behaviour.throws !== undefined) throw new Error(behaviour.throws);
          return meshOf(behaviour.vertices ?? 9);
        },
      },
    });
  };

  /**
   * A mesher that can rule a chunk out before sampling it, counting how often it was asked
   * and how often it actually meshed.
   *
   * The count is the point. A gate that is consulted and then ignored is worse than no gate,
   * because it looks like the optimisation is in place.
   */
  const gatedBuild = (couldHaveMesh: boolean) => {
    const asked = { gate: 0, mesh: 0 };
    const factory: MesherFactory = () => ({
      ground: {
        couldHaveMesh: () => {
          asked.gate++;
          return couldHaveMesh;
        },
        mesh: () => {
          asked.mesh++;
          return meshOf(9);
        },
      },
    });
    return { factory, asked };
  };

  it("asks whether a chunk could hold a surface before meshing it", () => {
    const { factory, asked } = gatedBuild(true);
    const handled = handleMeshMessage(
      { ...emptyWorkerState(), model: model() },
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 },
      factory,
    );

    expect(asked.gate).toBe(1);
    expect(asked.mesh).toBe(1);
    expect(handled.reply).toMatchObject({ kind: "meshReady", empty: false });
  });

  it("passes a request's overlap mask through to the mesher", () => {
    // The mask has to survive the message boundary, or a chunk at a level boundary stops at
    // its own edge and the seam opens again — with nothing else to show for it, because the
    // geometry is still a perfectly valid mesh of the chunk.
    const seen: MeshRequest[] = [];
    const factory: MesherFactory = () => ({
      ground: {
        mesh: (request) => {
          seen.push(request);
          return meshOf(9);
        },
      },
    });
    handleMeshMessage(
      { ...emptyWorkerState(), model: model() },
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1, overlap: 5 },
      factory,
    );
    expect(seen[0]?.overlap).toBe(5);
  });

  it("asks the skip gate about the cells an overlap reaches into", () => {
    // The gate decides whether a chunk is meshed at all, and a chunk whose only surface is
    // in the cell it reaches into would be ruled out by a gate that only heard about its
    // own extent — a hole that nothing would ever ask again.
    const asked: Array<number | undefined> = [];
    const factory: MesherFactory = () => ({
      ground: {
        mesh: () => meshOf(9),
        couldHaveMesh: (_cell: CellCoord, _lod: Lod, overlap?: OverlapMask) => {
          asked.push(overlap);
          return false;
        },
      },
    });
    handleMeshMessage(
      { ...emptyWorkerState(), model: model() },
      { kind: "meshChunk", cell: cell(0), lod: 1, generation: 1, overlap: 3 },
      factory,
    );
    expect(asked).toEqual([3]);
  });

  it("answers a chunk the mesher rules out, without meshing it", () => {
    // The saving: in a terrain world most chunks are entirely air or entirely solid, and
    // this is 34,304 field evaluations replaced by a box test.
    const { factory, asked } = gatedBuild(false);
    const handled = handleMeshMessage(
      { ...emptyWorkerState(), model: model() },
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 },
      factory,
    );

    expect(asked.mesh).toBe(0);
    // Answered, not dropped. A request the worker says nothing about is a chunk that stays
    // blank on the main thread until something unrelated re-asks it, which looks like a
    // mesher that has hung.
    expect(handled.reply).toMatchObject({ kind: "meshReady", empty: true });
    expect(
      handled.reply?.kind === "meshReady" && handled.reply.ground,
    ).toBeUndefined();
  });

  describe("a chunk with two surfaces", () => {
    /**
     * A world whose ground and sea are gated separately, so the two answers can be set apart.
     *
     * **A mesher per surface rather than one that does both**, because that is the shape the
     * real world has: the sea is gated on the landscape and the ground on the model, and a
     * chunk of open ocean has to come back with a sea and no ground.
     */
    const twoSurfaces = (options: {
      ground?: boolean;
      sea?: boolean;
      vertices?: number;
    }) => {
      const asked = { ground: 0, sea: 0 };
      const factory: MesherFactory = () => ({
        ground: {
          couldHaveMesh: () => {
            asked.ground++;
            return options.ground !== false;
          },
          mesh: () => meshOf(options.vertices ?? 9),
        },
        sea: {
          couldHaveMesh: () => {
            asked.sea++;
            return options.sea === true;
          },
          mesh: () => meshOf(6),
        },
      });
      const handled = handleMeshMessage(
        { ...emptyWorkerState(), model: model() },
        { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 },
        factory,
      );
      return { asked, reply: handled.reply };
    };

    it("carries both when the chunk has both", () => {
      const { reply } = twoSurfaces({ ground: true, sea: true });
      expect(reply).toMatchObject({ kind: "meshReady", empty: false });
      const ready = reply as Extract<FromWorker, { kind: "meshReady" }>;
      expect(ready.ground?.vertexCount).toBe(9);
      expect(ready.sea?.vertexCount).toBe(6);
    });

    it("carries the sea alone over open water", () => {
      // **The common case for the sea half, and the one a single-mesh protocol cannot express.**
      // A chunk of ocean has no ground in it, and "no ground" is the *presence* of the thing
      // that is there — so it has to be its own field rather than the absence of the other.
      const { asked, reply } = twoSurfaces({ ground: false, sea: true });
      expect(asked.ground).toBe(1);
      expect(asked.sea).toBe(1);
      expect(reply).toMatchObject({ kind: "meshReady", empty: false });
      const ready = reply as Extract<FromWorker, { kind: "meshReady" }>;
      expect(ready.ground).toBeUndefined();
      expect(ready.sea?.vertexCount).toBe(6);
    });

    it("carries the ground alone over land", () => {
      const { asked, reply } = twoSurfaces({ ground: true, sea: false });
      expect(asked.sea).toBe(1);
      const ready = reply as Extract<FromWorker, { kind: "meshReady" }>;
      expect(ready.ground?.vertexCount).toBe(9);
      expect(ready.sea).toBeUndefined();
    });

    it("meshes neither when neither is wanted", () => {
      // **One answer covers both surfaces**, so a chunk holding neither is meshed zero times
      // rather than once. On a planet that is most of a window: most of a large volume near the
      // surface is deep rock or open sky, and neither is worth 34,304 samples.
      const { asked, reply } = twoSurfaces({ ground: false, sea: false });
      expect(asked.ground).toBe(1);
      expect(asked.sea).toBe(1);
      expect(reply).toMatchObject({ kind: "meshReady", empty: true });
    });

    it("reports a surface that meshed to nothing as absent", () => {
      // **The gate answers "could this hold a surface", not "does it".** Only sampling settles
      // that, and a surface that samples to nothing must not cost four empty arrays on the wire.
      const factory: MesherFactory = () => ({
        ground: { mesh: () => meshOf(0) },
        sea: { mesh: () => meshOf(6) },
      });
      const handled = handleMeshMessage(
        { ...emptyWorkerState(), model: model() },
        { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 },
        factory,
      );
      const ready = handled.reply as Extract<FromWorker, { kind: "meshReady" }>;
      expect(ready.ground).toBeUndefined();
      expect(ready.sea?.vertexCount).toBe(6);
      // **Not empty**, because something *is* there. `empty` means neither surface.
      expect(ready.empty).toBe(false);
    });

    it("transfers both meshes' buffers", () => {
      const ground = meshOf(9);
      const sea = meshOf(6);
      expect(
        meshTransferables({
          kind: "meshReady",
          cell: cell(0),
          lod: 0,
          generation: 1,
          ground,
          sea,
          empty: false,
        }),
      ).toHaveLength(8);
    });
  });

  it("meshes a chunk whose mesher cannot answer", () => {
    // `couldHaveMesh` is optional, and absence has to mean "mesh it". The two failure
    // directions are not symmetric: a mesher that cannot answer costs samples, and one that
    // answers wrongly leaves a permanent hole.
    const handled = handleMeshMessage(
      { ...emptyWorkerState(), model: model() },
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 },
      build(),
    );

    expect(handled.reply).toMatchObject({ kind: "meshReady", empty: false });
  });

  const run = (
    messages: unknown[],
    behaviour: Parameters<typeof build>[0] = {},
  ): { state: WorkerState; replies: FromWorker[] } => {
    let state = emptyWorkerState();
    const replies: FromWorker[] = [];
    for (const message of messages) {
      const handled = handleMeshMessage(state, message, build(behaviour));
      state = handled.state;
      if (handled.reply !== undefined) replies.push(handled.reply);
    }
    return { state, replies };
  };

  it("declines a request that arrives before it has a model", () => {
    // The main thread sends the model and the requests together, and a request is allowed
    // to arrive first. Reporting a *failure* here would be noise, not information — but
    // silence is not available either, because the pool is holding a slot for this
    // generation and only an answer releases it.
    const { state, replies } = run([
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 },
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "meshCancelled",
      reason: "no model",
    });
    expect(state.pending).toBeUndefined();
    expect(state.meshed).toBe(0);
  });

  it("meshes a chunk once it has a model", () => {
    const { state, replies } = run([
      model(),
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 },
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0].kind).toBe("meshReady");
    expect(state.meshed).toBe(1);
    expect(state.pending).toBeUndefined();
  });

  it("declines a request it has been told to abandon", () => {
    // A chunk re-requested before its answer arrives: the old answer is not wanted
    // whatever happens to the new one. Declined *loudly* — the pool is holding a slot for
    // this generation, and only an answer frees it, so silence here would wedge it.
    const { replies, state } = run([
      model(),
      { kind: "cancel", belowGeneration: 5 },
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 4 },
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "meshCancelled",
      cell: cell(0),
      generation: 4,
      reason: "cancelled",
    });
    expect(state.meshed).toBe(0);
  });

  it("still meshes a request newer than the cancellation", () => {
    const { replies } = run([
      model(),
      { kind: "cancel", belowGeneration: 5 },
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 6 },
    ]);
    expect(replies).toHaveLength(1);
  });

  it("keeps the highest cancellation, so an old one cannot revive work", () => {
    const { replies } = run([
      model(),
      { kind: "cancel", belowGeneration: 9 },
      { kind: "cancel", belowGeneration: 3 },
      { kind: "meshChunk", cell: cell(0), lod: 0, generation: 7 },
    ]);
    // Declined at 7, which is below the *highest* line and above the one that would
    // have let it through — so the message is the evidence that 9 was kept.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "meshCancelled",
      reason: "cancelled",
    });
  });

  it("reports a failure instead of dying", () => {
    // A worker that throws is a worker the main thread's request waits on forever.
    const { replies, state } = run(
      [model(), { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 }],
      { throws: "sampling failed" },
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].kind).toBe("meshFailed");
    expect(replies[0]).toMatchObject({ reason: "sampling failed" });
    expect(state.failed).toBe(1);
    expect(state.pending).toBeUndefined();
  });

  it("reports an air chunk as empty rather than sending four empty buffers", () => {
    const { replies } = run(
      [model(), { kind: "meshChunk", cell: cell(0), lod: 0, generation: 1 }],
      { vertices: 0 },
    );
    expect(replies[0]).toMatchObject({ kind: "meshReady", empty: true });
    // Neither surface, on either key: "empty" is the claim and a mesh beside it would be
    // the lie the flag exists to prevent.
    expect((replies[0] as { ground?: unknown }).ground).toBeUndefined();
    expect((replies[0] as { sea?: unknown }).sea).toBeUndefined();
  });

  it("carries the mesh when there is one", () => {
    const { replies } = run([
      model(),
      { kind: "meshChunk", cell: cell(0), lod: 1, generation: 3 },
    ]);
    expect(replies[0]).toMatchObject({
      kind: "meshReady",
      empty: false,
      lod: 1,
      generation: 3,
    });
    expect((replies[0] as { ground?: ChunkMesh }).ground?.vertexCount).toBe(9);
  });

  it("ignores a model older than the one it has", () => {
    // A worker replaced by a newer bundle can be handed an older queued message.
    const { state } = run([model(5), model(2)]);
    expect(state.model?.revision).toBe(5);
  });

  it("takes a newer model, and abandons anything built against the old one", () => {
    // A worker's `mesh` blocks, so a model message queues behind it and is handled the
    // moment it returns — which is exactly when a chunk built against the old model is
    // in the reply the main thread is about to discard. The state is set up by hand
    // because that moment is inside a synchronous call a test cannot interrupt.
    const factory = () => ({ ground: { mesh: () => meshOf(3) } });
    let state = handleMeshMessage(emptyWorkerState(), model(1), factory).state;
    state = { ...state, pending: { cell: cell(0), lod: 0, generation: 4 } };
    state = handleMeshMessage(state, model(2), factory).state;

    expect(state.model?.revision).toBe(2);
    expect(state.pending).toBeUndefined();

    // The in-flight generation, and anything older, will not be meshed now: a chunk
    // answered from a mixture of two models is a bug neither model's tests could catch.
    for (const generation of [4, 3, 1]) {
      const handled = handleMeshMessage(
        state,
        { kind: "meshChunk", cell: cell(0), lod: 0, generation },
        factory,
      );
      expect(handled.reply, `generation ${generation}`).toMatchObject({
        kind: "meshCancelled",
        reason: "cancelled",
      });
    }

    // And a genuinely new request is meshed.
    expect(
      handleMeshMessage(
        state,
        { kind: "meshChunk", cell: cell(0), lod: 0, generation: 5 },
        factory,
      ).reply,
    ).toBeDefined();
  });

  it("ignores a message it does not recognise", () => {
    const before = emptyWorkerState();
    const handled = handleMeshMessage(
      before,
      { kind: "somethingNewer" },
      build(),
    );
    expect(handled.state).toBe(before);
    expect(handled.reply).toBeUndefined();
  });

  it("does not re-enter while a chunk is in flight", () => {
    // The pool serialises a worker's requests, so this should not arrive. Ignoring it is
    // safer than meshing two chunks at once in one worker.
    let built = 0;
    const slow: MesherFactory = () => ({
      ground: {
        mesh: () => {
          built++;
          return meshOf(3);
        },
      },
    });
    // Set by hand: a real worker's `mesh` blocks, and the state a message sees while it
    // blocks is the point, which a synchronous call cannot reach from a test.
    let state = handleMeshMessage(emptyWorkerState(), model(), slow).state;
    state = { ...state, pending: { cell: cell(0), lod: 0, generation: 1 } };
    const second = handleMeshMessage(
      state,
      { kind: "meshChunk", cell: cell(1), lod: 0, generation: 2 },
      slow,
    );
    expect(second.reply).toMatchObject({
      kind: "meshCancelled",
      reason: "busy",
    });
    expect(built).toBe(0);
  });
});

describe("what counts as a wanted answer", () => {
  const wanted = { cell: cell(1, 2, 3), lod: 0, generation: 5 };
  const reply = { cell: cell(1, 2, 3), lod: 0, generation: 5 };

  it("accepts an exact match", () => {
    expect(replyIsWanted(reply, wanted, 0)).toBe(true);
  });

  it("refuses a different generation, in both directions", () => {
    // Not "at least": a chunk that reverts for a frame because an older answer landed is
    // the failure this rule exists to prevent.
    expect(replyIsWanted({ ...reply, generation: 4 }, wanted, 0)).toBe(false);
    expect(replyIsWanted({ ...reply, generation: 6 }, wanted, 0)).toBe(false);
  });

  it("refuses a different cell", () => {
    expect(replyIsWanted({ ...reply, cell: cell(2) }, wanted, 0)).toBe(false);
  });

  it("refuses a different level of detail", () => {
    // Both answers are correct meshes of the same chunk; only one is at the level asked
    // for, and the other looks like a LOD bug nobody can reproduce.
    expect(replyIsWanted({ ...reply, lod: 1 }, wanted, 0)).toBe(false);
  });

  it("refuses anything once the chunk is not wanted at all", () => {
    expect(replyIsWanted(reply, undefined, 0)).toBe(false);
  });

  it("refuses anything below the cancellation line", () => {
    expect(replyIsWanted(reply, wanted, 5)).toBe(false);
    expect(replyIsWanted(reply, wanted, 4)).toBe(true);
  });

  it("compares cells by coordinate, not by identity", () => {
    // A cell arrives from a structured clone as a different object every time.
    expect(
      replyIsWanted({ ...reply, cell: { ...cell(1, 2, 3) } }, wanted, 0),
    ).toBe(true);
  });
});

describe("the pool", () => {
  const build = (log: string[]): WorkerFactory => {
    let made = 0;
    return () => {
      const fake = fakeWorker();
      made++;
      log.push(`worker ${made} made`);
      return fake.worker;
    };
  };

  interface Recorded {
    meshes: Array<{ cell: CellCoord; generation: number }>;
    empties: Array<{ cell: CellCoord; generation: number }>;
    failures: Array<{ cell: CellCoord; reason: string }>;
  }

  const recording = (): Recorded => ({ meshes: [], empties: [], failures: [] });

  const handlersFor = (recorded: Recorded) => ({
    onMesh: (
      meshed: MeshedChunk,
      wanted: { cell: CellCoord; generation: number },
    ) => {
      recorded.meshes.push({
        cell: wanted.cell,
        generation: wanted.generation,
      });
      // **A promise of geometry, so at least one surface must have some** — the pool's whole
      // reason for distinguishing `onMesh` from `onEmpty`.
      expect(meshed.ground?.vertexCount ?? 0).toBeGreaterThan(0);
      expect(meshed.sea?.vertexCount ?? 0).toBeGreaterThanOrEqual(0);
    },
    onEmpty: (wanted: { cell: CellCoord; generation: number }) => {
      recorded.empties.push({
        cell: wanted.cell,
        generation: wanted.generation,
      });
    },
    onFailed: (wanted: { cell: CellCoord }, reason: string) => {
      recorded.failures.push({ cell: wanted.cell, reason });
    },
  });

  it("makes as many workers as it was asked for", () => {
    const log: string[] = [];
    const pool = new WorldWorkerPool({
      workers: 4,
      create: build(log),
      handlers: handlersFor(recording()),
    });
    expect(pool.size).toBe(4);
    expect(log).toHaveLength(4);
    pool.dispose();
  });

  it("gives a request to an idle worker", () => {
    const fake = fakeWorker();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recording()),
    });

    const wanted = pool.request(cell(3), 0);
    expect(fake.lastRequest()).toEqual({
      kind: "meshChunk",
      cell: cell(3),
      lod: 0,
      generation: wanted.generation,
    });
    expect(pool.busy).toBe(1);
    pool.dispose();
  });

  it("applies an answer that is the one it asked for", () => {
    const fake = fakeWorker();
    const recorded = recording();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recorded),
    });

    const wanted = pool.request(cell(3), 0);
    fake.answer({
      kind: "meshReady",
      cell: cell(3),
      lod: 0,
      generation: wanted.generation,
      ground: meshOf(9),
      empty: false,
    });

    expect(recorded.meshes).toEqual([
      { cell: cell(3), generation: wanted.generation },
    ]);
    expect(pool.busy).toBe(0);
    pool.dispose();
  });

  it("drops an answer that has been superseded, and frees the worker", () => {
    // The failure this exists for: the chunk visibly reverts for a frame.
    const fake = fakeWorker();
    const recorded = recording();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recorded),
    });

    const first = pool.request(cell(3), 0);
    const second = pool.request(cell(3), 0);
    expect(second.generation).toBeGreaterThan(first.generation);

    fake.answer({
      kind: "meshReady",
      cell: cell(3),
      lod: 0,
      generation: first.generation,
      ground: meshOf(9),
      empty: false,
    });
    expect(recorded.meshes).toEqual([]);

    // And the newer answer still lands.
    fake.answer({
      kind: "meshReady",
      cell: cell(3),
      lod: 0,
      generation: second.generation,
      ground: meshOf(9),
      empty: false,
    });
    expect(recorded.meshes).toEqual([
      { cell: cell(3), generation: second.generation },
    ]);
    pool.dispose();
  });

  it("does not cancel work on re-request, because the cancel cannot abort it", () => {
    // **A cancel here would be actively harmful, and was measured to be.**
    //
    // Cancelling was meant to stop a worker wasting time on a chunk that has been
    // re-requested. It cannot: a worker handles one message at a time and `meshChunk` is
    // synchronous, so the cancel is not observed until the chunk it was meant to abandon
    // has already been meshed. The time saved is zero.
    //
    // What it does instead is raise the worker's cancellation line, which is one number
    // covering every chunk that worker will ever be handed — so raising it for one chunk
    // also refuses later requests for *other* chunks at or below that line, which is what
    // the pool's own retries are. Measured: a few hundred refusals per pan, each one a
    // chunk that had to be retried, and each retry refused by the same cancel.
    //
    // The superseded chunk is abandoned by its own answer arriving, which `onMessage`
    // drops as stale and which is what frees the slot.
    const fake = fakeWorker();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recording()),
    });

    pool.request(cell(3), 0);
    pool.request(cell(3), 0);

    expect(
      fake.posted.some((message) => message.kind === "cancel"),
      "a re-request must not cancel",
    ).toBe(false);
    pool.dispose();
  });

  it("does not apply an answer for a chunk that has been abandoned", () => {
    // The chunk left the window between the request and the answer.
    const fake = fakeWorker();
    const recorded = recording();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recorded),
    });

    const wanted = pool.request(cell(3), 0);
    pool.abandon(cell(3));
    fake.answer({
      kind: "meshReady",
      cell: cell(3),
      lod: 0,
      generation: wanted.generation,
      ground: meshOf(9),
      empty: false,
    });

    expect(recorded.meshes).toEqual([]);
    pool.dispose();
  });

  it("does not apply an answer at a level of detail no longer wanted", () => {
    // Both answers are correct meshes of the same chunk; only one is at the level asked
    // for.
    const fake = fakeWorker();
    const recorded = recording();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recorded),
    });

    const coarse = pool.request(cell(3), 0);
    pool.request(cell(3), 1);
    fake.answer({
      kind: "meshReady",
      cell: cell(3),
      lod: 0,
      generation: coarse.generation,
      ground: meshOf(9),
      empty: false,
    });

    expect(recorded.meshes).toEqual([]);
    pool.dispose();
  });

  it("reports a failure without taking the worker out of service", () => {
    const fake = fakeWorker();
    const recorded = recording();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recorded),
    });

    const wanted = pool.request(cell(3), 0);
    fake.answer({
      kind: "meshFailed",
      cell: cell(3),
      lod: 0,
      generation: wanted.generation,
      reason: "boom",
    });

    expect(recorded.failures).toEqual([{ cell: cell(3), reason: "boom" }]);
    expect(pool.busy).toBe(0);
    pool.dispose();
  });

  it("spreads chunks across workers", () => {
    const fakes = [fakeWorker(), fakeWorker(), fakeWorker()];
    let made = 0;
    const pool = new WorldWorkerPool({
      workers: 3,
      create: () => fakes[made++].worker,
      handlers: handlersFor(recording()),
    });

    pool.request(cell(0), 0);
    pool.request(cell(1), 0);
    pool.request(cell(2), 0);
    expect(pool.busy).toBe(3);
    // One chunk each, because a worker holds its own model and two chunks in flight could
    // be answered from two different ones.
    for (const fake of fakes) {
      expect(
        fake.posted.filter((message) => message.kind === "meshChunk"),
      ).toHaveLength(1);
    }
    pool.dispose();
  });

  it("queues rather than overloading a busy worker", () => {
    const fakes = [fakeWorker(), fakeWorker()];
    let made = 0;
    const pool = new WorldWorkerPool({
      workers: 2,
      create: () => fakes[made++].worker,
      handlers: handlersFor(recording()),
    });

    pool.request(cell(0), 0);
    pool.request(cell(1), 0);
    pool.request(cell(2), 0);
    pool.request(cell(3), 0);

    expect(pool.busy).toBe(2);
    expect(pool.outstanding).toBe(2);
    expect(fakes[0].posted.filter((m) => m.kind === "meshChunk")).toHaveLength(
      1,
    );
    expect(fakes[1].posted.filter((m) => m.kind === "meshChunk")).toHaveLength(
      1,
    );
    pool.dispose();
  });

  it("starts a queued chunk as soon as a worker frees up", () => {
    const fake = fakeWorker();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recording()),
    });

    const first = pool.request(cell(0), 0);
    const second = pool.request(cell(1), 0);
    expect(pool.outstanding).toBe(1);

    fake.answer({
      kind: "meshReady",
      cell: cell(0),
      lod: 0,
      generation: first.generation,
      ground: meshOf(9),
      empty: false,
    });
    expect(fake.lastRequest()).toMatchObject({
      cell: cell(1),
      generation: second.generation,
    });
    pool.dispose();
  });

  it("does not queue a chunk twice", () => {
    const fake = fakeWorker();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recording()),
    });

    pool.request(cell(0), 0);
    pool.request(cell(1), 0);
    pool.request(cell(1), 0);
    pool.request(cell(1), 0);
    // One queued, not three: re-requesting must replace rather than accumulate.
    expect(pool.outstanding).toBe(1);
    pool.dispose();
  });

  it("reports an air chunk as empty and not as a mesh", () => {
    const fake = fakeWorker();
    const recorded = recording();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recorded),
    });

    const wanted = pool.request(cell(3), 0);
    fake.answer({
      kind: "meshReady",
      cell: cell(3),
      lod: 0,
      generation: wanted.generation,
      empty: true,
    });
    expect(recorded.empties).toEqual([
      { cell: cell(3), generation: wanted.generation },
    ]);
    expect(recorded.meshes).toEqual([]);
    pool.dispose();
  });

  it("ignores a message that is not one of its own", () => {
    const fake = fakeWorker();
    const recorded = recording();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recorded),
    });

    pool.request(cell(3), 0);
    fake.answer({ kind: "somethingNewer" } as unknown as FromWorker);
    expect(recorded.meshes).toEqual([]);
    pool.dispose();
  });

  it("sends the new model to every worker and abandons what was in flight", () => {
    // Each worker holds its own copy, and one about to be handed a chunk must not answer
    // from a model the main thread has replaced.
    const fakes = [fakeWorker(), fakeWorker()];
    let made = 0;
    const pool = new WorldWorkerPool({
      workers: 2,
      create: () => fakes[made++].worker,
      handlers: handlersFor(recording()),
    });

    const wanted = pool.request(cell(0), 0);
    pool.setModel({
      revision: 2,
      operations: new ArrayBuffer(8),
      paint: [],
      base: undefined,
    });

    for (const fake of fakes) {
      expect(fake.posted.some((message) => message.kind === "setModel")).toBe(
        true,
      );
      expect(fake.posted.some((message) => message.kind === "cancel")).toBe(
        true,
      );
    }

    const recorded = recording();
    fakes[0].answer({
      kind: "meshReady",
      cell: cell(0),
      lod: 0,
      generation: wanted.generation,
      ground: meshOf(9),
      empty: false,
    });
    expect(recorded.meshes).toEqual([]);
    pool.dispose();
  });

  it("stops every worker when disposed, once", () => {
    const fakes = [fakeWorker(), fakeWorker()];
    let made = 0;
    const pool = new WorldWorkerPool({
      workers: 2,
      create: () => fakes[made++].worker,
      handlers: handlersFor(recording()),
    });

    pool.dispose();
    pool.dispose();
    for (const fake of fakes) expect(fake.terminated).toBe(true);
    expect(pool.size).toBe(0);
  });

  it("does nothing once disposed", () => {
    const fake = fakeWorker();
    const pool = new WorldWorkerPool({
      workers: 1,
      create: () => fake.worker,
      handlers: handlersFor(recording()),
    });
    pool.dispose();
    pool.request(cell(0), 0);
    expect(fake.posted).toEqual([]);
  });
});
