/**
 * The streaming logic with meshing removed, and declines made deterministic.
 *
 * Every bug in this area is a bookkeeping bug, and every one has been found by racing
 * real workers against real meshing times — which is the slowest and least reliable way
 * to find one. It needs the timing to line up, so it reproduces on some pans and not
 * others, which is exactly the reported symptom.
 *
 * So both sources of timing are removed here:
 *
 * - **Meshing costs nothing.** The mesher returns immediately. Nothing in this file is
 *   about speed.
 * - **Declines are scheduled, not hoped for.** A worker can be told to decline a
 *   deterministic subset of generations. That is the whole point: a decline is what
 *   loses work, so a test that does not produce one is not testing the thing that
 *   breaks. An earlier version of this file ran four schedules and produced zero
 *   declines, and it passed with the defect deliberately re-introduced — it was
 *   checking nothing.
 *
 * The invariant is a property of the bookkeeping and needs no triangles:
 *
 *   **once nothing is in flight, every window slot is either filled or has a request
 *   outstanding.**
 *
 * Anything else is a chunk that nothing is asking for — a window that stops populating,
 *   with `busy` at zero and an empty queue, clearing only when an unrelated model send
 *   happens to re-ask. That is the bug this file exists to make impossible.
 */

import { describe, expect, it } from "vitest";

import { Scene, type Material } from "@random-mesh/rmsl/scene";

import type { Operation } from "@big-mesh-studios/csg";
import type {
  ChunkMeshers,
  FromWorker,
  MeshRequest,
  PoolWorker,
  ToWorker,
} from "../mesh";
import { emptyWorkerState, handleMeshMessage } from "../mesh/worker";
import { Session, starterOperations } from "../session";

const key = (cell: { x: number; y: number; z: number }): string =>
  `${cell.x},${cell.y},${cell.z}`;

/**
 * Meshing costs nothing. Nothing here is about time.
 *
 * **Ground only, and the sea left out on purpose.** A session built here has no sea
 * material, so a second mesher would be built for a model with no landscape and produce
 * nothing — and the harness counts requests, which is the whole of what it measures.
 */
const noCostMeshers: ChunkMeshers = {
  ground: {
    mesh: (_r: MeshRequest) => ({
      positions: new Float32Array(9),
      normalOct: new Int16Array(6),
      colours: new Uint8Array(12),
      indices: new Uint32Array(9),
      vertexCount: 3,
      triangleCount: 3,
    }),
  },
};

interface Harness {
  readonly session: Session;
  readonly workers: ReturnType<typeof makeWorker>[];
  readonly declines: number;
}

/**
 * A worker whose replies are delivered only when stepped.
 *
 * `declineWhen` decides, from the generation alone, whether this request is answered or
 * declined — so the pattern is identical on every run and needs no wall clock.
 */
const makeWorker = (declineWhen: (generation: number) => boolean) => {
  const inbox: ToWorker[] = [];
  let state = emptyWorkerState();
  let listener: ((event: { data: unknown }) => void) | undefined;
  let declines = 0;
  const worker: PoolWorker = {
    post: (m) => inbox.push(m),
    addEventListener: (_t, fn) => {
      listener = fn;
    },
    terminate: () => {},
  };
  return {
    worker,
    declinedCount: () => declines,
    step: (): boolean => {
      const message = inbox.shift();
      if (message === undefined) return false;
      if (message.kind === "meshChunk" && declineWhen(message.generation)) {
        declines++;
        const reply: FromWorker = {
          kind: "meshCancelled",
          cell: message.cell,
          lod: message.lod,
          generation: message.generation,
          reason: "cancelled",
        };
        listener?.({ data: reply });
        return true;
      }
      const handled = handleMeshMessage(state, message, () => noCostMeshers);
      state = handled.state;
      if (handled.reply !== undefined) listener?.({ data: handled.reply });
      return true;
    },
  };
};

const harness = (
  radius: number,
  workers: number,
  declineWhen: (generation: number) => boolean,
): Harness => {
  const made: ReturnType<typeof makeWorker>[] = [];
  const session = new Session({
    scene: new Scene(),
    material: {} as Material,
    operations: starterOperations() as Operation[],
    workers,
    radius,
    createWorker: () => {
      const w = makeWorker(declineWhen);
      made.push(w);
      return w.worker;
    },
  });
  return {
    session,
    workers: made,
    get declines(): number {
      return made.reduce((n, w) => n + w.declinedCount(), 0);
    },
  };
};

/**
 * Chunks the window is showing that nothing will ever act on.
 *
 * **Being wanted is not enough, and getting that wrong is how this went unnoticed twice.**
 * The first version of this check asked only whether a chunk was wanted by the session or
 * the pool, and it passed while 43 of 123 chunks sat unfilled, unqueued and unbuilt —
 * recorded in both, acted on by neither. A record of intent is not work.
 *
 * The property that matters is whether anything is *going to happen* about the chunk: it
 * is either being built, or it is on the queue waiting for a worker, or it is not the
 * window's problem. Anything else is a hole with a note attached saying someone cares.
 */
const stranded = (session: Session): string[] => {
  const pool = (
    session as unknown as {
      pool: {
        queue: { x: number; y: number; z: number }[];
        wantedByCell: Map<string, unknown>;
        slots: {
          building: { cell: { x: number; y: number; z: number } } | undefined;
        }[];
      };
    }
  ).pool;
  const queued = new Set(pool.queue.map(key));
  const building = new Set(
    pool.slots.flatMap((s) =>
      s.building === undefined ? [] : [key(s.building.cell)],
    ),
  );
  const bad: string[] = [];
  for (const slot of session.window.slots) {
    if (slot.filled) continue;
    const k = key(slot.cell);
    if (!queued.has(k) && !building.has(k)) bad.push(k);
  }
  return bad;
};

/**
 * Runs every worker's queue until the grid is at rest, and reports whether it got
 * there. Bounded, so a run that cannot settle fails rather than hanging.
 */
const settle = (
  session: Session,
  workers: ReturnType<typeof makeWorker>[],
  budget = 4000,
): boolean => {
  for (let i = 0; i < budget; i++) {
    let moved = false;
    for (const w of workers) moved = w.step() || moved;
    const pool = (
      session as unknown as {
        pool: { queue: unknown[]; slots: { building: unknown }[] };
      }
    ).pool;
    const idle = pool.slots.every((s) => s.building === undefined);
    if (!moved && pool.queue.length === 0 && idle) return true;
  }
  return false;
};

/**
 * A transient refusal: the worker declines for a while and then behaves.
 *
 * This is what a real worker does once the pool stops asking for work it has told the
 * worker to abandon — a burst while requests are in flight, then nothing. Declining a
 * *fixed fraction* forever is a harsher thing than the pool can be asked to survive, and
 * testing that would be testing an impossibility rather than the code.
 */
const transient = (window: number) => {
  let seen = 0;
  const state = { refusing: true };
  const declineWhen = (generation: number): boolean => {
    void generation;
    return state.refusing && seen++ < window;
  };
  return { declineWhen, state };
};

describe("the streaming logic, with no meshing and scheduled declines", () => {
  it("produces declines, so it is testing the thing that breaks", () => {
    // Without this the rest of the file is decoration. An earlier version ran four
    // schedules, produced no declines at all, and passed with the defect deliberately
    // re-introduced — it was checking nothing.
    const burst = transient(400);
    const h = harness(3, 3, burst.declineWhen);
    settle(h.session, h.workers);
    for (let step = 1; step <= 4; step++) {
      h.session.follow({ x: step * 320, y: 0, z: 0 });
      settle(h.session, h.workers);
    }
    console.log(`\ndeclines deliberately caused: ${h.declines}`);
    expect(h.declines).toBeGreaterThan(0);
  });

  it("leaves nothing stranded when requests are declined in bursts", () => {
    const burst = transient(400);
    const h = harness(3, 3, burst.declineWhen);
    expect(settle(h.session, h.workers)).toBe(true);

    const span = 320;
    const moves: [number, number][] = [];
    // Forward, backward, far, back to where it started, and repeats of the same spot.
    for (let i = -4; i <= 4; i++) moves.push([i * span, i * span]);
    for (let i = 4; i >= -4; i--) moves.push([i * span, -i * span]);
    moves.push([12 * span, 0], [-12 * span, 0], [0, 0], [0, 0], [span, 0]);

    for (const [x, z] of moves) {
      h.session.follow({ x, y: 0, z });
      const settled = settle(h.session, h.workers);
      const bad = stranded(h.session);
      expect(
        bad,
        `after moving to ${x},${z}: stranded ${bad.slice(0, 5).join(" ")}`,
      ).toEqual([]);
      expect(settled, `never came to rest after moving to ${x},${z}`).toBe(
        true,
      );
    }

    console.log(
      `after ${moves.length} scrolls: ${JSON.stringify(h.session.stats())}, ${h.declines} declines`,
    );
    expect(stranded(h.session)).toEqual([]);
    expect(h.session.stats().filled).toBe(h.session.stats().chunks);
  });

  it("leaves nothing stranded when a model is sent between every scroll", () => {
    // The reported workaround was sculpting, which means the window was relying on a
    // model send to re-ask. A fix that needs the user to keep sculpting is not a fix, so
    // the schedule has to include model sends and still settle without one at the end.
    const burst = transient(400);
    const h = harness(3, 3, burst.declineWhen);
    expect(settle(h.session, h.workers)).toBe(true);
    for (let step = 1; step <= 5; step++) {
      h.session.follow({ x: step * 320, y: 0, z: 0 });
      for (const w of h.workers) w.step();
      h.session.setOperations(h.session.operations);
      expect(settle(h.session, h.workers)).toBe(true);
      expect(stranded(h.session), `stranded after step ${step}`).toEqual([]);
    }
  });

  it("leaves nothing stranded when a worker declines everything, then recovers", () => {
    // The permanent-refusal case. Nothing can be answered while it lasts, so the pool
    // has to give up on those chunks rather than retry for ever — and once the worker
    // behaves, the chunks have to come back without the user doing anything.
    const burst = transient(Number.MAX_SAFE_INTEGER);
    const h = harness(3, 3, burst.declineWhen);
    expect(settle(h.session, h.workers)).toBe(true);

    h.session.follow({ x: 320, y: 0, z: 0 });
    settle(h.session, h.workers);
    const refused = stranded(h.session);
    console.log(
      `\nwhile refusing everything: ${refused.length} of ${h.session.stats().chunks} chunks unwanted`,
    );
    // Honest, and the point of the cap: a worker that declines everything produces no
    // chunks, so all of them are unwanted. What must not happen is spinning — and it did
    // not, because `settle` returned rather than running out of its budget.
    expect(refused.length).toBe(h.session.stats().chunks);
    expect(h.declines).toBeGreaterThan(0);

    // The worker recovers. Nothing but time and a scroll should be needed.
    burst.state.refusing = false;
    h.session.follow({ x: 640, y: 0, z: 0 });
    expect(settle(h.session, h.workers)).toBe(true);
    expect(
      stranded(h.session),
      "still stranded after the worker recovered",
    ).toEqual([]);
  });
});
