/**
 * A running session: a model, a chunk window, a pool of meshing workers, and the store
 * that holds what comes back.
 *
 * This is where the phases meet. Phases 1 to 4 each built a piece that is testable on its
 * own and useless alone; nothing here is new logic, only the wiring — and the wiring is
 * where the interesting failures live, because each piece enforces its own invariant and
 * the seam between two correct pieces is not automatically correct.
 *
 * Three of those seams carry a decision worth stating up front.
 *
 * **A mesh reply is applied at the revision recorded when it was requested, not at the
 * slot's current revision.** The slot that asked is looked up from a record made at
 * request time, not from the window's present answer. Between the two, the window may
 * have scrolled and given that slot to a different cell — and applying the mesh anyway
 * would draw one chunk's surface at another's coordinates. The store refuses it; this is
 * what it refuses.
 *
 * **A cell leaving the window is abandoned in the pool, not merely dropped.** The pool
 * queues by cell and the window forgets by slot, so without this the queue fills with work
 * for cells nobody is waiting for, and the pool's cancellation line never advances.
 *
 * **The model is sent on change, not per chunk.** Every worker builds its own field, so
 * every worker needs the operations. Sending them per chunk would re-serialise the model
 * once per chunk; sending on change makes it once per edit.
 */

import type { Vec3 } from "./constants";
import {
  makeOperation,
  serialiseOperations,
  type Operation,
  type TerrainParams,
} from "./csg";
import type { Material, Scene } from "@random-mesh/rmsl/scene";

import {
  type CellCoord,
  type LodBands,
  ChunkWindow,
  cellDistance,
  chunkCellOf,
  sameCell,
} from "./world";
import {
  type ChunkMesh,
  type ModelMessage,
  type PoolWorker,
  type Wanted,
  WorldWorkerPool,
} from "./mesh";
import { ChunkMeshStore, hooksFor } from "./render";
import type { Bounds } from "./edit/document";

/**
 * The streaming window's radius, in chunks, when the caller does not ask for one.
 *
 * **Four is not a preference: it is the fog's far distance.** `src/render/fog.ts` closes
 * at `4 * BLOCK_WORLD` because that is where the terrain stops, and this is where the
 * terrain stops. So the two are named here and in there and `fog.test.ts` holds them
 * together — a window that grew without the fog following it would still be *correct*
 * (an exponential never stops) and would still show a seam at its edge, which is the
 * failure mode that costs a day to find from a screenshot.
 */
export const DEFAULT_WINDOW_RADIUS = 4;

/**
 * The game's window: wider and much flatter than the editor's.
 *
 * A walking player wants ground ahead and a little above, not a ball of sky, and wants
 * further than an orbit camera does because the horizon is most of what a first-person
 * frame is. Five chunks is 1600 units against the editor's 1280, which the fog has to
 * cover — so `fog.test.ts` asserts against this and not only against `FOG_FAR`.
 */
export const GAME_WINDOW = { radius: 5, yRadius: 2 } as const;

/** What a mesh request is remembered as, so its answer can be applied where it belongs. */
interface Outstanding {
  readonly slot: number;
  readonly revision: number;
  readonly wanted: Wanted;
}

export interface SessionOptions {
  readonly scene: Scene;
  readonly material: Material;
  readonly operations: readonly Operation[];
  /**
   * The landscape behind those operations, if the world has one.
   *
   * Four numbers rather than something opaque, because the main thread and every worker
   * build their field from them independently and have to arrive at the same one. That is
   * the agreement ADR 0009 is about, and a base field that could only be built on one side
   * of the thread boundary could not be checked at all.
   */
  readonly terrain?: TerrainParams;
  /** Chunk radius in x and z. Defaults to `DEFAULT_WINDOW_RADIUS`. */
  readonly radius?: number;
  /** Chunk radius in y, normally smaller — see `sphereCells`. */
  readonly yRadius?: number;
  readonly bands?: LodBands;
  /** How many meshing workers to run. Defaults to one per hardware thread, capped. */
  readonly workers?: number;
  /**
   * How to make a meshing worker.
   *
   * Injectable because this class is where the phases meet, and a seam between two
   * correct pieces is not automatically correct: the wiring is the most bug-prone code
   * in the project and there is no way to test any of it without standing up real workers,
   * which is exactly what cannot be done in a test run. The default is the real thing.
   */
  readonly createWorker?: () => PoolWorker;
}

export interface SessionStats {
  readonly chunks: number;
  readonly filled: number;
  readonly drawn: number;
  readonly triangles: number;
  /**
   * Chunks asked for and not yet answered, whether they are being meshed or queued.
   *
   * Named `pending` rather than `outstanding` because the pool already uses
   * `outstanding` for the narrower question — chunks queued rather than in flight — and two
   * statistics with one name and different meanings is a readout nobody can trust.
   */
  readonly pending: number;
  /** Workers currently meshing something. */
  readonly busy: number;
  /**
   * Chunks the pool has been asked for and has not yet handed to a worker.
   *
   * The third number needed to tell a slow window from a stuck one. `pending` alone
   * cannot: a chunk that is pending because a worker is building it and a chunk that is
   * pending because it is sitting in the queue look identical, and only the second is
   * evidence of a stall. A healthy window drains this towards zero; a starved one holds
   * it high with `busy` at zero.
   */
  readonly queued: number;
  readonly staleRefusals: number;
  readonly failures: number;
}

export class Session {
  readonly window: ChunkWindow;
  readonly store: ChunkMeshStore;
  readonly pool: WorldWorkerPool;

  /** What is outstanding, keyed by cell — never by slot, which is recycled. */
  private readonly inFlight = new Map<string, Outstanding>();

  /** Bumped on every model change, so a worker can discard a model it has passed. */
  private revision = 1;

  /**
   * The operations the workers are meshing.
   *
   * Public because the picker needs its own field built from exactly these, and a second
   * copy of the model kept alongside would be free to drift — which is the one disagreement
   * this design exists to rule out.
   */
  private currentOperations: readonly Operation[] = [];
  /**
   * The landscape, if the world has one. Held as the four numbers the workers build from,
   * for the same reason the operations are held as a list: the picker builds its own field
   * and the two must not be able to drift.
   */
  private readonly terrainParams: TerrainParams | undefined;
  private failures = 0;
  private disposed = false;

  /**
   * Whether the window exists yet.
   *
   * The window places its initial cells inside its own constructor and fires
   * `onSlotsWanted` while doing so — before this constructor has assigned `this.window`.
   * A flag rather than a null check on the window itself, because the window is not
   * genuinely optional; there is a brief moment during construction when it exists and is
   * not yet reachable, and saying so plainly beats a type that invites a reader to supply
   * a fallback.
   */
  private windowReady = false;

  constructor(options: SessionOptions) {
    this.terrainParams = options.terrain;
    this.store = new ChunkMeshStore(
      options.scene,
      options.material,
      // Sized from the window's own count below, once the window exists. The store is
      // resized by the window's `onSlotCountChanged`, so the number here is only a
      // starting point.
      1,
    );

    const hooks = hooksFor(this.store);

    this.window = new ChunkWindow({
      radius: options.radius ?? DEFAULT_WINDOW_RADIUS,
      ...(options.yRadius !== undefined ? { yRadius: options.yRadius } : {}),
      ...(options.bands !== undefined ? { bands: options.bands } : {}),
      ...hooks,
      onSlotsWanted: (slots) => this.onSlotsWanted(slots),
      onSlotRelease: (slot) => {
        hooks.onSlotRelease(slot);
        this.forgetSlot(slot);
      },
      onSlotReposition: (slot) => {
        hooks.onSlotReposition(slot);
        this.forgetSlot(slot);
      },
      // The store keeps the slot's mesh here — the cell has not moved, only the resolution
      // it is wanted at — but the request that would fill it at the *old* resolution is
      // still superseded, so it is forgotten exactly as a release would forget it.
      onSlotRefill: (slot) => {
        hooks.onSlotRefill(slot);
        this.forgetSlot(slot);
      },
    });

    this.pool = new WorldWorkerPool({
      workers: options.workers ?? defaultWorkerCount(),
      create: options.createWorker ?? createMeshingWorker,
      handlers: {
        onMesh: (mesh, wanted) => this.onMesh(mesh, wanted),
        onEmpty: (wanted) => this.onEmpty(wanted),
        onFailed: (wanted, reason) => this.onFailed(wanted, reason),
      },
    });

    // The window's own constructor placement fired `onSlotsWanted` before there was a
    // window to read. Those requests are made explicitly here instead, which is both later
    // and clearer than relying on a callback that fires inside another object's
    // constructor.
    this.windowReady = true;

    // Resizing fixes the store's size, and — because a resize invalidates every slot —
    // leaves the store ready for the requests that follow.
    this.store.resize(this.window.capacity);
    this.setOperations(options.operations);
  }

  /** The operations currently being streamed. */
  get operations(): readonly Operation[] {
    return this.currentOperations;
  }

  /**
   * The landscape this session streams, or undefined for an operations-only world.
   *
   * Public because the picker has to build the same field and cannot ask a worker what it
   * built (ADR 0009). It is the same four numbers the workers read, from the same field, so
   * the two cannot drift.
   */
  get terrain(): TerrainParams | undefined {
    return this.terrainParams;
  }

  /** The model, as the workers need it. */
  modelMessage(): ModelMessage {
    const terrain = this.terrainParams;
    return {
      kind: "setModel",
      revision: this.revision,
      operations: serialiseOperations(this.currentOperations),
      paint: [],
      base: terrain !== undefined ? "terrain" : "none",
      // Carried only when there is terrain, so a world with no base field cannot arrive
      // with half of one — which is why `ModelMessage` makes this a block rather than three
      // optional numbers.
      ...(terrain !== undefined ? { terrain } : {}),
    };
  }

  /**
   * Replaces the model, tells every worker, and re-requests what the change left undone.
   *
   * The re-request is the part that is easy to miss and matters most here. Sending a model
   * cancels everything in flight, so a sculpt — which changes the model on every dab —
   * would silently strand every chunk that happened to be mid-mesh at that instant. They
   * would stay blank until something unrelated scrolled the window, which looks like a
   * mesher that hangs.
   *
   * Chunks that are already filled are left alone: their geometry is still valid, because
   * `touched` is what says which chunks the change actually altered.
   */
  setOperations(operations: readonly Operation[], touched?: Bounds): void {
    this.currentOperations = operations;
    this.revision++;
    // `modelMessage()` rather than a second construction of the same thing, because a model
    // message that named terrain in one place and not the other would leave the workers
    // meshing an operations-only world while the header said otherwise — and the only
    // symptom would be a landscape that never appears.
    this.pool.setModel(this.modelMessage());

    // In-flight meshes were built against the old model, so they are not wanted whatever
    // their generations say. Dropping the record is enough: the store's revision has not
    // moved, so a late answer would find a record that is gone.
    this.inFlight.clear();

    this.requestAll();

    if (touched !== undefined) this.invalidateBox(touched);
  }

  /**
   * Whether every worker is free and nothing is outstanding.
   *
   * The question an edit that re-sends the model has to ask *first*, because sending
   * cancels every mesh in flight. A send per frame does not merely cost a frame: it cancels
   * the very mesh that would have shown the edit, over and over, so the chunk under the
   * brush never lands. The symptom is not a stutter — it is an edit that appears to do
   * nothing until the pointer stops moving, and chunks whose geometry goes missing and
   * comes back.
   *
   * Deliberately coarse: it asks about the whole pool rather than only the chunks this edit
   * touches, because a send throws away *everything* outstanding and not just its own, so
   * a finer question would still let each send cancel the world's streaming. Waiting on the
   * mesher's real throughput is also what sets the update rate, and that is what makes a
   * live preview affordable rather than merely possible.
   */
  get idle(): boolean {
    return this.inFlight.size === 0 && this.pool.busy === 0;
  }

  /**
   * Invalidates every resident chunk a world-space box touches, and re-requests them.
   *
   * Derived from the edit's own bounds rather than from a list of chunks the brush
   * happened to visit, because a stroke's operations know their extents and a caller
   * tracking them separately is a second thing to get wrong in the one place where being
   * wrong is invisible — the edit appears, but only partly.
   */
  invalidateBox(bounds: Bounds): number {
    let invalidated = 0;
    for (const cell of cellsInBox(bounds)) {
      // `claimedSlotOf` and not `slotOf`: a query refuses an unfilled chunk, but a chunk
      // whose mesh has not arrived is exactly the one an edit most needs to invalidate,
      // because it is the one most likely to have an answer in flight.
      const slot = this.window.claimedSlotOf(cell);
      if (slot === undefined) continue;
      // `markOutOfDate` and not `markStale`: this is the same cell with a different
      // model, so its current mesh is still the right thing to draw until the replacement
      // lands. Dropping it here would open a hole in the model for as long as the mesher
      // takes, once per edit.
      this.store.markOutOfDate(slot);
      this.window.markStale(slot);
      this.forgetSlot(slot);
      this.requestSlot(slot);
      invalidated++;
    }
    return invalidated;
  }

  /** Moves the window to follow a world position, and asks for whatever is now missing. */
  follow(world: Vec3): void {
    if (this.disposed) return;
    if (!this.window.scrollTo(world)) return;

    // **Ask for everything unfilled, not only what the window flagged.**
    //
    // The window reports the cells that *arrived* and the ones whose level of detail
    // changed, which is what makes a pan cost a ring rather than a window. It cannot
    // report a chunk that was asked for earlier, never answered, and is still sitting in
    // the window — because from the window's side nothing distinguishes that chunk from
    // one that was never requested at all.
    //
    // That gap is why this used to be done only by sending a model. `requestAll` asks for
    // every unfilled slot, so a sculpt was the only thing that recovered a window with a
    // hole in it, and "pan fast, then sculpt, and it all appears" was the observable
    // behaviour. A window that cannot ask for its own missing chunks is relying on an
    // unrelated event to do it, which is not a recovery path.
    //
    // A scan of the window's slots on a scroll, where a scroll is a discrete movement of
    // the focus cell rather than a per-frame event: `scrollTo` returns false — and so
    // costs nothing — for every frame in which the focus cell has not changed.
    for (let slot = 0; slot < this.window.slots.length; slot++) {
      const entry = this.window.slots[slot];
      if (entry !== undefined && !entry.filled) this.requestSlot(slot);
    }
  }

  /** Reports what is on screen. */
  stats(): SessionStats {
    return {
      chunks: this.window.capacity,
      filled: this.window.slots.reduce(
        (count, slot) => count + (slot.filled ? 1 : 0),
        0,
      ),
      drawn: this.store.drawnCount,
      triangles: this.store.triangleCount,
      pending: this.inFlight.size,
      busy: this.pool.busy,
      queued: this.pool.outstanding,
      staleRefusals: this.store.staleRefusals,
      failures: this.failures,
    };
  }

  /** Stops the workers and frees every buffer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inFlight.clear();
    this.pool.dispose();
    this.store.dispose();
  }

  // ---- the window's wants

  /**
   * Asks the pool for the slots the window says it needs, nearest first.
   *
   * A slot that is already `filled` is skipped, which is what stops the window re-requesting
   * every chunk every frame: the window asks for anything invalidated, not for anything
   * absent.
   */
  private onSlotsWanted(slots: readonly number[]): void {
    if (!this.windowReady) return;
    for (const slot of slots) {
      const entry = this.window.slots[slot];
      if (entry === undefined || entry.filled) continue;
      this.requestSlot(slot);
    }
  }

  /**
   * Asks for every unfilled slot, nearest first.
   *
   * Sorted here rather than left to the window because the window does not sort: its
   * `sphereCells` documents that callers order by distance, and `scrollTo` does — but the
   * initial placement does not, since it happens inside its own constructor before anything
   * can ask for a particular order. Left unsorted, startup meshes the far corners of the
   * window while the chunk the player is standing in waits its turn.
   */
  private requestAll(): void {
    const focus = this.window.focusCell;
    const order = this.window.slots
      .map((_, slot) => slot)
      .sort((a, b) => {
        const here = this.window.slots[a];
        const there = this.window.slots[b];
        return cellDistance(here.cell, focus) - cellDistance(there.cell, focus);
      });
    for (const slot of order) {
      const entry = this.window.slots[slot];
      // Filled slots are left alone, which is what stops a model change re-mesh chunks
      // whose geometry is still perfectly good. Every chunk is *unfilled* after one, since
      // sending a model cancels the work in flight — so this asks for the whole window
      // again, not just the edit's.
      if (entry !== undefined && !entry.filled) this.requestSlot(slot);
    }
  }

  /**
   * Requests one slot's mesh, recording where the answer belongs.
   *
   * The record is keyed by cell and holds the slot and the revision captured *now*.
   * Looking the slot up again when the answer arrives would find whichever cell holds
   * that slot number by then, which after a scroll is a different cell entirely.
   */
  private requestSlot(slot: number): void {
    const entry = this.window.slots[slot];
    if (entry === undefined) return;

    const cell = entry.cell;
    const key = this.key(cell);

    // Re-requesting supersedes: the pool drops the queued one, and the record is
    // replaced rather than kept, so a reply to the older request finds nothing.
    const existing = this.inFlight.get(key);
    if (existing !== undefined) this.inFlight.delete(key);

    const revision = this.store.revisionOf(slot);
    // The skirt mask comes from the window, which chose the level from the same `lodAt`;
    // passing it here is what keeps the mask and the level from being decided twice.
    const wanted = this.pool.request(cell, entry.targetLod, entry.targetSkirt);
    this.inFlight.set(key, { slot, revision, wanted });
  }

  // ---- the pool's answers

  private onMesh(mesh: ChunkMesh, wanted: Wanted): void {
    this.settle(wanted, (request) => {
      const outcome = this.store.apply(request.slot, mesh, request.revision);
      if (!outcome.accepted) return;
      this.window.markFilled(request.slot);
    });
  }

  private onEmpty(wanted: Wanted): void {
    // An air chunk is an answer, not a failure, and the slot must be marked filled so the
    // window stops asking and the picker stops being refused.
    this.settle(wanted, (request) => {
      this.store.apply(request.slot, emptyMesh(), request.revision);
      this.window.markFilled(request.slot);
    });
  }

  private onFailed(wanted: Wanted, reason: string): void {
    this.failures++;
    console.warn(
      `chunk ${this.key(wanted.cell)} could not be meshed: ${reason}`,
    );
    // Deliberately leaves the slot unfilled, so it stays answerable-as-no and the window
    // will ask again. Marking it filled with nothing on the GPU would be a lie that the
    // window believes.
    this.settle(wanted, () => {});
  }

  /**
   * Applies an answer to the request it belongs to, and forgets it.
   *
   * The pool has already checked the generation (ADR 0008); this checks that the cell is
   * still the one being waited on, and hands the recorded slot and revision to the store,
   * which is where an overtaken answer is refused.
   */
  private settle(wanted: Wanted, apply: (request: Outstanding) => void): void {
    const key = this.key(wanted.cell);
    const request = this.inFlight.get(key);
    this.inFlight.delete(key);
    if (request === undefined) return;
    if (request.wanted.generation !== wanted.generation) return;
    if (!sameCell(request.wanted.cell, wanted.cell)) return;
    apply(request);
  }

  /** Drops a slot's outstanding request, and abandons its cell in the pool. */
  private forgetSlot(slot: number): void {
    if (!this.windowReady) return;
    const entry = this.window.slots[slot];
    if (entry === undefined) return;
    const key = this.key(entry.cell);
    if (this.inFlight.delete(key)) this.pool.abandon(entry.cell);
  }

  private key(cell: CellCoord): string {
    return `${cell.x},${cell.y},${cell.z}`;
  }
}

const emptyMesh = () => ({
  positions: new Float32Array(0),
  normalOct: new Int16Array(0),
  colours: new Uint8Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
});

/**
 * A meshing worker, as a module worker.
 *
 * The `new URL(..., import.meta.url)` form is what the bundler recognises to emit the
 * worker as its own chunk with its own dependencies, rather than inlining it into the
 * main bundle where it would pull the CSG and the mesher into the page.
 */
const createMeshingWorker = (): PoolWorker => {
  const worker = new Worker(new URL("./mesh/mesh-worker.ts", import.meta.url), {
    type: "module",
    name: "bm-sculpt-mesh",
  });
  // Adapted rather than passed straight in, because `Worker`'s own overloads are wider
  // than what the pool uses — and a `PoolWorker` that named `Worker` directly could not
  // be stood in for by a fake, which is the only reason it is an interface.
  return {
    post: (message) => worker.postMessage(message),
    addEventListener: (type, listener) =>
      worker.addEventListener(type, (event) =>
        listener({ data: (event as MessageEvent).data }),
      ),
    terminate: () => worker.terminate(),
  };
};

/**
 * One worker per hardware thread, capped.
 *
 * Capped because each worker holds a whole copy of the operation list and a set of scratch
 * buffers sized for a whole chunk, and because meshing is CPU-bound: a fifth worker on four
 * cores costs context switches and memory and buys nothing.
 */
const defaultWorkerCount = (): number => {
  const cores =
    typeof navigator === "undefined"
      ? 4
      : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(1, Math.min(4, cores - 1));
};

/** A model to look at: a few primitives spread over enough chunks to stream. */
export const starterOperations = (): Operation[] => [
  makeOperation(
    0,
    { x: 0, y: 0, z: 0 },
    { type: "Ellipsoid", radius: { x: 90, y: 90, z: 90 } },
    "Add",
    { colour: { r: 214, g: 150, b: 96 } },
  ),
  makeOperation(
    1,
    { x: 220, y: -40, z: 60 },
    { type: "Box", len: { x: 120, y: 70, z: 120 } },
    "Add",
    { colour: { r: 150, g: 180, b: 214 } },
  ),
  makeOperation(
    2,
    { x: -200, y: 30, z: -80 },
    { type: "Capsule", lenX: 260, radius: 46 },
    "Add",
    { colour: { r: 200, g: 120, b: 130 } },
  ),
  makeOperation(
    3,
    { x: 80, y: 120, z: -220 },
    { type: "Ellipsoid", radius: { x: 70, y: 110, z: 70 } },
    "Subtract",
    { colour: { r: 120, g: 200, b: 170 } },
  ),
];

/** Every chunk cell a world-space box overlaps. */
const cellsInBox = (bounds: Bounds): CellCoord[] => {
  const min = chunkCellOf(bounds.min);
  const max = chunkCellOf({
    // The far corner is exclusive: a box ending exactly on a chunk boundary does not reach
    // into the next chunk, and including it would invalidate a chunk the edit did not
    // touch — which costs a re-mesh of something that did not change.
    x: bounds.max.x - 1e-6,
    y: bounds.max.y - 1e-6,
    z: bounds.max.z - 1e-6,
  });

  const cells: CellCoord[] = [];
  for (let x = Math.min(min.x, max.x); x <= Math.max(min.x, max.x); x++) {
    for (let y = Math.min(min.y, max.y); y <= Math.max(min.y, max.y); y++) {
      for (let z = Math.min(min.z, max.z); z <= Math.max(min.z, max.z); z++) {
        cells.push({ x, y, z });
      }
    }
  }
  return cells;
};
