/**
 * The pool of meshing workers, and the rules about which answer counts.
 *
 * Everything interesting here is about *staleness*, because that is the part of a worker
 * pool that is not obvious. A worker takes 250 ms or so per chunk and four run at once,
 * so at any moment there are four answers in flight for chunks that may no longer exist.
 * Every rule below exists to make sure a late answer cannot overwrite a current one.
 *
 * The rule itself is one line: **a reply is applied only if its generation is exactly the
 * generation the main thread last asked for.** Not "at least", not "newer than the mesh
 * currently held" — exactly. Anything looser lets one of three failures through:
 *
 * - A chunk re-requested at generation 9 comes back with 9 while 10 is wanted, and the
 *   chunk visibly reverts for a frame before 10 lands.
 * - A chunk evicted from the window and later re-entered is meshed again and looks right,
 *   so nothing about it can be wrong — but if its *first* answer is applied on top of the
 *   second, a mesh for a cell that is no longer in the slot appears at the slot's
 *   coordinates.
 * - A chunk whose level of detail changed has two answers whose geometry differs. The
 *   wrong one is not obviously wrong; it is a correct mesh of the same chunk at another
 *   level, which looks like a LOD bug that nobody can reproduce.
 *
 * Counting generations rather than comparing timestamps is what makes "exactly" cheap:
 * a per-cell counter, incremented on every request, and one equality test.
 */

import type { CellCoord, Lod } from "../world";
import { sameCell } from "../world";

import type { ChunkMesh } from "./chunk-mesh";
import type { FromWorker, ToWorker } from "./protocol";
import { isFromWorker } from "./protocol";
import type { Wanted } from "./worker";

/**
 * The part of a `Worker` this pool uses.
 *
 * Declared rather than taken as `Worker` so a fake can stand in: pool behaviour is
 * exactly the part worth testing — which worker gets which chunk, and which answer is
 * believed — and none of it can be tested through a real `Worker` without a browser.
 */
export interface PoolWorker {
  post(message: ToWorker, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  terminate(): void;
}

/** Builds a worker. Injected so the pool can be tested, and so the count is a choice. */
export type WorkerFactory = () => PoolWorker;

/** What the pool does with an answer. */
export interface PoolHandlers {
  /** A mesh arrived and is current. The buffers are the worker's; copy if kept. */
  onMesh(mesh: ChunkMesh, wanted: Wanted): void;
  /** A chunk was meshed and had no surface. */
  onEmpty(wanted: Wanted): void;
  /** A chunk could not be meshed. */
  onFailed(wanted: Wanted, reason: string): void;
}

export interface WorldWorkerPoolOptions {
  readonly workers: number;
  readonly create: WorkerFactory;
  readonly handlers: PoolHandlers;
}

interface Slot {
  readonly worker: PoolWorker;
  /** What this worker is currently building, if anything. Written as answers arrive. */
  building: Wanted | undefined;
}

export class WorldWorkerPool {
  private readonly slots: Slot[] = [];
  /** Chunks asked for but not yet given to a worker, in request order. */
  private readonly queue: CellCoord[] = [];
  /** What has been asked for, by cell. The authority on staleness. */
  private readonly wantedByCell = new Map<string, Wanted>();

  private readonly handlers: PoolHandlers;

  private nextGeneration = 1;
  private disposed = false;

  constructor(options: WorldWorkerPoolOptions) {
    this.handlers = options.handlers;
    for (let i = 0; i < options.workers; i++) {
      const worker = options.create();
      const slot: Slot = { worker, building: undefined };
      worker.addEventListener("message", (event) => {
        this.onMessage(slot, event.data);
      });
      this.slots.push(slot);
    }
  }

  /** How many workers are running. */
  get size(): number {
    return this.slots.length;
  }

  /** How many chunks are wanted but have not been given to a worker yet. */
  get outstanding(): number {
    return this.queue.length;
  }

  /** How many workers are building something. */
  get busy(): number {
    return this.slots.reduce(
      (count, slot) => count + (slot.building ? 1 : 0),
      0,
    );
  }

  /**
   * Asks for a chunk, replacing any request already outstanding for it.
   *
   * The generation increments even when the chunk is already wanted at the same level,
   * because "wanted" is not the same as "being built": a stroke can touch a chunk whose
   * mesh has not arrived yet, and the answer to the earlier request is then built from a
   * model that no longer exists.
   */
  request(cell: CellCoord, lod: Lod): Wanted {
    const generation = this.nextGeneration++;
    const wanted: Wanted = { cell: { ...cell }, lod, generation };
    this.wantedByCell.set(this.key(cell), wanted);

    // Anything already queued for this cell is now redundant: the new request supersedes
    // it. Removing it here rather than letting it reach a worker is what stops the queue
    // filling with work for chunks that have been walked away from.
    this.dropQueued(cell);

    for (const slot of this.slots) {
      if (slot.building !== undefined && sameCell(slot.building.cell, cell)) {
        // In flight. Tell the worker its work is unwanted so it can stop early, but leave
        // the slot marked busy: it *is* busy, and freeing it here would let a second
        // chunk be sent to a worker that is still meshing the first.
        slot.worker.post({ kind: "cancel", belowGeneration: generation });
      }
    }

    this.enqueue(cell);
    this.pump();
    return wanted;
  }

  /** Gives up on a chunk: it has left the window. */
  abandon(cell: CellCoord): void {
    this.wantedByCell.delete(this.key(cell));
    this.dropQueued(cell);
    this.pump();
  }

  /**
   * Tells every worker the model has changed.
   *
   * Sent to all of them rather than one, because each holds its own copy and each is
   * about to be handed a chunk. Cancelling at the current generation is what makes the
   * next answers trustworthy: a worker that was mid-chunk under the old model cannot
   * reply with it, and cannot quietly reply with a mixture of the two.
   */
  setModel(
    message: Omit<Extract<ToWorker, { kind: "setModel" }>, "kind">,
  ): void {
    const highest = this.nextGeneration - 1;
    for (const slot of this.slots) {
      slot.worker.post({ kind: "cancel", belowGeneration: highest });
      slot.worker.post({ ...message, kind: "setModel" });
    }
    // Queued chunks are not stale — they will simply be meshed under the new model —
    // but anything in flight is, so it is dropped and re-requested by the caller.
    for (const slot of this.slots) slot.building = undefined;
    this.wantedByCell.clear();
    this.queue.length = 0;
  }

  /** Stops every worker. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
    this.queue.length = 0;
    this.wantedByCell.clear();
  }

  // ---- answering

  private onMessage(slot: Slot, data: unknown): void {
    if (!isFromWorker(data)) return;

    const wanted = this.wantedByCell.get(this.key(data.cell));
    if (!this.isCurrent(data, wanted)) {
      // The one rule. A reply that is not exactly the generation last asked for is
      // dropped and its buffers let go.
      slot.building = undefined;
      this.pump();
      return;
    }

    slot.building = undefined;

    if (data.kind === "meshFailed") {
      this.handlers.onFailed(data, data.reason);
    } else if (data.empty) {
      this.handlers.onEmpty(data);
    } else if (data.mesh !== undefined) {
      this.handlers.onMesh(data.mesh, data);
    }

    this.pump();
  }

  /**
   * Whether a reply is the answer to the request currently outstanding.
   *
   * Deliberately the *only* place staleness is decided, on both sides: the worker applies
   * the same rule to what it is asked for, and the mesher's own tests pin that chunking
   * cannot change a chunk's geometry. Three checks because each covers a different way of
   * being wrong — an old generation, a chunk that has left the window, and a level of
   * detail that has changed since the request was made.
   */
  private isCurrent(reply: FromWorker, wanted: Wanted | undefined): boolean {
    if (wanted === undefined) return false;
    if (reply.generation !== wanted.generation) return false;
    return reply.lod === wanted.lod && sameCell(reply.cell, wanted.cell);
  }

  // ---- queueing

  private enqueue(cell: CellCoord): void {
    this.queue.push(cell);
  }

  /** Removes every queued request for a cell, wherever it sits. */
  private dropQueued(cell: CellCoord): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (sameCell(this.queue[i], cell)) this.queue.splice(i, 1);
    }
  }

  /**
   * Hands queued chunks to idle workers, one each.
   *
   * One chunk per worker, and the reason is the model rather than the hardware. A worker
   * builds its field from the last model it received, so a worker that has been given a
   * newer model than its neighbour will answer from a different model. One at a time
   * means a model change cancels everything in flight, the next requests go out in
   * order, and every worker has converged on the newest model before any of them is
   * trusted.
   *
   * The list is walked once per call rather than a queue per worker, so a worker that
   * frees up cannot take a chunk another worker has already been given — which is how
   * the first version of this sent every chunk to worker zero.
   */
  private pump(): void {
    if (this.disposed) return;

    const idle = this.slots.filter((slot) => slot.building === undefined);
    const take = Math.min(idle.length, this.queue.length);

    for (let i = 0; i < take; i++) {
      const cell = this.queue[i];
      const wanted = this.wantedByCell.get(this.key(cell));
      if (wanted === undefined) continue;
      idle[i].building = wanted;
      idle[i].worker.post({
        kind: "meshChunk",
        cell: wanted.cell,
        lod: wanted.lod,
        generation: wanted.generation,
      });
    }

    if (take > 0) this.queue.splice(0, take);
  }

  /**
   * A stable string for a cell.
   *
   * `JSON.stringify` on a three-number object, which is right here because the key never
   * leaves the pool and the alternative — the `CoordinateMap` the world uses — is a
   * general-purpose hash for cross-object lookups. A cell key has to survive a cell
   * arriving from a structured clone as a different object, and a string does that where
   * a `WeakMap` would not.
   */
  private key(cell: CellCoord): string {
    return `${cell.x},${cell.y},${cell.z}`;
  }
}
