/**
 * What a worker knows, and what it does when told something.
 *
 * `handleMeshMessage` is a pure function of the worker's state, the message, and an
 * injected mesher factory — and that is the whole design. A worker is a `Worker` object
 * you cannot inspect, cannot ask questions of, and cannot exercise in a test without a
 * browser. All the logic lives here instead, so it can be called directly: a meshChunk
 * request is `handle(state, message, build)` and gives back a new state and a reply. The
 * `Worker` is then a few lines of adapter that owns the state and posts what comes back.
 *
 * Purity costs a state copy per message, which is the right trade. A worker handles one
 * chunk at a time, so the state is a handful of fields, and an immutable state cannot be
 * half-updated by a message arriving while a chunk is being built.
 */

import type { CellCoord, Lod } from "../world";
import { sameCell } from "../world";

import type { ChunkMesher } from "./chunk-mesher";
import type { ChunkFailedMessage, FromWorker, ModelMessage } from "./protocol";
import { isToWorker } from "./protocol";

/**
 * Builds the mesher for a model, on the worker's side of the boundary.
 *
 * Injected rather than imported so that the message-handling logic — which is where the
 * ordering rules live — can be tested against a counting fake instead of a real field.
 */
export type MesherFactory = (model: ModelMessage) => ChunkMesher;

/** How a worker remembers what it is working on. */
export interface WorkerState {
  /** The model as last set. Absent until the first `setModel`. */
  readonly model: ModelMessage | undefined;
  /** The chunk being meshed, if any. */
  readonly pending:
    { cell: CellCoord; lod: Lod; generation: number } | undefined;
  /** Generations at or below this are unwanted. */
  readonly cancelledBelow: number;
  readonly meshed: number;
  readonly failed: number;
}

/** A worker that has been told nothing yet. */
export const emptyWorkerState = (): WorkerState => ({
  model: undefined,
  pending: undefined,
  cancelledBelow: 0,
  meshed: 0,
  failed: 0,
});

/** What handling a message produced. */
export interface Handled {
  readonly state: WorkerState;
  /** What to post back, if anything. */
  readonly reply: FromWorker | undefined;
}

/**
 * Handles one message, returning the worker's new state and its reply.
 *
 * Never throws. A worker that throws dies, and the main thread's request for that chunk
 * then waits forever — a failure that arrives as a message can be logged, counted, and
 * the chunk retried.
 */
export const handleMeshMessage = (
  state: WorkerState,
  message: unknown,
  build: MesherFactory,
): Handled => {
  if (!isToWorker(message)) {
    // A message from a newer or older bundle. Ignoring it lets the worker start and
    // carry on, where throwing would take the whole pool down with it.
    return { state, reply: undefined };
  }

  switch (message.kind) {
    case "setModel":
      return setModel(state, message);

    case "cancel":
      return {
        state: {
          ...state,
          cancelledBelow: Math.max(
            state.cancelledBelow,
            message.belowGeneration,
          ),
        },
        reply: undefined,
      };

    case "meshChunk":
      return meshChunk(state, message, build);

    default:
      return { state, reply: undefined };
  }
};

/**
 * Records a new model.
 *
 * A superseded revision is ignored rather than applied. Messages arrive in order on one
 * worker, so this should not happen — but a worker replaced by a newer bundle can be
 * handed an older queued message, and applying it would leave it meshing a model the
 * main thread has already replaced.
 */
const setModel = (state: WorkerState, model: ModelMessage): Handled => {
  if (state.model !== undefined && model.revision < state.model.revision) {
    return { state, reply: undefined };
  }
  return {
    state: {
      ...state,
      model,
      // Work in flight was built against the model now being replaced, so it is no longer
      // wanted. Without this a single rebuild could be answered from a mix of two models.
      cancelledBelow: Math.max(
        state.cancelledBelow,
        state.pending?.generation ?? 0,
      ),
      pending: undefined,
    },
    reply: undefined,
  };
};

/**
 * Meshes one chunk, if it is still wanted.
 *
 * The order of the checks is the substance:
 *
 * 1. **Is there a model?** No model means no field, so there is nothing to do. Reporting
 *    a failure would be honest but noisy: the main thread sends the model and the
 *    requests together, and a request is allowed to arrive first.
 * 2. **Is the generation wanted?** A chunk can be re-requested before its answer
 *    arrives, and answers arrive out of order.
 * 3. **Is a chunk already in flight?** A worker meshes one at a time and the pool
 *    serialises them, so this should not happen; ignoring it is safer than re-entering.
 */
const meshChunk = (
  state: WorkerState,
  request: { cell: CellCoord; lod: Lod; generation: number },
  build: MesherFactory,
): Handled => {
  const model = state.model;
  if (model === undefined) return { state, reply: undefined };
  if (request.generation <= state.cancelledBelow)
    return { state, reply: undefined };
  if (state.pending !== undefined) return { state, reply: undefined };

  const pending: WorkerState = { ...state, pending: request };

  try {
    const mesher = build(model);

    // The gate, before any sampling. In a terrain world most chunks are entirely air or
    // entirely solid and this is the difference between a few thousand field evaluations
    // and thirty-four thousand of them. Answered as an empty mesh rather than skipped
    // silently, because the main thread is waiting for an answer to this generation and an
    // unanswered request is a chunk that stays blank until something unrelated re-asks.
    //
    // Optional on the interface, and absent means "mesh it" — see `ChunkMesher`. Only a
    // mesher that answers `false` is trusted, and only it is allowed to have an opinion.
    if (mesher.couldHaveMesh?.(request.cell, request.lod) === false) {
      return {
        state: { ...pending, pending: undefined, meshed: pending.meshed + 1 },
        reply: {
          kind: "meshReady",
          cell: request.cell,
          lod: request.lod,
          generation: request.generation,
          empty: true,
        },
      };
    }

    const mesh = mesher.mesh({ cell: request.cell, lod: request.lod });
    const empty = mesh.vertexCount === 0;
    return {
      state: { ...pending, pending: undefined, meshed: pending.meshed + 1 },
      reply: {
        kind: "meshReady",
        cell: request.cell,
        lod: request.lod,
        generation: request.generation,
        // An empty mesh is reported as such rather than sent. Four empty typed arrays
        // per air chunk would be most of the traffic in a terrain world, and building
        // them in the first place would defeat asking whether the chunk needs meshing.
        ...(empty ? {} : { mesh }),
        empty,
      },
    };
  } catch (reason) {
    const reply: ChunkFailedMessage = {
      kind: "meshFailed",
      cell: request.cell,
      lod: request.lod,
      generation: request.generation,
      reason: reason instanceof Error ? reason.message : String(reason),
    };
    return {
      state: { ...pending, pending: undefined, failed: pending.failed + 1 },
      reply,
    };
  }
};

/** What the main thread currently wants for a given cell. */
export interface Wanted {
  readonly cell: CellCoord;
  readonly lod: Lod;
  readonly generation: number;
}

/**
 * Whether a reply is still wanted.
 *
 * On the worker's own side this is the "is the generation wanted" check; on the main
 * thread's it is the same check plus whether the cell is still wanted at all. One
 * function for both, because a disagreement between the two about which answers are
 * stale is a bug that shows up as a chunk flickering between two versions of itself.
 */
export const replyIsWanted = (
  reply: { cell: CellCoord; lod: Lod; generation: number },
  wanted: Wanted | undefined,
  cancelledBelow: number,
): boolean => {
  if (wanted === undefined) return false;
  if (reply.generation !== wanted.generation) return false;
  if (reply.generation <= cancelledBelow) return false;
  return sameCell(reply.cell, wanted.cell) && reply.lod === wanted.lod;
};

/**
 * The cell a reply is about, as the main thread will look it up.
 *
 * Cells are values and compared by coordinate, so a reply identifies its chunk without
 * referring to a slot that may since have been recycled.
 */
export const replyCell = (reply: FromWorker): CellCoord => reply.cell;
