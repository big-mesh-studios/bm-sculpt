import { describe, expect, it } from "vitest";

import { Scene, type Material } from "@random-mesh/rmsl/scene";

import { Operation } from "@big-mesh-studios/csg";
import type { ChunkMesh } from "@big-mesh-studios/meshing";
import type { FromWorker, ModelMessage, PoolWorker, ToWorker } from "./mesh";
import { Session, starterOperations, type SessionStats } from "./session";

/**
 * A worker that answers only when told to.
 *
 * The session's failures are all about *when* something arrives relative to a scroll, so
 * the fake has to be able to hold an answer back and release it after the world has moved
 * underneath it. A fake that answered immediately could express none of them.
 */
const fakeWorker = () => {
  const posted: ToWorker[] = [];
  let deliver: ((data: unknown) => void) | undefined;

  const worker: PoolWorker = {
    post: (message) => {
      posted.push(message);
    },
    addEventListener: (_type, listener) => {
      deliver = (data) => listener({ data });
    },
    terminate: () => {},
  };

  return {
    worker,
    posted,
    /** Every mesh request that reached this worker, in order. */
    requests(): Request[] {
      return posted
        .filter(
          (message): message is Extract<ToWorker, { kind: "meshChunk" }> =>
            message.kind === "meshChunk",
        )
        .map((message) => ({
          cell: `${message.cell.x},${message.cell.y},${message.cell.z}`,
          lod: message.lod,
          generation: message.generation,
        }));
    },
    models(): ModelMessage[] {
      return posted.filter(
        (message): message is ModelMessage => message.kind === "setModel",
      );
    },
    replies(data: FromWorker): void {
      if (deliver === undefined) throw new Error("nothing is listening");
      deliver(data);
    },
  };
};

interface Request {
  readonly cell: string;
  readonly lod: number;
  readonly generation: number;
}

const meshOf = (vertices: number): ChunkMesh => ({
  positions: new Float32Array(vertices * 3),
  normalOct: new Int16Array(vertices * 2),
  colours: new Uint8Array(vertices * 4),
  indices: new Uint32Array(vertices * 3),
  vertexCount: vertices,
  triangleCount: vertices,
});

const model = (): Operation[] => starterOperations();

const newSession = (
  options: { radius?: number; workers?: number } = {},
): {
  session: Session;
  fakes: ReturnType<typeof fakeWorker>[];
  stats: () => SessionStats;
} => {
  const fakes: ReturnType<typeof fakeWorker>[] = [];
  const session = new Session({
    scene: new Scene(),
    material: {} as Material,
    operations: model(),
    workers: options.workers ?? 2,
    radius: options.radius ?? 2,
    createWorker: () => {
      const fake = fakeWorker();
      fakes.push(fake);
      return fake.worker;
    },
  });
  return { session, fakes, stats: () => session.stats() };
};

const cellOf = (cell: string): { x: number; y: number; z: number } => {
  const [x, y, z] = cell.split(",").map(Number);
  return { x, y, z };
};

const replyWith = (
  fake: ReturnType<typeof fakeWorker>,
  request: Request,
  vertices = 12,
): void => {
  fake.replies({
    kind: "meshReady",
    cell: cellOf(request.cell),
    lod: request.lod,
    generation: request.generation,
    empty: vertices === 0,
    ...(vertices === 0 ? {} : { ground: meshOf(vertices) }),
  });
};

/** Answers the newest request seen for a cell. */
const answerNewest = (
  fake: ReturnType<typeof fakeWorker>,
  cell: string,
  vertices = 12,
): Request => {
  const latest = fake
    .requests()
    .filter((request) => request.cell === cell)
    .pop();
  if (latest === undefined) throw new Error(`no request for ${cell}`);
  replyWith(fake, latest, vertices);
  return latest;
};

/**
 * Answers everything the session is waiting on, repeatedly, until nothing is left.
 *
 * A loop rather than a single answer, because the pool gives a worker one chunk and queues
 * the rest: a request only reaches a worker once a slot frees up. So the only way to watch
 * a window fill is to keep answering and let it run.
 */
const drain = (
  fakes: ReturnType<typeof fakeWorker>[],
  maxRounds = 400,
): { rounds: number; answered: number } => {
  const answered = new Set<string>();
  let rounds = 0;
  let count = 0;

  for (; rounds < maxRounds; rounds++) {
    let progressed = false;
    for (const fake of fakes) {
      for (const request of fake.requests()) {
        const key = `${request.cell}#${request.generation}`;
        if (answered.has(key)) continue;
        answered.add(key);
        count++;
        replyWith(fake, request);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return { rounds, answered: count };
};

describe("a session asking for work", () => {
  it("wants every chunk in its window", () => {
    // Logical requests, which is what `outstanding` counts — not the messages that reached
    // a worker, because the pool queues rather than flooding them.
    const { session, stats } = newSession({ radius: 2, workers: 2 });
    expect(stats().pending).toBe(stats().chunks);
    expect(stats().filled).toBe(0);
    session.dispose();
  });

  it("gives each worker one chunk and queues the rest", () => {
    // One per worker is the model's requirement (ADR 0008) rather than a throughput
    // choice: a worker holding two chunks could answer them from two different models.
    const { session, fakes, stats } = newSession({ radius: 2, workers: 2 });
    for (const fake of fakes)
      expect(fake.requests().length).toBeLessThanOrEqual(1);
    expect(stats().busy).toBe(2);
    // Still every chunk, because this counts requested-and-unanswered rather than queued;
    // the two dispatched ones have not been answered yet either.
    expect(stats().pending).toBe(stats().chunks);
    session.dispose();
  });

  it("sends the model to every worker", () => {
    // Each worker builds its own field from it, and each is about to be handed a chunk.
    const { session, fakes } = newSession({ workers: 3 });
    for (const fake of fakes) {
      expect(fake.models().length).toBeGreaterThan(0);
      expect(fake.models()[0].operations.byteLength).toBeGreaterThan(0);
    }
    session.dispose();
  });

  it("asks for the nearest chunks first", () => {
    // The window's initial placement is deliberately unsorted — its own documentation says
    // callers order by distance — so the session does it. Left unsorted, startup meshes the
    // far corners of the window while the chunk the player is standing in waits its turn.
    const { session, fakes } = newSession({ radius: 2, workers: 1 });
    const asked = fakes[0]
      .requests()
      .map((r) => ({ cell: r.cell, lod: r.lod }));
    expect(asked[0].cell).toBe("0,0,0");
    expect(asked[0].lod).toBe(0);
    session.dispose();
  });

  it("asks in order of distance across the first batch", () => {
    const { session, fakes } = newSession({ radius: 2, workers: 1 });
    drain(fakes);
    const asked = fakes[0].requests();
    const first = asked[0].cell.split(",").map(Number);
    expect(first).toEqual([0, 0, 0]);
    // Every later request is at least as far from the focus as the one before it, or the
    // ordering is not an ordering.
    const distances = asked.map((r) => {
      const [x, y, z] = r.cell.split(",").map(Number);
      return Math.hypot(x, y, z);
    });
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i], `request ${i}`).toBeGreaterThanOrEqual(
        distances[i - 1],
      );
    }
    session.dispose();
  });

  it("never asks a worker for the same chunk twice", () => {
    const { session, fakes } = newSession({ radius: 2, workers: 2 });
    drain(fakes);
    const all = fakes.flatMap((fake) => fake.requests());
    expect(new Set(all.map((r) => `${r.cell}#${r.generation}`)).size).toBe(
      all.length,
    );
    session.dispose();
  });
});

describe("a session receiving meshes", () => {
  it("installs a mesh and marks the slot filled", () => {
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    answerNewest(fakes[0], fakes[0].requests()[0].cell);
    expect(stats().filled).toBe(1);
    expect(stats().drawn).toBe(1);
    session.dispose();
  });

  it("marks an air chunk filled too, or the window asks for ever", () => {
    // An air chunk is an answer, not a failure. Left unfilled, the window re-requests it
    // every frame and it is never drawn because it has nothing to draw.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    answerNewest(fakes[0], fakes[0].requests()[0].cell, 0);
    expect(stats().filled).toBe(1);
    expect(stats().drawn).toBe(0);
    session.dispose();
  });

  it("applies each mesh to its own slot, one worker at a time", () => {
    // One worker means one chunk dispatched at a time, so the second request only exists
    // once the first has been answered. A test that asked for two at once would be testing
    // the pool rather than the session.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    const first = fakes[0].requests()[0];

    answerNewest(fakes[0], first.cell);
    expect(stats().drawn).toBe(1);

    const second = fakes[0].requests().find((r) => r.cell !== first.cell);
    expect(second).toBeDefined();
    replyWith(fakes[0], second!);
    expect(stats().drawn).toBe(2);
    session.dispose();
  });

  it("does not ask again for a slot that is filled", () => {
    const { session, fakes } = newSession({ radius: 1, workers: 1 });
    answerNewest(fakes[0], fakes[0].requests()[0].cell);
    const before = fakes[0].requests().length;

    // Two moves that keep the window where it is.
    session.follow({ x: 10, y: 0, z: 0 });
    session.follow({ x: 20, y: 0, z: 0 });
    expect(fakes[0].requests().length).toBe(before);
    session.dispose();
  });

  it("never reports a slot filled with nothing on the GPU unless the chunk is air", () => {
    // The distinction ADR 0007 exists for: filled means the answer is in hand.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 2 });
    drain(fakes);
    expect(stats().filled).toBe(stats().drawn);
    session.dispose();
  });
});

describe("a session whose world moved under an answer", () => {
  it("drops an answer for a chunk that has left the window", () => {
    // The cell is gone, so the pool has abandoned it and the record with it. Installing the
    // mesh anyway would draw a chunk that is no longer there.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    const request = fakes[0].requests()[0];

    session.follow({ x: 4000, y: 0, z: 0 });
    const before = stats().filled + stats().drawn;
    replyWith(fakes[0], request);
    expect(stats().filled + stats().drawn).toBe(before);
    session.dispose();
  });

  it("drops an answer whose request was superseded by a model change", () => {
    // The chunk was re-requested under a new model; the older answer must not land on top
    // of the newer one.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    const request = fakes[0].requests()[0];

    session.setOperations(model());
    replyWith(fakes[0], request);
    expect(stats().drawn).toBe(0);
    expect(stats().filled).toBe(0);
    session.dispose();
  });

  it("drops a second answer for a chunk it has already taken", () => {
    // The same mesh delivered twice would otherwise be applied twice: the second install
    // would free the first and draw the same surface again, which is only visible as a
    // flicker on a chunk that is otherwise fine.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    const request = fakes[0].requests()[0];
    replyWith(fakes[0], request);
    expect(stats().drawn).toBe(1);

    replyWith(fakes[0], request);
    expect(stats().drawn).toBe(1);
    expect(stats().filled).toBe(1);
    session.dispose();
  });
});

describe("a session scrolling", () => {
  it("asks for the chunks it arrives at", () => {
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    drain(fakes);
    const before = new Set(
      fakes.flatMap((fake) => fake.requests()).map((r) => r.cell),
    );

    // Drained first, because a worker still meshing the old window would queue the new
    // work rather than take it — so with one worker, an undrained scroll looks like a
    // session that asked for nothing.
    session.follow({ x: 3200, y: 0, z: 0 });
    drain(fakes);

    const after = new Set(
      fakes.flatMap((fake) => fake.requests()).map((r) => r.cell),
    );
    expect(after.size).toBeGreaterThan(before.size);
    expect(stats().filled).toBe(stats().chunks);
    session.dispose();
  });

  it("frees the geometry of a chunk that left", () => {
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    drain(fakes);
    expect(stats().drawn).toBe(stats().chunks);

    session.follow({ x: 4000, y: 0, z: 0 });
    expect(stats().drawn).toBe(0);
    session.dispose();
  });

  it("does not re-request a chunk that is still resident", () => {
    const { session, fakes } = newSession({ radius: 1, workers: 1 });
    drain(fakes);
    const asked = fakes[0].requests().length;
    session.follow({ x: 10, y: 0, z: 0 });
    session.follow({ x: -10, y: 5, z: 0 });
    expect(fakes[0].requests().length).toBe(asked);
    session.dispose();
  });
});

describe("changing the model", () => {
  it("sends it again and asks for everything that was left unfinished", () => {
    // Sending a model cancels everything in flight, so a sculpt — which changes the model
    // on every dab — would strand every chunk that happened to be mid-mesh at that instant.
    // They would stay blank until something unrelated scrolled the window, which looks
    // like a mesher that hangs rather than like a lost request.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    drain(fakes);
    expect(stats().filled).toBe(stats().chunks);

    session.setOperations(model());
    // Everything was filled, so nothing is outstanding and nothing is asked for again.
    expect(stats().pending).toBe(0);

    session.setOperations(model(), {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 10 },
    });
    // Now one chunk was invalidated, and exactly one was asked for.
    expect(stats().pending).toBe(1);
    session.dispose();
  });

  it("asks again for chunks that were still waiting when the model changed", () => {
    const { session, stats } = newSession({ radius: 1, workers: 1 });
    expect(stats().pending).toBe(stats().chunks);

    session.setOperations(model());
    expect(stats().pending).toBe(stats().chunks);
    session.dispose();
  });

  it("does not apply a mesh built against the old model", () => {
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    const request = fakes[0].requests()[0];
    session.setOperations(model());
    replyWith(fakes[0], request);
    expect(stats().drawn).toBe(0);
    session.dispose();
  });
});

describe("a chunk that cannot be meshed", () => {
  it("leaves the slot unfilled rather than lying about it", () => {
    // Marking it filled with nothing on the GPU is a lie the window would believe, and the
    // chunk would stay blank until something unrelated invalidated it.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    const request = fakes[0].requests()[0];
    fakes[0].replies({
      kind: "meshFailed",
      cell: cellOf(request.cell),
      lod: request.lod,
      generation: request.generation,
      reason: "sampling failed",
    });

    expect(stats().filled).toBe(0);
    expect(stats().drawn).toBe(0);
    expect(stats().failures).toBe(1);
    session.dispose();
  });
});

describe("the whole window filling", () => {
  it("converges: every chunk filled, drawn, and nothing left queued", () => {
    // The end-to-end property none of the pieces can show on its own. Given workers that
    // answer, a window reaches a steady state — which is what "streaming" means.
    const { session, fakes, stats } = newSession({ radius: 2, workers: 2 });
    const { answered } = drain(fakes);

    expect(answered).toBeGreaterThan(0);
    expect(stats().filled).toBe(stats().chunks);
    expect(stats().drawn).toBe(stats().chunks);
    expect(stats().pending).toBe(0);
    expect(stats().busy).toBe(0);
    expect(stats().failures).toBe(0);
    expect(stats().staleRefusals).toBe(0);
    session.dispose();
  });

  it("reaches more than one level of detail across a window that hits the far band", () => {
    // Coarse chunks are dispatched last, which is why this needs the window drained rather
    // than merely started.
    const { session, fakes, stats } = newSession({ radius: 3, workers: 2 });
    drain(fakes);
    const levels = new Set(
      fakes.flatMap((fake) => fake.requests().map((r) => r.lod)),
    );
    expect(levels.size).toBeGreaterThan(1);
    expect(stats().filled).toBe(stats().chunks);
    session.dispose();
  });

  it("keeps filling after the world scrolls under it", () => {
    const { session, fakes, stats } = newSession({ radius: 1, workers: 2 });
    drain(fakes);
    expect(stats().filled).toBe(stats().chunks);

    for (const at of [3200, -3200, 6400]) {
      session.follow({ x: at, y: 0, z: at });
      drain(fakes);
    }

    expect(stats().filled).toBe(stats().chunks);
    expect(stats().pending).toBe(0);
    expect(stats().staleRefusals).toBe(0);
    session.dispose();
  });
});

describe("disposing a session", () => {
  it("frees everything and stops asking", () => {
    const { session, fakes, stats } = newSession({ radius: 1, workers: 2 });
    drain(fakes);
    expect(stats().drawn).toBeGreaterThan(0);

    session.dispose();
    expect(stats().drawn).toBe(0);
    expect(stats().pending).toBe(0);
  });

  it("is safe twice, and does nothing afterwards", () => {
    const { session, fakes } = newSession({ radius: 1, workers: 1 });
    drain(fakes);
    const asked = fakes[0].requests().length;

    session.dispose();
    expect(() => session.dispose()).not.toThrow();
    session.follow({ x: 5000, y: 0, z: 0 });
    expect(fakes[0].requests().length).toBe(asked);
  });
});

describe("invalidating what an edit touched", () => {
  it("invalidates the chunks a box overlaps and asks for them again", () => {
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    drain(fakes);
    expect(stats().drawn).toBe(stats().chunks);

    const invalidated = session.invalidateBox({
      min: { x: -10, y: -10, z: -10 },
      max: { x: 10, y: 10, z: 10 },
    });

    expect(invalidated).toBeGreaterThan(0);
    // The chunk under the edit is no longer filled and is being meshed again; the rest keep
    // the geometry they had, which is still correct.
    expect(stats().filled).toBeLessThan(stats().chunks);
    expect(stats().pending).toBe(invalidated);
    session.dispose();
  });

  it("leaves chunks outside the box alone", () => {
    // Derived from the edit's bounds rather than from the chunks a brush visited, so an
    // edit only costs the chunks it actually altered.
    const { session, fakes, stats } = newSession({ radius: 2, workers: 1 });
    drain(fakes);
    const filledBefore = stats().filled;

    session.invalidateBox({
      min: { x: -10, y: -10, z: -10 },
      max: { x: 10, y: 10, z: 10 },
    });
    expect(stats().filled).toBeLessThan(filledBefore);
    expect(stats().filled).toBeGreaterThan(0);
    session.dispose();
  });

  it("invalidates one chunk for a box inside one", () => {
    const { session, fakes } = newSession({ radius: 2, workers: 1 });
    drain(fakes);

    // Chunks are centred on multiples of BLOCK_WORLD, so cell 0 covers -160 to 160 and a
    // box well inside that is one chunk.
    expect(
      session.invalidateBox({
        min: { x: 0, y: 0, z: 0 },
        max: { x: 100, y: 100, z: 100 },
      }),
    ).toBe(1);
    drain(fakes);
    session.dispose();
  });

  it("invalidates every chunk a box spans", () => {
    // A box reaching 320 on all three axes crosses a chunk boundary on each, so it covers
    // eight. Getting this wrong in the cheap direction is the failure that matters: too few
    // leaves part of an edit's chunk showing the old surface.
    const { session, fakes } = newSession({ radius: 2, workers: 1 });
    drain(fakes);
    expect(
      session.invalidateBox({
        min: { x: 0, y: 0, z: 0 },
        max: { x: 320, y: 320, z: 320 },
      }),
    ).toBe(8);
    session.dispose();
  });

  it("ignores chunks the window does not hold", () => {
    const { session } = newSession({ radius: 1, workers: 1 });
    // Far outside the resident window, so every cell resolves to no slot.
    const invalidated = session.invalidateBox({
      min: { x: 100000, y: 100000, z: 100000 },
      max: { x: 100100, y: 100100, z: 100100 },
    });
    expect(invalidated).toBe(0);
    session.dispose();
  });

  it("does not apply a mesh that was already in flight when the edit landed", () => {
    // Caught in two places by design, and neither of them is the store's revision counter:
    // invalidating a slot drops its record of what was asked for, and asking again
    // supersedes the generation, so a late reply finds a record that no longer matches it.
    // The store's own guard covers the other race — a slot re-pointed at a different cell,
    // where the old cell's record survives — and is tested in `chunk-mesh-store.test.ts`.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    const asked = fakes[0].requests()[0];

    session.invalidateBox({
      min: { x: -100, y: -100, z: -100 },
      max: { x: 100, y: 100, z: 100 },
    });
    const drawnAfterEdit = stats().drawn;

    replyWith(fakes[0], asked);
    // The surface from before the edit is not on screen, and the chunk is still waiting
    // for a mesh built from the model that includes it.
    expect(stats().drawn).toBe(drawnAfterEdit);
    expect(stats().filled).toBeLessThan(stats().chunks);
    session.dispose();
  });

  it("does not ask twice for a chunk that was already stale", () => {
    // A stroke invalidates the same box on every dab; without the window refusing a
    // second staleness, each dab would re-request the same chunk.
    const { session, fakes, stats } = newSession({ radius: 1, workers: 1 });
    drain(fakes);

    const box = {
      min: { x: -10, y: -10, z: -10 },
      max: { x: 10, y: 10, z: 10 },
    };
    const first = session.invalidateBox(box);
    const after = stats().pending;
    const second = session.invalidateBox(box);

    expect(second).toBe(first);
    expect(stats().pending).toBe(after);
    session.dispose();
  });
});
