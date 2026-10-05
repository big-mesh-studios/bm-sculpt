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

import type { CellCoord, Lod, OverlapMask } from "../world";

import type { ChunkMesh } from "@big-mesh-studios/meshing";
import type { BaseFieldSpec } from "@big-mesh-studios/csg";

/** Which chunk, which level, and which attempt. */
export interface ChunkRequestMessage {
  readonly kind: "meshChunk";
  readonly cell: CellCoord;
  readonly lod: Lod;
  /**
   * Faces whose neighbour is meshed more finely, as an `OverlapMask`.
   *
   * Optional, so a message from an older bundle — which reaches into no neighbour at all —
   * is still a valid request. A worker given one without it simply meshes to its own
   * boundary, which is the behaviour before this field existed.
   */
  readonly overlap?: OverlapMask;
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
  /**
   * The infinite world behind the operations, or `undefined` for a world of operations alone.
   *
   * **A value rather than a kind beside a bag of parameters**, which is what this used to be and
   * which could arrive wrong. `base: "planet"` with a terrain's four numbers was representable, and
   * every worker would then have built a landscape of the wrong shape at the wrong scale. The
   * union carries the kind that selects the parameters and the parameters together, so there is
   * no such message to write. See `BaseFieldSpec`.
   */
  readonly base: BaseFieldSpec | undefined;
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

/**
 * What a chunk turned out to hold: a ground surface, a sea surface, both or neither.
 *
 * **Two independent fields rather than one mesh and an optional sea**, because "this chunk
 * is open ocean, so there is no ground in it" and "this chunk is a mountain, so there is no
 * sea in it" are the two common answers and one of them each would have to encode as the
 * absence of the thing that is present. Each is absent when that chunk holds no such
 * surface, which is most chunks for both.
 *
 * The sea is not the model: it comes from the landscape alone and does not move when an
 * edit does, which is why the two are separate answers rather than one mesh with a flag.
 * See `mesh/water-mesher.ts`.
 */
export interface MeshedChunk {
  readonly ground?: ChunkMesh;
  readonly sea?: ChunkMesh;
}

/** A finished mesh, or the fact that the chunk has none. */
export interface ChunkMeshMessage {
  readonly kind: "meshReady";
  readonly cell: CellCoord;
  readonly lod: Lod;
  readonly generation: number;
  /** Absent when this chunk holds no ground; its buffers are transferred, not cloned. */
  readonly ground?: ChunkMesh;
  /** Absent when this chunk holds no sea, on the same terms. */
  readonly sea?: ChunkMesh;
  /**
   * Whether the chunk held neither surface.
   *
   * **The one answer that can be sent without buffers**, and it is the common one: a
   * planet's window is mostly deep rock and open sky, and four empty typed arrays for each
   * would be most of the traffic in the session as well as most of the work.
   */
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
 *
 * **Every mesh in the message, ground first.** A partial list leaves whichever mesh is
 * missing to be cloned, so a list that named only the ground would quietly clone the sea
 * on every ocean chunk — a cost per chunk that no test of the renderer would ever notice,
 * because a cloned array draws exactly as well as a transferred one.
 */
export const meshTransferables = (message: FromWorker): Transferable[] => {
  if (message.kind !== "meshReady") return [];
  const transferables: Transferable[] = [];
  for (const mesh of [message.ground, message.sea]) {
    if (mesh === undefined) continue;
    const { positions, normalOct, colours, indices } = mesh;
    transferables.push(
      positions.buffer,
      normalOct.buffer,
      colours.buffer,
      indices.buffer,
    );
  }
  return transferables as Transferable[];
};

/**
 * Whether a worker is promising geometry for this message.
 *
 * **False for a decline, and that is the whole point of the distinction.** The pool
 * applies a promise and frees a slot on a decline, and must never do the first for the
 * second — reporting a chunk that was not meshed as an empty one marks its slot filled
 * with no geometry, and a filled slot is one the window stops asking about.
 */
export const isMeshAnswer = (message: FromWorker): boolean =>
  message.kind === "meshReady";

/**
 * The meshes a reply carries, as the pair a store applies.
 *
 * **Read through one function rather than by the caller picking the fields off**, because
 * `empty` and the two meshes have to agree: a reply that says `empty` and carries a mesh
 * is a lie either way, and which one wins should be a decision stated once.
 */
export const meshedOf = (message: ChunkMeshMessage): MeshedChunk => {
  if (message.empty) return {};
  return {
    ...(message.ground !== undefined ? { ground: message.ground } : {}),
    ...(message.sea !== undefined ? { sea: message.sea } : {}),
  };
};
