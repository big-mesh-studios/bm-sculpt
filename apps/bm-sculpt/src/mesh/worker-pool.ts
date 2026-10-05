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

import type { CellCoord, Lod, OverlapMask } from "../world";
import { sameCell } from "../world";

import type { FromWorker, MeshedChunk, ToWorker } from "./protocol";
import { isFromWorker, meshedOf } from "./protocol";
import type { Wanted } from "./worker";

/**
 * The part of a `Worker` this pool uses.
 *
 * Declared rather than taken as `Worker` so a fake can stand in: pool behaviour is
 * exactly the part worth testing — which worker gets which chunk, and which answer is
 * believed — and none of it can be tested through a real `Worker` without a browser.
 */
export interface PoolWorker {
  /**
   * Sends a message. No transfer list, because the pool never transfers: the model goes
   * out cloned, and the mesh comes back transferred by the *worker*, which is the only
   * party that both holds and wants to give up those buffers. Naming a transfer list here
   * would imply otherwise.
   */
  post(message: ToWorker): void;
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
  /**
   * A chunk arrived and is current. The buffers are the worker's; copy if kept.
   *
   * **The pair, rather than a mesh, because a chunk can hold one surface and not the
   * other** — open ocean has a sea and no ground, a mountain has the reverse — and the
   * store owns both geometries for one slot, so it has to hear about both or neither.
   */
  onMesh(meshed: MeshedChunk, wanted: Wanted): void;
  /** A chunk was meshed and held neither surface. */
  onEmpty(wanted: Wanted): void;
  /** A chunk could not be meshed. */
  onFailed(wanted: Wanted, reason: string): void;
}

export interface WorldWorkerPoolOptions {
  readonly workers: number;
  readonly create: WorkerFactory;
  readonly handlers: PoolHandlers;
}

/**
 * How many times a single worker may decline one chunk before the pool stops retrying.
 *
 * A count per worker rather than one for the pool, because the useful reading is "every
 * worker has already said no to this chunk this many times".
 */
const DECLINE_BUDGET_PER_WORKER = 4;

interface Slot {
  readonly worker: PoolWorker;
  /** What this worker is currently building, if anything. Written as answers arrive. */
  building: Wanted | undefined;
}

export class WorldWorkerPool {
  private readonly slots: Slot[] = [];
  /** Chunks asked for but not yet given to a worker, in request order. */
  private readonly queue: CellCoord[] = [];
  /** How many times each cell has been declined, so a retry can be bounded. */
  private readonly declinedFor = new Map<string, number>();
  /** What has been asked for, by cell. The authority on staleness. */
  private readonly wantedByCell = new Map<string, Wanted>();

  private readonly handlers: PoolHandlers;

  private nextGeneration = 1;
  private disposed = false;

  /**
   * How many requests a worker has declined.
   *
   * Not a failure count: nothing went wrong, and nothing is retried. It is here because
   * the condition that produces declines is invisible from outside — a pool that is
   * merely slow and a pool that is declining work it cannot then re-issue look identical
   * from the busy count alone, and the difference is the difference between slow and
   * wedged.
   */
  private cancellations = 0;

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

  /** How many requests a worker has declined since the pool was made. */
  get declined(): number {
    return this.cancellations;
  }

  /**
   * Puts a declined chunk back on the queue, up to a limit.
   *
   * The limit is the whole subtlety. A decline is usually transient — the request was
   * cancelled, or a worker was still finishing the previous one — and retrying once the
   * pool has a free slot is exactly right. But a decline can also be permanent: a worker
   * with no model declines everything, and retrying that forever is a hot loop that never
   * stops. Counting per cell bounds the permanent case without slowing the transient one,
   * and the count is forgotten as soon as the cell is answered, abandoned, or swept by a
   * new model — so a chunk that was unlucky once is not penalised later.
   *
   * The retry reuses the same generation rather than minting a new one. The generation
   * identifies *which* mesh is wanted, not which attempt is being made, and re-issuing it
   * keeps the pool's staleness rule a single equality test.
   */
  private retryDeclined(cell: CellCoord): void {
    const key = this.key(cell);
    const wanted = this.wantedByCell.get(key);
    if (wanted === undefined) return;
    const attempts = (this.declinedFor.get(key) ?? 0) + 1;
    // A worker that declines everything would otherwise be retried for ever, which is a
    // hot loop that never drains. The cap is generous because a refusal is normally
    // transient — a request caught by a cancellation, or a worker still finishing the
    // previous one — and because a caller asking for the chunk again clears the count,
    // so a chunk that spends its budget is not permanently unaskable.
    if (attempts > DECLINE_BUDGET_PER_WORKER * this.slots.length) return;
    this.declinedFor.set(key, attempts);
    this.issue(wanted.cell, wanted.lod, wanted.overlap);
  }

  /**
   * Puts a request on the queue at a fresh generation.
   *
   * Split from `request` so that a retry can be a real re-request — new generation, new
   * queue entry — without also clearing the decline history, which is what a call from
   * outside means.
   */
  private issue(cell: CellCoord, lod: number, overlap?: OverlapMask): Wanted {
    const wanted: Wanted = {
      cell: { ...cell },
      lod,
      generation: this.nextGeneration++,
      ...(overlap !== undefined ? { overlap } : {}),
    };
    this.wantedByCell.set(this.key(cell), wanted);
    this.dropQueued(cell);
    this.enqueue(cell);
    this.pump();
    return wanted;
  }

  /** Forgets a cell's decline count, so a later attempt starts fresh. */
  private forgetDeclines(cell: CellCoord): void {
    this.declinedFor.delete(this.key(cell));
  }

  /**
   * Asks for a chunk, replacing any request already outstanding for it.
   *
   * The generation increments even when the chunk is already wanted at the same level,
   * because "wanted" is not the same as "being built": a stroke can touch a chunk whose
   * mesh has not arrived yet, and the answer to the earlier request is then built from a
   * model that no longer exists.
   */
  request(cell: CellCoord, lod: Lod, overlap?: OverlapMask): Wanted {
    this.forgetDeclines(cell);
    return this.issue(cell, lod, overlap);
  }

  /** Gives up on a chunk: it has left the window. */
  abandon(cell: CellCoord): void {
    this.wantedByCell.delete(this.key(cell));
    this.dropQueued(cell);
    this.forgetDeclines(cell);
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
    // but anything in flight is, so its slot stays busy until the worker answers it.
    //
    // **The slots are deliberately not marked idle here.** Clearing a busy flag says "this
    // worker is free", and a worker mid-chunk is not: it will refuse the next request
    // because it still holds this one, and — before `meshCancelled` existed — that
    // refusal was silence, so the slot was wedged for good. The worker answers the
    // superseded chunk when it finishes, the pool drops that answer as stale, and
    // `onMessage` frees the slot. Waiting for that answer is also what keeps the pool
    // from over-committing a worker that is busy, which is why the re-requests made after
    // this simply queue.
    //
    // The wanted records are dropped because a generation issued before the cancel line is
    // not wanted any more, and because `requestAll` is about to re-issue the unfilled
    // chunks at generations above the line.
    this.wantedByCell.clear();
    this.queue.length = 0;
    this.declinedFor.clear();
  }

  /** Stops every worker. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
    this.queue.length = 0;
    this.wantedByCell.clear();
    this.declinedFor.clear();
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
    if (data.kind !== "meshCancelled") this.forgetDeclines(data.cell);

    if (data.kind === "meshCancelled") {
      // **The slot is freed, and the chunk goes back on the queue.**
      //
      // Freeing is the part that stops the pool wedging: the slot's busy flag exists to
      // say "an answer is coming", and a decline is the answer that says one is not, so
      // leaving the flag set is how a pool ends up permanently short a worker.
      //
      // Re-queueing is the part that stops the window going blank. A declined request has
      // been *consumed* — its queue entry is gone — so if the chunk is not asked for again
      // here, nothing will: the window only re-asks a slot when it scrolls or when the
      // model changes, and a user who has stopped panning does neither. The symptom is a
      // window that stays partly empty with `busy` at zero and nothing in the queue, and
      // it clears only when something unrelated happens to send a model.
      //
      // Nothing is applied. The chunk was not meshed, so recording it as filled would
      // mark a slot filled with no geometry, and a filled slot is one the window stops
      // asking about — which is the same hole by a different route.
      this.cancellations++;
      this.retryDeclined(data.cell);
      this.pump();
      return;
    }

    if (data.kind === "meshFailed") {
      this.handlers.onFailed(data, data.reason);
    } else if (data.empty) {
      this.handlers.onEmpty(data);
    } else {
      // **`empty` has already been ruled out, so at least one mesh is here.** The gate is
      // above rather than folded into this branch because "a reply that carries neither a
      // mesh nor the empty flag" is the one shape that must never reach a store as
      // geometry, and one place deciding that is worth more than the branch saved.
      this.handlers.onMesh(meshedOf(data), data);
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
      // A queued cell with nothing wanted behind it cannot be sent, and leaving it in
      // place would wedge the queue behind it. Dropping the entry is correct because
      // nothing wants it.
      if (wanted === undefined) continue;
      idle[i].building = wanted;
      idle[i].worker.post({
        kind: "meshChunk",
        cell: wanted.cell,
        lod: wanted.lod,
        generation: wanted.generation,
        ...(wanted.overlap !== undefined ? { overlap: wanted.overlap } : {}),
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
