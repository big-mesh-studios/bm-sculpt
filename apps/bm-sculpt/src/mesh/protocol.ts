/**
 * The messages between the main thread and a meshing worker.
 *
 * Three rules govern this file, and all three follow from one fact: a worker is not a
 * place you can ask a question.
 *
 * **Everything a worker needs arrives in a message.** The operations, the paint and the
 * base field cannot be reached across the thread boundary, so the main thread sends them
 * and the worker rebuilds its own field on its own side. A worker holding a reference to
 * "the" field would be sharing mutable state with a thread that cannot be synchronised,
 * and the main thread's edits would never be seen.
 *
 * **Cloned going out, transferred coming back.** The model is small relative to a mesh
 * and is copied. The mesh is large and its buffers are transferred, so ownership moves
 * rather than being duplicated — which is why `ChunkMeshBuilder.finish` copies to exact
 * length: a transferred *view* would be detached in flight and the main thread would
 * receive an empty array, silently, having been told the transfer succeeded.
 *
 * **Every request carries a generation.** A chunk can be re-requested before its previous
 * answer has arrived — the player walked, or a stroke invalidated it — and answers come
 * back out of order, because workers run in parallel and one chunk takes arbitrarily
 * longer than another. The generation is how the main thread tells a late answer from a
 * current one. A counter, not a timestamp: it only has to be compared, and a counter
 * cannot repeat.
 */

import type { CellCoord, Lod, SkirtMask } from "../world";

import type { ChunkMesh } from "@big-mesh-studios/meshing";

/** Which chunk, which level, and which attempt. */
export interface ChunkRequestMessage {
  readonly kind: "meshChunk";
  readonly cell: CellCoord;
  readonly lod: Lod;
  /**
   * Faces whose neighbour is at a different level, as a `SkirtMask`.
   *
   * Optional, so a message from an older bundle — which has no skirts at all — is still a
   * valid request. A worker given one without it simply meshes without a skirt, which is the
   * behaviour before this field existed.
   */
  readonly skirt?: SkirtMask;
  /**
   * The main thread's count of how many times it has asked for this chunk.
   *
   * Not a slot number, because a slot is recycled: the same slot can stand for a
   * different cell by the time an answer arrives, and a result keyed by slot would be
   * applied to whichever cell then occupied it.
   */
  readonly generation: number;
}

/** A painted chunk, as it crosses the boundary. */
export interface PaintTileMessage {
  readonly cell: CellCoord;
  readonly colours: Uint8Array;
}

/** The kind of infinite world, if any, behind the operations. */
export type BaseFieldKind = "none" | "terrain";

/**
 * The model, as it crosses the boundary: data and nothing else.
 *
 * No classes and no functions, because structured clone turns a class instance into a
 * plain object with its fields and none of its methods — so a worker handed a `Field`
 * would hold something that looks like one and cannot sample. The worker builds its own
 * field from this (see `MesherFactory`), which is also what lets the two sides evolve
 * separately: this shape is the contract, and nothing else crosses.
 */
export interface ModelMessage {
  readonly kind: "setModel";
  /** So a worker can discard a model it has already been superseded by. */
  readonly revision: number;
  /** Serialised by `serialiseOperations`; read by `deserialiseOperations`. */
  readonly operations: ArrayBuffer;
  /** Painted chunks, and only those — an unpainted chunk needs no message. */
  readonly paint: readonly PaintTileMessage[];
  readonly base: BaseFieldKind;
  /**
   * Terrain parameters, when `base` is `"terrain"`.
   *
   * Carried as a separate optional rather than three optional numbers, so that a world
   * with no base field cannot accidentally arrive with half of one.
   */
  readonly terrain?: {
    /** The world y a height of zero sits at, and the vertical scale. */
    readonly origin: number;
    readonly scale: number;
    readonly octaves: number;
    readonly seed: number;
  };
}

/** Cancels work the main thread no longer wants. */
export interface CancelMessage {
  readonly kind: "cancel";
  /**
   * Every generation at or below this is unwanted.
   *
   * One number rather than a list, because the main thread abandons work in order: once a
   * chunk has been re-requested at generation 9, generation 8 is not wanted whatever
   * else happens, and neither is anything older.
   */
  readonly belowGeneration: number;
}

/** What the main thread may send. */
export type ToWorker = ChunkRequestMessage | ModelMessage | CancelMessage;

/** A finished mesh, or the fact that the chunk has none. */
export interface ChunkMeshMessage {
  readonly kind: "meshReady";
  readonly cell: CellCoord;
  readonly lod: Lod;
  readonly generation: number;
  /** Absent when `empty`; its buffers are transferred, not cloned. */
  readonly mesh?: ChunkMesh;
  readonly empty: boolean;
}

/** A worker reporting that it could not mesh what it was asked for. */
export interface ChunkFailedMessage {
  readonly kind: "meshFailed";
  readonly cell: CellCoord;
  readonly lod: Lod;
  readonly generation: number;
  readonly reason: string;
}

/**
 * A worker reporting that it will **not** mesh what it was asked for.
 *
 * This message exists because of one rule the pool cannot work without: **every
 * generation the pool marks busy must eventually be answered.** A worker that declines a
 * request in silence cannot satisfy that rule, and the pool has no other way to learn
 * that a request is not coming — it is not holding a mesh, so nothing arrives, so the
 * slot it marked busy is never freed, and the pool's busy count never comes back down.
 * One lost reply is a chunk that never appears; one lost reply for a request the pool
 * cannot re-issue is a pool that never works again, because `Session.idle` stays false
 * and every streamed edit is gated on it.
 *
 * So a decline is a reply. It carries the cell and generation so the pool can free the
 * right slot, and it is **never applied as geometry** — a chunk that was not meshed has
 * no mesh, and reporting one as empty would mark a slot filled with nothing and leave a
 * hole in the world that nothing re-requests.
 */
export interface ChunkCancelledMessage {
  readonly kind: "meshCancelled";
  readonly cell: CellCoord;
  readonly lod: Lod;
  readonly generation: number;
  /**
   * Why the worker declined, for the pool's counter and for anyone reading a log.
   *
   * Never for behaviour. A worker with no model and a worker told to cancel are the same
   * thing to the pool: that slot is free and no mesh is coming.
   */
  readonly reason: "no model" | "cancelled" | "busy";
}

/** What a worker may send back. */
export type FromWorker =
  ChunkMeshMessage | ChunkFailedMessage | ChunkCancelledMessage;

const TO_WORKER_KINDS = new Set(["meshChunk", "setModel", "cancel"]);
const FROM_WORKER_KINDS = new Set(["meshReady", "meshFailed", "meshCancelled"]);

const kindOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
};

/**
 * Whether a value is a message the main thread may send.
 *
 * Needed because a worker receives whatever arrives, including a structured clone of
 * something from an older bundle after a deploy. Rejecting by shape rather than trusting
 * the type is what lets that be survivable.
 */
export const isToWorker = (value: unknown): value is ToWorker => {
  const kind = kindOf(value);
  return kind !== undefined && TO_WORKER_KINDS.has(kind);
};

/** Whether a value is a message a worker may send. */
export const isFromWorker = (value: unknown): value is FromWorker => {
  const kind = kindOf(value);
  return kind !== undefined && FROM_WORKER_KINDS.has(kind);
};

/**
 * The buffers to transfer alongside a mesh, in a fixed order.
 *
 * Kept beside the message so sender and receiver cannot disagree about the list. Getting
 * it wrong does not throw: the arrays are cloned instead of transferred, and the mesh
 * costs a copy per chunk for the rest of the session.
 */
export const meshTransferables = (message: FromWorker): Transferable[] => {
  if (
    message.kind !== "meshReady" ||
    message.empty ||
    message.mesh === undefined
  )
    return [];
  const { positions, normalOct, colours, indices } = message.mesh;
  return [
    positions.buffer,
    normalOct.buffer,
    colours.buffer,
    indices.buffer,
  ] as Transferable[];
};

/**
 * Whether a worker is promising a mesh for this message.
 *
 * **False for a decline, and that is the whole point of the distinction.** The pool
 * applies a promise and frees a slot on a decline, and must never do the first for the
 * second — reporting a chunk that was not meshed as an empty one marks its slot filled
 * with no geometry, and a filled slot is one the window stops asking about.
 */
export const isMeshAnswer = (message: FromWorker): boolean =>
  message.kind === "meshReady";
