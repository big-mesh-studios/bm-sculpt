/**
 * The messages between the main thread and a cloud-bake worker.
 *
 * The same three rules as `src/mesh/protocol.ts`, for the same reason — a worker is
 * not a place you can ask a question — and the third one is barely needed here. There
 * is one request, it is asked once, and there is no model to rebuild under it, so no
 * generation is required: a late answer to a bake that has been disposed of is
 * dropped by the caller that disposed it, which is the same mechanism as every other
 * promise in the application and does not need a number on the wire.
 *
 * What is load-bearing is the transfer list. The two fields are 844 KB and 225 KB at
 * the production sizes, and they are produced by a two-and-a-half-second bake whose
 * only reason for being on another thread is that the main thread was stalling on it.
 * Copying them would put a megabyte of memcpy on the thread that was being freed.
 */

import type { PackedField } from "./cloud-field";

/** Ask for a field to be baked. The only thing the main thread ever says. */
export interface BakeRequestMessage {
  readonly kind: "bakeCloudField";
  /** The world's seed. The field is a pure function of it. */
  readonly seed: number;
  /**
   * The two resolutions, so a test can ask for a small field.
   *
   * Optional because the production caller does not know them and should not have to:
   * `bakeCloudField`'s own defaults are `SHAPE_SIZE` and `WEATHER_SIZE`, and a message
   * from an older bundle that has no such fields is still a valid request.
   */
  readonly shapeSize?: number;
  readonly weatherSize?: number;
}

/** What the main thread may send. */
export type ToBakeWorker = BakeRequestMessage;

/** A baked field, or the fact that there is not one. */
export interface BakeReadyMessage {
  readonly kind: "cloudFieldReady";
  /** Echoed back, so an answer can be matched to the world it is for. */
  readonly seed: number;
  readonly shape: PackedField;
  readonly weather: PackedField;
}

/** A worker reporting that it could not bake what it was asked for. */
export interface BakeFailedMessage {
  readonly kind: "cloudFieldFailed";
  readonly seed: number;
  readonly reason: string;
}

/** What a worker may send back. */
export type FromBakeWorker = BakeReadyMessage | BakeFailedMessage;

const TO_WORKER_KINDS = new Set(["bakeCloudField"]);
const FROM_WORKER_KINDS = new Set(["cloudFieldReady", "cloudFieldFailed"]);

const kindOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
};

/**
 * Whether a value is a message the main thread may send.
 *
 * Rejecting by shape rather than trusting the type, so that a queued message from an
 * older or newer bundle is survivable: an answer nobody asked for is dropped, where
 * trusting it would build a sky out of somebody else's weather.
 */
export const isToBakeWorker = (value: unknown): value is ToBakeWorker => {
  const kind = kindOf(value);
  return kind !== undefined && TO_WORKER_KINDS.has(kind);
};

/** Whether a value is a message a worker may send. */
export const isFromBakeWorker = (value: unknown): value is FromBakeWorker => {
  const kind = kindOf(value);
  return kind !== undefined && FROM_WORKER_KINDS.has(kind);
};

/**
 * The two buffers to transfer alongside a baked field, in a fixed order.
 *
 * Beside the message so sender and receiver cannot disagree about the list. Getting
 * it wrong does not throw: the arrays are cloned instead of transferred, and the bake
 * pays a megabyte of copying on every load for the rest of the session — which is
 * exactly the cost the worker was added to avoid, so it is worth a test rather than a
 * comment.
 */
export const bakeTransferables = (message: FromBakeWorker): Transferable[] => {
  if (message.kind !== "cloudFieldReady") return [];
  return [
    message.shape.data.buffer,
    message.weather.data.buffer,
  ] as Transferable[];
};
